// App shell: the sidebar drawer on small screens, the overview numbers, and small status touches.
// Presentation only: it reads what the other scripts already load and calls their functions.

// ---------- Sidebar drawer (below 1024px wide) ----------
const wideScreen = window.matchMedia('(min-width: 1024px)');
function setNav(open) {
  open = open && !wideScreen.matches;
  document.body.classList.toggle('nav-open', open);
  $('navBtn').setAttribute('aria-expanded', String(open));
  $('content').inert = open; // keyboard and screen readers stay in the open menu
  if (open) document.querySelector('.navitem[aria-selected=true]')?.focus();
}
$('navBtn').addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
$('navScrim').addEventListener('click', () => { setNav(false); $('navBtn').focus(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { setNav(false); $('navBtn').focus(); }
});
wideScreen.addEventListener('change', () => setNav(false));

// Picking a section closes the drawer and starts at the top; the overview isn't shown in Settings or the Dashboard
const showTabBase = showTab;
showTab = function (name, how) {
  showTabBase(name, how);
  name = Object.keys(TABS).find(k => !$(TABS[k][1]).hidden) || name; // where it went (a role may have redirected it)
  $('stats').hidden = name === 'settings' || name === 'dashboard';
  if (name !== 'settings' && name !== 'dashboard') { loadOverview(); if (name !== 'inbox') loadInbox(); } // the sheet sync may have sent things meanwhile
  if (document.body.classList.contains('nav-open')) setNav(false);
  window.scrollTo({ top: 0 });
};

// ---------- Overview numbers (real data: the Inbox and today's history) ----------
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isoLocalDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let overviewBusy = false;
async function loadOverview() {
  if (!passOk() || overviewBusy) return;
  overviewBusy = true;
  try {
    const { items, more } = await api(`ui/activity?from=${todayStart().getTime()}&limit=500`);
    // Sheet updates from Jira and conflict notes aren't sends to Jira
    const sends = items.filter(e => e.source !== 'jira' && !(e.actions || []).some(a => a === 'conflict' || a === 'row-removed'));
    const sentToday = sends.filter(e => e.ok).length, failedToday = sends.length - sentToday;
    $('nSent').textContent = sentToday + (more ? '+' : '');
    $('nFailed').textContent = failedToday;
  } catch { /* the numbers are a help; the rest of the page works without them */ }
  finally { overviewBusy = false; }
}
// Waiting count: whenever the Inbox is (re)drawn
const renderInboxBase = renderInbox;
renderInbox = function () {
  renderInboxBase();
  $('nWaiting').textContent = inbox.pending.length;
};
// After any send the numbers move
const sentBase = sent;
sent = function () { sentBase(); loadOverview(); };
setInterval(() => { if (document.visibilityState === 'visible') loadOverview(); }, 60000);

$('statWaiting').addEventListener('click', () => showTab('inbox'));
function openActivityToday(result) {
  $('afrom').value = isoLocalDay(todayStart());
  $('ato').value = '';
  $('aresult').value = result;
  showTab('activity');
}
$('statSent').addEventListener('click', () => openActivityToday('ok'));
$('statFailed').addEventListener('click', () => openActivityToday('failed'));
// Screen readers: the number and its meaning in one name
for (const id of ['statWaiting', 'statSent', 'statFailed']) $(id).setAttribute('aria-describedby', 'stats');

// ---------- Small status touches ----------
// Connection dot: green once Jira's lists loaded, amber otherwise
new MutationObserver(() => $('optsState').classList.toggle('off', !/^Lists loaded/.test($('optsState').textContent)))
  .observe($('optsState'), { childList: true, characterData: true, subtree: true });
// "New ticket" hint while no ticket is loaded
new MutationObserver(() => { $('syncEmpty').hidden = !!$('sync').textContent.trim(); })
  .observe($('sync'), { childList: true, characterData: true, subtree: true });
