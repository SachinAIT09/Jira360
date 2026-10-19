// The portal calls this every time a task is posted/updated (HMAC-signed).

import crypto from 'node:crypto';
import express from 'express';
import { PORTAL_SHARED_SECRET } from '../lib/config.js';
import { syncTaskQueued } from '../lib/sync.js';
import { store } from '../lib/store.js';

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

router.post('/portal/task', async (req, res) => {
  if (!validSignature(req)) return res.status(401).json({ error: 'bad signature' });
  const task = req.body || {};
  if (!task.taskId) return res.status(400).json({ error: 'taskId is required' });

  const eventId = req.get('X-Event-Id');
  const prior = await priorResult(eventId);
  if (prior) return res.json({ ...prior, duplicate: true });

  try {
    const result = await syncTaskQueued(task);
    await remember(eventId, result);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    res.json(result);
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: e.message });
  }
});
