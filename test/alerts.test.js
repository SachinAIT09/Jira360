import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import './helpers.js';

const { saveSettings, settingsForPage, effective } = await import('../lib/settings.js');
const { notify, formats, testChannel, runDigestIfDue } = await import('../lib/alerts.js');
const { record } = await import('../lib/activity.js');

// A local server standing in for Slack / a webhook receiver
const received = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { received.push({ path: req.url, body: JSON.parse(body) }); res.end('ok'); });
});
await new Promise(r => hook.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${hook.address().port}`;
test.after(() => hook.close());

test('channels are checked, and their addresses never go back to the page', async () => {
  await assert.rejects(saveSettings({ alerts: { channels: [{ name: 'x', type: 'slack', target: 'https://example.com/x', events: [] }] } }), /hooks\.slack\.com/);
  await assert.rejects(saveSettings({ alerts: { timezone: 'Mars/Base' } }), /time zone/);
  const page = await saveSettings({ alerts: { appUrl: 'https://j360.example.com/', timezone: 'Asia/Kolkata', digestHour: 9,
    channels: [{ name: 'Hook', type: 'webhook', target: `${hookUrl}/a`, events: ['send_failed', 'portal_refused', 'inbox_waiting', 'daily_digest', 'bogus'] }] } });
  const c = page.alerts.channels[0];
  assert.equal(c.target, '');
  assert.ok(c.targetHint.startsWith('…'));
  assert.deepEqual(c.events, ['send_failed', 'portal_refused', 'inbox_waiting', 'daily_digest']);
  assert.equal(page.alerts.appUrl, 'https://j360.example.com');

  // Saving the list again with an empty address keeps the saved one
  await saveSettings({ alerts: { channels: [{ ...c, name: 'Hook 2', target: '' }] } });
  assert.equal(effective().alerts.channels[0].target, `${hookUrl}/a`);
  assert.equal(settingsForPage().alerts.channels[0].name, 'Hook 2');
});

test('message formats', () => {
  const m = { title: 'T', text: 'Body', items: ['one'], url: 'https://x' };
  assert.match(formats.slack(m).blocks[0].text.text, /\*T\*\nBody\n• one/);
  assert.equal(formats.teams(m).attachments[0].content.type, 'AdaptiveCard');
  assert.deepEqual(Object.keys(formats.webhook({ ...m, event: 'e' })).sort(), ['at', 'event', 'items', 'text', 'title', 'url']);
});

test('a failed send alerts once; the same failure again is not repeated', async () => {
  received.length = 0;
  await record({ source: 'ui', by: 'Ada', taskId: 'T-1', jiraKey: '', title: 'Fix it', ok: false, error: 'Assignee not found' });
  await record({ source: 'bulk', by: 'Ada', taskId: 'T-2', jiraKey: '', title: 'Fix that', ok: false, error: 'Assignee not found' });
  assert.equal(received.length, 1);
  assert.equal(received[0].body.event, 'send_failed');
  assert.match(received[0].body.text, /T-1 "Fix it" from the form \(Ada\)/);
  assert.equal(received[0].body.url, 'https://j360.example.com');

  // Successful sends say nothing; an event the channel didn't pick says nothing
  await record({ source: 'ui', taskId: 'T-3', ok: true });
  await notify('sheet_sync_failed', { title: 'x', text: 'y' });
  assert.equal(received.length, 1);

  // Refused portal tasks are their own event
  await record({ source: 'portal', taskId: 'P-1', ok: false, refused: true, error: 'Refused: no title' });
  assert.equal(received.at(-1).body.event, 'portal_refused');
});

test('test button and daily summary', async () => {
  received.length = 0;
  const id = effective().alerts.channels[0].id;
  assert.deepEqual(await testChannel(id), { ok: true, name: 'Hook 2' });
  assert.equal(received.at(-1).body.title, 'Test alert from Jira360');

  // 08:00 in Kolkata is before the 09:00 summary; 10:00 is after it, and only once a day
  assert.equal((await runDigestIfDue(new Date('2026-10-20T02:30:00Z'))).reason, 'not yet');
  const sent = await runDigestIfDue(new Date('2026-10-20T04:30:00Z'));
  assert.equal(sent.sent, true);
  assert.equal(received.at(-1).body.event, 'daily_digest');
  assert.ok(received.at(-1).body.items.some(i => /Last 24 hours/.test(i)));
  assert.equal((await runDigestIfDue(new Date('2026-10-20T08:30:00Z'))).reason, 'already sent today');
});
