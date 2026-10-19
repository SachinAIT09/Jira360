// Fields on the form: built-in ones can be switched off, and any other Jira field of the project can
// be switched on. A shared setting (saved on the server, for everyone) plus each person's own
// show / hide choices (kept in this browser).

let fieldInfo = { form: [], extra: [], notEditable: [], config: { hidden: [], order: [] } };
const myFieldPrefs = () => store.get('jira.fieldPrefs', {}); // { key: 'show' | 'hide' }
const isRequired = key => key === 'title' || fieldInfo.extra.some(f => f.id === key && f.required);
// The shared setting alone (the Excel template uses this: it is shared with others)
function sharedVisible(key) {
  if (isRequired(key)) return true;
  // Extra fields start hidden until someone switches them on; built-in ones start shown
  const extra = fieldInfo.extra.some(f => f.id === key);
  return extra ? fieldInfo.config.order.includes(key) && !fieldInfo.config.hidden.includes(key) : !fieldInfo.config.hidden.includes(key);
}
// What this person sees: their own choice first, then the shared setting
function fieldVisible(key) {
  const mine = myFieldPrefs()[key];
  if (!isRequired(key) && mine) return mine === 'show';
  return sharedVisible(key);
}
const orderedExtras = () => fieldInfo.extra.map((f, i) => [f, i])
  .sort((a, b) => ((fieldInfo.config.order.indexOf(a[0].id) + 1 || 1e6 + a[1]) - (fieldInfo.config.order.indexOf(b[0].id) + 1 || 1e6 + b[1])))
  .map(([f]) => f);

async function loadFields() {
  if (!$('passcode').value) return;
  try {
    fieldInfo = await api('ui/fields');
    applyFields();
  } catch (err) {
    console.warn('Field list not loaded:', err.message); // the built-in form still works
  }
}

// The block (label + input) of a built-in field
const blockOf = key => $(key)?.closest('.grid > div');

const MULTI = ['options', 'components', 'versions', 'users'];
function extraInput(f) {
  const attrs = `id="x-${esc(f.id)}" data-fid="${esc(f.id)}"`;
  const opt = (v, t) => `<option value="${esc(v)}">${esc(t ?? v)}</option>`;
  let input;
  switch (f.kind) {
    case 'textarea': input = `<textarea ${attrs}></textarea>`; break;
    case 'number': input = `<input ${attrs} type="number" step="any">`; break;
    case 'date': input = `<input ${attrs} type="date">`; break;
    case 'datetime': input = `<input ${attrs} type="datetime-local">`; break;
    case 'option': case 'version': input = `<select ${attrs}>${opt('', '(none)')}${f.allowed.map(v => opt(v)).join('')}</select>`; break;
    case 'options': case 'components': case 'versions':
      input = `<select ${attrs} multiple size="${Math.min(4, Math.max(2, f.allowed.length))}">${f.allowed.map(v => opt(v)).join('')}</select>`; break;
    case 'user': input = `<select ${attrs}>${opt('', '(nobody)')}${opts.users.map(u => opt(u.id, u.name)).join('')}</select>`; break;
    case 'users': input = `<select ${attrs} multiple size="4">${opts.users.map(u => opt(u.id, u.name)).join('')}</select>`; break;
    case 'strings': input = `<input ${attrs} placeholder="Separate with commas">`; break;
    default: input = `<input ${attrs}>`;
  }
  const wide = f.kind === 'textarea' ? ' class="full"' : '';
  return `<div${wide}><label for="x-${esc(f.id)}">${esc(f.name)}${f.required ? ' <span class="opt">(required)</span>' : ''}` +
    `${MULTI.includes(f.kind) ? ' <span class="opt">(Ctrl+click for several)</span>' : ''}</label>${input}</div>`;
}
const getExtraValue = el => el.multiple ? [...el.selectedOptions].map(o => o.value).join(', ') : el.value.trim();
function setExtraValue(el, v) {
  if (el.multiple) { const want = splitList(v); for (const o of el.options) o.selected = want.includes(o.value); }
  else if (el.tagName === 'SELECT') ensureOption(el, v, v && el.dataset.fid && fieldInfo.extra.find(f => f.id === el.dataset.fid)?.kind === 'user'
    ? 'Someone not in the assignable list' : undefined); // e.g. a Reporter who can't be assigned
  else el.value = v ?? '';
}

function applyFields() {
  for (const f of fieldInfo.form) { const box = blockOf(f.key); if (box) box.hidden = !fieldVisible(f.key); }
  // Rebuild the extra inputs, keeping what is typed in them
  const keep = Object.fromEntries([...$('extraFields').querySelectorAll('[data-fid]')].map(el => [el.dataset.fid, getExtraValue(el)]));
  const shown = orderedExtras().filter(f => fieldVisible(f.id));
  $('extraFields').innerHTML = shown.map(extraInput).join('');
  for (const el of $('extraFields').querySelectorAll('[data-fid]')) if (keep[el.dataset.fid]) setExtraValue(el, keep[el.dataset.fid]);
  $('extraHead').hidden = !shown.length;
}

// ---------- Used by the single-ticket form (single.js) ----------
// Values to send: for a loaded ticket only what changed (emptied = remove), for a new one what is filled
function extraValues(compareWithLoaded) {
  const out = {};
  for (const el of $('extraFields').querySelectorAll('[data-fid]')) {
    const v = getExtraValue(el), id = el.dataset.fid;
    if (compareWithLoaded) { if (v !== (loaded.fields?.[id] ?? '')) out[id] = v; }
    else if (v) out[id] = v;
  }
  return Object.keys(out).length ? out : null;
}
// Live sync: fills the extra inputs from Jira, keeping ones edited here; returns what they hold now
function syncExtras(out, same) {
  const snapshot = {};
  let kept = 0;
  for (const el of $('extraFields').querySelectorAll('[data-fid]')) {
    const id = el.dataset.fid, fromJira = out.values.fields?.[id] ?? '';
    if (same && getExtraValue(el) !== (loaded.fields?.[id] ?? '')) { kept++; snapshot[id] = loaded.fields?.[id] ?? ''; continue; }
    setExtraValue(el, fromJira);
    snapshot[id] = getExtraValue(el);
  }
  return { snapshot, kept };
}
const extraName = (id, info) => info?.fieldNames?.[id] || fieldInfo.extra.find(f => f.id === id)?.name || id;
function extraShown(id, v) {
  const f = fieldInfo.extra.find(x => x.id === id);
  if (f && (f.kind === 'user' || f.kind === 'users')) return splitList(v).map(x => opts.users.find(u => u.id === x)?.name || x).join(', ');
  return v;
}
// Review dialog rows for the extra fields (what the ticket has now -> what it will have)
function extraReviewRows(task, info) {
  return Object.entries(task.fields || {}).map(([id, v]) => {
    const was = extraShown(id, info.current?.fields?.[id] ?? ''), now = extraShown(id, v);
    return `<dt>${esc(extraName(id, info))}</dt><dd>` + (was && was !== now ? `<span class="was">${esc(was)}</span> → ` : '') +
      (v === '' ? '<span class="remove">removed from the ticket</span>' : `<span class="new">${esc(now)}</span>`) + '</dd>';
  }).join('');
}

// ---------- "Customize fields" dialog ----------
const KIND_NAMES = { text: 'Text', textarea: 'Long text', number: 'Number', date: 'Date', datetime: 'Date and time', option: 'List', options: 'Checkboxes',
  user: 'Person', users: 'People', strings: 'Words', components: 'Components', version: 'Version', versions: 'Versions' };
let draftOrder = [];
function fcRow(key, name, kind, required, extra) {
  const shared = extra ? draftOrder.includes(key) && !fcHidden.has(key) : !fcHidden.has(key);
  const mine = myFieldPrefs()[key] || '';
  return `<tr data-key="${esc(key)}"><td>${esc(name)}${required ? ' <span class="muted">(required)</span>' : ''}</td><td class="muted">${esc(kind)}</td>` +
    `<td><label class="switch"><input type="checkbox" data-shared ${shared || required ? 'checked' : ''} ${required ? 'disabled' : ''}><span>Shown</span></label></td>` +
    `<td><select data-mine ${required ? 'disabled' : ''} aria-label="Just for me: ${esc(name)}">` +
    `<option value=""${mine === '' ? ' selected' : ''}>Same as everyone</option><option value="show"${mine === 'show' ? ' selected' : ''}>Always show</option>` +
    `<option value="hide"${mine === 'hide' ? ' selected' : ''}>Always hide</option></select></td>` +
    `<td>${extra ? '<button class="ghost" type="button" data-move="-1" aria-label="Move up">↑</button><button class="ghost" type="button" data-move="1" aria-label="Move down">↓</button>' : ''}</td></tr>`;
}
let fcHidden = new Set();
function renderFieldDialog() {
  const extras = [...fieldInfo.extra].sort((a, b) => (draftOrder.indexOf(a.id) + 1 || 1e6) - (draftOrder.indexOf(b.id) + 1 || 1e6));
  $('fcBody').innerHTML =
    '<p class="hint">"Shown" applies to everyone using this page (and to the Excel template). "Just for me" overrides it in this browser only.</p>' +
    '<div class="scroll"><table class="fctable"><tr><th>Field</th><th>Type</th><th>Everyone</th><th>Just for me</th><th></th></tr>' +
    `<tr><th colspan="5" class="pvsec">More Jira fields (${extras.length})</th></tr>` +
    (extras.length ? extras.map(f => fcRow(f.id, f.name, KIND_NAMES[f.kind] || f.kind, f.required, true)).join('') : '<tr><td colspan="5" class="empty">No other fields.</td></tr>') +
    '<tr><th colspan="5" class="pvsec">Already on the form</th></tr>' +
    fieldInfo.form.map(f => fcRow(f.key, f.name, '', f.locked, false)).join('') +
    '</table></div>' +
    (fieldInfo.notEditable.length ? `<p class="muted">Not editable from here: ${esc(fieldInfo.notEditable.join(', '))}.</p>` : '') +
    (fieldInfo.config.updatedBy ? `<p class="muted">Last changed by ${esc(fieldInfo.config.updatedBy)}, ${esc(when(fieldInfo.config.updatedAt))}.</p>` : '');
}
$('fcBtn').addEventListener('click', async () => {
  if (!needPass(show)) return;
  await loadFields();
  fcHidden = new Set(fieldInfo.config.hidden);
  draftOrder = orderedExtras().filter(f => fieldInfo.config.order.includes(f.id)).map(f => f.id);
  $('fcmsg').className = 'msg';
  renderFieldDialog();
  $('fc').showModal();
});
$('fcBody').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  const key = tr.dataset.key, extra = fieldInfo.extra.some(f => f.id === key);
  if (e.target.matches('[data-shared]')) {
    if (e.target.checked) { fcHidden.delete(key); if (extra && !draftOrder.includes(key)) draftOrder.push(key); }
    else { fcHidden.add(key); if (extra) draftOrder = draftOrder.filter(k => k !== key); }
  }
  if (e.target.matches('[data-mine]')) { // personal choice: saved straight away, in this browser
    const prefs = myFieldPrefs();
    if (e.target.value) prefs[key] = e.target.value; else delete prefs[key];
    store.set('jira.fieldPrefs', prefs);
    applyFields();
  }
});
$('fcBody').addEventListener('click', e => {
  const btn = e.target.closest('button[data-move]');
  if (!btn) return;
  const key = btn.closest('tr').dataset.key;
  if (!draftOrder.includes(key)) draftOrder.push(key);
  const i = draftOrder.indexOf(key), j = i + Number(btn.dataset.move);
  if (j < 0 || j >= draftOrder.length) return;
  [draftOrder[i], draftOrder[j]] = [draftOrder[j], draftOrder[i]];
  renderFieldDialog();
});
$('fcSave').addEventListener('click', async () => {
  try {
    fieldInfo.config = await api('ui/fields/config', postJson({ hidden: [...fcHidden], order: draftOrder }));
    applyFields();
    $('fc').close();
    show('ok', 'Fields saved for everyone.');
  } catch (err) {
    const m = $('fcmsg'); m.className = 'msg err'; m.textContent = 'Not saved: ' + err.message;
  }
});
$('fcClose').addEventListener('click', () => $('fc').close());
