// Settings → Alerts: the channels (Slack, Teams, webhook, email), which events each gets, the daily
// summary's hour and time zone, and the email server. Saved with the other settings ("Save settings").
// Webhook addresses are never shown again: an empty box keeps the saved one.

const AL_EVENTS = { send_failed: 'Send to Jira failed', portal_refused: 'Portal task refused', sheet_sync_failed: 'Sheet sync failed',
  inbox_waiting: 'Waiting for approval', daily_digest: 'Daily summary' };
const AL_TYPES = { slack: 'Slack', teams: 'Microsoft Teams', webhook: 'Webhook (JSON)', email: 'Email' };
const AL_HINT = { slack: 'https://hooks.slack.com/services/…', teams: 'Teams Workflows webhook address (https://…)', webhook: 'https://… (receives JSON)', email: 'alice@example.com, bob@example.com' };

for (let h = 0; h < 24; h++) $('alHour').add(new Option(`${String(h).padStart(2, '0')}:00`, h));
try { $('alTzList').innerHTML = Intl.supportedValuesOf('timeZone').map(z => `<option value="${esc(z)}">`).join(''); } catch {}

function channelCard(c = { id: '', name: '', type: 'slack', events: ['send_failed', 'sheet_sync_failed'], enabled: true, target: '', targetHint: '' }) {
  const div = document.createElement('div');
  div.className = 'alch';
  div.dataset.id = c.id;
  div.dataset.hint = c.targetHint || '';
  div.dataset.savedType = c.id ? c.type : '';
  const uid = c.id || Math.random().toString(36).slice(2, 8);
  div.innerHTML =
    `<div class="flex flex-wrap items-center gap-2.5">` +
      `<label class="check m-0"><input type="checkbox" data-f="enabled"${c.enabled ? ' checked' : ''}> On</label>` +
      `<label for="aln${uid}" class="sr-only">Channel name</label><input id="aln${uid}" data-f="name" placeholder="Name, e.g. #jira-alerts" value="${esc(c.name)}" class="min-w-0 flex-1 basis-40">` +
      `<label for="alt${uid}" class="sr-only">Type</label><select id="alt${uid}" data-f="type" class="w-auto">${Object.entries(AL_TYPES).map(([v, t]) => `<option value="${v}"${v === c.type ? ' selected' : ''}>${t}</option>`).join('')}</select>` +
      `<button class="ghost" type="button" data-test>Send test</button>` +
      `<button class="linkbtn errt" type="button" data-remove>Remove</button>` +
    `</div>` +
    `<label for="alg${uid}" class="sr-only">Address</label><input id="alg${uid}" data-f="target" spellcheck="false" autocomplete="off" class="mt-2.5 w-full" value="${esc(c.target || '')}">` +
    `<fieldset class="alev"><legend class="sr-only">Send alerts for</legend>${Object.entries(AL_EVENTS).map(([v, t]) =>
      `<label class="check m-0"><input type="checkbox" data-ev="${v}"${c.events.includes(v) ? ' checked' : ''}> ${t}</label>`).join('')}</fieldset>`;
  placeholderFor(div);
  return div;
}
function placeholderFor(card) {
  const type = card.querySelector('[data-f=type]').value, target = card.querySelector('[data-f=target]');
  target.placeholder = card.dataset.hint && card.dataset.savedType === type ? `Saved (${card.dataset.hint}). Paste a new address to replace it` : AL_HINT[type];
}

function renderAlerts() {
  const a = settings.alerts;
  $('alChannels').innerHTML = '';
  for (const c of a.channels) $('alChannels').append(channelCard(c));
  if (!a.channels.length) $('alChannels').innerHTML = '<p class="muted m-0" id="alNone">No channels yet: add one to start getting alerts.</p>';
  $('alUrl').value = a.appUrl;
  $('alHour').value = a.digestHour;
  $('alTz').value = a.timezone;
  $('alHost').value = a.smtp.host; $('alPort').value = a.smtp.port; $('alUser').value = a.smtp.user; $('alFrom').value = a.smtp.from;
  $('alPass').value = '';
  $('alPass').placeholder = a.smtp.hasPass ? `Saved (${a.smtp.passHint})` : '';
  $('alSmtpBox').open = a.channels.some(c => c.type === 'email') && !a.smtp.host;
  $('alTestOut').className = 'msg';
}

const cardsNow = () => [...$('alChannels').querySelectorAll('.alch')].map(card => ({
  id: card.dataset.id,
  name: card.querySelector('[data-f=name]').value.trim(),
  type: card.querySelector('[data-f=type]').value,
  target: card.querySelector('[data-f=target]').value.trim(),
  enabled: card.querySelector('[data-f=enabled]').checked,
  events: [...card.querySelectorAll('[data-ev]:checked')].map(x => x.dataset.ev),
}));

// What changed in this section, or null
function alertsPatch() {
  const a = settings?.alerts;
  if (!a) return null;
  const p = {};
  const was = a.channels.map(c => ({ id: c.id, name: c.name, type: c.type, target: c.target || '', enabled: c.enabled, events: c.events }));
  if (JSON.stringify(cardsNow()) !== JSON.stringify(was)) p.channels = cardsNow();
  if ($('alUrl').value.trim() !== a.appUrl) p.appUrl = $('alUrl').value.trim();
  if (Number($('alHour').value) !== a.digestHour) p.digestHour = Number($('alHour').value);
  if ($('alTz').value.trim() && $('alTz').value.trim() !== a.timezone) p.timezone = $('alTz').value.trim();
  const sm = {};
  for (const [id, k] of [['alHost', 'host'], ['alUser', 'user'], ['alFrom', 'from']]) if ($(id).value.trim() !== a.smtp[k]) sm[k] = $(id).value.trim();
  if ($('alPort').value !== '' && Number($('alPort').value) !== a.smtp.port) sm.port = Number($('alPort').value);
  if ($('alPass').value) sm.pass = $('alPass').value;
  if (Object.keys(sm).length) p.smtp = sm;
  return Object.keys(p).length ? p : null;
}

$('alAdd').addEventListener('click', () => {
  $('alNone')?.remove();
  const card = channelCard();
  $('alChannels').append(card);
  card.querySelector('[data-f=name]').focus();
});
$('alChannels').addEventListener('change', e => { if (e.target.matches('[data-f=type]')) placeholderFor(e.target.closest('.alch')); });
$('alChannels').addEventListener('click', e => {
  const card = e.target.closest('.alch');
  if (e.target.closest('[data-remove]')) {
    card.remove();
    if (!$('alChannels').querySelector('.alch')) $('alChannels').innerHTML = '<p class="muted m-0" id="alNone">No channels: add one to start getting alerts.</p>';
  }
  if (e.target.closest('[data-test]')) {
    if (!card.dataset.id) { $('alTestOut').className = 'msg err'; $('alTestOut').textContent = 'Save settings first, then test the new channel.'; return; }
    runTest('ui/settings/test-alert', 'alTestOut', r => `Test sent to ${esc(r.name)}. Check that it arrived.`, { id: card.dataset.id });
  }
});
