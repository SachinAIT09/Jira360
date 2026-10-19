// HTML form routes (page served by server.js locally, by Netlify when hosted). All need the passcode.

import crypto from 'node:crypto';
import express from 'express';
import { BASE, JIRA_ISSUE_TYPE, JIRA_PROJECT_KEY, PORTAL_REQUIRE_APPROVAL, UI_PASSCODE } from '../lib/config.js';
import { jira, lists, adfToText, customFieldIds } from '../lib/jira.js';
import { findIssue, syncTaskQueued } from '../lib/sync.js';
import { checkTask, previewContext } from '../lib/check.js';
import { readBulkFile, mapLimit, CHECK_CHUNK } from '../lib/bulk.js';
import { listInbox, approve, reject } from '../lib/inbox.js';
import { log, logError, fail, sendError } from '../lib/log.js';

const router = express.Router();
export default router;

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
  res.json({ project: p, issueType: JIRA_ISSUE_TYPE, sprints, versions, priorities, users, parents, statuses, labels, failed });
});

// Current Jira values for the form, keyed by the form's field names (polled by the page)
router.get('/ui/issue', uiAuth, async (req, res) => {
  const { jiraKey, taskId } = req.query;
  if (!jiraKey && !taskId) return fail(res, 400, 'invalid', 'Give a Jira key or task ID');
  try {
    const found = await findIssue({ jiraKey, taskId: taskId || '' });
    if (!found) return fail(res, 404, 'not_found', 'No ticket found', { notFound: true });
    const ids = await customFieldIds();
    const fieldList = ['summary', 'description', 'assignee', 'parent', 'duedate', 'priority', 'status',
      'labels', 'fixVersions', 'timetracking', 'updated', ids.sprint, ids.startDate].filter(Boolean).join(',');
    const [{ key, fields: f }, { transitions = [] }] = await Promise.all([
      jira('GET', `/rest/api/3/issue/${encodeURIComponent(found.key)}?fields=${fieldList}`),
      jira('GET', `/rest/api/3/issue/${encodeURIComponent(found.key)}/transitions`).catch(() => ({})),
    ]);
    const sprints = (ids.sprint && f[ids.sprint]) || [];
    const sprint = sprints.find(s => s.state === 'active') || sprints.find(s => s.state === 'future') || sprints.at(-1);
    res.json({
      jiraKey: key,
      url: `${BASE}/browse/${key}`,
      updated: f.updated,
      statusName: f.status?.name || '',
      nextStatuses: [...new Set(transitions.map(t => t.to?.name).filter(Boolean))],
      assignee: f.assignee ? { id: f.assignee.accountId, name: f.assignee.displayName } : null,
      parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
      sprintState: sprint?.state || '',
      values: {
        title: f.summary || '',
        description: adfToText(f.description).trim(),
        assigneeId: f.assignee?.accountId || '',
        parentKey: f.parent?.key || '',
        startDate: (ids.startDate && f[ids.startDate]) || '',
        dueDate: f.duedate || '',
        originalEstimate: f.timetracking?.originalEstimate || '',
        sprint: sprint?.name || '',
        labels: (f.labels || []).filter(l => !l.startsWith('portal-')).join(', '),
        fixVersions: (f.fixVersions || []).map(v => v.name).join(', '),
        priority: f.priority?.name || '',
        status: f.status?.name || '',
      },
    });
  } catch (e) {
    sendError(res, e, 'ui', { jiraKey, taskId });
  }
});

// ---------- Preview before sending (single form and bulk upload) ----------
router.post('/ui/preview', uiAuth, async (req, res) => {
  res.json(await checkTask(req.body || {}, previewContext()));
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
  res.json({ rows: await mapLimit(rows, 5, async r => ({ row: r.row, ...(await checkTask(r.task || {}, ctx)) })) });
});

// The page says which of its screens sent the task, for the logs
router.post('/ui/task', uiAuth, async (req, res) => {
  const task = req.body || {};
  const source = req.get('X-Source') === 'bulk' ? 'bulk' : 'ui';
  if (!task.taskId) return fail(res, 400, 'invalid', 'Task ID is required');
  try {
    const result = await syncTaskQueued(task);
    log(source, result);
    res.json({ ...result, url: `${BASE}/browse/${result.jiraKey}` });
  } catch (e) {
    sendError(res, e, source, { taskId: task.taskId });
  }
});

// ---------- Inbox: changes waiting for approval (portal now, Google Sheet later) ----------
const withUrl = item => item.result?.jiraKey ? { ...item, result: { ...item.result, url: `${BASE}/browse/${item.result.jiraKey}` } } : item;

router.get('/ui/inbox', uiAuth, async (_req, res) => {
  try {
    const { pending, decided } = await listInbox();
    res.json({ approvalMode: PORTAL_REQUIRE_APPROVAL, pending, decided: decided.map(withUrl) });
  } catch (e) {
    sendError(res, e, 'inbox');
  }
});

// Who decided, as typed on the page (the passcode is shared, so this is a name, not a login)
const decidedBy = req => String(req.body?.by || '').trim().slice(0, 80);

router.post('/ui/inbox/:id/approve', uiAuth, async (req, res) => {
  try {
    const item = await approve(req.params.id, decidedBy(req));
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
