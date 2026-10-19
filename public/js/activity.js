// Activity tab: history of every send to Jira, task timeline, retry, CSV export.

// ---------- Activity: everything sent to Jira, for everyone (kept on the server) ----------
let acts = { items: [], next: '', more: false };
const SOURCE_NAMES = { ui: 'Form', bulk: 'Bulk upload', portal: 'Portal', sheet: 'Google Sheet' };
const FIELD_NAMES = { ...LABELS, assignee: 'Assignee', hoursSpent: 'Work logged' };
function ashow(kind, html) { const m = $('amsg'); m.className = 'msg ' + kind; m.innerHTML = html; }
const sourceText = e => (SOURCE_NAMES[e.source] || e.source) + (e.via === 'inbox' ? ' (approved in Inbox)' : '');

function actionText(a) {
  if (a === 'created') return 'Created';
  if (a === 'updated') return 'Updated';
  if (a === 'commented') return 'Comment added';
  if (a.startsWith('transitioned:')) return 'Status → ' + a.slice(13);
  if (a.startsWith('worklog:')) return 'Logged ' + a.slice(8);
  return a;
}
const happened = e => e.ok
  ? (e.actions.map(actionText).join(' · ') || 'No changes') + (e.changes?.length ? ` · changed: ${e.changes.map(c => c.label || FIELD_NAMES[c.field] || c.field).join(', ')}` : '')
  : (e.refused ? '' : 'Failed: ') + (e.error || '');

// Date boxes are local days; the server gets them as times (end day is included)
const dayMs = (v, nextDay) => v ? new Date(v + 'T00:00:00').getTime() + (nextDay ? 86400000 : 0) : '';
function activityParams(extra = {}) {
  const p = { q: $('aq').value.trim(), source: $('asource').value, result: $('aresult').value,
    from: dayMs($('afrom').value), to: dayMs($('ato').value, true), ...extra };
  return new URLSearchParams(Object.entries(p).filter(([, v]) => v !== '' && v != null));
}

async function loadActivity(more = false) {
  if (!$('passcode').value) return;
  try {
    const out = await api('ui/activity?' + activityParams(more ? { before: acts.next } : {}));
    acts = more ? { ...out, items: [...acts.items, ...out.items] } : out;
    renderActivity();
    if ($('amsg').classList.contains('err')) $('amsg').className = 'msg';
  } catch (err) {
    ashow('err', 'History not loaded: ' + esc(err.message));
  }
}

function renderActivity() {
  const rows = acts.items;
  $('acount').textContent = rows.length ? `${rows.length}${acts.more ? '+' : ''} shown` : '';
  $('amore').hidden = !acts.more;
  $('atable').innerHTML = !rows.length ? '<tr><td class="empty">Nothing matches.</td></tr>' :
    '<thead><tr><th>When</th><th>From</th><th>By</th><th>Task</th><th>Jira</th><th>What happened</th><th></th></tr></thead><tbody>' +
    rows.map((e, i) => `<tr class="hit${e.ok ? '' : ' failed'}" data-i="${i}">` +
      `<td>${esc(when(e.at))}</td><td>${esc(sourceText(e))}</td><td>${esc(e.by || '')}</td>` +
      `<td>${esc(e.taskId)}${e.title ? `<div class="muted">${esc(e.title.length > 60 ? e.title.slice(0, 60) + '…' : e.title)}</div>` : ''}</td>` +
      `<td>${e.jiraKey ? (e.url ? link(e.url, e.jiraKey) : esc(e.jiraKey)) : ''}</td>` +
      `<td class="wrap ${e.ok ? '' : 'errt'}">${esc(happened(e))}${e.warning ? `<div class="warnt">${esc(e.warning)}</div>` : ''}</td>` +
      `<td>${!e.ok && !e.refused && e.task ? '<button class="ghost" type="button" data-retry>Retry</button>' : ''}</td></tr>`).join('') + '</tbody>';
}

$('atable').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr || e.target.closest('a')) return;
  const entry = acts.items[+tr.dataset.i];
  if (e.target.closest('button[data-retry]')) retry(entry); else openTimeline(entry);
});

let aTimer = null;
$('aq').addEventListener('input', () => { clearTimeout(aTimer); aTimer = setTimeout(() => loadActivity(), 350); });
for (const id of ['asource', 'aresult', 'afrom', 'ato']) $(id).addEventListener('change', () => loadActivity());
$('arefresh').addEventListener('click', () => loadActivity());
$('amore').addEventListener('click', () => loadActivity(true));

// ---------- One task's full history ----------
function changeTable(changes) {
  if (!changes?.length) return '';
  const cell = v => `<td><div>${esc(v)}</div></td>`;
  return '<table class="chg"><tr><th>Field</th><th>Before</th><th>After</th></tr>' + changes.map(c =>
    `<tr><td>${esc(c.label || FIELD_NAMES[c.field] || c.field)}</td>` +
    (c.before === '?' ? '<td class="muted">unknown</td>' : cell(c.before)) +
    (c.after === '' && c.before ? '<td class="removed">removed</td>' : cell(c.after)) + '</tr>').join('') + '</table>';
}

async function openTimeline(entry) {
  $('tlTitle').innerHTML = `Task ${esc(entry.taskId)}` + (entry.url ? ` · ${link(entry.url, entry.jiraKey)}` : entry.jiraKey ? ` · ${esc(entry.jiraKey)}` : '');
  $('tlBody').innerHTML = '<p class="muted">Loading…</p>';
  $('tl').showModal();
  try {
    const q = new URLSearchParams({ taskId: entry.taskId, ...(entry.jiraKey && { jiraKey: entry.jiraKey }) });
    const { items } = await api('ui/activity/task?' + q);
    $('tlBody').innerHTML = !items.length ? '<p class="empty">No history.</p>' : items.map(e =>
      `<div class="item"><b>${esc(when(e.at))}</b> <span class="muted">· ${esc(sourceText(e))}${e.by ? ' · ' + esc(e.by) : ''}</span>` +
      `<div class="${e.ok ? '' : 'errt'}" style="margin-top:4px">${esc(happened(e).replace(/ · changed: .*$/, ''))}</div>` +
      (e.warning ? `<div class="warnt">${esc(e.warning)}</div>` : '') + changeTable(e.changes) + '</div>').join('');
  } catch (err) {
    $('tlBody').innerHTML = `<p class="errt">${esc(err.message)}</p>`;
  }
}
$('tlClose').addEventListener('click', () => $('tl').close());

// ---------- Retry a failed send: the normal preview first, then send ----------
async function retry(entry) {
  if (!needPass(ashow)) return;
  ashow('info', `Checking task ${esc(entry.taskId)} against Jira again…`);
  try {
    pending = await api('ui/preview', postJson(entry.task));
    pendingFrom = 'activity';
    $('amsg').className = 'msg';
    openPreview(pending);
  } catch (err) {
    ashow('err', 'Could not check it: ' + esc(err.message));
  }
}
async function retrySend(task) {
  pendingFrom = '';
  ashow('info', 'Sending…');
  try {
    const out = await api('ui/task', postJson(task));
    ashow('ok', `Sent: ${link(out.url, out.jiraKey)} (${esc(out.actions.map(actionText).join(', ') || 'no changes')})` + (out.warning ? `<br>Note: ${esc(out.warning)}` : ''));
  } catch (err) {
    ashow('err', 'Failed again: ' + esc(err.message));
  }
  loadActivity();
}

// ---------- CSV of what the filters show (up to 500 rows) ----------
function downloadCsv(name, rows) {
  const csv = rows.map(r => r.map(v => { v = String(v ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })); // BOM so Excel reads UTF-8
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('acsv').addEventListener('click', async () => {
  if (!needPass(ashow)) return;
  try {
    const { items, more } = await api('ui/activity?' + activityParams({ limit: 500 }));
    downloadCsv(`jira-activity-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['When', 'From', 'By', 'Task ID', 'Jira key', 'Title', 'Result', 'What happened', 'Changes', 'Error'],
      ...items.map(e => [e.at, sourceText(e), e.by, e.taskId, e.jiraKey, e.title, e.ok ? 'Sent' : e.refused ? 'Refused' : 'Failed',
        e.ok ? e.actions.map(actionText).join('; ') : '',
        (e.changes || []).map(c => `${c.label || FIELD_NAMES[c.field] || c.field}: ${c.before || '(empty)'} -> ${c.after || '(empty)'}`).join('; '),
        e.error || '']),
    ]);
    ashow('ok', `Exported ${items.length} row${items.length === 1 ? '' : 's'}.` + (more ? ' Only the newest 500 are included; narrow the filters to export the rest.' : ''));
  } catch (err) {
    ashow('err', 'Export failed: ' + esc(err.message));
  }
});
