// Alerts: tells people when something needs them, on the channels set in Settings → Alerts.
//   send_failed        a send to Jira failed (form, bulk, portal, Google Sheet, Inbox approval)
//   portal_refused     the portal sent a task with problems; nothing reached Jira
//   sheet_sync_failed  the Google Sheet sync couldn't run
//   inbox_waiting      a change is waiting for approval in the Inbox
//   daily_digest       once a day: yesterday's sends, failures, the Inbox and overdue tickets
// Channels: Slack and Teams incoming webhooks, any webhook (JSON), or email (SMTP, needs the
// nodemailer package). Sending never fails what triggered it: problems are only logged.
// The same alert is sent at most once per 15 minutes, and at most 30 alerts go out per hour.

import crypto from 'node:crypto';
import { effective, refreshSettings } from './settings.js';
import { store } from './store.js';
import { log, logError } from './log.js';
import { onFailed } from './activity.js';
import { onAdded } from './inbox.js';
import { onSyncFailed } from './sheet.js';

export const EVENT_NAMES = {
  send_failed: 'Send to Jira failed', portal_refused: 'Portal task refused', sheet_sync_failed: 'Google Sheet sync failed',
  inbox_waiting: 'Waiting for approval', daily_digest: 'Daily summary', test: 'Test',
};
const SAME_ALERT_MS = 15 * 60000, WINDOW_MS = 3600000, MAX_PER_WINDOW = 30, TIMEOUT_MS = 5000, HOOK_WAIT_MS = 1500;
// What triggered an alert waits for it at most 1.5 s (the alert carries on after that)
const briefly = p => Promise.race([p, new Promise(r => setTimeout(r, HOOK_WAIT_MS))]);

// ---------- Senders: one message { title, text, items[], url } in each channel's format ----------
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

export const formats = {
  slack: m => ({
    text: `${m.title}: ${m.text}`, // the notification preview
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${m.title}*\n${m.text}` + (m.items?.length ? '\n' + m.items.map(i => `• ${i}`).join('\n') : '') } },
      ...(m.url ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<${m.url}|Open Jira360>` }] }] : []),
    ],
  }),
  // Adaptive card: what Teams Workflows webhooks (and the older connectors) accept
  teams: m => ({
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
      body: [
        { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
        { type: 'TextBlock', text: m.text, wrap: true },
        ...(m.items?.length ? [{ type: 'TextBlock', text: m.items.map(i => `- ${i}`).join('\n'), wrap: true }] : []),
      ],
      ...(m.url && { actions: [{ type: 'Action.OpenUrl', title: 'Open Jira360', url: m.url }] }),
    } }],
  }),
  webhook: m => ({ event: m.event, title: m.title, text: m.text, items: m.items || [], url: m.url || '', at: new Date().toISOString() }),
};

let mailer = null;
async function sendEmail(to, m) {
  const smtp = effective().alerts.smtp;
  if (!smtp.host || !smtp.from) throw new Error('Email alerts need the SMTP server and "From" address in Settings → Alerts');
  if (!mailer) {
    // By name in a variable: the Netlify bundler then doesn't need the package unless email is used
    const pkg = 'nodemailer';
    try { mailer = (await import(pkg)).default; }
    catch { throw new Error('Email alerts need the nodemailer package: run npm install nodemailer'); }
  }
  const t = mailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.port === 465, ...(smtp.user && { auth: { user: smtp.user, pass: smtp.pass } }),
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS * 2 });
  const lines = [m.text, ...(m.items || []).map(i => `- ${i}`), ...(m.url ? ['', `Open Jira360: ${m.url}`] : [])];
  await t.sendMail({ from: smtp.from, to, subject: `[Jira360] ${m.title}`, text: lines.join('\n') });
}

export async function sendTo(channel, m) {
  if (channel.type === 'email') return sendEmail(channel.target, m);
  const format = formats[channel.type];
  if (!format) throw new Error(`Unknown channel type ${channel.type}`);
  await post(channel.target, format(m));
}

// ---------- Deciding what goes out ----------
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// true when this alert may go now (not the same one within 15 minutes, not over the hourly limit)
async function allowed(event, dedupeKey, now = Date.now()) {
  const key = `alert:recent:${hash(dedupeKey)}`;
  const last = await store.get(key).catch(() => null);
  if (last && now - last < SAME_ALERT_MS) return false;
  const wkey = `alert:window:${event}`; // each event has its own budget, so a burst of one can't hide another
  const w = (await store.get(wkey).catch(() => null)) || { start: now, n: 0 };
  if (now - w.start > WINDOW_MS) { w.start = now; w.n = 0; }
  if (w.n >= MAX_PER_WINDOW) { log('alerts', { dropped: dedupeKey, reason: 'more than 30 alerts this hour' }); return false; }
  w.n++;
  await Promise.all([store.set(key, now), store.set(wkey, w)]).catch(() => {});
  return true;
}

// Sends an alert to every switched-on channel that wants this event. Never throws.
export async function notify(event, msg, { dedupe = msg.title + '|' + msg.text } = {}) {
  try {
    await refreshSettings();
    const a = effective().alerts;
    const channels = a.channels.filter(c => c.enabled && c.events.includes(event));
    if (!channels.length || !(await allowed(event, event + '|' + dedupe))) return;
    const m = { ...msg, event, url: msg.url || a.appUrl || '' };
    const results = await Promise.allSettled(channels.map(c => sendTo(c, m)));
    results.forEach((r, i) => { if (r.status === 'rejected') logError('alerts', r.reason, { channel: channels[i].name, event }); });
    log('alerts', { event, sent: results.filter(r => r.status === 'fulfilled').length, of: channels.length });
  } catch (e) {
    logError('alerts', e, { event });
  }
}

// ---------- What triggers them ----------
const SOURCES = { ui: 'the form', bulk: 'a bulk upload', portal: 'the portal', sheet: 'the Google Sheet', jira: 'Jira' };
const ticket = e => [e.jiraKey, e.taskId && e.taskId !== e.jiraKey ? e.taskId : '', e.title ? `"${String(e.title).slice(0, 80)}"` : ''].filter(Boolean).join(' ');

onFailed(e => briefly(e.refused
  ? notify('portal_refused', { title: EVENT_NAMES.portal_refused, text: `${ticket(e) || 'A task'} from the portal was refused: nothing reached Jira.`, items: [String(e.error || '').slice(0, 300)] },
    { dedupe: `${e.taskId}|${e.error}` })
  : notify('send_failed', { title: EVENT_NAMES.send_failed, text: `${ticket(e) || 'A task'} from ${SOURCES[e.source] || e.source}${e.by ? ` (${e.by})` : ''} didn't reach Jira.`, items: [String(e.error || '').slice(0, 300)] },
    { dedupe: String(e.error || '').slice(0, 200) }))); // a bulk upload failing the same way sends one alert

onAdded(item => briefly(notify('inbox_waiting', {
  title: EVENT_NAMES.inbox_waiting,
  text: `A change from ${SOURCES[item.source] || item.source} is waiting for approval in the Inbox: ${ticket({ ...item.task, jiraKey: item.check?.info?.existingKey || item.task?.jiraKey }) || 'a task'}.`,
  items: item.check?.errors?.length ? [`Problems: ${item.check.errors.join('; ').slice(0, 300)}`] : [],
}, { dedupe: item.source }))); // a sheet sync queuing many rows sends one (then at most one per 15 minutes)

onSyncFailed(err => briefly(notify('sheet_sync_failed', { title: EVENT_NAMES.sheet_sync_failed, text: 'The Google Sheet could not be synced with Jira.', items: [String(err?.message || err).slice(0, 300)] },
  { dedupe: String(err?.message || err).slice(0, 200) })));

// ---------- Daily summary ----------
// The hour and day in the summary's time zone
function localParts(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Called every hour (server.js, or the Netlify scheduled function): sends once a day, at or after the hour set
export async function runDigestIfDue(now = new Date(), { force = false } = {}) {
  await refreshSettings(true);
  const a = effective().alerts;
  if (!a.channels.some(c => c.enabled && c.events.includes('daily_digest'))) return { sent: false, reason: 'no channel wants it' };
  const { day, hour } = localParts(now, a.timezone);
  if (!force && hour < a.digestHour) return { sent: false, reason: 'not yet' };
  if (!force && (await store.get('alert:digest:last').catch(() => null)) === day) return { sent: false, reason: 'already sent today' };
  await store.set('alert:digest:last', day).catch(() => {}); // first, so two servers don't both send it
  const m = await digestMessage(now);
  const channels = a.channels.filter(c => c.enabled && c.events.includes('daily_digest'));
  const results = await Promise.allSettled(channels.map(c => sendTo(c, { ...m, event: 'daily_digest', url: a.appUrl })));
  results.forEach((r, i) => { if (r.status === 'rejected') logError('alerts', r.reason, { channel: channels[i].name, event: 'daily_digest' }); });
  return { sent: true, day };
}

async function digestMessage(now) {
  // Loaded here: the dashboard reads Jira, which only the summary needs
  const [{ activitySince, isSend, dashboard }, { listInbox }] = await Promise.all([import('./dashboard.js'), import('./inbox.js')]);
  const items = [];
  const sends = await activitySince(now.getTime() - 86400000).then(l => l.filter(isSend)).catch(() => null);
  if (sends) {
    const failed = sends.filter(e => !e.ok).length;
    items.push(`Last 24 hours: ${sends.length - failed} sent to Jira${failed ? `, ${failed} failed` : ', none failed'}`);
  }
  const pending = await listInbox().then(i => i.pending.length).catch(() => null);
  if (pending !== null) items.push(pending ? `${pending} change${pending === 1 ? '' : 's'} waiting for approval in the Inbox` : 'Nothing waiting in the Inbox');
  const j = await dashboard({ days: 7 }).then(d => d.jira).catch(() => null);
  if (j) items.push(`${j.open} open tickets: ${j.overdue} overdue, ${j.unassigned} unassigned`, `This week: ${j.created} created, ${j.resolved} resolved`);
  return { title: EVENT_NAMES.daily_digest, text: `Jira360 for ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: effective().alerts.timezone })}`, items };
}

// Settings → Alerts → "Send test"
export async function testChannel(id) {
  await refreshSettings(true);
  const a = effective().alerts, c = a.channels.find(x => x.id === id);
  if (!c) throw Object.assign(new Error('Save the channel first, then test it'), { status: 400 });
  await sendTo(c, { event: 'test', title: 'Test alert from Jira360', text: `Alerts for ${c.events.map(e => EVENT_NAMES[e]).join(', ') || 'nothing yet'} will arrive here.`, url: a.appUrl });
  return { ok: true, name: c.name };
}
