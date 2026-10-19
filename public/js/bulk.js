// Bulk upload tab: read an Excel / CSV file, review the rows in a full-screen dialog (before ->
// after for updates, fix a row in place), send the ticked ones, retry failures, download results.

// rows: [{ row, raw, task, fileErrors, errors, warnings, info, selected, checking, sending, done, result, editing }]
//   raw  = the row as read from the file (edited in place); task = the checked version that is sent
let bulk = null;
let running = false, stopAsked = false, btab = 'all';

// Both the tab and the dialog show progress messages
function bshow(kind, html) { for (const id of ['bmsg', 'bmmsg']) { const m = $(id); m.className = 'msg ' + kind; m.innerHTML = html; } }
const bclear = () => { $('bmsg').className = 'msg'; $('bmmsg').className = 'msg'; };

const allErrors = r => [...r.fileErrors, ...r.errors];
const sendable = r => r.selected && !r.done && !r.checking && !r.editing && !allErrors(r).length;
const failedRow = r => r.result && !r.result.ok;

// ---------- Read the file, then check its rows against Jira ----------
async function uploadFile(file) {
  if (!file || !needPass(bshow)) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) return bshow('err', 'Choose an .xlsx or .csv file. Old .xls files: open in Excel and use Save As .xlsx.');
  if (file.size > 5 * 1024 * 1024) return bshow('err', 'The file is larger than 5 MB.');
  bulk = null;
  $('bpreview').hidden = true;
  bshow('info', `Reading <b>${esc(file.name)}</b>…`);
  let mine;
  try {
    // Step 1: the server reads the file and finds duplicates inside it
    const out = await api('ui/bulk/parse', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    mine = bulk = { ...out, fileName: file.name, rows: out.rows.map(r => ({
      row: r.row, raw: { ...r.task }, task: r.task, fileErrors: r.errors, errors: [], warnings: [], info: r.info, checking: true, selected: false,
    })) };
    btab = 'all';
    openReview();
  } catch (err) {
    return bshow('err', esc(err.message));
  }
  // Step 2: check the rows against Jira a few at a time, so every request stays short
  const rows = mine.rows, size = mine.checkChunk || 5;
  for (let i = 0; i < rows.length; i += size) {
    if (bulk !== mine) return; // another file was chosen meanwhile
    bshow('info', `Checking rows against Jira: ${i} of ${rows.length}…`);
    const chunk = rows.slice(i, i + size);
    try {
      await checkRows(chunk);
    } catch (err) {
      for (const r of rows.slice(i)) Object.assign(r, { errors: ['Not checked: ' + err.message], checking: false, selected: false });
      if (bulk === mine) { renderBulk(); bshow('err', 'Checking stopped: ' + esc(err.message)); }
      return;
    }
    if (bulk === mine) renderBulk();
  }
  if (bulk === mine) bclear();
}

async function checkRows(chunk) {
  const out = await api('ui/bulk/check', postJson({ rows: chunk.map(r => ({ row: r.row, task: r.raw })) }));
  out.rows.forEach((c, j) => {
    const r = chunk[j];
    Object.assign(r, { task: c.task, errors: c.errors, warnings: c.warnings, info: { ...r.info, ...c.info }, checking: false });
    r.selected = !allErrors(r).length && !r.info.suggestUntick;
  });
}
$('file').addEventListener('change', () => { uploadFile($('file').files[0]); $('file').value = ''; });
for (const ev of ['dragenter', 'dragover']) $('drop').addEventListener(ev, () => $('drop').classList.add('over'));
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, () => $('drop').classList.remove('over'));

// ---------- The review dialog ----------
function openReview() {
  $('bmTitle').textContent = `Review ${bulk.fileName}`;
  fillDatalist($('bUsers'), opts.users.map(u => ({ value: u.email || u.name, text: u.name })));
  fillDatalist($('bSprints'), opts.sprints.map(s => ({ value: s.name, text: s.state })));
  fillDatalist($('bPriorities'), opts.priorities.map(p => ({ value: p })));
  fillDatalist($('bStatuses'), opts.statuses.map(s => ({ value: s })));
  renderBulk();
  if (!$('bm').open) $('bm').showModal();
}
$('bopen').addEventListener('click', openReview);
$('bmClose').addEventListener('click', () => $('bm').close());
$('bm').addEventListener('close', () => { if (bulk) { $('bpreview').hidden = false; $('bfile').innerHTML = `<b>${esc(bulk.fileName)}</b>: ${bulk.rows.length} rows`; } });
$('bm').addEventListener('cancel', e => { if (running) e.preventDefault(); }); // Esc doesn't hide a send in progress

const TABS_B = [
  ['all', 'All', () => true],
  ['errors', 'Problems', r => !r.checking && allErrors(r).length],
  ['warnings', 'Warnings', r => !r.checking && !allErrors(r).length && (r.warnings.length || r.info.suggestUntick)],
  ['creates', 'New tickets', r => !r.checking && !allErrors(r).length && r.info.action === 'create'],
  ['updates', 'Updates', r => !r.checking && !allErrors(r).length && r.info.action === 'update'],
  ['sent', 'Sent', r => r.done],
  ['failed', 'Failed', failedRow],
];
const inTab = r => TABS_B.find(t => t[0] === btab)[2](r);

// "Possible duplicate" lines with links to the matching Jira tickets / file rows
function duplicateNotes(info) {
  const out = [];
  if (info.duplicates?.length)
    out.push('Same title already in Jira: ' + info.duplicates.map(d => `${link(d.url, d.key)} (${esc(d.status)})`).join(', '));
  if (info.sameTitleRow) out.push(`Same title as row ${info.sameTitleRow} in this file`);
  return out;
}

function checksCell(r) {
  if (r.sending) return '<span class="muted">Sending…</span>';
  if (r.checking) return '<span class="muted">Checking…</span>';
  if (r.result?.ok) {
    const what = r.result.actions.includes('created') ? 'Created' : 'Updated';
    return `<div class="good">✓ ${what} ${link(r.result.url, r.result.jiraKey)}</div>` +
      (r.result.warning ? `<div class="warnt">${esc(r.result.warning)}</div>` : '');
  }
  if (r.result) return `<div class="errt">✗ ${esc(r.result.error)}</div>`;
  const lines = allErrors(r).map(x => `<div class="errt">✗ ${esc(x)}</div>`)
    .concat(duplicateNotes(r.info).map(x => `<div class="warnt">! Possible duplicate. ${x}. Tick the row only if you want another ticket.</div>`))
    .concat(r.warnings.map(x => `<div class="warnt">! ${esc(x)}</div>`));
  return lines.join('') || '<span class="good">Ready</span>';
}

// Columns: [field in the task, header, what the ticket has now (updates only)]
const BCOLS = [
  ['title', 'Title', c => c.title],
  ['assigneeEmail', 'Assignee', c => c.assigneeName],
  ['parentKey', 'Parent', c => c.parentKey],
  ['startDate', 'Start', c => c.startDate],
  ['dueDate', 'End', c => c.dueDate],
  ['originalEstimate', 'Estimate', c => c.originalEstimate],
  ['sprint', 'Sprint', c => c.sprint],
  ['labels', 'Labels', c => c.labels],
  ['fixVersions', 'Fix version', c => c.fixVersions],
  ['priority', 'Priority', c => c.priority],
  ['status', 'Status', c => c.status],
  ['fields', 'More fields', c => c.fields],
];
const LIST_COLS = ['labels', 'fixVersions'];

// A value cell: for an update, the ticket's value struck through when the file changes it
function valueCell(r, k, now) {
  const t = r.task;
  let v = k === 'assigneeEmail' ? (r.info.assigneeName || t.assigneeEmail || '') : k === 'status' ? (r.info.statusName || t.status || '') : (t[k] || '');
  const cur = r.info.current;
  if (k === 'fields') return `<td class="wrap">${Object.entries(t.fields || {}).map(([id, x]) => {
    const was = cur?.fields?.[id] ?? '', name = esc(extraName(id, r.info));
    return `<div>${name}: ${cur && was && was !== x ? `<span class="was">${esc(extraShown(id, was))}</span> → ` : ''}<span class="${cur && was === x ? 'same' : 'new'}">${esc(extraShown(id, x))}</span></div>`;
  }).join('')}</td>`;
  if (!v) return '<td></td>';
  if (!cur) return `<td${k === 'title' ? ' class="wrap"' : ''}>${esc(v)}${k === 'title' ? descLine(t) : ''}</td>`;
  const was = now(cur) || '';
  if (LIST_COLS.includes(k)) { // added to what the ticket has
    const added = splitList(v).filter(x => !splitList(was).some(w => sameText(w, x)));
    return `<td>${was ? `<span class="same">${esc(was)}</span>` : ''}${added.length ? `${was ? ' + ' : ''}<span class="new">${esc(added.join(', '))}</span>` : ''}</td>`;
  }
  if (sameText(was, v)) return `<td class="same${k === 'title' ? ' wrap' : ''}" title="No change">${esc(v)}</td>`;
  return `<td${k === 'title' ? ' class="wrap"' : ''}>${was ? `<span class="was">${esc(was)}</span> → ` : ''}<span class="new">${esc(v)}</span>${k === 'title' ? descLine(t) : ''}</td>`;
}
const descLine = t => t.description ? `<div class="muted">${esc(t.description.length > 90 ? t.description.slice(0, 90) + '…' : t.description)}</div>` : '';

// Fields the row editor offers (file values; checked again on save)
const EDIT_FIELDS = [
  ['jiraKey', 'Jira key', ''], ['title', 'Title', '', 'full'], ['description', 'Description', '', 'full', 'textarea'],
  ['assigneeEmail', 'Assignee (email or name)', 'bUsers'], ['parentKey', 'Parent ticket', 'parentList'],
  ['startDate', 'Start date', ''], ['dueDate', 'End date', ''], ['originalEstimate', 'Estimate', ''],
  ['sprint', 'Sprint', 'bSprints'], ['labels', 'Labels', 'labelList'], ['fixVersions', 'Fix version', 'versionList'],
  ['priority', 'Priority', 'bPriorities'], ['status', 'Status', 'bStatuses'],
];
function editRow(r, i) {
  const field = ([k, label, dl, wide, kind]) => `<div class="${wide || ''}"><label>${label}</label>` + (kind === 'textarea'
    ? `<textarea data-f="${k}" rows="2">${esc(r.raw[k] || '')}</textarea>`
    : `<input data-f="${k}" value="${esc(r.raw[k] || '')}"${dl ? ` list="${dl}"` : ''}>`) + '</div>';
  return `<tr class="editing" data-i="${i}"><td colspan="${BCOLS.length + 5}"><b>Row ${r.row}</b> <span class="muted">Task ID ${esc(r.raw.taskId)}</span>` +
    `<div class="editgrid">${EDIT_FIELDS.map(field).join('')}</div>` +
    `<div class="row tight"><button class="primary" type="button" data-act="save">Save and check again</button>` +
    `<button class="ghost" type="button" data-act="cancel">Cancel</button></div></td></tr>`;
}

function renderBulk() {
  const rows = bulk.rows;
  const checking = rows.filter(r => r.checking).length;
  const problems = rows.filter(r => !r.checking && allErrors(r).length).length;
  const maybeDupes = rows.filter(r => !r.checking && !allErrors(r).length && r.info.suggestUntick).length;
  const todo = rows.filter(sendable);
  const creates = todo.filter(r => r.info.action === 'create').length, updates = todo.length - creates;
  $('bsummary').innerHTML = `${rows.length} row${rows.length === 1 ? '' : 's'} · ` +
    (checking ? `<span class="muted">${checking} still being checked</span> · ` : '') +
    `<span class="good">${rows.length - checking - problems - maybeDupes} ready</span>` +
    (maybeDupes ? ` · <span class="warnt">${maybeDupes} possible duplicate${maybeDupes === 1 ? '' : 's'} (unticked)</span>` : '') +
    (problems ? ` · <span class="errt">${problems} with problems (not sent)</span>` : '') +
    (bulk.ignoredColumns.length ? ` · <span class="muted">ignored columns: ${esc(bulk.ignoredColumns.join(', '))}</span>` : '');

  $('btabs').innerHTML = TABS_B.map(([id, name, test]) => {
    const n = rows.filter(test).length;
    return (id === 'sent' || id === 'failed') && !n ? '' :
      `<button type="button" role="tab" data-tab="${id}" aria-selected="${btab === id}">${name}<span class="count">${n}</span></button>`;
  }).join('');

  const shown = rows.map((r, i) => [r, i]).filter(([r]) => inTab(r));
  const eligible = shown.filter(([r]) => !allErrors(r).length && !r.done && !r.checking && !r.editing);
  const allOn = eligible.length && eligible.every(([r]) => r.selected);
  $('btable').innerHTML =
    `<thead><tr><th><input type="checkbox" id="ball" aria-label="Tick all ready rows shown" ${allOn ? 'checked' : ''} ${running || !eligible.length ? 'disabled' : ''}></th>` +
    '<th>Row</th><th>Will</th><th>Checks / result</th>' + BCOLS.map(c => `<th>${c[1]}</th>`).join('') + '<th></th></tr></thead><tbody>' +
    (shown.length ? '' : `<tr><td colspan="${BCOLS.length + 5}" class="empty">No rows here.</td></tr>`) +
    shown.map(([r, i]) => {
      if (r.editing) return editRow(r, i);
      const will = r.info.action === 'update' ? `Update ${link(r.info.url, r.info.existingKey)}` : r.info.action === 'create' ? 'Create' : '–';
      const locked = allErrors(r).length || r.done || r.checking || running;
      return `<tr class="${allErrors(r).length || failedRow(r) ? 'bad' : ''}" data-i="${i}">` +
        `<td><input type="checkbox" data-i="${i}" aria-label="Send row ${r.row}" ${r.selected && !r.done ? 'checked' : ''} ${locked ? 'disabled' : ''}></td>` +
        `<td>${r.row}</td><td>${will}</td><td class="wrap checks">${checksCell(r)}</td>` +
        BCOLS.map(([k, , now]) => valueCell(r, k, now)).join('') +
        `<td>${r.done || r.checking || running ? '' : '<button class="ghost" type="button" data-act="edit">Edit</button>'}</td></tr>`;
    }).join('') + '</tbody>';

  $('bsel').textContent = todo.length ? `${todo.length} ticked` : '';
  $('bgo').textContent = todo.length
    ? `Send ${todo.length} to Jira (${creates} new, ${updates} update${updates === 1 ? '' : 's'})` : 'Nothing ticked to send';
  $('bgo').disabled = running || !!checking || !todo.length;
  $('btick').disabled = $('buntick').disabled = running;
  $('breset').disabled = running;
  $('bstop').hidden = !running;
  $('bretry').hidden = running || !rows.some(failedRow);
  $('bresults').hidden = running || !rows.some(r => r.result);
}

$('btabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { btab = b.dataset.tab; renderBulk(); } });

$('btable').addEventListener('change', e => {
  if (!bulk || running) return;
  if (e.target.id === 'ball') bulk.rows.forEach(r => { if (inTab(r) && !allErrors(r).length && !r.done && !r.checking) r.selected = e.target.checked; });
  else if (e.target.type === 'checkbox' && e.target.dataset.i) bulk.rows[+e.target.dataset.i].selected = e.target.checked;
  renderBulk();
});
$('btick').addEventListener('click', () => { bulk.rows.forEach(r => { if (inTab(r) && !allErrors(r).length && !r.done && !r.checking && !r.editing) r.selected = true; }); renderBulk(); });
$('buntick').addEventListener('click', () => { bulk.rows.forEach(r => { if (inTab(r)) r.selected = false; }); renderBulk(); });

// ---------- Fix a row in place ----------
$('btable').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !bulk || running) return;
  const tr = btn.closest('tr[data-i]'), r = bulk.rows[+tr.dataset.i];
  if (btn.dataset.act === 'edit') { r.editing = true; renderBulk(); $('btable').querySelector(`tr[data-i="${tr.dataset.i}"] [data-f="title"]`)?.focus(); return; }
  if (btn.dataset.act === 'cancel') { r.editing = false; renderBulk(); return; }
  if (btn.dataset.act === 'save') {
    const raw = { taskId: r.raw.taskId, ...(r.raw.fields && { fields: r.raw.fields }) };
    for (const input of tr.querySelectorAll('[data-f]')) { const v = input.value.trim(); if (v) raw[input.dataset.f] = v; }
    r.raw = raw;
    r.editing = false;
    r.checking = true;
    r.result = null;
    refreshFileDuplicates();
    renderBulk();
    try { await checkRows([r]); }
    catch (err) { Object.assign(r, { errors: ['Not checked: ' + err.message], checking: false, selected: false }); }
    renderBulk();
  }
});

// After an edit, Task IDs / Jira keys used by two rows are found again (the server did it for the file)
function refreshFileDuplicates() {
  const first = new Map();
  for (const r of bulk.rows) {
    r.fileErrors = [];
    for (const id of [r.raw.taskId && !r.info.autoTaskId && `Task ID ${r.raw.taskId}`, r.raw.jiraKey && `Jira key ${r.raw.jiraKey.toUpperCase()}`]) {
      if (!id) continue;
      if (first.has(id)) r.fileErrors.push(`${id} is also on row ${first.get(id)}`); else first.set(id, r.row);
    }
  }
}

// ---------- Send the ticked rows, one at a time ----------
async function sendTicked() {
  const todo = bulk?.rows.filter(sendable) || [];
  if (!todo.length || running || !needPass(bshow)) return;
  running = true; stopAsked = false;
  $('bstop').disabled = false; $('bstop').textContent = 'Stop after this row';
  $('bprog').hidden = false; $('bprog').max = todo.length; $('bprog').value = 0;
  let created = 0, updated = 0, failed = 0, halted = '';
  bshow('info', `Sending ${todo.length} row${todo.length === 1 ? '' : 's'} to Jira, one at a time…`);
  for (const r of todo) {
    if (stopAsked) { halted = 'Stopped before the remaining rows.'; break; }
    r.sending = true; renderBulk();
    try {
      const out = await api('ui/task', { ...postJson(r.task), headers: { 'Content-Type': 'application/json', 'X-Source': 'bulk' } });
      r.result = { ok: true, ...out };
      r.done = true;
      out.actions.includes('created') ? created++ : updated++;
      sent();
    } catch (err) {
      r.result = { ok: false, error: err.message };
      failed++;
      // A wrong passcode or a stopped server will fail every row, so stop here
      if (err.status === 401 || err.status === 503 || !err.status) { halted = 'Stopped: ' + err.message; r.sending = false; break; }
    }
    r.sending = false;
    $('bprog').value++;
  }
  running = false;
  $('bprog').hidden = true;
  renderBulk();
  const summary = `Finished: ${created} created, ${updated} updated` + (failed ? `, ${failed} failed` : '') + '.';
  bshow(failed || halted ? 'err' : 'ok', esc(summary) + (halted ? ' ' + esc(halted) : '') +
    (failed ? ' Use "Retry failed rows" to send them again.' : halted ? ' Rows not sent are still ticked; click Send to continue.' : ''));
}
$('bgo').addEventListener('click', sendTicked);
$('bstop').addEventListener('click', () => { stopAsked = true; $('bstop').disabled = true; $('bstop').textContent = 'Stopping…'; });
$('bretry').addEventListener('click', () => {
  for (const r of bulk.rows) if (failedRow(r)) { r.result = null; r.selected = true; }
  btab = 'all';
  sendTicked();
});

// One line per row: what happened to it
$('bresults').addEventListener('click', () => {
  const outcome = r => r.result?.ok ? (r.result.actions.includes('created') ? 'Created' : 'Updated')
    : r.result ? 'Failed' : allErrors(r).length ? 'Not sent (problems)' : 'Not sent';
  downloadCsv(`${bulk.fileName.replace(/\.(xlsx|csv)$/i, '')}-results.csv`, [
    ['Row', 'Task ID', 'Title', 'Result', 'Jira key', 'Link', 'Message'],
    ...bulk.rows.map(r => [r.row, r.raw.taskId, r.raw.title, outcome(r), r.result?.jiraKey || r.info.existingKey || '', r.result?.url || r.info.url || '',
      r.result?.error || r.result?.warning || allErrors(r).join('; ')]),
  ]);
});

$('breset').addEventListener('click', () => {
  bulk = null; $('bpreview').hidden = true; bclear();
  $('file').click();
});

// Template is built here rather than downloaded, so it works even where the server isn't reachable
$('tmpl').addEventListener('click', e => {
  e.preventDefault();
  const extras = orderedExtras().filter(f => sharedVisible(f.id)).map(f => f.name);
  const rows = [
    ['Task ID', 'Jira key', 'Title', 'Description', 'Assignee', 'Parent ticket', 'Start date', 'End date',
      'Original estimate', 'Sprint', 'Labels', 'Fix version', 'Priority', 'Status', ...extras],
    ['T-2001', '', 'Example: configure outage SMS template (delete this row)', 'Set up the SMS text sent during outages.',
      'name@company.com', '', '2026-10-20', '2026-10-24', '1d 4h', '', 'sms, outage', '', 'Medium', 'To Do', ...extras.map(() => '')],
  ];
  downloadCsv('jira-bulk-template.csv', rows);
});
