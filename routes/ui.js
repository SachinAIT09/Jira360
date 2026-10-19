// HTML form routes (page served by server.js locally, by Netlify when hosted). All need the passcode.

import crypto from 'node:crypto';
import express from 'express';
import { JIRA_ISSUE_TYPE, JIRA_PROJECT_KEY, UI_PASSCODE } from '../lib/config.js';
import { effective, settingsForPage, saveSettings, adminPasscode } from '../lib/settings.js';
import { jira, lists, readIssue, browseUrl } from '../lib/jira.js';
import { findIssue } from '../lib/sync.js';
import { syncAndRecord, listActivity, taskActivity } from '../lib/activity.js';
import { checkTask, previewContext } from '../lib/check.js';
import { readBulkFile, mapLimit, CHECK_CHUNK } from '../lib/bulk.js';
import { listInbox, approve, reject } from '../lib/inbox.js';
import { pollSheet, sheetStatus } from '../lib/sheet.js';
import { fieldsForPage, setFieldConfig } from '../lib/fields.js';
import { log, logError, fail, sendError } from '../lib/log.js';
import { aiStatus, testAi, draftTicket, rewriteTicket, similarTickets, suggestRowFixes, summarizeChanges } from '../lib/ai.js';
import { readSheet, sheetInfo } from '../lib/google.js';

const router = express.Router();
export default router;

// Who is using the page, as typed in its "Your name" box (the passcode is shared, so this is a
// name for the history, not a login). Sent URI-encoded so any language works in a header.
function userOf(req) {
  try { return decodeURIComponent(req.get('X-User-Name') || '').trim().slice(0, 80); } catch { return ''; }
}

function uiAuth(req, res, next) {
  if (!UI_PASSCODE) return fail(res, 503, 'not_configured', 'Form disabled: set UI_PASSCODE on the server');
  const given = req.get('X-UI-Passcode') || '';
  if (given.length !== UI_PASSCODE.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(UI_PASSCODE)))
    return fail(res, 401, 'unauthorized', 'Wrong passcode');
  next();
}

// Everything the form's pickers offer, read from Jira. A list that fails comes back empty and is
// named in "failed", so the page can still be used for the rest.
router.get('/ui/options', uiAuth, async (_req, res) => {
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
router.get('/ui/issue', uiAuth, async (req, res) => {
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
router.post('/ui/preview', uiAuth, async (req, res) => {
  res.json(await checkTask(req.body || {}, previewContext(), { withCurrent: true }));
});

// Bulk step 1: read the file and find duplicates inside it. No Jira calls, so it is quick.
router.post('/ui/bulk/parse', uiAuth, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
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
router.post('/ui/bulk/check', uiAuth, async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > CHECK_CHUNK)
    return fail(res, 400, 'invalid', `Send 1 to ${CHECK_CHUNK} rows at a time`);
  const ctx = previewContext();
  res.json({ rows: await mapLimit(rows, 5, async r => ({ row: r.row, ...(await checkTask(r.task || {}, ctx, { withCurrent: true })) })) });
});

// The page says which of its screens sent the task, for the logs
router.post('/ui/task', uiAuth, async (req, res) => {
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

router.get('/ui/inbox', uiAuth, async (_req, res) => {
  try {
    const { pending, decided } = await listInbox();
    res.json({ approvalMode: effective().portal.requireApproval, pending, decided: decided.map(withUrl), sheet: await sheetStatus() });
  } catch (e) {
    sendError(res, e, 'inbox');
  }
});

// Who decided: the page's name box (older pages sent it in the body)
const decidedBy = req => userOf(req) || String(req.body?.by || '').trim().slice(0, 80);

router.post('/ui/inbox/:id/approve', uiAuth, async (req, res) => {
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

router.post('/ui/inbox/:id/reject', uiAuth, async (req, res) => {
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

router.get('/ui/activity', uiAuth, async (req, res) => {
  const { q, source, result, from, to, before, limit } = req.query;
  try {
    res.json(await listActivity({ q, source, result, from: dayStart(from), to: dayStart(to), before, limit }));
  } catch (e) {
    sendError(res, e, 'activity');
  }
});

router.get('/ui/activity/task', uiAuth, async (req, res) => {
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
  router.post(path, uiAuth, async (req, res) => {
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

// ---------- Google Sheet: check it for new / changed rows now (they go to the Inbox) ----------
router.post('/ui/sheet/check', uiAuth, async (_req, res) => {
  try {
    res.json(await pollSheet());
  } catch (e) {
    if (e.status === 400 || e.status === 503) return fail(res, e.status, e.status === 400 ? 'invalid' : 'not_configured', e.message);
    logError('sheet', e);
    fail(res, 502, 'sheet_error', e.message);
  }
});

// ---------- Fields: every field Jira has for the project, and which ones the form shows ----------
router.get('/ui/fields', uiAuth, async (_req, res) => {
  try {
    res.json(await fieldsForPage());
  } catch (e) {
    sendError(res, e, 'fields');
  }
});

// The shared setting (everyone sees it); people can also show / hide fields just for themselves in the page
router.post('/ui/fields/config', uiAuth, async (req, res) => {
  try {
    const saved = await setFieldConfig(req.body || {}, userOf(req));
    log('fields', { config: saved });
    res.json(saved);
  } catch (e) {
    sendError(res, e, 'fields');
  }
});

// ---------- Settings (keys and switches): admin passcode only ----------
// Wrong guesses are slowed down, and an address that keeps guessing is locked out for 10 minutes.
const adminFails = new Map(); // ip -> { n, until }
async function adminAuth(req, res, next) {
  const admin = adminPasscode();
  if (!admin) return fail(res, 503, 'not_configured', 'Settings are locked: set ADMIN_PASSCODE in .env (on the server) to use them');
  const ip = req.ip || 'x', f = adminFails.get(ip);
  if (f?.until > Date.now()) return fail(res, 429, 'locked', 'Too many wrong admin passcodes; try again in 10 minutes');
  const given = req.get('X-Admin-Passcode') || '';
  if (given.length !== admin.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(admin))) {
    const n = (f?.n || 0) + 1;
    adminFails.set(ip, { n, until: n >= 10 ? Date.now() + 600000 : 0 });
    await new Promise(r => setTimeout(r, 600));
    log('settings', { wrongAdminPasscode: ip, attempts: n });
    return fail(res, 401, 'unauthorized', 'Wrong admin passcode');
  }
  adminFails.delete(ip);
  next();
}

router.get('/ui/settings', uiAuth, adminAuth, (_req, res) => res.json(settingsForPage()));

router.post('/ui/settings', uiAuth, adminAuth, async (req, res) => {
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
router.post('/ui/settings/test-ai', uiAuth, adminAuth, async (_req, res) => {
  try { res.json(await testAi()); }
  catch (e) { fail(res, e.status || 502, 'ai_test_failed', e.message); }
});
router.post('/ui/settings/test-sheet', uiAuth, adminAuth, async (_req, res) => {
  try {
    const grid = await readSheet();
    const header = grid.find(r => r.some(c => String(c).trim())) || [];
    res.json({ ok: true, ...sheetInfo(), rows: Math.max(0, grid.length - 1), columns: header.filter(Boolean) });
  } catch (e) {
    fail(res, e.status === 503 ? 503 : 502, 'sheet_test_failed', e.message);
  }
});
