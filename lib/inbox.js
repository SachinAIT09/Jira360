// Changes waiting for someone to approve them before they reach Jira (from the portal and the
// Google Sheet). Each one is kept in the store as inbox:<id>; ids sort by time.
//   status: pending -> approved | rejected | withdrawn   (approved items keep the Jira result)
// A sheet item can carry `conflicts`: fields changed in both the sheet and Jira since the last sync.

import { store, timeId } from './store.js';
import { checkTask, previewContext } from './check.js';
import { syncAndRecord } from './activity.js';
import { badRequest } from './jira.js';

const KEY = id => `inbox:${id}`;
const SHOW_DECIDED = 30; // how many decided items the page lists below the pending ones

// Told about each new waiting change (alerts)
const addedHooks = [];
export const onAdded = fn => { addedHooks.push(fn); };

// extra: anything the source needs back later (the sheet keeps its row values and conflicts)
export async function addToInbox({ source, task, check, eventId, ...extra }) {
  const item = { id: timeId(), source, status: 'pending', receivedAt: new Date().toISOString(), eventId: eventId || null, task, check, ...extra };
  await store.set(KEY(item.id), item);
  for (const fn of addedHooks) await Promise.resolve(fn(item)).catch(e => console.error('inbox hook failed:', e.message));
  return item;
}

export const getItem = id => store.get(KEY(id));

// A newer version of a waiting change (the sheet row was edited again before approval)
export async function replaceItem(id, patch) {
  const item = await getItem(id);
  if (!item || item.status !== 'pending') return null;
  const next = { ...item, ...patch, receivedAt: new Date().toISOString() };
  await store.set(KEY(id), next);
  return next;
}

// Pending items oldest first (approve in the order they came in), then the latest decided ones
export async function listInbox() {
  const ids = (await store.list('inbox:')).map(k => k.slice('inbox:'.length)).sort();
  const items = (await Promise.all(ids.map(getItem))).filter(Boolean);
  const pending = items.filter(i => i.status === 'pending');
  const decided = items.filter(i => i.status !== 'pending').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, SHOW_DECIDED);
  return { pending, decided };
}

// The source is told about each decision (the sheet writes the outcome into its row)
const hooks = [];
export const onDecision = fn => hooks.push(fn);
async function tell(item) {
  for (const fn of hooks) await Promise.resolve(fn(item)).catch(e => console.error('inbox hook failed:', e.message));
}

// One decision at a time per item on this server, so a double click sends once
const busy = new Set();
async function decide(id, fn) {
  if (busy.has(id)) throw Object.assign(new Error('This change is already being handled'), { status: 409 });
  busy.add(id);
  try {
    const item = await getItem(id);
    if (!item) throw Object.assign(new Error('No such change in the inbox'), { status: 404 });
    if (item.status !== 'pending') throw Object.assign(new Error(`Already ${item.status}`), { status: 409 });
    const done = await fn(item);
    await tell(done);
    return done;
  } finally { busy.delete(id); }
}

// Checks the change again (Jira may have changed since it arrived), then sends it.
// keepJira: fields in conflict where Jira's value wins (they are left out of the send).
// With errors it stays pending and the fresh check is returned instead.
export const approve = (id, by, { keepJira = [] } = {}) => decide(id, async item => {
  const keep = (Array.isArray(keepJira) ? keepJira : []).filter(f => (item.conflicts || []).some(c => c.field === f));
  const task = Object.fromEntries(Object.entries(item.task).filter(([k]) => !keep.includes(k)));
  const check = await checkTask(task, previewContext(task.projectKey || undefined));
  if (check.errors.length) {
    await store.set(KEY(id), { ...item, check });
    throw Object.assign(badRequest('This change has problems now; fix it at the source and send it again, or reject it'), { errors: check.errors, item: { ...item, check } });
  }
  const sendable = Object.keys(check.task).some(k => !['taskId', 'jiraKey', 'replaceLists'].includes(k));
  const result = sendable ? await syncAndRecord(check.task, { source: item.source, by, via: 'inbox' })
    : { taskId: task.taskId, jiraKey: item.check?.info?.existingKey || task.jiraKey, actions: [] }; // only Jira's values were kept
  const done = { ...item, check, keptJira: keep, status: 'approved', decidedAt: new Date().toISOString(), decidedBy: by || '', result };
  await store.set(KEY(id), done);
  // A resend of the same portal event now gets the real result instead of "queued"
  if (item.eventId) await store.set(`event:${item.eventId}`, result).catch(() => {});
  return done;
});

export const reject = (id, by, reason) => decide(id, async item => {
  const done = { ...item, status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: by || '', reason: reason || '' };
  await store.set(KEY(id), done);
  if (item.eventId) await store.set(`event:${item.eventId}`, { taskId: item.task.taskId, rejected: true, reason: reason || '' }).catch(() => {});
  return done;
});

// The source took the change back (the sheet row was changed back to what was last synced)
export const withdraw = (id, reason) => decide(id, async item => {
  const done = { ...item, status: 'withdrawn', decidedAt: new Date().toISOString(), decidedBy: '', reason };
  await store.set(KEY(id), done);
  return done;
});
