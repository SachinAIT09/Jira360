// Google Sheet <-> Jira, with a person approving every change.
//
// Sheet -> Jira: each check (every SHEET_POLL_MINUTES, or "Check sheet now") compares every row with
// the values last synced for its task (kept in the store as sheet:base:<taskId>). A new or changed
// row becomes a change in the Inbox, checked against Jira; nothing is sent until it is approved.
// If Jira changed the same field since the last sync, the change shows a conflict and the person
// picks which value wins.
// After a decision the row gets its Jira key, "Sync status" and "Last synced" written back.
//
// Jira -> sheet: status, end date and assignee changes made in Jira are written into the row
// (and into the stored values, so they are not mistaken for edits in the sheet).

import crypto from 'node:crypto';
import { readSheet, writeCells, sheetConfigured, sheetInfo } from './google.js';
import { HEADER_TO_FIELD, normHeader } from './bulk.js';
import { checkTask, previewContext, normDate } from './check.js';
import { addToInbox, listInbox, replaceItem, withdraw, onDecision } from './inbox.js';
import { badRequest, list } from './jira.js';
import { store } from './store.js';
import { log, logError } from './log.js';
import { extraHeaderMap } from './fields.js';

export { sheetConfigured };

// Columns beyond the bulk-upload ones. The app fills these in (and adds them if missing).
const EXTRA_COLS = { comment: 'comment', comments: 'comment', update: 'comment', syncstatus: 'syncStatus', lastsynced: 'lastSynced' };
const APP_COLS = { taskId: 'Task ID', jiraKey: 'Jira Key', syncStatus: 'Sync status', lastSynced: 'Last synced' };
const NOT_DATA = ['taskId', 'jiraKey', 'syncStatus', 'lastSynced'];
const DATES = ['startDate', 'dueDate'];
const baseKey = taskId => `sheet:base:${taskId}`;
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// Cell value -> comparable value: dates as YYYY-MM-DD (the sheet sends day numbers), lists tidied
function norm(field, v) {
  v = String(v ?? '').trim();
  if (!v) return '';
  if (DATES.includes(field)) return normDate(v) || v;
  if (field === 'labels' || field === 'fixVersions') return list(v).join(', ');
  return v;
}
const sameValue = (field, a, b) => field === 'labels' || field === 'fixVersions'
  ? list(a).map(x => x.toLowerCase()).sort().join() === list(b).map(x => x.toLowerCase()).sort().join()
  : String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

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

function readRows(grid, lay) {
  const out = [];
  for (let i = lay.headerRow; i < grid.length; i++) {
    const cell = f => (lay.cols[f] ? grid[i][lay.cols[f] - 1] ?? '' : '');
    const values = {};
    for (const f of Object.keys(lay.cols)) if (!NOT_DATA.includes(f)) values[f] = norm(f, cell(f));
    const taskId = String(cell('taskId')).trim(), jiraKey = String(cell('jiraKey')).trim().toUpperCase();
    if (taskId || jiraKey || Object.values(values).some(Boolean)) out.push({ row: i + 1, taskId, jiraKey, values });
  }
  return out;
}

// One sheet job at a time: a check, a decision being written back, or a Jira update
let chain = Promise.resolve();
const locked = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

// Fields where Jira's current value can be compared with the sheet's (info.current names)
const CURRENT = { title: 'title', description: 'description', parentKey: 'parentKey', startDate: 'startDate', dueDate: 'dueDate',
  originalEstimate: 'originalEstimate', sprint: 'sprint', labels: 'labels', fixVersions: 'fixVersions', priority: 'priority', status: 'status' };
function findConflicts(changed, sheet, base, current) {
  const out = [];
  for (const f of changed) {
    if (!CURRENT[f]) continue;
    const jira = norm(f, current[CURRENT[f]]), was = base[f] || '', now = sheet[f] || '';
    if (!sameValue(f, jira, was) && !sameValue(f, jira, now)) out.push({ field: f, base: was, sheet: now, jira });
  }
  return out;
}

// ---------- Sheet -> Inbox ----------
let lastPoll = null;
export const sheetStatus = async () => ({ ...sheetInfo(), lastPoll: lastPoll || await store.get('sheet:lastPoll').catch(() => null) });

export const pollSheet = () => locked(async () => {
  if (!sheetConfigured) throw Object.assign(new Error('Google Sheet not set up (GOOGLE_SA_JSON and SHEET_ID)'), { status: 503 });
  const grid = await readSheet();
  const lay = layout(grid, await extraHeaderMap(normHeader));
  const writes = [];
  // Columns the app needs and the sheet lacks are added after the last header
  let next = lay.width + 1;
  for (const [f, header] of Object.entries(APP_COLS)) if (!lay.cols[f]) { lay.cols[f] = next++; writes.push({ row: lay.headerRow, col: lay.cols[f], value: header }); }
  const rows = readRows(grid, lay);
  const status = (r, text) => writes.push({ row: r.row, col: lay.cols.syncStatus, value: text });

  // Every row needs its own Task ID to be followed (even if rows are moved); new rows get one
  for (const r of rows) if (!r.taskId) { r.taskId = 'SH-' + crypto.randomBytes(4).toString('hex').toUpperCase(); writes.push({ row: r.row, col: lay.cols.taskId, value: r.taskId }); }
  const seen = new Map();
  for (const r of rows) { if (seen.has(r.taskId)) r.duplicateOf = seen.get(r.taskId); else seen.set(r.taskId, r.row); }

  const pending = new Map((await listInbox()).pending.filter(i => i.source === 'sheet').map(i => [i.task.taskId, i]));
  const ctx = previewContext();
  const summary = { rows: rows.length, queued: 0, updated: 0, unchanged: 0, withdrawn: 0, skipped: 0 };
  for (const r of rows) {
    if (r.duplicateOf) { status(r, `Task ID also on row ${r.duplicateOf}: give this row its own`); summary.skipped++; continue; }
    const base = await store.get(baseKey(r.taskId)).catch(() => null);
    const old = pending.get(r.taskId);
    const jiraKey = r.jiraKey || base?.jiraKey || '';
    const changed = Object.keys(r.values).filter(f => !sameValue(f, r.values[f], base?.values?.[f] || ''));
    if (base && !changed.length && (!r.jiraKey || r.jiraKey === base.jiraKey)) {
      if (old) { await withdraw(old.id, 'The sheet row was changed back'); status(r, 'Synced'); summary.withdrawn++; } else summary.unchanged++;
      continue;
    }
    if (!base && !r.values.title && !r.jiraKey) { summary.skipped++; continue; } // nothing to create a ticket from
    const hash = crypto.createHash('sha1').update(JSON.stringify([jiraKey, r.values])).digest('hex');
    if (old?.hash === hash) { summary.unchanged++; continue; }

    // A row that has a ticket sends only what changed; a row without one sends everything
    const hasTicket = !!jiraKey;
    const task = { taskId: r.taskId, ...(jiraKey && { jiraKey }) };
    const clear = [];
    for (const f of hasTicket && base ? changed : Object.keys(r.values)) {
      const v = r.values[f];
      if (f.startsWith('f:')) { if (v || hasTicket) (task.fields ||= {})[f.slice(2)] = v; } // '' empties it in Jira
      else if (v) task[f] = v;
      else if (hasTicket) clear.push(f === 'assigneeEmail' ? 'assigneeId' : f); // an emptied cell empties the field in Jira
    }
    if (clear.length) task.clear = clear;
    if (hasTicket) task.replaceLists = true; // a labels cell holds the whole list
    if (Object.keys(task).every(k => ['taskId', 'jiraKey', 'clear', 'replaceLists'].includes(k)) && !clear.length && !task.fields) {
      // e.g. only the comment cell was emptied: nothing to send, just remember the row as it is
      await store.set(baseKey(r.taskId), { values: r.values, jiraKey, at: new Date().toISOString() });
      if (old) await withdraw(old.id, 'Nothing left to send');
      summary.unchanged++;
      continue;
    }
    const check = await checkTask(task, ctx, { withCurrent: true });
    const conflicts = base && check.info.current ? findConflicts(changed, r.values, base.values, check.info.current) : [];
    const extra = { hash, sheetRow: r.row, rowValues: r.values, rowJiraKey: jiraKey, conflicts };
    if (old) { await replaceItem(old.id, { task, check, ...extra }); summary.updated++; }
    else { await addToInbox({ source: 'sheet', task, check, ...extra }); summary.queued++; }
    status(r, check.errors.length ? `Problems: ${check.errors.join('; ')}` : conflicts.length ? 'Waiting for approval (conflict with Jira)' : 'Waiting for approval');
  }
  await writeCells(writes);
  lastPoll = { at: new Date().toISOString(), ...summary };
  await store.set('sheet:lastPoll', lastPoll).catch(() => {});
  log('sheet', lastPoll);
  return lastPoll;
});

// ---------- Decisions -> the row ----------
async function findRow(taskId) {
  const grid = await readSheet();
  const lay = layout(grid);
  const r = readRows(grid, lay).find(x => x.taskId === taskId);
  return r ? { lay, r } : null;
}

onDecision(item => {
  if (item.source !== 'sheet' || item.status === 'withdrawn') return; // withdrawals come from a check that writes the row itself
  return locked(async () => {
    const base = await store.get(baseKey(item.task.taskId)).catch(() => null);
    const values = { ...item.rowValues };
    const fromJira = []; // conflicts settled in Jira's favour: the sheet gets Jira's value
    for (const f of item.keptJira || []) { const c = item.conflicts.find(x => x.field === f); if (c) { values[f] = c.jira; fromJira.push(c); } }
    const jiraKey = item.status === 'approved' ? item.result?.jiraKey || item.rowJiraKey : base?.jiraKey || item.rowJiraKey || '';
    // Rejected values count as seen too: they are not offered again unless the row changes again
    await store.set(baseKey(item.task.taskId), { values, jiraKey, at: new Date().toISOString() });
    const found = await findRow(item.task.taskId).catch(e => { logError('sheet', e); return null; });
    if (!found) return;
    const { lay, r } = found;
    const cells = [];
    const put = (f, value) => { if (lay.cols[f]) cells.push({ row: r.row, col: lay.cols[f], value }); };
    if (item.status === 'approved') {
      if (jiraKey) put('jiraKey', jiraKey);
      for (const c of fromJira) put(c.field, c.jira);
      put('syncStatus', fromJira.length ? `Synced (kept Jira's ${fromJira.map(c => c.field).join(', ')})` : 'Synced');
    } else put('syncStatus', `Rejected${item.reason ? ': ' + item.reason : ''}${item.decidedBy ? ` (${item.decidedBy})` : ''}`);
    put('lastSynced', stamp());
    await writeCells(cells);
  });
});

// ---------- Jira -> the row ----------
// changes: { status?, assignee?: { name } | null, dueDate? } from the Jira webhook
export const jiraChangedToSheet = (taskId, changes) => !sheetConfigured ? null : locked(async () => {
  const base = await store.get(baseKey(taskId)).catch(() => null);
  if (!base) return; // not a task from the sheet
  const found = await findRow(taskId);
  if (!found) return;
  const { lay, r } = found;
  const cells = [], values = { ...base.values };
  const put = (f, value) => {
    if (!lay.cols[f]) return;
    cells.push({ row: r.row, col: lay.cols[f], value });
    if (!NOT_DATA.includes(f)) values[f] = norm(f, value);
  };
  if ('status' in changes) put('status', changes.status || '');
  if ('dueDate' in changes) put('dueDate', changes.dueDate || '');
  if ('assignee' in changes) put('assigneeEmail', changes.assignee?.name || '');
  if (!cells.length) return;
  put('syncStatus', 'Updated from Jira');
  put('lastSynced', stamp());
  // Remember Jira's values as synced first, so the next check doesn't take them for sheet edits
  await store.set(baseKey(taskId), { ...base, values, at: new Date().toISOString() });
  await writeCells(cells);
  log('sheet', { fromJira: taskId, changes });
});
