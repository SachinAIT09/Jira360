// Optional reverse sync: Jira changes on portal tickets are sent back to PORTAL_CALLBACK_URL, and
// status / end date / assignee changes are written into the Google Sheet row (when the sheet is set up).
// In Jira, add a webhook for "Issue updated" and "Comment created" pointing to
//   https://<host>/jira/webhook?secret=<JIRA_WEBHOOK_SECRET>
//
// What the portal receives (signed with X-Jira-Signature = HMAC-SHA256 of the body):
//   { taskId, jiraKey, event: "updated", status?, changes: { status?, assignee?, dueDate? } }
//   { taskId, jiraKey, event: "commented", comment: { id, author, body, created } }
// "status" stays at the top level too, as before, for portals built against the first version.

import crypto from 'node:crypto';
import express from 'express';
import { JIRA_WEBHOOK_SECRET, PORTAL_CALLBACK_URL, PORTAL_SHARED_SECRET } from '../lib/config.js';
import { jira, whoAmI, adfToText } from '../lib/jira.js';
import { log, logError } from '../lib/log.js';
import { sheetConfigured, jiraChangedToSheet } from '../lib/sheet.js';

const router = express.Router();
export default router;

// The portal-<taskId> label links a ticket to its portal task. Comment events don't always
// carry the labels, so they are read from Jira then.
async function portalTaskId(issue) {
  let labels = issue.fields?.labels;
  if (!labels) labels = (await jira('GET', `/rest/api/3/issue/${encodeURIComponent(issue.key)}?fields=labels`)).fields.labels || [];
  const label = labels.find(l => l.startsWith('portal-'));
  return label ? label.slice('portal-'.length) : null;
}

// Changelog items -> the fields the portal follows
function followedChanges(items = []) {
  const changes = {};
  for (const i of items) {
    if (i.field === 'status') changes.status = i.toString;
    else if (i.field === 'assignee') changes.assignee = i.to ? { id: i.to, name: i.toString || '' } : null;
    else if (i.field === 'duedate') changes.dueDate = i.to ? String(i.to).slice(0, 10) : null;
  }
  return changes;
}

async function toPortal(payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', PORTAL_SHARED_SECRET).update(body).digest('hex');
  const res = await fetch(PORTAL_CALLBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jira-Signature': sig }, body });
  if (!res.ok) throw new Error(`portal replied ${res.status}`);
}

router.post('/jira/webhook', async (req, res) => {
  if (!PORTAL_CALLBACK_URL && !sheetConfigured) return res.status(404).end();
  if (JIRA_WEBHOOK_SECRET && req.query.secret !== JIRA_WEBHOOK_SECRET) return res.status(401).end();
  const { webhookEvent, issue, user, changelog, comment } = req.body || {};
  try {
    if (!issue?.key) return;
    const self = await whoAmI().catch(() => null);
    let payload = null;
    if (comment && /comment_created/.test(webhookEvent || '')) {
      // our own comments came from the portal in the first place (loop guard)
      if (comment.author?.accountId === self) return;
      payload = { event: 'commented', comment: {
        id: comment.id, author: comment.author?.displayName || '',
        body: (typeof comment.body === 'string' ? comment.body : adfToText(comment.body)).trim(), created: comment.created,
      } };
    } else {
      const changes = followedChanges(changelog?.items);
      if (!Object.keys(changes).length || user?.accountId === self) return; // nothing followed, or our own edit
      payload = { event: 'updated', ...(changes.status && { status: changes.status }), changes };
    }
    const taskId = await portalTaskId(issue);
    if (!taskId) return; // not a ticket the portal created
    if (PORTAL_CALLBACK_URL) await toPortal({ taskId, jiraKey: issue.key, ...payload });
    if (payload.changes) await jiraChangedToSheet(taskId, payload.changes);
    log('jira-webhook', { taskId, jiraKey: issue.key, event: payload.event, ...(payload.changes && { changes: payload.changes }) });
  } catch (e) {
    logError('jira-webhook', e, { jiraKey: issue?.key });
  } finally {
    res.status(204).end();
  }
});
