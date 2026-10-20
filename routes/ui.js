// HTML form routes (page served by server.js locally, by Netlify when hosted). All need someone
// signed in (routes/auth.js), with the role each one names: viewer < editor < admin.

import express from 'express';
import { JIRA_ISSUE_TYPE, JIRA_PROJECT_KEY } from '../lib/config.js';
import { effective, settingsForPage, saveSettings } from '../lib/settings.js';
import { need, userOf } from '../lib/auth.js';
import { jira, lists, readIssue, browseUrl } from '../lib/jira.js';
import { findIssue } from '../lib/sync.js';
import { syncAndRecord, listActivity, taskActivity } from '../lib/activity.js';
import { checkTask, previewContext } from '../lib/check.js';
import { readBulkFile, mapLimit, CHECK_CHUNK } from '../lib/bulk.js';
import { listInbox, approve, reject } from '../lib/inbox.js';
import { pollSheet, syncFailed, sheetStatus, createSheet, setupSheet, sheetPreview } from '../lib/sheet.js';
import { templateXlsx } from '../lib/sheet-layout.js';
import { fieldsForPage, setFieldConfig } from '../lib/fields.js';
import { log, logError, fail, sendError } from '../lib/log.js';
import { aiStatus, testAi, draftTicket, rewriteTicket, similarTickets, suggestRowFixes, summarizeChanges, weeklyReport } from '../lib/ai.js';
import { dashboard } from '../lib/dashboard.js';
import { testChannel } from '../lib/alerts.js';
import { readSheet, sheetInfo } from '../lib/google.js';

const router = express.Router();
export default router;

const viewer = need('viewer'), editor = need('editor'), admin = need('admin');

// Everything the form's pickers offer, read from Jira. A list that fails comes back empty and is
// named in "failed", so the page can still be used for the rest.
router.get('/ui/options', viewer, async (_req, res) => {
  const p = JIRA_PROJECT_KEY, failed = [];
  const get = (name, promise, fallback) => promise.catch(e => { failed.push(name); logError('ui', e, { list: name }); return fallback; });
  const [sprints, versions, priorities, users, parents, statuses, labels] = await Promise.all([
    get('sprints', lists.sprints(p), []), get('versions', lists.versions(p), []), get('priorities', lists.priorities(), []),
    get('users', lists.users(p), []), get('parents', lists.parents(p), []), get('statuses', lists.statuses(p), []),
    get('labels', lists.labels(), []),
  ]);
  res.json({ project: p, issueType: JIRA_ISSUE_TYPE, sprints, versions, priorities, users, parents, statuses, labels, failed, ai: aiStatus() });
});

// Current Jira values for the form, keyed by the form's field names (polled by the page)
router.get('/ui/issue', viewer, async (req, res) => {
  const { jiraKey, taskId } = req.query;
  if (!jiraKey && !taskId) return fail(res, 400, 'invalid', 'Give a Jira key or task ID');
  try {
    const found = await findIssue({ jiraKey, taskId: taskId || '' });
    if (!found) return fail(res, 404, 'not_found', 'No ticket found', { notFound: true });
    const [issue, { transitions = [] }] = await Promise.all([
      readIssue(found.key, { recent: true }),
      jira('GET', `/rest/api/3/issue/${encodeURIComponent(found.key)}/transitions`).catch(() => ({})),
    ]);
    res.json({ ...issue, nextStatuses: [...new Set(transitions.map(t => t.to?.name).filter(Boolean))] });
  } catch (e) {
    sendError(res, e, 'ui', { jiraKey, taskId });
  }
});

// ---------- Preview before sending (single form and bulk upload) ----------
router.post('/ui/preview', viewer, async (req, res) => {
  res.json(await checkTask(req.body || {}, previewContext(), { withCurrent: true }));
});

// Bulk step 1: read the file and find duplicates inside it. No Jira calls, so it is quick.
router.post('/ui/bulk/parse', editor, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return fail(res, 400, 'invalid', 'No file received');
  try {
    res.json({ project: JIRA_PROJECT_KEY, checkChunk: CHECK_CHUNK, ...(await readBulkFile(buf)) });
  } catch (e) {
    sendError(res, e, 'bulk');
  }
});

// Bulk step 2: check a few rows against Jira. The page sends the file's rows in chunks so each
// request stays well inside Netlify's ~10 second limit.
router.post('/ui/bulk/check', editor, async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > CHECK_CHUNK)
    return fail(res, 400, 'invalid', `Send 1 to ${CHECK_CHUNK} rows at a time`);
  const ctx = previewContext();
  res.json({ rows: await mapLimit(rows, 5, async r => ({ row: r.row, ...(await checkTask(r.task || {}, ctx, { withCurrent: true })) })) });
});

// The page says which of its screens sent the task, for the logs
router.post('/ui/task', editor, async (req, res) => {
  const task = req.body || {};
  const source = req.get('X-Source') === 'bulk' ? 'bulk' : 'ui';
  if (!task.taskId) return fail(res, 400, 'invalid', 'Task ID is required');
  try {
    const result = await syncAndRecord(task, { source, by: userOf(req) });
    log(source, { ...result, by: userOf(req) });
    res.json({ ...result, url: browseUrl(result.jiraKey) });
  } catch (e) {
    sendError(res, e, source, { taskId: task.taskId });
  }
});

// ---------- Inbox: changes waiting for approval (portal now, Google Sheet later) ----------
const withUrl = item => item.result?.jiraKey ? { ...item, result: { ...item.result, url: browseUrl(item.result.jiraKey) } } : item;

router.get('/ui/inbox', viewer, async (_req, res) => {
  try {
    const { pending, decided } = await listInbox();
    res.json({ approvalMode: effective().portal.requireApproval, pending, decided: decided.map(withUrl), sheet: await sheetStatus() });
  } catch (e) {
    sendError(res, e, 'inbox');
  }
});

// Who decided: the page's name box (older pages sent it in the body)
const decidedBy = req => userOf(req) || String(req.body?.by || '').trim().slice(0, 80);

router.post('/ui/inbox/:id/approve', editor, async (req, res) => {
  try {
    const item = await approve(req.params.id, decidedBy(req), { keepJira: req.body?.keepJira });
    log('inbox', { approved: item.id, by: item.decidedBy, ...item.result });
    res.json(withUrl(item));
  } catch (e) {
    if (e.errors) return fail(res, 409, 'invalid', e.message, { errors: e.errors, item: e.item });
    if (e.status === 409) return fail(res, 409, 'conflict', e.message);
    sendError(res, e, 'inbox', { id: req.params.id });
  }
});

router.post('/ui/inbox/:id/reject', editor, async (req, res) => {
  try {
    const item = await reject(req.params.id, decidedBy(req), String(req.body?.reason || '').trim().slice(0, 500));
    log('inbox', { rejected: item.id, by: item.decidedBy, taskId: item.task.taskId });
    res.json(item);
  } catch (e) {
    if (e.status === 409) return fail(res, 409, 'conflict', e.message);
    sendError(res, e, 'inbox', { id: req.params.id });
  }
});

// ---------- Activity: history of every send to Jira ----------
const dayStart = v => (/^\d+$/.test(String(v || '')) ? Number(v) : 0); // the page sends local day bounds in ms

router.get('/ui/activity', viewer, async (req, res) => {
  const { q, source, result, from, to, before, limit } = req.query;
  try {
    res.json(await listActivity({ q, source, result, from: dayStart(from), to: dayStart(to), before, limit }));
  } catch (e) {
    sendError(res, e, 'activity');
  }
});

router.get('/ui/activity/task', viewer, async (req, res) => {
  const { taskId, jiraKey } = req.query;
  if (!taskId && !jiraKey) return fail(res, 400, 'invalid', 'Give a task ID or Jira key');
  try {
    res.json({ items: await taskActivity({ taskId, jiraKey }) });
  } catch (e) {
    sendError(res, e, 'activity');
  }
});

// ---------- AI suggestions (never sent to Jira from here: the page shows them, the person decides) ----------
function aiRoute(path, fn) {
  router.post(path, editor, async (req, res) => {
    try {
      res.json(await fn(req.body || {}));
    } catch (e) {
      if ([400, 422, 429, 503].includes(e.status)) return fail(res, e.status, e.status === 400 ? 'invalid' : 'ai_unavailable', e.message);
      sendError(res, e, 'ai');
    }
  });
}
aiRoute('/ui/ai/draft', b => draftTicket(b.text));
aiRoute('/ui/ai/rewrite', b => rewriteTicket(b));
aiRoute('/ui/ai/similar', b => similarTickets(b));
aiRoute('/ui/ai/fix-rows', b => suggestRowFixes(b.rows));
aiRoute('/ui/ai/summarize', async () => summarizeChanges((await listInbox()).pending));
aiRoute('/ui/ai/report', b => dashboard({ days: b.days, tz: b.tz }).then(weeklyReport));

// ---------- Dashboard: open tickets, hours logged, and what Jira360 sent, for 7 or 30 days ----------
router.get('/ui/dashboard', viewer, async (req, res) => {
  try { res.json(await dashboard({ days: req.query.days, tz: req.query.tz })); }
  catch (e) { sendError(res, e, 'dashboard'); }
});

// ---------- Google Sheet: check it for new / changed rows now (they go to the Inbox) ----------
router.post('/ui/sheet/check', editor, async (_req, res) => {
  try {
    res.json(await pollSheet());
  } catch (e) {
    if (e.status === 400 || e.status === 503) return fail(res, e.status, e.status === 400 ? 'invalid' : 'not_configured', e.message);
    logError('sheet', e);
    await syncFailed(e);
    fail(res, 502, 'sheet_error', e.message);
  }
});

// ---------- Fields: every field Jira has for the project, and which ones the form shows ----------
router.get('/ui/fields', viewer, async (_req, res) => {
  try {
    res.json(await fieldsForPage());
  } catch (e) {
    sendError(res, e, 'fields');
  }
});

// The shared setting (everyone sees it); people can also show / hide fields just for themselves in the page
router.post('/ui/fields/config', admin, async (req, res) => {
  try {
    const saved = await setFieldConfig(req.body || {}, userOf(req));
    log('fields', { config: saved });
    res.json(saved);
  } catch (e) {
    sendError(res, e, 'fields');
  }
});

// ---------- Settings (keys and switches): admins only ----------
router.get('/ui/settings', admin, (_req, res) => res.json(settingsForPage()));

router.post('/ui/settings', admin, async (req, res) => {
  try {
    const out = await saveSettings(req.body || {}, userOf(req));
    log('settings', { savedBy: userOf(req), changed: Object.keys(req.body || {}) }); // never the values
    res.json(out);
  } catch (e) {
    if (e.status === 400) return fail(res, 400, 'invalid', e.message);
    sendError(res, e, 'settings');
  }
});

// "Test" buttons: check what is saved, without changing anything
router.post('/ui/settings/test-ai', admin, async (_req, res) => {
  try { res.json(await testAi()); }
  catch (e) { fail(res, e.status || 502, 'ai_test_failed', e.message); }
});
router.post('/ui/settings/test-alert', admin, async (req, res) => {
  try { res.json(await testChannel(String(req.body?.id || ''))); }
  catch (e) { fail(res, e.status === 400 ? 400 : 502, 'alert_test_failed', e.message); }
});
router.post('/ui/settings/test-sheet', admin, async (_req, res) => {
  try {
    const grid = await readSheet();
    const header = grid.find(r => r.some(c => String(c).trim())) || [];
    res.json({ ok: true, ...sheetInfo(), rows: Math.max(0, grid.length - 1), columns: header.filter(Boolean) });
  } catch (e) {
    fail(res, e.status === 503 ? 503 : 502, 'sheet_test_failed', e.message);
  }
});

// ---------- Making the Google Sheet, and the Settings preview (admin) ----------
const sheetFail = (res, e) => {
  if ([400, 409, 503].includes(e.status)) return fail(res, e.status, e.code || (e.status === 409 ? 'no_drive_storage' : e.status === 400 ? 'invalid' : 'not_configured'), e.message);
  logError('sheet', e);
  fail(res, 502, 'sheet_error', e.message);
};
router.post('/ui/sheet/create', admin, async (req, res) => {
  try { res.json(await createSheet({ title: req.body?.title, shareWith: String(req.body?.shareWith || '').trim(), by: userOf(req) })); }
  catch (e) { sheetFail(res, e); }
});
router.post('/ui/sheet/setup', admin, async (_req, res) => {
  try { res.json(await setupSheet()); } catch (e) { sheetFail(res, e); }
});
router.get('/ui/sheet/preview', admin, async (req, res) => {
  try { res.json(await sheetPreview({ plan: req.query.plan === '1' })); } catch (e) { sheetFail(res, e); }
});
// The layout as an .xlsx, with Jira's dropdowns (File -> Import in Google Sheets)
router.get('/ui/sheet/template.xlsx', viewer, async (_req, res) => {
  try {
    const buf = await templateXlsx();
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="jira360-sheet-template.xlsx"' });
    res.send(buf);
  } catch (e) { sendError(res, e, 'sheet'); }
});
