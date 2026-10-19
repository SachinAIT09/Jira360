// AI suggestions (shown only when the server has AI on). Nothing here sends to Jira: suggestions
// fill the form or a bulk row, and the normal review and confirm still follow.

function aishow(kind, html) { const m = $('aimsg'); m.className = 'msg ' + kind; m.innerHTML = html; }
let aiAction = null; // what "aiGo" does in the current dialog

function openAi(title, bodyHtml, goText, action) {
  $('aiTitle').textContent = title;
  $('aiBody').innerHTML = bodyHtml;
  $('aimsg').className = 'msg';
  $('aiGo').textContent = goText;
  $('aiGo').disabled = false;
  aiAction = action;
  if (!$('ai').open) $('ai').showModal();
}
$('aiCancel').addEventListener('click', () => $('ai').close());
$('aiGo').addEventListener('click', async () => {
  if (!aiAction) return;
  $('aiGo').disabled = true;
  try { await aiAction(); } finally { $('aiGo').disabled = false; }
});

// A table of suggestions, each with a tick box (all ticked); returns the ticked keys on apply
function suggestionTable(rows) {
  return '<table class="sugg"><tr><th></th><th>Field</th><th>Suggestion</th><th>Why</th></tr>' + rows.map(r =>
    `<tr><td><input type="checkbox" data-k="${esc(r.key)}" checked aria-label="Use ${esc(r.label)}"></td><td>${esc(r.label)}</td>` +
    `<td class="val"><div>${r.before ? `<span class="was">${esc(r.before)}</span><br>` : ''}${esc(r.value)}</div></td>` +
    `<td class="muted">${esc(r.reason || '')}</td></tr>`).join('') + '</table>';
}
const tickedKeys = () => [...$('aiBody').querySelectorAll('input[data-k]:checked')].map(i => i.dataset.k);

// ---------- Draft a ticket from free text ----------
$('aiDraftBtn').addEventListener('click', () => {
  openAi('Draft a ticket from text',
    '<p class="hint">Paste an email, a chat message or meeting notes. The AI suggests a title, a description with acceptance criteria, and the other fields. You choose what goes into the form.</p>' +
    '<label for="aiText" style="margin-top:12px">Text</label><textarea id="aiText" placeholder="Paste the request here"></textarea>',
    'Suggest', draftSuggest);
  $('aiText').focus();
});

async function draftSuggest() {
  const text = $('aiText').value.trim();
  if (!text) return aishow('err', 'Paste some text first.');
  if (!needPass(aishow)) return;
  aishow('info', 'Asking the AI…');
  let s;
  try { s = await api('ui/ai/draft', postJson({ text })); }
  catch (err) { return aishow('err', esc(err.message)); }
  const why = Object.fromEntries((s.reasons || []).map(r => [r.field, r.reason]));
  const user = opts.users.find(u => u.email && sameText(u.email, s.assigneeEmail || ''));
  const parent = opts.parents.find(p => p.key === s.parentKey);
  const rows = [
    ['title', 'Title', s.title], ['description', 'Description', s.description],
    ['assigneeEmail', 'Assignee', user ? `${user.name} (${user.email})` : ''],
    ['parentKey', 'Parent ticket', parent ? `${parent.key}: ${parent.summary}` : ''],
    ['priority', 'Priority', s.priority], ['labels', 'Labels', (s.labels || []).join(', ')],
    ['originalEstimate', 'Original estimate', s.originalEstimate], ['sprint', 'Sprint', s.sprint],
  ].filter(r => r[2]).map(([key, label, value]) => ({ key, label, value, reason: why[key] || why[label.toLowerCase()] || '' }));
  if (!rows.length) return aishow('err', 'The AI had no suggestions for this text.');
  openAi('AI suggestions', '<p class="hint">Untick anything you don\'t want. Ticked fields replace what is in the form.</p>' + suggestionTable(rows),
    'Fill the form', () => fillFromDraft(s, user));
}

function fillFromDraft(s, user) {
  const use = new Set(tickedKeys());
  if (use.has('title')) $('title').value = s.title;
  if (use.has('description')) $('description').value = s.description;
  if (use.has('assigneeEmail') && user) ensureOption($('assigneeId'), user.id, user.name);
  if (use.has('parentKey')) { $('parentKey').value = s.parentKey; showParentInfo(); }
  if (use.has('priority')) ensureOption($('priority'), s.priority);
  if (use.has('labels')) pickers.labels.set([...splitList($('labels').value), ...s.labels]);
  if (use.has('originalEstimate')) $('originalEstimate').value = s.originalEstimate;
  if (use.has('sprint')) ensureOption($('sprint'), s.sprint);
  $('ai').close();
  show('info', `Filled ${use.size} field${use.size === 1 ? '' : 's'} from the AI's suggestions. Check them, then review and send.`);
  $('title').focus();
}

// ---------- Improve the wording of the title / description ----------
$('aiRewriteBtn').addEventListener('click', async e => {
  e.preventDefault(); // the button sits inside a label
  const title = $('title').value.trim(), description = $('description').value.trim();
  if (!title && !description) return show('err', 'Write a title or description first, then ask the AI to improve it.');
  if (!needPass(show)) return;
  openAi('Improve wording', '<p class="muted">Asking the AI…</p>', 'Use the ticked changes', null);
  let s;
  try { s = await api('ui/ai/rewrite', postJson({ title, description })); }
  catch (err) { $('aiBody').innerHTML = ''; return aishow('err', esc(err.message)); }
  const rows = [['title', 'Title', title, s.title], ['description', 'Description', description, s.description]]
    .filter(([, , before, after]) => after && after.trim() !== before).map(([key, label, before, value]) => ({ key, label, before, value }));
  if (!rows.length) { $('aiBody').innerHTML = '<p>The AI found nothing to improve.</p>'; return; }
  $('aiBody').innerHTML = (s.notes ? `<p class="hint">${esc(s.notes)}</p>` : '') + suggestionTable(rows);
  aiAction = () => {
    const use = new Set(tickedKeys());
    if (use.has('title')) $('title').value = s.title;
    if (use.has('description')) $('description').value = s.description;
    $('ai').close();
    show('info', 'Wording updated. Check it, then review and send.');
  };
});

// ---------- Review dialog of a new ticket: tickets that mean the same thing ----------
const openPreviewBase = openPreview;
let similarRun = 0;
openPreview = function (p) {
  openPreviewBase(p);
  if (!document.body.classList.contains('ai-on') || p.info.action !== 'create' || !p.task.title) return;
  const run = ++similarRun;
  const box = document.createElement('div');
  box.className = 'note';
  box.innerHTML = '<span class="muted">Looking for similar open tickets (AI)…</span>';
  $('pvBody').append(box);
  api('ui/ai/similar', postJson({ title: p.task.title, description: p.task.description || '' })).then(({ similar }) => {
    if (run !== similarRun || !$('pv').open) return;
    if (!similar.length) { box.remove(); return; }
    box.className = 'note warn';
    box.innerHTML = '<b>Similar open tickets (AI):</b><ul>' + similar.map(x =>
      `<li>${link(x.url, x.key)} ${esc(x.summary)} <span class="muted">(${esc(x.status)}) · ${esc(x.reason)}</span></li>`).join('') +
      '</ul>Confirm only if this is really new work.';
  }, () => { if (run === similarRun) box.remove(); }); // the check is a help, not a gate
};

// ---------- Bulk review: suggested fixes for rows with problems ----------
const aiFixable = r => !r.checking && !r.done && !r.editing && r.errors.length;
const renderBulkBase = renderBulk;
renderBulk = function () {
  renderBulkBase();
  const n = bulk.rows.filter(aiFixable).length, pendingFixes = bulk.rows.some(r => r.aiFix?.length);
  $('baifix').hidden = running || !n;
  $('baifix').textContent = `Suggest fixes with AI (${n} row${n === 1 ? '' : 's'})`;
  $('baiall').hidden = running || !pendingFixes;
};
const checksCellBase = checksCell;
checksCell = function (r) {
  const base = checksCellBase(r);
  if (!r.aiFix?.length || r.checking || r.done) return base;
  return base + r.aiFix.map((f, j) => `<div class="aifix">AI: set <b>${esc(BULK_FIELD_NAMES[f.field] || f.field)}</b> to <b>${esc(f.value)}</b>` +
    ` <span class="muted">${esc(f.reason)}</span><button class="ghost" type="button" data-act="aiapply" data-j="${j}">Use</button></div>`).join('');
};
const BULK_FIELD_NAMES = { assigneeEmail: 'Assignee', parentKey: 'Parent', startDate: 'Start date', dueDate: 'End date', originalEstimate: 'Estimate',
  sprint: 'Sprint', fixVersions: 'Fix version', priority: 'Priority', status: 'Status' };

$('baifix').addEventListener('click', async () => {
  const rows = bulk.rows.filter(aiFixable);
  $('baifix').disabled = true;
  bshow('info', `Asking the AI about ${rows.length} row${rows.length === 1 ? '' : 's'}…`);
  let found = 0;
  try {
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20);
      const { fixes } = await api('ui/ai/fix-rows', postJson({ rows: chunk.map(r => ({ row: r.row, task: r.raw, errors: r.errors })) }));
      for (const r of chunk) { r.aiFix = fixes.filter(f => f.row === r.row); found += r.aiFix.length; }
      renderBulk();
    }
    bshow(found ? 'ok' : 'info', found ? `The AI suggested ${found} fix${found === 1 ? '' : 'es'}. Click "Use" on each one you agree with, or "Use all AI fixes".` : 'The AI found no confident fixes. Use "Edit" to fix the rows.');
  } catch (err) {
    bshow('err', 'AI suggestions failed: ' + esc(err.message));
  } finally {
    $('baifix').disabled = false;
  }
});

// Using a fix changes the row as if it had been edited, then checks it again
async function useFixes(r, fixes) {
  for (const f of fixes) r.raw[f.field] = f.value;
  r.aiFix = (r.aiFix || []).filter(f => !fixes.includes(f));
  r.checking = true; r.result = null;
  renderBulk();
  try { await checkRows([r]); }
  catch (err) { Object.assign(r, { errors: ['Not checked: ' + err.message], checking: false, selected: false }); }
}
$('btable').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act="aiapply"]');
  if (!btn || running) return;
  const r = bulk.rows[+btn.closest('tr[data-i]').dataset.i];
  await useFixes(r, [r.aiFix[+btn.dataset.j]]);
  renderBulk();
});
$('baiall').addEventListener('click', async () => {
  const rows = bulk.rows.filter(r => r.aiFix?.length);
  await Promise.all(rows.map(r => useFixes(r, [...r.aiFix])));
  renderBulk();
  bshow('ok', `Used the AI fixes on ${rows.length} row${rows.length === 1 ? '' : 's'}; they were checked again.`);
});

// ---------- Inbox: summary of everything waiting ----------
$('isum').addEventListener('click', async () => {
  if (!inbox.pending.length) return ishow('info', 'Nothing is waiting.');
  ishow('info', 'Asking the AI for a summary…');
  try {
    const s = await api('ui/ai/summarize', postJson({}));
    const taskOf = id => inbox.pending.find(x => x.id === id)?.task.taskId || id;
    ishow('info', `<b>Summary (AI):</b> ${esc(s.summary)}` + (s.risky?.length
      ? '<br><b>Worth a second look:</b><ul>' + s.risky.map(x => `<li>Task ${esc(taskOf(x.id))}: ${esc(x.reason)}</li>`).join('') + '</ul>' : ''));
  } catch (err) {
    ishow('err', 'Summary failed: ' + esc(err.message));
  }
});
