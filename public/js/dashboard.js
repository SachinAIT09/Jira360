// Dashboard tab: tiles, per-day columns and ranked bars from ui/dashboard. Plain HTML marks, no
// chart library. Refreshes every 2 minutes while the tab is open (the server keeps it for 2 too).

const dash = { days: 7, data: null, timer: 0, busy: false };
function dshow(kind, html) { const m = $('dashMsg'); m.className = kind ? 'msg ' + kind : 'msg'; m.innerHTML = html || ''; }
const fmt = n => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K' : Number(n).toLocaleString());
const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const shortDay = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

try { dash.days = store.get('jira.dashDays', 7) === 30 ? 30 : 7; } catch {}

function dashTabShown(open) {
  clearInterval(dash.timer);
  if (!open) return;
  loadDashboard();
  dash.timer = setInterval(() => { if (document.visibilityState === 'visible') loadDashboard(); }, 120000);
}

async function loadDashboard() {
  if (!passOk()) return;
  if (dash.busy) { dash.again = true; return; } // e.g. 30 days clicked while 7 days load
  dash.busy = true; dash.again = false;
  for (const b of document.querySelectorAll('#dashPanel .seg button')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === dash.days));
  if (!dash.data) dshow('info', 'Loading from Jira…');
  try {
    dash.data = await api(`ui/dashboard?days=${dash.days}&tz=${new Date().getTimezoneOffset()}`);
    renderDashboard();
    const names = { jira: 'Jira tickets', hours: 'hours logged', activity: 'Jira360 activity', sheet: 'Google Sheet status' };
    dshow(dash.data.failed.length ? 'warn' : '', dash.data.failed.length ? `Couldn't load: ${dash.data.failed.map(f => names[f] || f).join(', ')}. The rest is shown.` : '');
  } catch (err) {
    dshow('err', 'Dashboard not loaded: ' + esc(err.message));
  } finally {
    dash.busy = false;
    if (dash.again) loadDashboard();
  }
}

// ---------- Marks ----------
const empty = text => `<p class="empty">${esc(text)}</p>`;

// Ranked horizontal bars (one series): label, bar, value at the tip; a bar with a jql opens Jira
function hbars(rows, { unit = '', max = 12, link: withLink = true } = {}) {
  if (!rows?.length) return empty('Nothing here for this period.');
  const shown = rows.slice(0, max), rest = rows.slice(max);
  if (rest.length) shown.push({ name: `${rest.length} more`, n: rest.reduce((s, r) => s + r.n, 0), other: true });
  const top = Math.max(...shown.map(r => r.n), 1);
  return '<ul class="hbars">' + shown.map(r => {
    const label = `${r.name}: ${fmt(r.n)}${unit}`;
    const inner = `<span class="hb-name" title="${esc(r.name)}">${esc(r.name)}</span>` +
      `<span class="hb-track"><span class="hb-bar${r.other ? ' other' : ''}" style="width:${Math.max(1.5, (r.n / top) * 100)}%"></span></span>` +
      `<span class="hb-val">${fmt(r.n)}${unit}</span>`;
    return `<li>${withLink && r.jql ? `<a href="${esc(jiraSearch(r.jql))}" target="_blank" rel="noopener" aria-label="${esc(label)}, open in Jira">${inner}</a>` : `<div aria-label="${esc(label)}">${inner}</div>`}</li>`;
  }).join('') + '</ul>';
}
const jiraSearch = jql => (dash.data?.jira?.links?.open || '').replace(/jql=.*$/, 'jql=' + encodeURIComponent(jql));

// Columns per day. series: [{ key, label, cls }]; stacked puts them on top of each other.
// Each day is one hover / focus target with a tooltip; the numbers are also in a table below.
function columns(days, series, { stacked = false } = {}) {
  if (!days?.length) return empty('No data.');
  const total = d => series.reduce((s, x) => s + (d[x.key] || 0), 0);
  const top = Math.max(1, ...days.map(d => (stacked ? total(d) : Math.max(...series.map(x => d[x.key] || 0)))));
  const nice = top <= 4 ? top + (top % 2) : Math.ceil(top / 4) * 4; // even, so the middle line is a whole number
  const every = days.length > 14 ? 7 : 1;
  const tip = d => `${shortDay(d.day)}: ` + series.map(x => `${x.label} ${d[x.key] || 0}`).join(', ');
  const bar = (d, x) => `<span class="cbar ${x.cls}" style="height:${((d[x.key] || 0) / nice) * 100}%"></span>`;
  const legend = '<div class="legend">' + series.map(x => `<span><i class="sw ${x.cls}"></i>${esc(x.label)}</span>`).join('') + '</div>';
  return legend +
    `<div class="cchart"><div class="cgrid" aria-hidden="true"><span data-v="${fmt(nice)}"></span><span data-v="${fmt(nice / 2)}"></span><span data-v="0"></span></div>` +
    `<div class="ccols${stacked ? ' stacked' : ''}">` + days.map(d =>
      `<div class="ccol" tabindex="0" aria-label="${esc(tip(d))}" data-tip="${esc(tip(d))}">` +
      (stacked ? `<span class="cstack">${series.filter(x => d[x.key]).map(x => bar(d, x)).join('')}</span>` : series.map(x => bar(d, x)).join('')) +
      '</div>').join('') + '</div>' +
    '<div class="cx" aria-hidden="true">' + days.map((d, i) => `<span>${i % every === 0 || i === days.length - 1 ? esc(shortDay(d.day)) : ''}</span>`).join('') + '</div>' +
    '<div class="ctip" hidden></div></div>' +
    `<details class="recent mt-3"><summary>Show as table</summary><div class="scroll"><table><thead><tr><th>Day</th>${series.map(x => `<th class="num">${esc(x.label)}</th>`).join('')}</tr></thead><tbody>` +
    days.map(d => `<tr><td>${esc(shortDay(d.day))}</td>${series.map(x => `<td class="num">${d[x.key] || 0}</td>`).join('')}</tr>`).join('') + '</tbody></table></div></details>';
}

// One tooltip per chart, following the hovered / focused day
function wireTips(root) {
  for (const chart of root.querySelectorAll('.cchart')) {
    const tip = chart.querySelector('.ctip');
    const show = col => {
      tip.textContent = col.dataset.tip;
      tip.hidden = false;
      const c = chart.getBoundingClientRect(), r = col.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(0, r.left - c.left + r.width / 2 - tip.offsetWidth / 2), c.width - tip.offsetWidth) + 'px';
    };
    for (const col of chart.querySelectorAll('.ccol')) {
      col.addEventListener('mouseenter', () => show(col));
      col.addEventListener('focus', () => show(col));
    }
    chart.addEventListener('mouseleave', () => { tip.hidden = true; });
    chart.addEventListener('focusout', e => { if (!chart.contains(e.relatedTarget)) tip.hidden = true; });
  }
}

function kpi(label, value, sub = '', href = '', tone = '') {
  const body = `<span class="kpi-label">${esc(label)}</span><span class="kpi-value">${value}</span>${sub ? `<span class="kpi-sub">${sub}</span>` : ''}`;
  return href ? `<a class="kpi ${tone}" href="${esc(href)}" target="_blank" rel="noopener">${body}</a>` : `<div class="kpi ${tone}">${body}</div>`;
}

// ---------- The tab ----------
function renderDashboard() {
  const d = dash.data, j = d.jira, h = d.hours, a = d.activity;
  const na = '<span class="muted">–</span>';
  $('dashSub').textContent = `${d.project}, last ${d.days} days. Updated ${new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;

  $('dashKpis').innerHTML =
    kpi('Open tickets', j ? fmt(j.open) + (j.capped ? '+' : '') : na, j?.sprints?.length ? `${fmt(j.sprints[0].n)} in ${esc(j.sprints[0].name)}` : '', j?.links.open) +
    kpi('Overdue', j ? fmt(j.overdue) : na, 'Open, past the due date', j?.links.overdue, j?.overdue ? 'bad' : '') +
    kpi('Unassigned', j ? fmt(j.unassigned) : na, 'Open, nobody on it', j?.links.unassigned, j?.unassigned ? 'warn' : '') +
    kpi('Created / resolved', j ? `${fmt(j.created)} / ${fmt(j.resolved)}` : na, j ? (j.resolved >= j.created ? 'Backlog not growing' : `Backlog grew by ${fmt(j.created - j.resolved)}`) : '', j?.links.created) +
    kpi('Hours logged', h ? fmt(h.total) + 'h' : na, h ? `${fmt(h.thisWeek)}h this week` : '') +
    kpi('Sent by Jira360', a ? fmt(a.sent) + (a.capped ? '+' : '') : na, a ? (a.failed ? `<span class="errt">${plural(a.failed, 'failed send')}</span>` : 'No failures') : '', '', a?.failed ? 'bad' : '');
  // Links in tiles open Jira; Jira360's own numbers open Activity instead
  const last = $('dashKpis').lastElementChild;
  last.classList.add('clickable'); last.tabIndex = 0; last.setAttribute('role', 'link');
  last.onclick = last.onkeydown = e => { if (e.type === 'click' || e.key === 'Enter') { $('aresult').value = a?.failed ? 'failed' : ''; showTab('activity'); } };

  $('dashFlowSub').textContent = j ? `${plural(j.created, 'ticket')} created, ${fmt(j.resolved)} resolved` : 'Not loaded';
  $('dashFlow').innerHTML = j ? columns(j.perDay, [{ key: 'created', label: 'Created', cls: 's1' }, { key: 'resolved', label: 'Resolved', cls: 's2' }]) : empty('Not loaded from Jira.');
  $('dashSendSub').textContent = a ? `${plural(a.sent, 'send')} to Jira, ${fmt(a.failed)} failed` : 'Not loaded';
  $('dashSends').innerHTML = a ? columns(a.perDay, [{ key: 'sent', label: 'Sent', cls: 'ok' }, { key: 'failed', label: 'Failed', cls: 'bad' }], { stacked: true }) : empty('Not loaded.');
  $('dashStatus').innerHTML = j ? hbars(j.byStatus) : empty('Not loaded from Jira.');
  $('dashAssignee').innerHTML = j ? hbars(j.byAssignee) : empty('Not loaded from Jira.');
  $('dashPriority').innerHTML = j ? hbars(j.byPriority) : empty('Not loaded from Jira.');
  $('dashSprint').textContent = j?.sprints?.length ? `Active sprint: ${j.sprints.map(s => `${s.name} (${s.n} open)`).join(', ')}` : 'No active sprint';
  $('dashHoursSub').textContent = h ? `${fmt(h.total)}h in ${d.days} days${h.capped ? ' (first 100 tickets with work logged)' : ''}` : 'Not loaded';
  $('dashHours').innerHTML = h ? hbars(h.people.map(p => ({ name: p.name, n: p.hours })), { unit: 'h', link: false }) : empty('Not loaded from Jira.');
  $('dashPeople').innerHTML = a ? hbars(a.byPerson, { link: false }) : empty('Not loaded.');

  const lp = d.sheet?.lastPoll;
  $('dashSheet').innerHTML = !d.sheet ? 'Most common reasons sends failed' :
    `Google Sheet: last synced ${lp?.at ? esc(when(lp.at)) : 'never'}${lp?.problems ? `, <span class="warnt">${plural(lp.problems, 'row')} with problems</span>` : ''}`;
  $('dashErrors').innerHTML = !a ? empty('Not loaded.') : a.errors.length
    ? '<ul class="errlist">' + a.errors.map(e => `<li><span class="tag tag-red">${fmt(e.n)}×</span><span>${esc(e.name)}</span></li>`).join('') + '</ul>'
    : '<p class="empty good">No failed sends in this period.</p>';
  wireTips($('dashPanel'));
}

for (const b of document.querySelectorAll('#dashPanel .seg button')) b.addEventListener('click', () => {
  dash.days = Number(b.dataset.days);
  store.set('jira.dashDays', dash.days);
  loadDashboard();
});
$('dashRefresh').addEventListener('click', loadDashboard);

$('dashAi').addEventListener('click', async () => {
  const btn = $('dashAi');
  btn.disabled = true;
  dshow('info', 'Writing the status update…');
  try {
    const r = await api('ui/ai/report', postJson({ days: dash.days, tz: new Date().getTimezoneOffset() }));
    $('dashAiText').textContent = r.text;
    $('dashAiBox').hidden = false;
    $('dashAiCopy').textContent = 'Copy';
    dshow('', '');
  } catch (err) {
    dshow('err', 'Not written: ' + esc(err.message));
  } finally {
    btn.disabled = false;
  }
});
$('dashAiCopy').addEventListener('click', () => navigator.clipboard?.writeText($('dashAiText').textContent).then(() => { $('dashAiCopy').textContent = 'Copied'; }));
