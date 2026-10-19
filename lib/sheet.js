// Google Sheet <-> Jira360 <-> Jira, kept in step: one ticket, one row.
//
// Every check (Settings: every N minutes, default 1; or "Check sheet now") compares, field by field,
//   S = the sheet row,  J = the ticket in Jira,  B = the values both last agreed on (sheet:base:<taskId>)
//   only S changed -> sent to Jira (automatic mode) or to the Inbox for approval (approval mode)
//   only J changed -> written into the row
//   both changed   -> the latest change wins (Jira's history vs the row's "Edited at" column, if the sheet
//                     has one; else the sheet edit counts as made halfway through the check window).
//                     The value that lost is kept in Activity.
// Then B becomes the result, so the app's own writes never look like new edits on the other side.
//
// Rows: every ticket Jira360 sends to Jira gets one (added after the send, and back-filled from the
// Activity history). New rows without a ticket create one. A row deleted from the sheet stops that
// ticket's sync (the ticket is left alone); a ticket gone from Jira is marked in its row.

import crypto from 'node:crypto';
import { readSheet, writeCells, isSheetConfigured, sheetInfo, sheetMeta, readHeader, writeRange, batchUpdate, createSpreadsheet, shareFile, serviceAccountEmail } from './google.js';
import { effective, onSettingsChange, saveSettings } from './settings.js';
import { sheetLayout } from './sheet-layout.js';
import { HEADER_TO_FIELD, normHeader } from './bulk.js';
import { checkTask, previewContext, normDate, jiraDuration } from './check.js';
import { addToInbox, listInbox, replaceItem, withdraw, onDecision } from './inbox.js';
import { badRequest, list, lists, readIssue, changedSince, fieldChangeTimes, customFieldIds, browseUrl } from './jira.js';
import { JIRA_PROJECT_KEY, STATUS_MAP } from './config.js';
import { syncAndRecord, onSynced, trackedTasks, record } from './activity.js';
import { store } from './store.js';
import { log, logError } from './log.js';
import { extraHeaderMap, extraFields } from './fields.js';

export { isSheetConfigured };

// Columns beyond the bulk-upload ones. The app fills these in (and adds them if missing), except
// "Edited at", which an optional Apps Script keeps (see the README).
const EXTRA_COLS = { comment: 'comment', comments: 'comment', update: 'comment', syncstatus: 'syncStatus', lastsynced: 'lastSynced', editedat: 'editedAt' };
const APP_COLS = { taskId: 'Task ID', jiraKey: 'Jira Key', syncStatus: 'Sync status', lastSynced: 'Last synced' };
const NOT_DATA = ['taskId', 'jiraKey', 'syncStatus', 'lastSynced', 'editedAt'];
const DATES = ['startDate', 'dueDate'];
const LISTS = ['labels', 'fixVersions'];
const NAMES = { title: 'Title', description: 'Description', assigneeEmail: 'Assignee', parentKey: 'Parent', startDate: 'Start date', dueDate: 'End date',
  originalEstimate: 'Estimate', sprint: 'Sprint', labels: 'Labels', fixVersions: 'Fix version', priority: 'Priority', status: 'Status', comment: 'Comment' };
const baseKey = taskId => `sheet:base:${taskId}`;
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const hashOf = v => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');

// Cell value as stored (dates as YYYY-MM-DD: the sheet sends day numbers; lists tidied)
function norm(field, v) {
  v = String(v ?? '').trim();
  if (!v) return '';
  if (DATES.includes(field)) return normDate(v) || v;
  if (LISTS.includes(field)) return list(v).join(', ');
  return v;
}

// ---------- Comparing values the way people mean them ----------
// ctx.users: assignable people; ctx.kinds: extra field id -> kind
const isPeople = (f, ctx) => f === 'assigneeEmail' || (f.startsWith('f:') && ['user', 'users'].includes(ctx.kinds.get(f.slice(2))));
const isList = (f, ctx) => LISTS.includes(f) || (f.startsWith('f:') && ['options', 'strings', 'components', 'versions', 'users'].includes(ctx.kinds.get(f.slice(2))));
function personId(v, ctx) {
  const s = String(v).trim().toLowerCase();
  return ctx.users.find(u => u.id.toLowerCase() === s || (u.email && u.email.toLowerCase() === s) || u.name.toLowerCase() === s)?.id || s;
}
function canon(f, v, ctx) {
  v = String(v ?? '').trim();
  if (!v) return '';
  if (DATES.includes(f)) return normDate(v) || v;
  if (isPeople(f, ctx)) return list(v).map(x => personId(x, ctx)).sort().join(',');
  if (isList(f, ctx)) return list(v).map(x => x.toLowerCase()).sort().join(',');
  if (f === 'status') return (STATUS_MAP[v.toLowerCase()] || v).toLowerCase(); // "done" = "Done"
  if (f === 'originalEstimate') return (jiraDuration(v) || v).toLowerCase();
  if (f === 'title' || f === 'description' || f.startsWith('f:')) return v.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n'); // case matters
  return v.toLowerCase();
}

// "Edited at" cell -> ms (Apps Script writes Date.now(); a date cell comes as a day number)
function editedAtMs(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return n > 1e11 ? n : Math.round((n - 25569) * 86400000);
  return Date.parse(s) || 0;
}

// ---------- Reading the sheet ----------
// Header row -> which column holds which field (1-based)
function layout(grid, extra = {}) {
  const h = grid.findIndex(r => r.some(c => String(c).trim()));
  if (h < 0) throw badRequest('The sheet is empty: add a header row (download the bulk template to see the columns)');
  const cols = {};
  grid[h].forEach((name, i) => {
    const n = normHeader(name), f = EXTRA_COLS[n] || HEADER_TO_FIELD[n] || (extra[n] && 'f:' + extra[n]);
    if (f && !cols[f]) cols[f] = i + 1;
  });
  if (!cols.title) throw badRequest('No "Title" column in the sheet');
  return { headerRow: h + 1, cols, width: grid[h].length };
}
const dataFields = lay => Object.keys(lay.cols).filter(f => !NOT_DATA.includes(f) && f !== 'comment');

function readRows(grid, lay) {
  const out = [];
  for (let i = lay.headerRow; i < grid.length; i++) {
    const cell = f => (lay.cols[f] ? grid[i][lay.cols[f] - 1] ?? '' : '');
    const values = {};
    for (const f of Object.keys(lay.cols)) if (!NOT_DATA.includes(f)) values[f] = norm(f, cell(f));
    const taskId = String(cell('taskId')).trim(), jiraKey = String(cell('jiraKey')).trim().toUpperCase();
    if (taskId || jiraKey || Object.values(values).some(Boolean)) out.push({ row: i + 1, taskId, jiraKey, values, editedAt: editedAtMs(cell('editedAt')) });
  }
  return out;
}

// One sheet job at a time: a check, a decision being written back, rows for sends from Jira360
let chain = Promise.resolve();
const locked = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

// ---------- Jira's ticket -> row values ----------
function jiraRow(issue, lay, ctx) {
  const v = issue.values;
  const map = { title: v.title, description: v.description, assigneeEmail: issue.assignee?.name || '', parentKey: v.parentKey, startDate: v.startDate,
    dueDate: v.dueDate, originalEstimate: v.originalEstimate, sprint: v.sprint, labels: v.labels, fixVersions: v.fixVersions, priority: v.priority, status: v.status };
  const out = {};
  for (const f of dataFields(lay)) {
    if (f.startsWith('f:')) {
      const x = v.fields?.[f.slice(2)] ?? '';
      out[f] = isPeople(f, ctx) ? list(x).map(id => ctx.users.find(u => u.id === id)?.name || id).join(', ') : x;
    } else if (f in map) out[f] = map[f] ?? '';
  }
  return out;
}

// Row field -> Jira field id in a ticket's history (for "which change is newer")
async function historyIds() {
  const ids = await customFieldIds();
  return { title: ['summary'], description: ['description'], assigneeEmail: ['assignee'], parentKey: ['parent', 'IssueParentAssociation'],
    startDate: [ids.startDate], dueDate: ['duedate'], originalEstimate: ['timeoriginalestimate'], sprint: [ids.sprint], labels: ['labels'],
    fixVersions: ['fixVersions'], priority: ['priority'], status: ['status'] };
}

// Fields where Jira's current value can be compared (approval mode shows these as conflicts)
const CURRENT = { title: 'title', description: 'description', parentKey: 'parentKey', startDate: 'startDate', dueDate: 'dueDate',
  originalEstimate: 'originalEstimate', sprint: 'sprint', labels: 'labels', fixVersions: 'fixVersions', priority: 'priority', status: 'status' };
function findConflicts(changed, sheet, base, current, ctx) {
  const out = [];
  for (const f of changed) {
    if (!CURRENT[f]) continue;
    const jira = norm(f, current[CURRENT[f]]), was = base[f] || '', now = sheet[f] || '';
    if (canon(f, jira, ctx) !== canon(f, was, ctx) && canon(f, jira, ctx) !== canon(f, now, ctx)) out.push({ field: f, base: was, sheet: now, jira });
  }
  return out;
}

// Row values -> a task to send (only `fields`; an emptied cell empties the field in Jira)
function taskFrom(taskId, jiraKey, values, fields, withComment) {
  const task = { taskId, ...(jiraKey && { jiraKey }) };
  const clear = [];
  for (const f of fields) {
    const v = values[f];
    if (f.startsWith('f:')) { if (v || jiraKey) (task.fields ||= {})[f.slice(2)] = v; }
    else if (v) task[f] = v;
    else if (jiraKey) clear.push(f === 'assigneeEmail' ? 'assigneeId' : f);
  }
  if (clear.length) task.clear = clear;
  if (jiraKey) task.replaceLists = true; // a labels cell holds the whole list
  if (withComment && values.comment) task.comment = values.comment;
  return task;
}
const hasPayload = t => Object.keys(t).some(k => !['taskId', 'jiraKey', 'replaceLists'].includes(k));

// ---------- One check ----------
let lastPoll = null;
export const sheetStatus = async () => ({ ...sheetInfo(), syncMode: effective().sheet.syncMode,
  lastPoll: lastPoll || await store.get('sheet:lastPoll').catch(() => null) });

async function loadContext(dry = false) {
  const grid = await readSheet();
  const lay = layout(grid, await extraHeaderMap(normHeader));
  const writes = [];
  let next = lay.width + 1;
  for (const [f, header] of Object.entries(APP_COLS)) if (!lay.cols[f]) { lay.cols[f] = next++; writes.push({ row: lay.headerRow, col: lay.cols[f], value: header }); }
  const rows = readRows(grid, lay);
  const [users, extras] = await Promise.all([lists.users(JIRA_PROJECT_KEY).catch(() => []), extraFields().catch(() => [])]);
  return {
    lay, rows, writes, users, kinds: new Map(extras.map(f => [f.id, f.kind])),
    nextRow: Math.max(grid.length, lay.headerRow) + 1, mode: effective().sheet.syncMode, now: Date.now(),
    lastAt: Number(await store.get('sheet:lastCycle').catch(() => 0)) || 0,
    pending: new Map((await listInbox()).pending.filter(i => i.source === 'sheet').map(i => [i.task.taskId, i])),
    checkCtx: previewContext(), hist: null, dry, plan: [],
    summary: { rows: rows.length, toJira: 0, toSheet: 0, added: 0, created: 0, conflicts: 0, problems: 0, queued: 0, updated: 0, unchanged: 0, withdrawn: 0, skipped: 0 },
  };
}
// Dry run ("what the next sync will do"): one line per decision, nothing written anywhere
const planAdd = (ctx, r, action, fields = [], detail = '') => ctx.plan.push({ row: r?.row || null, taskId: r?.taskId || '', jiraKey: r?.jiraKey || '',
  title: r?.values?.title || '', action, fields, detail });
const put = (ctx, row, f, value) => { if (ctx.lay.cols[f]) ctx.writes.push({ row, col: ctx.lay.cols[f], value }); };
const status = (ctx, row, text) => { put(ctx, row, 'syncStatus', text); put(ctx, row, 'lastSynced', stamp()); };

// Approval mode: the sheet's change waits in the Inbox (with conflicts shown there)
async function queueForApproval(ctx, r, task, base, changed, current) {
  const hash = hashOf([task, r.values]);
  const old = ctx.pending.get(r.taskId);
  if (old?.hash === hash) { ctx.summary.unchanged++; return; }
  const check = await checkTask(task, ctx.checkCtx, { withCurrent: true });
  const conflicts = base && (current || check.info.current) ? findConflicts(changed, r.values, base.values, current || check.info.current, ctx) : [];
  const extra = { hash, sheetRow: r.row, rowValues: r.values, rowJiraKey: task.jiraKey || '', conflicts };
  if (old) { await replaceItem(old.id, { task, check, ...extra }); ctx.summary.updated++; }
  else { await addToInbox({ source: 'sheet', task, check, ...extra }); ctx.summary.queued++; }
  status(ctx, r.row, check.errors.length ? `Problems: ${check.errors.join('; ')}` : conflicts.length ? 'Waiting for approval (conflict with Jira)' : 'Waiting for approval');
}

// Automatic mode: checked, then sent. Problems are not sent: the row says why, and the Inbox shows it.
async function sendNow(ctx, r, task, base) {
  const hash = hashOf(task);
  if (base?.failed?.hash === hash) return { skipped: true }; // the same change failed before: wait for an edit
  const check = await checkTask(task, ctx.checkCtx);
  if (check.errors.length) {
    ctx.summary.problems++;
    status(ctx, r.row, `Problems: ${check.errors.join('; ')}`);
    const old = ctx.pending.get(r.taskId), extra = { hash, sheetRow: r.row, rowValues: r.values, rowJiraKey: task.jiraKey || '', conflicts: [] };
    if (old) await replaceItem(old.id, { task, check, ...extra }); else await addToInbox({ source: 'sheet', task, check, ...extra });
    return { failed: { hash, error: check.errors.join('; ') } };
  }
  try {
    const result = await syncAndRecord(check.task, { source: 'sheet', by: 'Google Sheet' });
    const old = ctx.pending.get(r.taskId);
    if (old) await withdraw(old.id, 'Sent from the sheet after it was fixed').catch(() => {});
    return { result };
  } catch (e) {
    status(ctx, r.row, `Failed: ${e.message.slice(0, 200)}`);
    return { failed: { hash, error: e.message } };
  }
}

// The three-way merge for one row that has a ticket
async function mergeRow(ctx, r, base, force = false) {
  const jiraKey = r.jiraKey || base?.jiraKey;
  const fields = dataFields(ctx.lay);
  const S = r.values, B = base?.values;
  const sheetChanged = B ? fields.filter(f => canon(f, S[f], ctx) !== canon(f, B[f], ctx)) : fields.filter(f => S[f]);
  const commentNew = !!S.comment && S.comment !== (B?.comment || '');
  const jiraMoved = ctx.changed?.has(jiraKey);
  if (!force && B && !sheetChanged.length && !commentNew && !jiraMoved && !(r.jiraKey && r.jiraKey !== base.jiraKey)) {
    // Changed back before it was approved (or fixed): the waiting change is withdrawn
    const old = ctx.pending.get(r.taskId);
    if (old && ctx.dry) planAdd(ctx, r, 'withdraw', [], 'Changed back: the waiting change will be withdrawn');
    else if (old) { await withdraw(old.id, 'The sheet row was changed back'); status(ctx, r.row, 'Synced'); ctx.summary.withdrawn++; }
    else ctx.summary.unchanged++;
    return;
  }

  let issue;
  try { issue = await readIssue(jiraKey); }
  catch (e) {
    if (e.status !== 404) throw e;
    if (ctx.dry) { if (!base?.missing) planAdd(ctx, r, 'missing', [], `${jiraKey} is not in Jira`); return; }
    if (!base?.missing) status(ctx, r.row, 'Ticket not found in Jira');
    await store.set(baseKey(r.taskId), { ...(base || { values: S }), jiraKey, missing: true, inSheet: true, at: new Date().toISOString() });
    return;
  }
  const J = jiraRow(issue, ctx.lay, ctx);
  const toJira = [], toSheet = [], lost = [];
  for (const f of fields) {
    const s = canon(f, S[f], ctx), j = canon(f, J[f], ctx);
    const b = B ? canon(f, B[f], ctx) : (S[f] ? null : j); // no history yet: a filled cell is the sheet's, an empty one Jira's
    const sC = s !== b, jC = j !== b;
    if (s === j || (!sC && !jC)) continue;
    if (sC && !jC) toJira.push(f);
    else if (!sC && jC) toSheet.push(f);
    else if (ctx.mode === 'approve') toJira.push(f); // the Inbox shows the clash
    else {
      // Both changed: the newer change wins
      ctx.hist ||= await historyIds();
      const times = (r._times ||= await fieldChangeTimes(issue.jiraKey).catch(() => ({})));
      const jt = Math.max(0, ...(ctx.hist[f] || [f.slice(2)]).filter(Boolean).map(id => times[id] || 0)) || Date.parse(issue.updated) || 0;
      const st = r.editedAt || Math.round(((ctx.lastAt || ctx.now - 60000) + ctx.now) / 2);
      ctx.summary.conflicts++;
      if (st >= jt) { toJira.push(f); lost.push({ field: f, side: 'Jira', value: J[f] }); }
      else { toSheet.push(f); lost.push({ field: f, side: 'sheet', value: S[f] }); }
    }
  }

  if (ctx.dry) {
    const name = f => NAMES[f] || f;
    if (toSheet.length) planAdd(ctx, r, 'from-jira', toSheet.map(f => ({ field: name(f), from: S[f] || '', to: J[f] || '' })));
    const task = taskFrom(r.taskId, jiraKey, S, toJira, commentNew);
    if (hasPayload(task)) {
      const check = await checkTask(task, ctx.checkCtx);
      const fieldsOut = toJira.map(f => ({ field: name(f), from: J[f] || '', to: S[f] || '' })).concat(task.comment ? [{ field: 'Comment', from: '', to: task.comment }] : []);
      planAdd(ctx, r, check.errors.length ? 'problem' : ctx.mode === 'approve' ? 'to-inbox' : 'to-jira', fieldsOut, check.errors.join('; '));
    }
    for (const l of lost) planAdd(ctx, r, 'conflict', [{ field: name(l.field), from: l.value || '', to: (l.side === 'Jira' ? S : J)[l.field] || '' }],
      `Changed in both places: the newer ${l.side === 'Jira' ? 'sheet' : 'Jira'} change wins`);
    return;
  }

  // Jira -> the row
  for (const f of toSheet) put(ctx, r.row, f, J[f]);
  if (toSheet.length) {
    ctx.summary.toSheet++;
    await record({ source: 'jira', by: 'Jira', ok: true, taskId: r.taskId, jiraKey, url: browseUrl(jiraKey), title: J.title || S.title || '',
      actions: ['sheet-updated'], changes: toSheet.map(f => {
        const l = lost.find(x => x.field === f);
        return { field: f, label: (NAMES[f] || f) + (l ? ' (newer Jira change kept)' : ''), before: S[f] || '', after: J[f] || '' };
      }) });
  }

  // The row -> Jira
  let sent = null, failed = null, pendingFields = [];
  const task = taskFrom(r.taskId, jiraKey, S, toJira, commentNew);
  const waiting = ctx.pending.get(r.taskId);
  if (!hasPayload(task) && waiting && !ctx.dry) { await withdraw(waiting.id, 'The sheet row was changed back'); status(ctx, r.row, 'Synced'); ctx.summary.withdrawn++; }
  if (hasPayload(task)) {
    if (ctx.mode === 'approve') { await queueForApproval(ctx, r, task, base, toJira, { ...issue.values, assigneeName: issue.assignee?.name }); pendingFields = toJira; }
    else {
      const out = await sendNow(ctx, r, task, base);
      if (out.result) { sent = out.result; ctx.summary.toJira++; }
      else { failed = out.failed || base?.failed; pendingFields = toJira; }
    }
  }
  if (lost.some(l => l.side === 'Jira') && sent) {
    await record({ source: 'sheet', by: 'Google Sheet', ok: true, taskId: r.taskId, jiraKey, url: browseUrl(jiraKey), title: S.title || J.title || '', actions: ['conflict'],
      changes: lost.filter(l => l.side === 'Jira').map(l => ({ field: l.field, label: `${NAMES[l.field] || l.field} (newer sheet change kept; Jira had)`, before: l.value || '', after: S[l.field] || '' })) });
  }

  // What both now agree on (changes still waiting keep the old agreed value, so they stay "changed")
  const values = {};
  for (const f of fields) values[f] = pendingFields.includes(f) ? (B ? B[f] : J[f]) : toSheet.includes(f) ? J[f] : S[f];
  // A comment not sent yet (automatic mode, failed) stays "new" so it goes with the next try; approval mode posts it on approval
  values.comment = task.comment && !sent && ctx.mode !== 'approve' ? (B?.comment || '') : S.comment || '';
  await store.set(baseKey(r.taskId), { values, jiraKey, inSheet: true, at: new Date().toISOString(), ...(failed && !sent && { failed }) });
  if (r.jiraKey !== jiraKey) put(ctx, r.row, 'jiraKey', jiraKey);
  if (sent || toSheet.length) {
    const l = lost.map(x => `${x.side === 'Jira' ? 'sheet' : 'Jira'}'s ${(NAMES[x.field] || x.field).toLowerCase()}`);
    status(ctx, r.row, sent && toSheet.length ? 'Synced both ways' : sent ? 'Synced to Jira' : 'Updated from Jira');
    if (l.length) put(ctx, r.row, 'syncStatus', `Synced (newer change kept: ${l.join(', ')})`);
  }
}

// A row without a ticket: create one
async function createFromRow(ctx, r, base) {
  if (!r.values.title) { ctx.summary.skipped++; return; } // nothing to create a ticket from
  // Already decided (rejected) or already tried: wait until the row changes again
  const fields = dataFields(ctx.lay);
  if (base && fields.every(f => canon(f, r.values[f], ctx) === canon(f, base.values?.[f], ctx)) && (r.values.comment || '') === (base.values?.comment || '')) {
    const old = ctx.pending.get(r.taskId);
    if (old && ctx.mode === 'approve' && old.hash !== hashOf([taskFrom(r.taskId, '', r.values, fields, true), r.values])) await withdraw(old.id, 'The sheet row was changed back');
    ctx.summary.unchanged++;
    return;
  }
  const task = taskFrom(r.taskId, '', r.values, dataFields(ctx.lay), true);
  if (ctx.dry) {
    const check = await checkTask(task, ctx.checkCtx);
    planAdd(ctx, r, check.errors.length ? 'problem' : ctx.mode === 'approve' ? 'to-inbox' : 'create', [], check.errors.join('; ') || 'A new ticket from this row');
    return;
  }
  if (ctx.mode === 'approve') return queueForApproval(ctx, r, task, base, [], null);
  const out = await sendNow(ctx, r, task, base);
  if (!out.result) {
    if (out.failed) await store.set(baseKey(r.taskId), { values: base?.values || {}, jiraKey: '', inSheet: true, failed: out.failed, at: new Date().toISOString() });
    return;
  }
  ctx.summary.created++;
  r.jiraKey = out.result.jiraKey; // so the same check doesn't also add a row for it
  put(ctx, r.row, 'jiraKey', out.result.jiraKey);
  status(ctx, r.row, 'Synced: ticket created');
  // Jira may have filled defaults (status, priority): agree on Jira's values and show them
  const issue = await readIssue(out.result.jiraKey).catch(() => null);
  const J = issue ? jiraRow(issue, ctx.lay, ctx) : r.values;
  for (const f of dataFields(ctx.lay)) if (J[f] && !r.values[f]) put(ctx, r.row, f, J[f]);
  await store.set(baseKey(r.taskId), { values: { ...J, comment: r.values.comment || '' }, jiraKey: out.result.jiraKey, inSheet: true, at: new Date().toISOString() });
}

// A ticket Jira360 sent that has no row yet: add one with Jira's values
async function appendRow(ctx, taskId, jiraKey) {
  if (ctx.dry) { planAdd(ctx, { taskId, jiraKey }, 'add-row', [], 'A Jira360 ticket without a row'); return; }
  let issue;
  try { issue = await readIssue(jiraKey); } catch (e) { if (e.status === 404) return; throw e; }
  const J = jiraRow(issue, ctx.lay, ctx), row = ctx.nextRow++;
  put(ctx, row, 'taskId', taskId);
  put(ctx, row, 'jiraKey', jiraKey);
  for (const f of dataFields(ctx.lay)) if (J[f]) put(ctx, row, f, J[f]);
  status(ctx, row, 'Added from Jira360');
  ctx.summary.added++;
  await store.set(baseKey(taskId), { values: { ...J, comment: '' }, jiraKey, inSheet: true, at: new Date().toISOString() });
}

async function allBases() {
  const keys = await store.list('sheet:base:');
  const out = new Map();
  for (const k of keys) { const b = await store.get(k).catch(() => null); if (b) out.set(k.slice('sheet:base:'.length), b); }
  return out;
}

// The whole check: every row, every tracked ticket. `only`: limit to these Jira keys / Task IDs.
async function cycle(only = null, { dry = false } = {}) {
  if (!isSheetConfigured()) throw Object.assign(new Error('Google Sheet not set up: add the service account key and sheet in Settings'), { status: 503 });
  const ctx = await loadContext(dry);
  const { rows } = ctx;
  // Every row needs its own Task ID to be followed (even if rows are moved); new rows get one
  for (const r of rows) if (!r.taskId) { r.taskId = 'SH-' + crypto.randomBytes(4).toString('hex').toUpperCase(); put(ctx, r.row, 'taskId', r.taskId); }
  const seenTask = new Map();
  for (const r of rows) { if (seenTask.has(r.taskId)) r.duplicateOf = seenTask.get(r.taskId); else seenTask.set(r.taskId, r.row); }

  const bases = await allBases();
  // What changed in Jira since the last check (a few minutes of overlap)
  if (!only) ctx.changed = ctx.lastAt ? await changedSince(JIRA_PROJECT_KEY, (ctx.now - ctx.lastAt) / 60000 + 2) : null;
  else ctx.changed = new Set(only);
  const wanted = r => !only || only.includes(r.taskId) || (r.jiraKey && only.includes(r.jiraKey)) || only.includes(bases.get(r.taskId)?.jiraKey);

  const rowByKey = new Map();
  for (const r of rows) {
    if (r.duplicateOf) { if (wanted(r)) { status(ctx, r.row, `Task ID also on row ${r.duplicateOf}: give this row its own`); ctx.summary.skipped++; } continue; }
    const base = bases.get(r.taskId);
    const key = r.jiraKey || base?.jiraKey;
    if (key) rowByKey.set(key, r);
    if (!wanted(r)) continue;
    // First check ever (no "changed since"): compare every row once
    const force = ctx.changed === null;
    try {
      if (key) await mergeRow(ctx, r, base, force || !!only);
      else { await createFromRow(ctx, r, base); if (r.jiraKey) rowByKey.set(r.jiraKey, r); }
    } catch (e) {
      logError('sheet', e, { taskId: r.taskId });
      if (dry) planAdd(ctx, r, 'problem', [], e.message.slice(0, 200));
      status(ctx, r.row, `Failed: ${e.message.slice(0, 200)}`);
    }
  }

  // Tickets Jira360 sent with no row: add them; rows that were deleted: stop syncing them
  const tracked = new Map();
  for (const t of await trackedTasks()) tracked.set(t.jiraKey, t.taskId);
  for (const [taskId, b] of bases) if (b.jiraKey && !tracked.has(b.jiraKey)) tracked.set(b.jiraKey, taskId);
  for (const [jiraKey, taskId] of tracked) {
    if (rowByKey.has(jiraKey) || (only && !only.includes(jiraKey) && !only.includes(taskId))) continue;
    const base = bases.get(taskId) || [...bases.values()].find(b => b.jiraKey === jiraKey);
    if (base?.removed) continue;
    if (base?.inSheet && dry) { planAdd(ctx, { taskId, jiraKey }, 'remove', [], 'Its row was deleted: the ticket stops syncing'); continue; }
    if (base?.inSheet) {
      await store.set(baseKey(taskId), { ...base, removed: true, at: new Date().toISOString() });
      await record({ source: 'sheet', by: 'Google Sheet', ok: true, taskId, jiraKey, url: browseUrl(jiraKey), title: base.values?.title || '', actions: ['row-removed'], changes: [] });
      continue;
    }
    try { await appendRow(ctx, taskId, jiraKey); } catch (e) { logError('sheet', e, { jiraKey }); }
  }

  if (dry) return { plan: ctx.plan, mode: ctx.mode, rows: rows.length };
  await writeCells(ctx.writes);
  if (!only) {
    await store.set('sheet:lastCycle', ctx.now).catch(() => {});
    lastPoll = { at: new Date(ctx.now).toISOString(), mode: ctx.mode, ...ctx.summary };
    await store.set('sheet:lastPoll', lastPoll).catch(() => {});
    log('sheet', lastPoll);
    return lastPoll;
  }
  return { only, ...ctx.summary };
}
export const pollSheet = () => locked(() => cycle());
export const syncCycle = pollSheet;

// One ticket now (after a send from Jira360, or the Jira webhook)
export const syncOne = refs => (!isSheetConfigured() ? null : locked(() => cycle([].concat(refs).filter(Boolean))));

// Sends from Jira360 (form, bulk, portal, Inbox): their rows follow, gathered so a 200-row upload
// updates the sheet once
const soon = new Set();
let soonTimer = null;
onSynced(({ result, task, source }) => {
  if (source === 'sheet' || !isSheetConfigured() || !result?.jiraKey) return; // the sheet's own sends are handled by the check
  soon.add(result.jiraKey); if (task?.taskId) soon.add(String(task.taskId));
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { const refs = [...soon]; soon.clear(); syncOne(refs)?.catch(e => logError('sheet', e)); }, 1200);
});

// ---------- Approval mode: decisions -> the row ----------
async function findRow(taskId) {
  const grid = await readSheet();
  const lay = layout(grid, await extraHeaderMap(normHeader));
  const r = readRows(grid, lay).find(x => x.taskId === taskId);
  return r ? { lay, r } : null;
}

onDecision(item => {
  if (item.source !== 'sheet' || item.status === 'withdrawn') return; // withdrawals come from a check that writes the row itself
  return locked(async () => {
    const base = await store.get(baseKey(item.task.taskId)).catch(() => null);
    const values = { ...item.rowValues };
    const fromJira = []; // conflicts settled in Jira's favour: the sheet gets Jira's value
    for (const f of item.keptJira || []) { const c = (item.conflicts || []).find(x => x.field === f); if (c) { values[f] = c.jira; fromJira.push(c); } }
    const jiraKey = item.status === 'approved' ? item.result?.jiraKey || item.rowJiraKey : base?.jiraKey || item.rowJiraKey || '';
    // Rejected values count as seen too: they are not offered again unless the row changes again
    await store.set(baseKey(item.task.taskId), { values, jiraKey, inSheet: true, at: new Date().toISOString() });
    const found = await findRow(item.task.taskId).catch(e => { logError('sheet', e); return null; });
    if (!found) return;
    const { lay, r } = found;
    const cells = [];
    const cell = (f, value) => { if (lay.cols[f]) cells.push({ row: r.row, col: lay.cols[f], value }); };
    if (item.status === 'approved') {
      if (jiraKey) cell('jiraKey', jiraKey);
      for (const c of fromJira) cell(c.field, c.jira);
      cell('syncStatus', fromJira.length ? `Synced (kept Jira's ${fromJira.map(c => c.field).join(', ')})` : 'Synced');
    } else cell('syncStatus', `Rejected${item.reason ? ': ' + item.reason : ''}${item.decidedBy ? ` (${item.decidedBy})` : ''}`);
    cell('lastSynced', stamp());
    await writeCells(cells);
  });
});

// ---------- Checking on a timer (only where the server keeps running: npm start) ----------
// Every "Check every … minutes" from Settings (SHEET_POLL_MINUTES, default 1); 0 = only by hand.
let timer = null, timerMinutes = 0;
function scheduleChecks() {
  const m = isSheetConfigured() ? effective().sheet.pollMinutes : 0;
  if (m === timerMinutes) return;
  clearInterval(timer);
  timer = null; timerMinutes = m;
  if (m > 0) {
    timer = setInterval(() => pollSheet().catch(e => console.error('sheet check failed:', e.message)), m * 60000);
    console.log(`Google Sheet synced every ${m} min`);
  }
}
export function enableSheetTimer() { onSettingsChange(scheduleChecks); scheduleChecks(); }

// ---------- Making the sheet, and the Settings preview ----------
const fieldOfHeader = (n, extra) => EXTRA_COLS[n] || HEADER_TO_FIELD[n] || (extra[n] && 'f:' + extra[n]) || null;
const rgb = hex => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });

// Headers, dropdowns, formats and widths on a sheet; the user's own columns are kept, missing ones added after them
async function prepareSheet(id, wantedTab, layoutDef) {
  const meta = await sheetMeta(id);
  const tab = meta.tabs.find(t => t.title === wantedTab) || meta.tabs[0];
  const { row: hr, values: head } = await readHeader(id, tab.title); // hr: the header row (0-based)
  const extra = await extraHeaderMap(normHeader);
  const have = head.map(h => ({ n: normHeader(h), f: fieldOfHeader(normHeader(h), extra) }));
  const row = [...head], added = [], idx = new Map();
  for (const c of layoutDef.columns) {
    const n = normHeader(c.header), f = fieldOfHeader(n, extra);
    let i = have.findIndex(h => h.n && (h.n === n || (f && h.f === f)));
    if (i < 0) { i = row.length; row.push(c.header); have.push({ n, f }); added.push(c.header); }
    idx.set(c.header, i);
  }
  if (added.length) await writeRange(id, tab.title, `A${hr + 1}`, [row]);
  const sid = tab.id, reqs = [];
  reqs.push({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: hr + 1 } }, fields: 'gridProperties.frozenRowCount' } });
  reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: hr, endRowIndex: hr + 1, startColumnIndex: 0, endColumnIndex: row.length },
    cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: rgb('#ECEAFF'), verticalAlignment: 'MIDDLE' } },
    fields: 'userEnteredFormat(textFormat,backgroundColor,verticalAlignment)' } });
  for (const c of layoutDef.columns) {
    const i = idx.get(c.header), col = { sheetId: sid, startColumnIndex: i, endColumnIndex: i + 1 };
    reqs.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: c.width, ...(c.hidden && { hiddenByUser: true }) }, fields: c.hidden ? 'pixelSize,hiddenByUser' : 'pixelSize' } });
    if (c.values?.length) reqs.push({ setDataValidation: { range: { ...col, startRowIndex: hr + 1 }, rule: {
      condition: { type: 'ONE_OF_LIST', values: c.values.slice(0, 500).map(v => ({ userEnteredValue: String(v) })) }, strict: false, showCustomUi: true } } });
    if (c.kind === 'date') {
      reqs.push({ setDataValidation: { range: { ...col, startRowIndex: hr + 1 }, rule: { condition: { type: 'DATE_IS_VALID' }, strict: false } } });
      reqs.push({ repeatCell: { range: { ...col, startRowIndex: hr + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } }, fields: 'userEnteredFormat.numberFormat' } });
    }
    if (c.kind === 'app') {
      reqs.push({ repeatCell: { range: { ...col, startRowIndex: hr + 1 }, cell: { userEnteredFormat: { backgroundColor: rgb('#F3F4F9') } }, fields: 'userEnteredFormat.backgroundColor' } });
      const description = `Jira360: ${c.header} is filled in by the app`;
      if (!tab.protected.includes(description)) reqs.push({ addProtectedRange: { protectedRange: { range: { ...col, startRowIndex: hr + 1 }, description, warningOnly: true } } });
    }
    if (c.note) reqs.push({ updateCells: { range: { sheetId: sid, startRowIndex: hr, endRowIndex: hr + 1, startColumnIndex: i, endColumnIndex: i + 1 }, rows: [{ values: [{ note: c.note }] }], fields: 'note' } });
  }
  await batchUpdate(id, reqs);
  return { tab: tab.title, added, url: meta.url, title: meta.title };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "Create a new sheet": made by the service account, set up, shared, linked, then filled by a sync
export async function createSheet({ title, shareWith, by }) {
  if (!EMAIL_RE.test(String(shareWith || ''))) throw badRequest('Type the Google email to share the new sheet with');
  const made = await locked(async () => {
    const layoutDef = await sheetLayout();
    const { id, url } = await createSpreadsheet(String(title || '').trim().slice(0, 100) || `Jira360 · ${JIRA_PROJECT_KEY} tasks`, layoutDef.tab, layoutDef.columns.length);
    await prepareSheet(id, layoutDef.tab, layoutDef);
    let shareError = '';
    try { await shareFile(id, shareWith); } catch (e) { shareError = e.message; }
    await saveSettings({ sheet: { sheetId: id, tab: layoutDef.tab } }, by);
    return { id, url, tab: layoutDef.tab, sharedWith: shareError ? '' : shareWith, shareError };
  });
  const sync = await pollSheet().catch(e => ({ error: e.message })); // fills it with the Jira360 tickets
  log('sheet', { created: made.id, by });
  return { ...made, sync };
}

// "Set up the linked sheet": headers, dropdowns and formats on the sheet in Settings, then a sync
export async function setupSheet() {
  if (!isSheetConfigured()) throw Object.assign(new Error('Link a sheet first: paste its address in Settings and save'), { status: 400 });
  const done = await locked(async () => prepareSheet(effective().sheet.sheetId, effective().sheet.tab, await sheetLayout()));
  if (done.tab !== effective().sheet.tab) await saveSettings({ sheet: { tab: done.tab } });
  const sync = await pollSheet().catch(e => ({ error: e.message }));
  return { ...done, sync };
}

// Everything the Settings preview shows; plan: also a dry run of the next sync
export async function sheetPreview({ plan = false } = {}) {
  const info = sheetInfo();
  if (!info.configured) return { ...info, serviceAccount: serviceAccountEmail() };
  const [meta, grid, extra] = await Promise.all([sheetMeta().catch(() => null), readSheet(), extraHeaderMap(normHeader)]);
  const h = grid.findIndex(r => r.some(c => String(c).trim()));
  const head = h < 0 ? [] : grid[h];
  const layoutDef = await sheetLayout().catch(() => ({ columns: [] }));
  const columns = head.map(x => {
    const header = String(x).trim(), f = header ? fieldOfHeader(normHeader(header), extra) : null;
    return { header, field: f, kind: !header ? 'empty' : !f ? 'unknown' : NOT_DATA.includes(f) ? 'app' : 'field' };
  }).filter(c => c.kind !== 'empty');
  const present = new Set(columns.map(c => c.field).filter(Boolean));
  const missing = layoutDef.columns.filter(c => { const f = fieldOfHeader(normHeader(c.header), extra); return f && !present.has(f) && c.header !== 'Edited at'; }).map(c => c.header);
  const at = new Map(head.map((x, i) => [fieldOfHeader(normHeader(String(x)), extra), i]));
  const rows = h < 0 ? [] : grid.slice(h + 1).map((cells, k) => ({ row: h + 2 + k, cells })).filter(r => r.cells.some(c => String(c).trim()));
  const show = columns.filter(c => c.kind === 'field' || ['jiraKey', 'syncStatus', 'lastSynced', 'taskId'].includes(c.field));
  const toText = (f, v) => (DATES.includes(f) ? norm(f, v) : String(v ?? ''));
  const out = {
    ...info, title: meta?.title || '', url: meta?.url || info.url, serviceAccount: serviceAccountEmail(),
    columns, missing, hasTitle: present.has('title'), total: rows.length, browse: browseUrl(''), syncMode: effective().sheet.syncMode,
    show: show.map(c => ({ header: c.header, field: c.field })),
    rows: rows.slice(0, 100).map(r => ({ row: r.row, values: show.map(c => toText(c.field, r.cells[at.get(c.field)])) })),
    lastPoll: lastPoll || await store.get('sheet:lastPoll').catch(() => null),
  };
  if (plan && out.hasTitle) out.plan = await locked(() => cycle(null, { dry: true })).catch(e => ({ error: e.message }));
  return out;
}
