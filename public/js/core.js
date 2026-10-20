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

// ---------- Colour theme: light, dark, or the device's setting (the default) ----------
// The <head> script already applied it before the first paint; this keeps it current.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function themeChoice() { try { return localStorage.getItem('jira.theme') || 'system'; } catch { return 'system'; } }
function applyTheme() {
  const choice = themeChoice();
  document.documentElement.dataset.theme = choice === 'dark' || (choice === 'system' && darkQuery.matches) ? 'dark' : 'light';
  for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
}
for (const b of document.querySelectorAll('[data-theme-choice]')) b.addEventListener('click', () => {
  try { if (b.dataset.themeChoice === 'system') localStorage.removeItem('jira.theme'); else localStorage.setItem('jira.theme', b.dataset.themeChoice); } catch {}
  applyTheme();
});
darkQuery.addEventListener('change', () => { if (themeChoice() === 'system') applyTheme(); });
applyTheme();

// The signed-in person ({ email, name, role, mustChange }); start.js signs in and fills it
let me = null;
const passOk = () => !!me && !me.mustChange;
const can = role => !!me && ['viewer', 'editor', 'admin'].indexOf(me.role) >= ['viewer', 'editor', 'admin'].indexOf(role);
let project = 'Jira';

// All calls to the server: the session cookie goes by itself; X-J360 tells the server the call comes
// from this page (other sites can't add it). Error replies and network failures become readable errors.
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...(opts.headers || {}), 'X-J360': '1' } });
  } catch {
    throw new Error("Can't reach the server. Check that it is running.");
  }
  // A reply that isn't JSON means the page is hosted somewhere without the Jira server behind it
  const out = await res.json().catch(() => ({ error: res.status === 404 || res.status === 405
    ? "This page can't find its Jira server. Open the form from the address where server.js runs (for example http://<that computer>:8080/)."
    : `HTTP ${res.status}` }));
  // Signed out meanwhile (expired, password changed elsewhere, account switched off): back to sign-in
  if (res.status === 401 && me && !path.startsWith('ui/me/') && typeof sessionEnded === 'function') sessionEnded();
  if (!res.ok) throw Object.assign(new Error(out.error || `HTTP ${res.status}`), { status: res.status, code: out.code, errors: out.errors });
  return out;
}
const postJson = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function needPass(show) {
  if (passOk()) return true;
  show('err', 'Sign in first.');
  return false;
}

// The history now lives on the server (Activity tab); drop what older versions kept in this browser
try { for (const k of ['jira.history', 'jira.keys', 'jira.passcode', 'jira.name']) localStorage.removeItem(k); sessionStorage.removeItem('jira.admin'); } catch {}
// After any send: the Activity tab, if open, shows it straight away
function sent() { if (!$('activityPanel').hidden) loadActivity(); }

// ---------- Tabs ----------
const TABS = { single: ['tabSingle', 'singlePanel'], bulk: ['tabBulk', 'bulkPanel'], inbox: ['tabInbox', 'inboxPanel'], dashboard: ['tabDashboard', 'dashPanel'], activity: ['tabActivity', 'activityPanel'], settings: ['tabSettings', 'settingsPanel'] };
// Each section has its own address (#inbox, #settings…), so links, refresh and Back/Forward work.
// how: 'push' (a click: a new history entry), 'replace' (opening the page), 'none' (Back/Forward)
const tabFromHash = () => (TABS[location.hash.slice(1)] ? location.hash.slice(1) : '');
function showTab(name, how = 'push') {
  if (!TABS[name] || (name === 'settings' && !can('admin')) || (name === 'bulk' && !can('editor'))) name = 'single';
  if (how !== 'none' && location.hash.slice(1) !== name) history[how === 'replace' ? 'replaceState' : 'pushState'](null, '', '#' + name);
  for (const [k, [tab, panel]] of Object.entries(TABS)) {
    $(panel).hidden = k !== name;
    $(tab).setAttribute('aria-selected', String(k === name));
  }
  document.querySelector('main').classList.toggle('wide', name === 'bulk' || name === 'activity' || name === 'dashboard');
  store.set('jira.tab', name);
  if (name === 'inbox') loadInbox();
  if (name === 'activity') loadActivity();
  if (name === 'settings') loadSettings();
  if (typeof dashTabShown === 'function') dashTabShown(name === 'dashboard');
}
for (const name of Object.keys(TABS)) $(TABS[name][0]).addEventListener('click', () => showTab(name));
window.addEventListener('popstate', () => { if (!tabFromHash() && location.hash) return; showTab(tabFromHash() || 'single', 'none'); }); // #main: the skip link

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
  if (!passOk()) return;
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
    $('optsState').textContent = err.status === 401 ? 'Signed out' : `Lists not loaded: ${err.message}`;
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
