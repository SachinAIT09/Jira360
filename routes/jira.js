// Optional reverse sync: register a Jira webhook (issue updated) pointing to
// https://<host>/jira/webhook?secret=<JIRA_WEBHOOK_SECRET>

import crypto from 'node:crypto';
import express from 'express';
import { JIRA_WEBHOOK_SECRET, PORTAL_CALLBACK_URL, PORTAL_SHARED_SECRET } from '../lib/config.js';
import { whoAmI } from '../lib/jira.js';

const router = express.Router();
export default router;

router.post('/jira/webhook', async (req, res) => {
  if (!PORTAL_CALLBACK_URL) return res.status(404).end();
  if (JIRA_WEBHOOK_SECRET && req.query.secret !== JIRA_WEBHOOK_SECRET) return res.status(401).end();
  try {
    const { issue, user, changelog } = req.body || {};
    const statusChange = changelog?.items?.find(i => i.field === 'status');
    const label = (issue?.fields?.labels || []).find(l => l.startsWith('portal-'));
    // ignore our own edits (loop guard), non-status changes and tickets the portal didn't create
    if (issue && statusChange && label && user?.accountId !== await whoAmI().catch(() => null)) {
      const body = JSON.stringify({ taskId: label.slice(7), jiraKey: issue.key, status: statusChange.toString });
      const sig = crypto.createHmac('sha256', PORTAL_SHARED_SECRET).update(body).digest('hex');
      await fetch(PORTAL_CALLBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jira-Signature': sig }, body });
    }
  } catch (e) { console.error('portal callback failed:', e.message); }
  res.status(204).end();
});
