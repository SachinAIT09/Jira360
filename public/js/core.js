// Shared helpers, server calls, tabs, Jira lists and tag pickers. Loaded first; the other
// scripts use what it defines (plain scripts sharing the page's scope, no build step).

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const splitList = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

$('passcode').value = store.get('jira.passcode', '');
let project = 'Jira';

// All calls to the server: adds the passcode, turns error replies and network failures into readable errors
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'X-UI-Passcode': $('passcode').value,
      'X-User-Name': encodeURIComponent($('who').value.trim()) } });
  } catch {
    throw new Error("Can't reach the server. Check that it is running.");
  }
  // A reply that isn't JSON means the page is hosted somewhere without the Jira server behind it
  const out = await res.json().catch(() => ({ error: res.status === 404 || res.status === 405
    ? "This page can't find its Jira server. Open the form from the address where server.js runs (for example http://<that computer>:8080/)."
    : `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(out.error || `HTTP ${res.status}`), { status: res.status, errors: out.errors });
  return out;
}
const postJson = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function needPass(show) {
  if ($('passcode').value) return true;
  show('err', 'Enter the passcode first.');
  $('passcode').focus();
  return false;
}

// ---------- Your name (goes with every send, for the history) ----------
$('who').value = store.get('jira.name', '');
$('who').addEventListener('change', () => store.set('jira.name', $('who').value.trim()));
// The history now lives on the server (Activity tab); drop what older versions kept in this browser
try { localStorage.removeItem('jira.history'); localStorage.removeItem('jira.keys'); } catch {}
// After any send: the Activity tab, if open, shows it straight away
function sent() { if (!$('activityPanel').hidden) loadActivity(); }

// ---------- Tabs ----------
const TABS = { single: ['tabSingle', 'singlePanel'], bulk: ['tabBulk', 'bulkPanel'], inbox: ['tabInbox', 'inboxPanel'], activity: ['tabActivity', 'activityPanel'], settings: ['tabSettings', 'settingsPanel'] };
function showTab(name) {
  if (!TABS[name]) name = 'single';
  for (const [k, [tab, panel]] of Object.entries(TABS)) {
    $(panel).hidden = k !== name;
    $(tab).setAttribute('aria-selected', String(k === name));
  }
  document.querySelector('main').classList.toggle('wide', name === 'bulk' || name === 'activity');
  store.set('jira.tab', name);
  if (name === 'inbox') loadInbox();
  if (name === 'activity') loadActivity();
  if (name === 'settings') loadSettings();
}
for (const name of Object.keys(TABS)) $(TABS[name][0]).addEventListener('click', () => showTab(name));

// ---------- Lists from Jira (people, epics, sprints, versions, labels, priorities, statuses) ----------
let opts = { users: [], parents: [], sprints: [], versions: [], labels: [], priorities: [], statuses: [] };

// Fills a <select>, keeping its current value (adding it as an extra option if Jira's list lacks it)
function fillSelect(sel, emptyText, items) {
  const keep = sel.value;
  sel.innerHTML = `<option value="">${esc(emptyText)}</option>` +
    items.map(o => `<option value="${esc(o.value)}">${esc(o.text)}</option>`).join('');
  ensureOption(sel, keep);
}
function ensureOption(sel, value, text) {
  if (value && ![...sel.options].some(o => o.value === value)) sel.add(new Option(text || value, value));
  sel.value = value || '';
}
const fillDatalist = (dl, items) => { dl.innerHTML = items.map(o => `<option value="${esc(o.value)}">${esc(o.text || '')}</option>`).join(''); };

function applyOptions() {
  fillSelect($('assigneeId'), 'Unassigned', opts.users.map(u => ({ value: u.id, text: u.email ? `${u.name} · ${u.email}` : u.name })));
  fillSelect($('sprint'), 'No sprint (backlog)', opts.sprints.map(s => ({ value: s.name, text: `${s.name} (${s.state})` })));
  fillSelect($('priority'), loaded ? 'No change' : 'Default', opts.priorities.map(p => ({ value: p, text: p })));
  fillDatalist($('parentList'), opts.parents.map(p => ({ value: p.key, text: p.summary })));
  if (!loaded) setStatusChoices(null);
  pickers.labels.refresh();
  pickers.fixVersions.refresh();
  showParentInfo();
}

// Status: a new ticket can start in any workflow status; an existing one only where Jira allows it to move
function setStatusChoices(current, next = []) {
  const sel = $('status'), keep = sel.value;
  if (current) {
    sel.innerHTML = '';
    for (const name of [current, ...next.filter(n => !sameText(n, current))])
      sel.add(new Option(sameText(name, current) ? `${name} (current)` : name, name));
    ensureOption(sel, keep || current);
    $('statusInfo').textContent = next.length ? `${next.filter(n => !sameText(n, current)).length} moves allowed from ${current}` : '';
  } else {
    fillSelect(sel, 'Default (first step)', opts.statuses.map(s => ({ value: s, text: s })));
    $('statusInfo').textContent = '';
  }
}

function showParentInfo() {
  const key = $('parentKey').value.trim().toUpperCase();
  const p = opts.parents.find(x => x.key === key) || (loaded?.parent?.key === key ? loaded.parent : null);
  $('parentInfo').textContent = !key ? '' : p ? p.summary : 'Not an open epic here; it will be checked when you review';
}
$('parentKey').addEventListener('input', showParentInfo);

async function loadOptions() {
  if (!$('passcode').value) return;
  $('optsState').textContent = 'Loading lists from Jira…';
  try {
    const o = await api('ui/options');
    project = o.project;
    opts = o;
    document.body.classList.toggle('ai-on', !!o.ai?.enabled); // AI buttons show only when the server has AI on
    applyOptions();
    loadFields(); // which fields the form shows (needs the people list for person fields)
    $('optsState').textContent = o.failed?.length ? `Couldn't load from Jira: ${o.failed.join(', ')}` : `Lists loaded from ${o.project}`;
  } catch (err) {
    $('optsState').textContent = err.status === 401 ? 'Wrong passcode' : `Lists not loaded: ${err.message}`;
  }
}

// ---------- Tag pickers (labels, fix versions) ----------
// The chosen tags live in a hidden input as "a, b", so the rest of the form treats them as text.
function makePicker(id, { listId, source, allowNew, noun }) {
  const hidden = $(id), box = $(id + 'Box'), input = $(id + 'Input'), note = $(id + 'Note');
  const values = () => splitList(hidden.value);
  const set = list => { hidden.value = [...new Set(list)].join(', '); render(); };
  function render() {
    box.querySelectorAll('.chip').forEach(c => c.remove());
    for (const v of values()) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span title="${esc(v)}">${esc(v)}</span><button type="button" aria-label="Remove ${esc(v)}">×</button>`;
      chip.querySelector('button').addEventListener('click', () => { set(values().filter(x => x !== v)); input.focus(); });
      box.insertBefore(chip, input);
    }
    refresh();
  }
  // Suggestions leave out what is already chosen
  function refresh() {
    const chosen = values().map(v => v.toLowerCase());
    fillDatalist($(listId), source().filter(o => !chosen.includes(o.value.toLowerCase())));
  }
  function add(raw) {
    note.textContent = ''; note.className = 'fieldnote';
    const known = source().map(o => o.value);
    for (let v of splitList(raw)) {
      const match = known.find(k => sameText(k, v));
      if (!match && !allowNew) { note.textContent = `"${v}" isn't a ${noun} in Jira`; note.className = 'fieldnote warnt'; continue; }
      if (!match && /\s/.test(v)) { v = v.replace(/\s+/g, '-'); note.textContent = `Spaces aren't allowed in labels, so it became "${v}"`; }
      if (!match && known.length) note.textContent ||= `"${v}" is a new label`;
      v = match || v;
      if (!values().some(x => sameText(x, v))) set([...values(), v]);
    }
    input.value = '';
  }
  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); add(input.value); }
    else if (e.key === 'Enter') e.preventDefault(); // don't submit the form from here
    else if (e.key === 'Backspace' && !input.value && values().length) set(values().slice(0, -1));
  });
  // Picking a suggestion from the list adds it straight away
  input.addEventListener('input', e => {
    if ((!e.inputType || e.inputType === 'insertReplacementText') && source().some(o => o.value === input.value)) add(input.value);
  });
  input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });
  box.addEventListener('click', e => { if (e.target === box) input.focus(); });
  return { render, refresh, set, clear: () => { set([]); note.textContent = ''; } };
}
const pickers = {
  labels: makePicker('labels', { listId: 'labelList', allowNew: true, noun: 'label',
    source: () => opts.labels.map(l => ({ value: l })) }),
  fixVersions: makePicker('fixVersions', { listId: 'versionList', allowNew: false, noun: 'version',
    source: () => [...opts.versions].sort((a, b) => a.released - b.released).map(v => ({ value: v.name, text: v.released ? 'released' : 'unreleased' })) }),
};
