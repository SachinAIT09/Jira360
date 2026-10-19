// Changes waiting for someone to approve them before they reach Jira (from the portal now,
// from the Google Sheet later). Each one is kept in the store as inbox:<id>; ids sort by time.
//   status: pending -> approved | rejected   (approved items keep the Jira result)

import crypto from 'node:crypto';
import { store } from './store.js';
import { checkTask, previewContext } from './check.js';
import { syncTaskQueued } from './sync.js';
import { badRequest } from './jira.js';

const KEY = id => `inbox:${id}`;
const newId = () => Date.now().toString(36).padStart(9, '0') + '-' + crypto.randomBytes(3).toString('hex');
const SHOW_DECIDED = 30; // how many approved / rejected items the page lists below the pending ones

export async function addToInbox({ source, task, check, eventId }) {
  const item = { id: newId(), source, status: 'pending', receivedAt: new Date().toISOString(), eventId: eventId || null, task, check };
  await store.set(KEY(item.id), item);
  return item;
}

export const getItem = id => store.get(KEY(id));

// Pending items oldest first (approve in the order they came in), then the latest decided ones
export async function listInbox() {
  const ids = (await store.list('inbox:')).map(k => k.slice('inbox:'.length)).sort();
  const items = (await Promise.all(ids.map(getItem))).filter(Boolean);
  const pending = items.filter(i => i.status === 'pending');
  const decided = items.filter(i => i.status !== 'pending').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, SHOW_DECIDED);
  return { pending, decided };
}

// One approval or rejection at a time per item on this server, so a double click sends once
const busy = new Set();
async function decide(id, fn) {
  if (busy.has(id)) throw Object.assign(new Error('This change is already being handled'), { status: 409 });
  busy.add(id);
  try {
    const item = await getItem(id);
    if (!item) throw Object.assign(new Error('No such change in the inbox'), { status: 404 });
    if (item.status !== 'pending') throw Object.assign(new Error(`Already ${item.status}`), { status: 409 });
    return await fn(item);
  } finally { busy.delete(id); }
}

// Checks the change again (Jira may have changed since it arrived), then sends it.
// With errors it stays pending and the fresh check is returned instead.
export const approve = (id, by) => decide(id, async item => {
  const check = await checkTask(item.task, previewContext(item.task.projectKey || undefined));
  if (check.errors.length) {
    await store.set(KEY(id), { ...item, check });
    throw Object.assign(badRequest('This change has problems now; fix it at the source and send it again, or reject it'), { errors: check.errors, item: { ...item, check } });
  }
  const result = await syncTaskQueued(check.task);
  const done = { ...item, check, status: 'approved', decidedAt: new Date().toISOString(), decidedBy: by || '', result };
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
