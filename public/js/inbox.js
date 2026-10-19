// Inbox tab: changes from the portal and the Google Sheet waiting for approval before they reach
// Jira. Each card shows what the ticket has now -> what it will have; sheet changes that clash with
// an edit made in Jira meanwhile let the person pick which value wins.

let inbox = { pending: [], decided: [], approvalMode: false, sheet: { configured: false } };
let inboxShown = ''; // which pending changes the cards show; the cards are redrawn only when that changes
function ishow(kind, html) { const m = $('imsg'); m.className = 'msg ' + kind; m.innerHTML = html; }
const when = iso => iso ? new Date(iso).toLocaleString() : '';
const SOURCES = { portal: 'the portal', sheet: 'the Google Sheet' };

async function loadInbox() {
  if (!passOk()) return;
  try {
    inbox = await api('ui/inbox');
    renderInbox();
  } catch (err) {
    if (!$('inboxPanel').hidden) ishow('err', 'Inbox not loaded: ' + esc(err.message));
  }
}

const FIELD_TITLES = { ...LABELS, assigneeEmail: 'Assignee', comment: 'Comment' };
function conflictBlock(it) {
  if (!it.conflicts?.length) return '';
  return '<div class="note warn"><b>Changed in both places since the last sync.</b> Pick which value to keep:' +
    it.conflicts.map(c => `<div class="conflict"><b>${esc(FIELD_TITLES[c.field] || c.field)}</b> ` +
      `<span class="muted">(was ${esc(c.base || 'empty')})</span>` +
      `<label><input type="radio" name="c-${esc(it.id)}-${esc(c.field)}" value="sheet" checked> Sheet: <b>${esc(c.sheet || 'empty')}</b></label>` +
      `<label><input type="radio" name="c-${esc(it.id)}-${esc(c.field)}" value="jira" data-field="${esc(c.field)}"> Jira: <b>${esc(c.jira || 'empty')}</b></label></div>`).join('') +
    '</div>';
}

function inboxCard(it) {
  const { task, errors, warnings, info } = it.check;
  const update = info.action === 'update';
  const fields = Object.keys(LABELS).filter(k => (task[k] !== undefined && task[k] !== '' && !(k === 'assigneeEmail' && task.assigneeId)) || (task.clear || []).includes(k));
  const sameTask = inbox.pending.filter(x => x.task.taskId === it.task.taskId).length - 1;
  const from = SOURCES[it.source] || it.source;
  return `<article class="item" data-id="${esc(it.id)}">` +
    `<b>${update ? `Update ${link(info.url, info.existingKey)}` : `Create a new ticket in ${esc(project)}`}</b>` +
    `<div class="muted">From ${esc(from)}${it.sheetRow ? ` (row ${it.sheetRow})` : ''} · Task ID ${esc(it.task.taskId)} · received ${esc(when(it.receivedAt))}</div>` +
    (fields.length || task.fields ? `<dl class="kv">${fields.map(k => pvRow(k, task, info)).join('')}${extraReviewRows(task, info)}</dl>` : '') +
    conflictBlock(it) +
    noteList('err', 'Problems (approving will fail until they are fixed at the source):', errors) +
    (info.duplicates?.length ? `<div class="note warn"><b>Possible duplicate.</b> ${duplicateNotes(info)[0]}.</div>` : '') +
    (sameTask > 0 ? `<div class="note warn">${sameTask} more change${sameTask > 1 ? 's' : ''} for this task ${sameTask > 1 ? 'are' : 'is'} waiting. Approve them in order, oldest first.</div>` : '') +
    noteList('warn', 'Please note:', warnings) +
    `<div class="row"><button class="primary" type="button" data-act="approve">Approve and send</button>` +
    `<button class="ghost" type="button" data-act="reject">Reject</button></div><div class="msg" role="status"></div></article>`;
}

const DECISIONS = { approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };
function renderInbox() {
  const n = inbox.pending.length;
  $('ibadge').hidden = !n;
  $('ibadge').textContent = n;
  $('imode').innerHTML = (inbox.approvalMode
    ? '<b>Portal approval is on.</b> Changes from the portal wait here.'
    : '<b>Portal approval is off.</b> Portal changes are checked and sent straight away (set PORTAL_REQUIRE_APPROVAL=true to review them here).') +
    (inbox.sheet?.configured ? ' Changes from the Google Sheet always wait here.' : '') + ' Nothing here reaches Jira until you approve it.';

  const s = inbox.sheet || {};
  $('isheet').hidden = !s.configured;
  if (s.configured) {
    const p = s.lastPoll;
    $('isheetInfo').innerHTML = `${link(s.url, 'Google Sheet')} (tab ${esc(s.tab)}) · ` + (p
      ? `last checked ${esc(when(p.at))}: ${p.queued} new, ${p.updated} updated, ${p.unchanged} unchanged` + (p.withdrawn ? `, ${p.withdrawn} withdrawn` : '')
      : 'not checked yet');
  }

  // Redraw the cards only when the waiting changes are different, so a choice in progress isn't lost
  const shown = JSON.stringify(inbox.pending.map(x => [x.id, x.receivedAt, x.check.errors.length]));
  if (shown !== inboxShown) {
    inboxShown = shown;
    $('ilist').innerHTML = n ? inbox.pending.map(inboxCard).join('') : '<div class="card p-0 sm:p-0"><p class="empty m-0">No changes waiting.</p></div>';
  }
  $('idone').innerHTML = !inbox.decided.length ? '<p class="empty">Nothing decided yet.</p>' :
    '<div class="scroll" style="border:0;margin:0"><table><tr><th>Decided</th><th>Task</th><th>From</th><th>Decision</th><th>By</th></tr>' +
    inbox.decided.map(it => `<tr><td>${esc(when(it.decidedAt))}</td><td>${esc(it.task.taskId)}</td><td>${esc(SOURCES[it.source] || it.source)}</td><td>` +
      (it.status === 'approved'
        ? `<span class="good">Approved</span>${it.result?.jiraKey ? ` · ${link(it.result.url, it.result.jiraKey)}` : ''} <span class="muted">(${esc(it.result?.actions?.join(', ') || 'no changes')})</span>`
        : `<span class="${it.status === 'rejected' ? 'errt' : 'muted'}">${DECISIONS[it.status] || it.status}</span>${it.reason ? ` <span class="muted">${esc(it.reason)}</span>` : ''}`) +
      `</td><td>${esc(it.decidedBy || '')}</td></tr>`).join('') + '</table></div>';
}

$('ilist').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !needPass(ishow)) return;
  const card = btn.closest('.item'), id = card.dataset.id, msg = card.querySelector('.msg');
  const say = (kind, html) => { msg.className = 'msg ' + kind; msg.innerHTML = html; };
  let reason = '';
  if (btn.dataset.act === 'reject') {
    reason = prompt('Reject this change? It will not be sent to Jira.\n\nReason (optional):');
    if (reason === null) return;
  }
  // Conflicts where "Jira" was picked: those fields are left out of the send
  const keepJira = [...card.querySelectorAll('input[type=radio][value=jira]:checked')].map(r => r.dataset.field);
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });
  say('info', btn.dataset.act === 'approve' ? 'Checking again and sending to Jira…' : 'Rejecting…');
  try {
    const item = await api(`ui/inbox/${encodeURIComponent(id)}/${btn.dataset.act}`, postJson({ reason, keepJira }));
    if (item.status === 'approved') {
      sent();
      say('ok', item.result.jiraKey
        ? `Sent: ${link(item.result.url, item.result.jiraKey)} (${esc(item.result.actions.join(', ') || 'no changes')})` + (item.result.warning ? `<br>Note: ${esc(item.result.warning)}` : '')
        : 'Done: Jira\'s values were kept, nothing was sent.');
    } else say('ok', 'Rejected. Nothing was sent to Jira.');
    card.classList.add('gone');
    setTimeout(loadInbox, 1500);
  } catch (err) {
    say('err', esc(err.message) + (err.errors?.length ? '<ul>' + err.errors.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''));
    card.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
});
$('irefresh').addEventListener('click', loadInbox);

// Google Sheet: look for new / changed rows now
$('isheetCheck').addEventListener('click', async () => {
  if (!needPass(ishow)) return;
  $('isheetCheck').disabled = true;
  ishow('info', 'Reading the Google Sheet…');
  try {
    const p = await api('ui/sheet/check', postJson({}));
    ishow('ok', `Sheet checked: ${p.rows} rows · ${p.queued} new change${p.queued === 1 ? '' : 's'} · ${p.updated} updated · ${p.unchanged} unchanged` +
      (p.withdrawn ? ` · ${p.withdrawn} withdrawn (changed back)` : '') + (p.skipped ? ` · ${p.skipped} skipped` : ''));
    await loadInbox();
  } catch (err) {
    ishow('err', 'Sheet check failed: ' + esc(err.message));
  } finally {
    $('isheetCheck').disabled = false;
  }
});
// Keep the badge current while the page is open
setInterval(() => { if (document.visibilityState === 'visible') loadInbox(); }, 30000);
