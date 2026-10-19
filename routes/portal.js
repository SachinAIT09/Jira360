// The portal calls this every time a task is posted/updated (HMAC-signed).
// Each task is checked like the form's preview first: a task with problems is refused with the list
// of errors and nothing reaches Jira. With PORTAL_REQUIRE_APPROVAL on, a good task waits in the
// page's Inbox (reply 202) instead of being sent.

import crypto from 'node:crypto';
import express from 'express';
import { PORTAL_SHARED_SECRET } from '../lib/config.js';
import { effective } from '../lib/settings.js';
import { syncAndRecord, record } from '../lib/activity.js';
import { checkTask, previewContext } from '../lib/check.js';
import { addToInbox } from '../lib/inbox.js';
import { store } from '../lib/store.js';
import { log, fail, sendError } from '../lib/log.js';

const router = express.Router();
export default router;

function validSignature(req) {
  const sig = req.get('X-Portal-Signature') || '';
  const expected = crypto.createHmac('sha256', PORTAL_SHARED_SECRET).update(req.rawBody || '').digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------- Idempotency: the result of each X-Event-Id is kept in the store, so a repeated
// event is answered from there (also after a restart or on another Netlify instance) ----------
const priorResult = eventId => eventId ? store.get(`event:${eventId}`).catch(() => null) : null;
const remember = (eventId, result) => eventId && store.set(`event:${eventId}`, result)
  .catch(e => console.error('store: could not save event result:', e.message));

// Same-title tickets are allowed (the portal decides), but the portal is told about them
const duplicateWarnings = info => (info.duplicates || []).map(d => `Possible duplicate: ${d.key} (${d.status}) has the same title`);

router.post('/portal/task', async (req, res) => {
  if (!validSignature(req)) return fail(res, 401, 'bad_signature', 'bad signature');
  const input = req.body || {};
  if (!input.taskId) return fail(res, 400, 'invalid', 'taskId is required', { errors: ['taskId is required'] });

  const eventId = req.get('X-Event-Id');
  const prior = await priorResult(eventId);
  if (prior) return res.json({ ...prior, duplicate: true });

  try {
    const check = await checkTask(input, previewContext(input.projectKey || undefined), { withCurrent: true });
    const warnings = [...check.warnings, ...duplicateWarnings(check.info)];
    if (check.errors.length) {
      log('portal', { taskId: input.taskId, eventId, refused: check.errors });
      await record({ source: 'portal', by: '', taskId: String(input.taskId), jiraKey: String(input.jiraKey || '').toUpperCase(),
        title: input.title || '', task: input, ok: false, refused: true, error: 'Refused: ' + check.errors.join('; ') });
      // Not remembered: the portal can fix the task and send the same event again
      return fail(res, 400, 'invalid', 'The task has problems; nothing was sent to Jira', { errors: check.errors, warnings });
    }

    if (effective().portal.requireApproval) { // Settings tab, or PORTAL_REQUIRE_APPROVAL
      const item = await addToInbox({ source: 'portal', task: input, check, eventId });
      const queued = { taskId: input.taskId, queued: true, inboxId: item.id, action: check.info.action, jiraKey: check.info.existingKey || undefined };
      await remember(eventId, queued);
      log('portal', { ...queued, eventId });
      return res.status(202).json({ ...queued, ...(warnings.length && { warnings }) });
    }

    const result = await syncAndRecord(check.task, { source: 'portal' });
    await remember(eventId, result);
    log('portal', { ...result, eventId });
    res.json({ ...result, ...(warnings.length && { warnings }) });
  } catch (e) {
    sendError(res, e, 'portal', { taskId: input.taskId, eventId });
  }
});
