// Settings → Google Sheet: make the sheet (create / set up / template) and its live preview
// (columns, what the next sync will do, the rows). The preview refreshes by itself every 15 s
// while Settings is open and the page is visible; the "next sync" dry run every 60 s.

let spv = { data: null, busy: false, ticks: 0 };
const sheetReady = () => !!(settings?.sheet?.hasKey && settings?.sheet?.sheetId);
const previewOn = () => !$('settingsPanel').hidden && !$('sform').hidden && document.visibilityState === 'visible';
function smake(kind, html) { const m = $('sMakeOut'); m.className = 'msg ' + kind; m.innerHTML = html; }
function spvMsg(kind, html) { const m = $('spvMsg'); m.className = kind ? 'msg ' + kind : 'msg'; m.innerHTML = html || ''; }
try { $('sShareWith').value = localStorage.getItem('jira.shareWith') || ''; } catch {}

async function loadPreview(withPlan = false) {
  if (!settings) return;
  $('sSaEmail').textContent = settings.sheet.serviceAccount && !settings.sheet.serviceAccount.startsWith('(') ? settings.sheet.serviceAccount : 'the service account';
  $('spv').hidden = !sheetReady();
  if (!sheetReady() || spv.busy) return;
  spv.busy = true;
  $('spvLive').classList.add('busy');
  try {
    const d = await adminApi('ui/sheet/preview?plan=' + (withPlan ? 1 : 0));
    if (!withPlan && spv.data?.plan) d.plan = spv.data.plan; // keep the last dry run between its refreshes
    spv.data = d;
    renderPreview();
    if ($('spvMsg').classList.contains('err')) spvMsg('');
  } catch (err) {
    // The admin passcode was changed elsewhere (or too many tries): lock Settings, so the refresh
    // stops instead of counting as wrong passcodes every 15 s
    if (err.status === 401 || err.status === 429) {
      if (err.status === 401) adminStore.set('');
      settings = null; $('sform').hidden = true; $('slock').hidden = !auth.admin; $('spv').hidden = true;
      sshow('err', esc(err.message));
      return;
    }
    spvMsg('err', 'Could not read the sheet: ' + esc(err.message));
  } finally {
    spv.busy = false;
    $('spvLive').classList.remove('busy');
  }
}

const PLAN = {
  'to-jira': ['To Jira', 'blue'], 'from-jira': ['From Jira', 'violet'], create: ['New ticket', 'green'], 'add-row': ['New row', 'green'],
  conflict: ['Conflict', 'amber'], problem: ['Problem', 'red'], 'to-inbox': ['To the Inbox', 'amber'], remove: ['Stops syncing', 'grey'],
  missing: ['Not in Jira', 'red'], withdraw: ['Withdrawn', 'grey'],
};
function renderPreview() {
  const d = spv.data;
  $('spvOpen').href = d.url || '#';
  const p = d.lastPoll;
  $('spvSub').innerHTML = `${esc(d.title || 'Google Sheet')} · tab ${esc(d.tab)} · ${d.total} row${d.total === 1 ? '' : 's'}` +
    (p ? ` · last synced ${esc(when(p.at))}` : ' · not synced yet') + ` · sheet edits: ${d.syncMode === 'approve' ? 'wait for approval' : 'sync automatically'}`;

  // Columns: what the app recognises
  const KIND = { field: ['✓', 'ok'], app: ['app', 'app'], unknown: ['not recognised', 'warn'] };
  $('spvCols').innerHTML = d.columns.length ? d.columns.map(c => `<span class="colchip ${KIND[c.kind][1]}" title="${esc(c.kind === 'unknown' ? 'Not synced: no Jira field has this name' : c.kind === 'app' ? 'Filled in by Jira360' : 'Synced with Jira')}">${esc(c.header)} <small>${KIND[c.kind][0]}</small></span>`).join('')
    : '<p class="muted">The sheet has no header row yet.</p>';
  $('spvMissing').innerHTML = !d.hasTitle ? '<span class="errt">No "Title" column: nothing can sync until there is one.</span> <button class="linkbtn" type="button" data-setup>Set up the linked sheet</button>'
    : d.missing.length ? `<span class="text-fg-2">Not in the sheet: ${esc(d.missing.join(', '))}.</span> <button class="linkbtn" type="button" data-setup>Add them</button>` : '';

  // The next sync (dry run)
  const plan = d.plan;
  if (!plan) $('spvPlan').innerHTML = '<p class="muted">Checking…</p>';
  else if (plan.error) $('spvPlan').innerHTML = `<p class="errt">${esc(plan.error)}</p>`;
  else if (!plan.plan.length) $('spvPlan').innerHTML = '<p class="good m-0">✓ Everything is in step: the next sync has nothing to do.</p>';
  else {
    const counts = {};
    for (const x of plan.plan) counts[x.action] = (counts[x.action] || 0) + 1;
    $('spvPlan').innerHTML = `<p class="m-0 text-sm text-fg-2">${Object.entries(counts).map(([a, n]) => `${n} ${esc((PLAN[a] || [a])[0].toLowerCase())}`).join(' · ')}</p><ul>` +
      plan.plan.slice(0, 60).map(x => `<li><span class="tag tag-${(PLAN[x.action] || ['', 'grey'])[1]}">${esc((PLAN[x.action] || [x.action])[0])}</span>` +
        `<span>${x.row ? `Row ${x.row}` : 'New row'}${x.jiraKey ? ' · ' + esc(x.jiraKey) : ''}${x.title ? ' · ' + esc(x.title) : ''}` +
        (x.fields.length ? `<span class="muted"> — ${x.fields.map(f => `${esc(f.field)}: ${esc(f.from || 'empty')} → ${esc(f.to || 'empty')}`).join('; ')}</span>` : '') +
        (x.detail ? `<span class="muted"> (${esc(x.detail)})</span>` : '') + '</span></li>').join('') + '</ul>';
  }

  // Rows
  $('spvCount').textContent = d.total > d.rows.length ? `showing ${d.rows.length} of ${d.total}` : '';
  const statusAt = d.show.findIndex(c => c.field === 'syncStatus'), keyAt = d.show.findIndex(c => c.field === 'jiraKey');
  $('spvRows').innerHTML = !d.rows.length ? '<tr><td class="empty">No rows yet.</td></tr>' :
    '<thead><tr><th>#</th>' + d.show.map(c => `<th>${esc(c.header)}</th>`).join('') + '</tr></thead><tbody>' +
    d.rows.map(r => `<tr class="${/^(Problems|Failed|Ticket not found)/.test(r.values[statusAt] || '') ? 'bad' : ''}"><td class="muted">${r.row}</td>` +
      r.values.map((v, i) => i === keyAt && v ? `<td>${link(d.browse + v, v)}</td>`
        : `<td${String(v).length > 60 ? ' class="wrap"' : ''}>${esc(String(v).length > 140 ? String(v).slice(0, 140) + '…' : v)}</td>`).join('') + '</tr>').join('') + '</tbody>';
}

// Settings drawn -> the preview follows
const renderSettingsBase = renderSettings;
renderSettings = function () { renderSettingsBase(); loadPreview(true); };

// Refresh by itself while Settings is open
setInterval(() => {
  if (!previewOn() || !sheetReady()) return;
  spv.ticks++;
  loadPreview(spv.ticks % 4 === 0);
}, 15000);
document.addEventListener('visibilitychange', () => { if (previewOn() && sheetReady()) loadPreview(true); });

$('spvSync').addEventListener('click', async () => {
  $('spvSync').disabled = true;
  spvMsg('info', 'Syncing…');
  try {
    const p = await api('ui/sheet/check', postJson({}));
    spvMsg('ok', `Synced: ${esc(syncCounts(p))}.`);
    loadInbox(); loadOverview();
  } catch (err) { spvMsg('err', 'Sync failed: ' + esc(err.message)); }
  finally { $('spvSync').disabled = false; spv.data = null; await loadPreview(true); }
});

$('sCreate').addEventListener('click', async () => {
  const email = $('sShareWith').value.trim();
  if (!settings?.sheet?.hasKey) return smake('err', 'Save the service account key above first.');
  if (!email) { $('sShareWith').focus(); return smake('err', 'Type your Google email: the new sheet is shared with it.'); }
  try { localStorage.setItem('jira.shareWith', email); } catch {}
  $('sCreate').disabled = true;
  smake('info', 'Creating the sheet, adding the columns and dropdowns, and filling in your tickets…');
  try {
    const r = await adminApi('ui/sheet/create', postJson({ shareWith: email }));
    smake(r.shareError ? 'err' : 'ok', `Created ${link(r.url, 'the sheet')} and linked it.` +
      (r.shareError ? ` ${esc(r.shareError)}` : ` It is shared with ${esc(r.sharedWith)} (check your email).`) +
      (r.sync && !r.sync.error ? ` ${esc(syncCounts(r.sync))}.` : ''));
    await loadSettings();
  } catch (err) {
    smake('err', esc(err.message));
  } finally { $('sCreate').disabled = false; }
});

async function setupLinked() {
  if (!sheetReady()) return smake('err', 'Paste the sheet\'s link in "Sheet address" above and save first.');
  smake('info', 'Setting up the sheet…');
  try {
    const r = await adminApi('ui/sheet/setup', postJson({}));
    smake('ok', (r.added.length ? `Added ${r.added.length} column${r.added.length === 1 ? '' : 's'}: ${esc(r.added.join(', '))}. ` : 'All columns were already there. ') +
      'Dropdowns and formats are set.' + (r.sync && !r.sync.error ? ` ${esc(syncCounts(r.sync))}.` : ''));
    spv.data = null;
    await loadPreview(true);
  } catch (err) { smake('err', esc(err.message)); }
}
$('sSetup').addEventListener('click', setupLinked);
$('spvMissing').addEventListener('click', e => { if (e.target.closest('[data-setup]')) setupLinked(); });

$('sTemplate').addEventListener('click', async () => {
  try {
    const res = await fetch('ui/sheet/template.xlsx', { headers: { 'X-UI-Passcode': $('passcode').value, 'X-User-Name': encodeURIComponent($('who').value.trim()) } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = 'jira360-sheet-template.xlsx';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    smake('ok', 'Template downloaded. In Google Sheets: File → Import → Upload, then share it with the service account and paste its link above.');
  } catch (err) { smake('err', 'Template not made: ' + esc(err.message)); }
});
