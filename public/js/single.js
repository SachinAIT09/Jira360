// Single ticket tab: live sync from Jira, review dialog, send.

// ---------- Single ticket: live sync from Jira ----------
// Fields filled from Jira. Every 10 s the page re-reads the ticket and refreshes any field
// you haven't edited since the last read; your unsent edits are kept.
const SYNCED = ['title', 'description', 'assigneeId', 'parentKey', 'startDate', 'dueDate',
  'originalEstimate', 'sprint', 'labels', 'fixVersions', 'priority', 'status'];
// Emptying one of these on an existing ticket removes the value in Jira
const CLEARABLE = ['assigneeId', 'startDate', 'dueDate', 'sprint', 'labels', 'fixVersions'];
const POLL_MS = 10000;
let loaded = null;   // { jiraKey, values, parent } as last read from Jira
let busy = false;

function show(kind, html) { const m = $('msg'); m.className = 'msg ' + kind; m.innerHTML = html; }
const setSync = html => { $('sync').innerHTML = html; };

// Puts a value from Jira into a field, whatever kind of field it is
function setField(k, v, out) {
  const el = $(k);
  if (k === 'assigneeId') ensureOption(el, v, out.assignee?.name);
  else if (k === 'sprint') ensureOption(el, v, v && `${v} (${out.sprintState || 'closed'})`);
  else if (el.tagName === 'SELECT') ensureOption(el, v);
  else el.value = v ?? '';
  if (pickers[k]) pickers[k].render();
}

function forgetTicket() {
  const hadTicket = !!loaded;
  loaded = null;
  showRecent(null);
  $('priority').options[0].text = 'Default';
  setStatusChoices(null);
  if (hadTicket) $('status').value = ''; // the old ticket's status means nothing for a new one
}

async function pullFromJira() {
  const jiraKey = $('jiraKey').value.trim(), taskId = $('taskId').value.trim();
  if (!passOk()) return; // signed out: keep the ticket and any unsent edits for after signing in
  if (!jiraKey && !taskId) { forgetTicket(); setSync(''); return; }
  if (busy) return;
  busy = true;
  // The key or task ID may change while a request is out; such answers are ignored
  const stale = () => jiraKey !== $('jiraKey').value.trim() || taskId !== $('taskId').value.trim();
  try {
    const q = new URLSearchParams();
    if (jiraKey) q.set('jiraKey', jiraKey);
    if (taskId) q.set('taskId', taskId);
    let out;
    try { out = await api('ui/issue?' + q); }
    catch (e) {
      if (stale()) return;
      if (e.status === 404 && !jiraKey) { forgetTicket(); setSync('New ticket: it will be created when you send.'); return; }
      throw e.status === 404 ? new Error(`${jiraKey} not found in Jira`) : e;
    }
    if (stale()) return;

    const same = loaded && loaded.jiraKey === out.jiraKey;
    // Status choices depend on the ticket's current status; keep a status you picked but haven't sent
    const statusEdited = same && $('status').value !== loaded.values.status;
    setStatusChoices(out.statusName, out.nextStatuses);
    if (!statusEdited) $('status').value = out.statusName;
    $('priority').options[0].text = 'No change';

    const snapshot = {};
    let kept = 0;
    for (const k of SYNCED) {
      if (same && $(k).value !== loaded.values[k]) { kept++; snapshot[k] = loaded.values[k]; continue; } // edited here
      setField(k, out.values[k], out);
      snapshot[k] = $(k).value; // what the field really holds
    }
    const extra = syncExtras(out, same);
    kept += extra.kept;
    loaded = { jiraKey: out.jiraKey, values: snapshot, fields: extra.snapshot, parent: out.parent };
    showRecent(out.recent);
    $('jiraKey').value = out.jiraKey;
    showParentInfo();

    setSync(`Synced with ${link(out.url, out.jiraKey)} · Status: <b>${esc(out.statusName)}</b>` +
      ` · checked ${new Date().toLocaleTimeString()}` + (kept ? ` · keeping ${kept} field${kept > 1 ? 's' : ''} you edited` : ''));
  } catch (err) {
    setSync('Jira sync failed: ' + esc(err.message));
  } finally {
    busy = false;
  }
}

// ---------- Latest comments and work logs of the loaded ticket (read-only) ----------
let recentShown = '';
function showRecent(recent) {
  const box = $('recent');
  if (!recent || (!recent.comments.length && !recent.worklogs.length)) { box.hidden = true; recentShown = ''; return; }
  const key = JSON.stringify(recent);
  if (key === recentShown) return; // unchanged: keep it as the person left it (open / scrolled)
  recentShown = key;
  const item = (who, at, extra, text) => `<div class="ritem"><b>${esc(who)}</b> <span class="muted">${esc(when(at))}${extra ? ' · ' + esc(extra) : ''}</span>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
  $('recentSum').textContent = `Latest in Jira: ${recent.comments.length} comment${recent.comments.length === 1 ? '' : 's'}, ${recent.worklogs.length} work log${recent.worklogs.length === 1 ? '' : 's'}`;
  $('recentBody').innerHTML =
    (recent.comments.length ? '<h3>Comments</h3>' + recent.comments.map(c => item(c.author, c.created, '', c.body)).join('') : '') +
    (recent.worklogs.length ? '<h3>Work logged</h3>' + recent.worklogs.map(w => item(w.author, w.started, w.timeSpent, w.comment)).join('') : '');
  box.hidden = false;
}

setInterval(() => { if (loaded && document.visibilityState === 'visible') pullFromJira(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (loaded && document.visibilityState === 'visible') pullFromJira(); });

// The server remembers which ticket each Task ID belongs to, so the Task ID alone loads it
$('taskId').addEventListener('change', pullFromJira);
$('jiraKey').addEventListener('change', pullFromJira);

// ---------- Log work: the "Set to" / "Reduce by" boxes are only active when chosen ----------
function syncEstimateInputs() {
  const choice = document.querySelector('input[name=adjustEstimate]:checked')?.value;
  $('newEstimate').disabled = choice !== 'new';
  $('reduceBy').disabled = choice !== 'manual';
}
for (const r of document.querySelectorAll('input[name=adjustEstimate]')) r.addEventListener('change', () => {
  syncEstimateInputs();
  const box = { new: 'newEstimate', manual: 'reduceBy' }[r.value];
  if (box) $(box).focus();
});
function clearLogWork() {
  for (const id of ['timeSpent', 'workDate', 'newEstimate', 'reduceBy', 'worklogNote']) $(id).value = '';
  document.querySelector('input[name=adjustEstimate][value=auto]').checked = true;
  syncEstimateInputs();
}
// The remaining-estimate choice in words (review dialog, Inbox)
function estimateText(t) {
  return { leave: 'Leave unchanged', new: `Set to ${t.newEstimate}`, manual: `Reduce by ${t.reduceBy}` }[t.adjustEstimate] || 'Adjust automatically';
}

$('clear').addEventListener('click', () => {
  $('f').reset(); $('msg').className = 'msg'; syncEstimateInputs();
  pickers.labels.clear(); pickers.fixVersions.clear();
  forgetTicket(); setSync(''); showParentInfo();
});

// ---------- Single ticket: preview, then send ----------
const LABELS = {
  title: 'Title', description: 'Description', assigneeId: 'Assignee', assigneeEmail: 'Assignee', parentKey: 'Parent ticket',
  startDate: 'Start date', dueDate: 'End date', originalEstimate: 'Original estimate', sprint: 'Sprint',
  labels: 'Labels', fixVersions: 'Fix version', priority: 'Priority', status: 'Status',
  comment: 'Comment', hoursSpent: 'Log work', timeSpent: 'Time spent', workDate: 'Started', adjustEstimate: 'Remaining estimate',
  worklogNote: 'Work description',
};
function shownValue(k, v, info) {
  if ((k === 'assigneeId' || k === 'assigneeEmail') && info.assigneeName) return info.assigneeName;
  if (k === 'parentKey' && info.parentSummary) return `${v}: ${info.parentSummary}`;
  if (k === 'status') return info.statusName || v;
  if (k === 'hoursSpent') return `${v} hours`;
  if (k === 'workDate') return new Date(v).toLocaleString();
  return v;
}
const noteList = (kind, title, items) => items.length
  ? `<div class="note ${kind}"><b>${title}</b><ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';

function setBusy(on, text) { $('go').disabled = on; $('go').textContent = on ? text : 'Review and send'; }

let pending = null;     // checked task waiting for "Confirm and send"
let pendingFrom = '';   // 'activity' when the preview was opened by Retry there

$('f').addEventListener('submit', async e => {
  e.preventDefault();
  if (!needPass(show)) return;
  if (!can('editor')) return show('err', 'Your role (viewer) can look at tickets but not send them.');
  // A tag typed but not yet confirmed with Enter still counts
  for (const k of Object.keys(pickers)) if ($(k + 'Input').value.trim()) $(k + 'Input').dispatchEvent(new Event('blur'));
  const data = {};
  for (const [k, v] of new FormData($('f'))) { const t = String(v).trim(); if (t) data[k] = t; }
  if (data.hoursSpent) data.hoursSpent = Number(data.hoursSpent);
  // Log work goes with a time spent only; "Date started" is sent as a full date-time (this computer's time zone)
  if (!data.timeSpent) for (const k of ['adjustEstimate', 'newEstimate', 'reduceBy', 'worklogNote']) delete data[k];
  else if ($('workDate').value) data.workDate = new Date($('workDate').value).toISOString();
  if (data.adjustEstimate === 'auto') delete data.adjustEstimate; // Jira's default
  // An existing ticket can be updated by its Jira key alone. A new one gets a Task ID if none was
  // given: it's how the ticket is found again later (shown in the form after sending).
  if (!data.taskId) data.taskId = data.jiraKey ? data.jiraKey.toUpperCase()
    : 'UI-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const extra = extraValues(loaded && sameText(loaded.jiraKey, data.jiraKey || ''));
  if (extra) data.fields = extra;
  // For a ticket loaded from Jira, send only what was changed here, so untouched fields
  // (like a richly formatted description) aren't rewritten. Emptied fields are removed in Jira.
  if (loaded && sameText(loaded.jiraKey, data.jiraKey || '')) {
    const clear = [];
    for (const k of SYNCED) {
      const now = (data[k] || ''), before = (loaded.values[k] || '').trim();
      if (now === before) delete data[k];
      else if (!now && CLEARABLE.includes(k)) clear.push(k);
    }
    if (clear.length) data.clear = clear;
    data.replaceLists = true; // labels / fix versions shown here are the full list
  }

  setBusy(true, 'Checking…');
  try {
    pending = await api('ui/preview', postJson(data));
    pendingFrom = '';
    openPreview(pending);
  } catch (err) {
    show('err', 'Failed: ' + esc(err.message));
  } finally {
    setBusy(false);
  }
});

// The review dialog groups the fields; for an update each one shows what the ticket has now -> what it will have
const PV_SECTIONS = [
  ['Details', ['title', 'description', 'assigneeId', 'assigneeEmail', 'parentKey']],
  ['Planning', ['startDate', 'dueDate', 'originalEstimate', 'sprint', 'labels', 'fixVersions', 'priority']],
  ['Status and comment', ['status', 'comment']],
  ['Log work', ['timeSpent', 'hoursSpent', 'workDate', 'adjustEstimate', 'worklogNote']],
];
function currentValue(k, info) {
  const c = info.current;
  if (!c) return '';
  if (k === 'assigneeId' || k === 'assigneeEmail') return c.assigneeName || '';
  return c[k] ?? '';
}
function pvRow(k, task, info) {
  const removed = (task.clear || []).includes(k);
  const now = removed ? '' : k === 'adjustEstimate' ? estimateText(task) : shownValue(k, task[k], info);
  const was = currentValue(k, info);
  // Labels / versions without replaceLists are added to what the ticket has
  const after = (k === 'labels' || k === 'fixVersions') && was && !task.replaceLists
    ? [...new Set([...splitList(was), ...splitList(now)])].join(', ') : now;
  const long = k === 'description' || k === 'comment';
  const show = v => long ? `<span class="long">${esc(v)}</span>` : esc(v);
  // The parent is shown as "KEY: title" but the ticket's value is just the key
  const changed = was && !sameText(was, k === 'parentKey' && !removed ? task[k] : after);
  return `<dt>${LABELS[k]}</dt><dd>` + (changed
    ? `<span class="was">${show(was)}</span>${long ? '' : ' → '}`
    : '') + (removed ? '<span class="remove">removed from the ticket</span>' : `<span class="new">${show(after)}</span>`) + '</dd>';
}

function openPreview({ task, errors, warnings, info }) {
  const update = info.action === 'update';
  const fields = Object.keys(LABELS).filter(k => (task[k] !== undefined && task[k] !== '' && !(k === 'assigneeEmail' && task.assigneeId)) || (task.clear || []).includes(k));
  const extras = extraReviewRows(task, info);
  const any = fields.length || extras;
  $('pvTitle').textContent = update ? `Update ${info.existingKey}` : `Create a new ticket in ${project}`;
  $('pvBody').innerHTML =
    `<p class="muted">Task ID ${esc(task.taskId)}${update ? ` · ${link(info.url, 'open in Jira')} · only the fields below change` : ''}</p>` +
    (any
      ? PV_SECTIONS.map(([name, keys]) => {
          const mine = keys.filter(k => fields.includes(k));
          return mine.length ? `<h3 class="pvsec">${name}</h3><dl class="kv">${mine.map(k => pvRow(k, task, info)).join('')}</dl>` : '';
        }).join('') + (extras ? `<h3 class="pvsec">More fields</h3><dl class="kv">${extras}</dl>` : '')
      : `<p>Nothing has changed, so there is nothing to send.</p>`) +
    noteList('err', 'Fix these before sending:', errors) +
    (info.duplicates?.length ? `<div class="note warn"><b>Possible duplicate.</b> ${duplicateNotes(info)[0]}. Confirm only if you really want another ticket.</div>` : '') +
    noteList('warn', 'Please note:', warnings);
  $('pvGo').disabled = !!errors.length || !any;
  $('pvGo').textContent = update ? 'Confirm and update' : 'Confirm and create';
  $('pv').showModal();
  (errors.length || !any ? $('pvBack') : $('pvGo')).focus();
}
$('pvBack').addEventListener('click', () => $('pv').close());

$('pvGo').addEventListener('click', async () => {
  $('pv').close();
  const task = pending.task;
  if (pendingFrom === 'activity') return retrySend(task);
  setBusy(true, 'Sending…');
  try {
    const out = await api('ui/task', postJson(task));
    sent();
    $('jiraKey').value = out.jiraKey;
    $('taskId').value = task.taskId;
    $('comment').value = ''; clearLogWork();
    loaded = null; pullFromJira(); // reload everything from Jira, including what was just sent
    show('ok', `Done: ${link(out.url, out.jiraKey)} (${esc(out.actions.map(actionText).join(', ') || 'no changes')})` +
      (out.warning ? `<br>Note: ${esc(out.warning)}` : ''));
  } catch (err) {
    show('err', 'Failed: ' + esc(err.message));
  } finally {
    setBusy(false);
  }
});

// ---------- Keyboard: Ctrl+Enter reviews (in the dialog: confirms), "/" jumps to the Task ID ----------
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if ($('pv').open) { e.preventDefault(); if (!$('pvGo').disabled) $('pvGo').click(); }
    else if (!$('singlePanel').hidden && !document.querySelector('dialog[open]')) { e.preventDefault(); $('f').requestSubmit(); }
    return;
  }
  const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
  if (e.key === '/' && !typing && !document.querySelector('dialog[open]') && !$('singlePanel').hidden) { e.preventDefault(); $('taskId').focus(); }
});
