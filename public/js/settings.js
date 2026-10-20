// Settings tab (admins): portal approval, AI key, Google Sheet, and the people who can sign in.
// Keys are sent to the server and never shown again: the page only gets a hint (last 4 characters)
// and where each value comes from.

function sshow(kind, html) { const m = $('smsg'); m.className = 'msg ' + kind; m.innerHTML = html; }
const adminApi = api; // the server checks the signed-in person's role
let settings = null;
const SOURCE = { page: 'set here', env: 'from .env', default: 'default' };
const src = v => `<span class="srctag">${SOURCE[v] || v}</span>`;

async function loadSettings() {
  if (!passOk() || !can('admin')) { $('sform').hidden = true; return; }
  loadUsers();
  try {
    settings = await adminApi('ui/settings');
    if (/err/.test($('smsg').className)) $('smsg').className = 'msg';
    renderSettings();
    $('sform').hidden = false;
  } catch (err) {
    $('sform').hidden = true;
    sshow('err', esc(err.message));
  }
}

function renderSettings() {
  const s = settings;
  $('sApproval').checked = s.portal.requireApproval;
  $('sApprovalSrc').innerHTML = src(s.portal.source.requireApproval);
  $('sAiOn').checked = s.ai.enabled;
  $('sAiOnSrc').innerHTML = src(s.ai.source.enabled);
  $('sAiKey').value = '';
  $('sAiKey').placeholder = s.ai.hasKey ? `Saved (${s.ai.keyHint}). Type a new key to replace it` : 'sk-ant-…';
  $('sAiKeySrc').innerHTML = s.ai.hasKey ? src(s.ai.source.apiKey) : '';
  $('sAiKeyDel').hidden = s.ai.source.apiKey !== 'page';
  $('sAiModel').value = s.ai.model;
  $('sAiLimit').value = s.ai.dailyLimit;
  $('sSheetKey').value = '';
  $('sSheetKey').placeholder = s.sheet.hasKey ? `Saved: ${s.sheet.serviceAccount}. Paste a new key file to replace it` : 'Paste the whole service account .json file here';
  $('sSheetKeySrc').innerHTML = s.sheet.hasKey ? src(s.sheet.source.saJson) : '';
  $('sSheetKeyDel').hidden = s.sheet.source.saJson !== 'page';
  $('sSheetShare').innerHTML = s.sheet.serviceAccount && !s.sheet.serviceAccount.startsWith('(')
    ? `Share the sheet with <b>${esc(s.sheet.serviceAccount)}</b> (Editor).` : '';
  $('sSheetId').value = s.sheet.sheetId;
  $('sSheetTab').value = s.sheet.tab;
  $('sSheetMin').value = s.sheet.pollMinutes;
  for (const r of document.querySelectorAll('input[name=sSyncMode]')) r.checked = r.value === s.sheet.syncMode;
  $('sSyncSrc').innerHTML = src(s.sheet.source.syncMode);
  $('supdated').textContent = s.updatedBy || s.updatedAt ? `Last changed${s.updatedBy ? ' by ' + s.updatedBy : ''}${s.updatedAt ? ', ' + when(s.updatedAt) : ''}.` : '';
  for (const id of ['sAiTest', 'sSheetTest']) $(id + 'Out').className = 'msg';
  if (typeof renderAlerts === 'function') renderAlerts();
}

// Only what was changed is sent; empty key boxes keep the saved key
function settingsPatch() {
  const s = settings, p = {};
  if (!s) return p;
  if ($('sApproval').checked !== s.portal.requireApproval) p.portal = { requireApproval: $('sApproval').checked };
  const ai = {};
  if ($('sAiOn').checked !== s.ai.enabled) ai.enabled = $('sAiOn').checked;
  if ($('sAiKey').value.trim()) ai.apiKey = $('sAiKey').value.trim();
  if ($('sAiModel').value.trim() && $('sAiModel').value.trim() !== s.ai.model) ai.model = $('sAiModel').value.trim();
  if ($('sAiLimit').value !== '' && Number($('sAiLimit').value) !== s.ai.dailyLimit) ai.dailyLimit = Number($('sAiLimit').value);
  if (Object.keys(ai).length) p.ai = ai;
  const sh = {};
  if ($('sSheetKey').value.trim()) sh.saJson = $('sSheetKey').value.trim();
  if ($('sSheetId').value.trim() && $('sSheetId').value.trim() !== s.sheet.sheetId) sh.sheetId = $('sSheetId').value.trim();
  if ($('sSheetTab').value.trim() && $('sSheetTab').value.trim() !== s.sheet.tab) sh.tab = $('sSheetTab').value.trim();
  if ($('sSheetMin').value !== '' && Number($('sSheetMin').value) !== s.sheet.pollMinutes) sh.pollMinutes = Number($('sSheetMin').value);
  const mode = document.querySelector('input[name=sSyncMode]:checked')?.value;
  if (mode && mode !== s.sheet.syncMode) sh.syncMode = mode;
  if (Object.keys(sh).length) p.sheet = sh;
  if (typeof alertsPatch === 'function') { const al = alertsPatch(); if (al) p.alerts = al; }
  return p;
}

async function saveSettingsNow(patch, done) {
  $('sSave').disabled = true;
  try {
    settings = await adminApi('ui/settings', postJson(patch));
    renderSettings();
    sshow('ok', done);
    loadOptions(); loadInbox(); // AI buttons and approval / sheet status follow straight away
  } catch (err) {
    sshow('err', 'Not saved: ' + esc(err.message));
  } finally {
    $('sSave').disabled = false;
  }
}
$('sSave').addEventListener('click', () => {
  if (!settings) return sshow('err', 'Settings are not loaded yet.');
  const p = settingsPatch();
  if (!Object.keys(p).length) return sshow('info', 'Nothing changed.');
  saveSettingsNow(p, 'Saved. It applies straight away.');
});
$('sAiKeyDel').addEventListener('click', () => {
  if (confirm('Remove the AI key saved here? The key in .env (if any) is used again.')) saveSettingsNow({ clear: ['ai.apiKey'] }, 'AI key removed.');
});
$('sSheetKeyDel').addEventListener('click', () => {
  if (confirm('Remove the Google key saved here? The key in .env (if any) is used again.')) saveSettingsNow({ clear: ['sheet.saJson'] }, 'Google key removed.');
});

// Test what is saved (save first if something changed)
async function runTest(path, outId, okText, body = {}) {
  const out = $(outId);
  if (Object.keys(settingsPatch()).length) { out.className = 'msg err'; out.textContent = 'Save first, then test.'; return; }
  out.className = 'msg info'; out.textContent = 'Testing…';
  try { const r = await adminApi(path, postJson(body)); out.className = 'msg ok'; out.innerHTML = okText(r); }
  catch (err) { out.className = 'msg err'; out.textContent = err.message; }
}
$('sAiTest').addEventListener('click', () => runTest('ui/settings/test-ai', 'sAiTestOut', r => `The key works with ${esc(r.name || r.model)}.`));
$('sSheetTest').addEventListener('click', () => runTest('ui/settings/test-sheet', 'sSheetTestOut',
  r => `Connected to the ${link(r.url, 'sheet')} (tab ${esc(r.tab)}): ${r.rows} row${r.rows === 1 ? '' : 's'}. Columns: ${esc(r.columns.join(', ') || 'none yet')}.`));
