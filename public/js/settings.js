// Settings tab (admin passcode): portal approval, AI key, Google Sheet. Keys are sent to the server
// and never shown again: the page only gets a hint (last 4 characters) and where each value comes from.

const adminStore = {
  get: () => { try { return sessionStorage.getItem('jira.admin') || ''; } catch { return ''; } },
  set: v => { try { v ? sessionStorage.setItem('jira.admin', v) : sessionStorage.removeItem('jira.admin'); } catch {} },
};
function sshow(kind, html) { const m = $('smsg'); m.className = 'msg ' + kind; m.innerHTML = html; }
const adminApi = (path, opts = {}) => api(path, { ...opts, headers: { ...(opts.headers || {}), 'X-Admin-Passcode': $('adminPass').value } });
let settings = null;
const SOURCE = { page: 'set here', env: 'from .env', default: 'default' };
const src = v => `<span class="srctag">${SOURCE[v] || v}</span>`;

$('adminPass').value = adminStore.get();
const adminOk = () => !auth.admin || !!$('adminPass').value;
async function loadSettings(fromButton = false) {
  if (!passOk() || !adminOk()) {
    $('sform').hidden = true;
    // Opening the tab with nothing typed yet is normal; pressing Unlock without both passcodes gets told why
    if (fromButton) sshow('err', !passOk() ? 'Enter the team passcode in the Passcode box at the top first.' : 'Enter the admin passcode.');
    return;
  }
  try {
    settings = await adminApi('ui/settings');
    adminStore.set($('adminPass').value); // for this browser tab only
    renderSettings();
    $('sform').hidden = false;
    $('slock').hidden = true;
    $('adminLock').hidden = !auth.admin; // nothing to lock without an admin passcode
  } catch (err) {
    $('sform').hidden = true; $('slock').hidden = !auth.admin;
    if (err.status === 401) adminStore.set('');
    sshow('err', esc(err.message));
  }
}
$('adminGo').addEventListener('click', () => { $('smsg').className = 'msg'; loadSettings(true); });
$('adminPass').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('adminGo').click(); } });
$('adminLock').addEventListener('click', () => { adminStore.set(''); $('adminPass').value = ''; $('sform').hidden = true; $('slock').hidden = false; settings = null; });

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
}

// Only what was changed is sent; empty key boxes keep the saved key
function settingsPatch() {
  const s = settings, p = {};
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
async function runTest(path, outId, okText) {
  const out = $(outId);
  if (Object.keys(settingsPatch()).length) { out.className = 'msg err'; out.textContent = 'Save first, then test.'; return; }
  out.className = 'msg info'; out.textContent = 'Testing…';
  try { const r = await adminApi(path, postJson({})); out.className = 'msg ok'; out.innerHTML = okText(r); }
  catch (err) { out.className = 'msg err'; out.textContent = err.message; }
}
$('sAiTest').addEventListener('click', () => runTest('ui/settings/test-ai', 'sAiTestOut', r => `The key works with ${esc(r.name || r.model)}.`));
$('sSheetTest').addEventListener('click', () => runTest('ui/settings/test-sheet', 'sSheetTestOut',
  r => `Connected to the ${link(r.url, 'sheet')} (tab ${esc(r.tab)}): ${r.rows} row${r.rows === 1 ? '' : 's'}. Columns: ${esc(r.columns.join(', ') || 'none yet')}.`));
