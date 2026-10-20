// History of every send to Jira, whatever started it: the form, a bulk upload, the portal, or an
// Inbox approval. Failures are kept too (with the task, so it can be sent again from the page).
//
// One store entry per send, keyed  activity:<id>|<source>|<ok 1/0>|<taskId>|<jiraKey>
// The key carries what the Activity tab filters on, so a filtered page only reads the entries it
// shows. Ids sort by time, newest last.

import { browseUrl, estimate, list, lists } from './jira.js';
import { JIRA_PROJECT_KEY } from './config.js';
import { syncTaskQueued } from './sync.js';
import { store, timeId } from './store.js';
import { logError } from './log.js';
import { extraFields } from './fields.js';

const PREFIX = 'activity:';
const KEY_PART = 80; // task ids / keys longer than this are cut in the key (the entry keeps them whole)
const enc = v => encodeURIComponent(String(v ?? '').slice(0, KEY_PART));
const keyOf = e => PREFIX + [e.id, e.source, e.ok ? 1 : 0, e.taskId, e.jiraKey].map(enc).join('|');
function parseKey(key) {
  const [id, source, ok, taskId, jiraKey] = key.slice(PREFIX.length).split('|').map(decodeURIComponent);
  return { key, id, source, ok: ok === '1', taskId, jiraKey, at: parseInt(id, 36) };
}

// Told about every failed or refused send (alerts). Awaited, so on Netlify it finishes before the reply.
const failedHooks = [];
export const onFailed = fn => { failedHooks.push(fn); };

export async function record(entry) {
  const e = { id: timeId(), at: new Date().toISOString(), ...entry };
  try { await store.set(keyOf(e), e); }
  catch (err) { logError('activity', err, { taskId: e.taskId }); } // losing a history line must not fail the send
  if (!e.ok) for (const fn of failedHooks) await Promise.resolve(fn(e)).catch(err => logError('activity', err));
  return e;
}

// ---------- What changed: the task's values against the ticket's values before the send ----------
const TRACKED = ['title', 'description', 'assigneeId', 'parentKey', 'startDate', 'dueDate', 'originalEstimate',
  'sprint', 'labels', 'fixVersions', 'priority', 'status'];
const LIST_FIELDS = ['labels', 'fixVersions'];
const short = v => { const s = String(v ?? ''); return s.length > 1000 ? s.slice(0, 1000) + '…' : s; };
const asSet = v => [...new Set(list(v).map(x => x.toLowerCase()))].sort().join(',');
const same = (k, a, b) => LIST_FIELDS.includes(k) ? asSet(a) === asSet(b) : String(a).trim() === String(b).trim();

async function assigneeName(task) {
  if (!task.assigneeId) return task.assigneeEmail || '';
  const users = await lists.users(task.projectKey || JIRA_PROJECT_KEY).catch(() => []);
  return users.find(u => u.id === task.assigneeId)?.name || task.assigneeEmail || task.assigneeId;
}

export async function changesOf(task, result) {
  const created = result.actions.includes('created');
  const before = result.before; // null for a new ticket, or when it couldn't be read
  const clear = new Set(Array.isArray(task.clear) ? task.clear : []);
  const moved = result.actions.find(a => a.startsWith('transitioned:'));
  const out = [];
  for (const k of TRACKED) {
    let after;
    if (k === 'status') { if (!moved) continue; after = moved.slice('transitioned:'.length); }
    else if (clear.has(k) && !created) after = '';
    else if (k === 'assigneeId') { if (!task.assigneeId && !task.assigneeEmail) continue; after = await assigneeName(task); }
    else if (task[k] === undefined || (task[k] === '' && k !== 'description')) continue;
    else after = String(task[k]).trim();

    if (k === 'originalEstimate' && after) after = estimate(after);
    if (k === 'labels') after = list(after).map(l => l.replace(/\s+/g, '-')).join(', ');
    // Without replaceLists, labels and versions are added to what the ticket had
    if (LIST_FIELDS.includes(k) && after && !created && !task.replaceLists) after = [...new Set([...list(before?.values[k]), ...list(after)])].join(', ');

    let was = '';
    if (!created) was = !before ? '?' : k === 'assigneeId' ? before.assignee?.name || '' : before.values[k] ?? '';
    if (created ? after === '' : was !== '?' && same(k, was, after)) continue;
    out.push({ field: k === 'assigneeId' ? 'assignee' : k, before: short(was), after: short(after) });
  }
  // Extra Jira fields: shown by their Jira name (people by name)
  if (task.fields && typeof task.fields === 'object') {
    const names = await extraFields().then(fs => new Map(fs.map(f => [f.id, f]))).catch(() => new Map());
    const users = await lists.users(task.projectKey || JIRA_PROJECT_KEY).catch(() => []);
    const show = (f, v) => (f?.kind === 'user' || f?.kind === 'users') ? list(v).map(id => users.find(u => u.id === id)?.name || id).join(', ') : v;
    for (const [id, v] of Object.entries(task.fields)) {
      const f = names.get(id);
      const was = created ? '' : !before ? '?' : before.values.fields?.[id] ?? '';
      if (!created && was !== '?' && String(was) === String(v)) continue;
      if (created && v === '') continue;
      out.push({ field: id, label: f?.name || id, before: short(show(f, was)), after: short(show(f, v)) });
    }
  }
  if (task.comment) out.push({ field: 'comment', before: '', after: short(task.comment) });
  const hours = Number(task.hoursSpent);
  if (task.timeSpent || hours > 0) out.push({ field: 'hoursSpent', before: '', after: (task.timeSpent || `${hours}h`) +
    (task.adjustEstimate === 'new' ? ` (remaining set to ${task.newEstimate})` : task.adjustEstimate === 'manual' ? ` (remaining reduced by ${task.reduceBy})` : task.adjustEstimate === 'leave' ? ' (remaining unchanged)' : '') });
  return out;
}

// Told after every successful send (the Google Sheet updates its row). Runs after the reply, so a
// slow sheet never slows a send down.
const syncedHooks = [];
export const onSynced = fn => { syncedHooks.push(fn); };

// Sends a task to Jira (the only way the routes do it) and records what happened, success or failure
export async function syncAndRecord(task, { source, by = '', via } = {}) {
  const base = { source, by, ...(via && { via }), taskId: String(task.taskId), task };
  let result;
  try {
    result = await syncTaskQueued(task);
  } catch (e) {
    await record({ ...base, ok: false, jiraKey: String(task.jiraKey || '').toUpperCase(), title: task.title || '', error: e.message });
    throw e;
  }
  const changes = await changesOf(task, result).catch(e => { logError('activity', e); return []; });
  await record({
    ...base, ok: true, jiraKey: result.jiraKey, url: browseUrl(result.jiraKey),
    title: task.title || result.before?.values.title || '', actions: result.actions,
    ...(result.warning && { warning: result.warning }), changes,
  });
  for (const fn of syncedHooks) setImmediate(() => Promise.resolve(fn({ task, result, source })).catch(e => logError('activity', e)));
  return result;
}

// ---------- Reading the history ----------
const MAX_READS = 400; // a title search reads entries one by one; stop there and offer "more"
const allKeys = async () => (await store.list(PREFIX)).map(parseKey).sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first

const matches = (e, needle) => [e.taskId, e.jiraKey, e.title, e.by].some(v => String(v || '').toLowerCase().includes(needle));

// Newest first, filtered. `before` is the paging cursor (the `next` of the previous page).
export async function listActivity({ q = '', source = '', result = '', from = 0, to = 0, before = '', limit = 50 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const needle = String(q).trim().toLowerCase();
  const keys = (await allKeys()).filter(k =>
    (!source || k.source === source) &&
    (result !== 'ok' || k.ok) && (result !== 'failed' || !k.ok) &&
    (!from || k.at >= from) && (!to || k.at < to) &&
    (!before || k.id < before));

  const items = [];
  let pos = 0, next = '';
  while (pos < keys.length && items.length < limit && pos < MAX_READS) {
    const chunk = keys.slice(pos, pos + (needle ? 20 : limit - items.length));
    const entries = await Promise.all(chunk.map(k => store.get(k.key).catch(() => null)));
    for (let j = 0; j < chunk.length && items.length < limit; j++) {
      next = chunk[j].id;
      pos++;
      if (entries[j] && (!needle || matches(entries[j], needle))) items.push(entries[j]);
    }
  }
  return { items, more: pos < keys.length, next: pos < keys.length ? next : '' };
}

// Every ticket Jira360 has sent to Jira: [{ taskId, jiraKey }], one per Jira key (from the entry keys)
export async function trackedTasks() {
  const byKey = new Map();
  for (const k of await allKeys()) {
    if (!k.ok || !k.jiraKey || k.source === 'jira') continue;
    const prev = byKey.get(k.jiraKey);
    // Prefer a real Task ID over the Jira key used as one (the form does that when only a key is typed)
    if (!prev || (prev.taskId === k.jiraKey && k.taskId !== k.jiraKey)) byKey.set(k.jiraKey, { taskId: k.taskId, jiraKey: k.jiraKey });
  }
  return [...byKey.values()];
}

// Everything that happened to one task (by its Task ID or Jira key), newest first
export async function taskActivity({ taskId = '', jiraKey = '' }) {
  const t = String(taskId).slice(0, KEY_PART).toLowerCase(), j = String(jiraKey).slice(0, KEY_PART).toUpperCase();
  if (!t && !j) return [];
  const keys = (await allKeys()).filter(k => (t && k.taskId.toLowerCase() === t) || (j && k.jiraKey.toUpperCase() === j)).slice(0, 200);
  return (await Promise.all(keys.map(k => store.get(k.key).catch(() => null)))).filter(Boolean);
}
