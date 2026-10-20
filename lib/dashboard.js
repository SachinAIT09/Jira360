// The Dashboard tab's numbers, for the last 7 or 30 days:
//   jira      open tickets of the project by status / assignee / priority, overdue, unassigned,
//             the active sprint, and tickets created vs resolved per day (read live from Jira)
//   hours     time logged per person and per week (Jira worklogs)
//   activity  what Jira360 sent: per day, by source, by person, and the most common errors
//   sheet     the Google Sheet sync's last run
// Each block is read on its own: one that fails comes back empty and is named in `failed`.
// Kept for 2 minutes, so a team with the tab open doesn't ask Jira again and again.

import { JIRA_PROJECT_KEY, BASE } from './config.js';
import { jira, searchAll, cached, customFieldIds } from './jira.js';
import { listActivity } from './activity.js';
import { sheetStatus } from './sheet.js';
import { mapLimit } from './bulk.js';
import { logError } from './log.js';

const DAY = 86400000;
const MAX_OPEN = 1000, MAX_WORKLOG_ISSUES = 100, MAX_ACTIVITY = 2000;
const BLOCK_MS = 8000; // Netlify ends a request at 10 s: a block still loading then is shown as not loaded

export const searchUrl = jql => `${BASE}/issues/?jql=${encodeURIComponent(jql)}`;
const q = v => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;

// Counts of `items` by key, biggest first: [{ name, n, ...extra }]
function countBy(items, keyOf, extraOf = () => ({})) {
  const m = new Map();
  for (const it of items) {
    const k = keyOf(it);
    const row = m.get(k) || { name: k, n: 0, ...extraOf(it) };
    row.n++;
    m.set(k, row);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
}

// Calendar days of the period in the page's time zone (tzOffset: minutes, as Date#getTimezoneOffset gives)
const dayOf = (ms, tz) => new Date(ms - tz * 60000).toISOString().slice(0, 10);
function daysOf(days, tz, now) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(now - i * DAY, tz));
  return out;
}
// Monday of the week a day is in, as YYYY-MM-DD
function weekOf(ms, tz) {
  const d = new Date(dayOf(ms, tz) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function jiraBlock(project, days, tz, now) {
  const ids = await customFieldIds().catch(() => ({}));
  const open = await searchAll(`project = ${q(project)} AND statusCategory != Done ORDER BY priority DESC`,
    ['status', 'assignee', 'priority', 'duedate', ...(ids.sprint ? [ids.sprint] : [])], MAX_OPEN);
  const today = dayOf(now, tz);
  const base = `project = ${q(project)} AND statusCategory != Done`;

  const sprintOf = i => {
    const list = (ids.sprint && i.fields[ids.sprint]) || [];
    return list.find(s => s.state === 'active');
  };
  const active = countBy(open.filter(sprintOf), i => sprintOf(i).name, i => ({ jql: `${base} AND sprint = ${sprintOf(i).id}` }));

  const [created, resolved] = await Promise.all([
    searchAll(`project = ${q(project)} AND created >= -${days}d`, ['created'], 2000),
    searchAll(`project = ${q(project)} AND resolved >= -${days}d`, ['resolutiondate'], 2000),
  ]);
  const perDay = daysOf(days, tz, now).map(day => ({ day, created: 0, resolved: 0 }));
  const at = new Map(perDay.map(d => [d.day, d]));
  for (const i of created) { const d = at.get(dayOf(Date.parse(i.fields.created), tz)); if (d) d.created++; }
  for (const i of resolved) { const d = at.get(dayOf(Date.parse(i.fields.resolutiondate), tz)); if (d) d.resolved++; }

  return {
    open: open.length, capped: open.length >= MAX_OPEN,
    overdue: open.filter(i => i.fields.duedate && i.fields.duedate < today).length,
    unassigned: open.filter(i => !i.fields.assignee).length,
    byStatus: countBy(open, i => i.fields.status?.name || '?', i => ({ category: i.fields.status?.statusCategory?.key || '', jql: `${base} AND status = ${q(i.fields.status?.name)}` })),
    byAssignee: countBy(open, i => i.fields.assignee?.displayName || 'Unassigned',
      i => ({ jql: `${base} AND assignee ${i.fields.assignee ? '= ' + q(i.fields.assignee.accountId) : 'is EMPTY'}` })),
    byPriority: countBy(open, i => i.fields.priority?.name || 'None', i => ({ jql: `${base} AND priority ${i.fields.priority ? '= ' + q(i.fields.priority.name) : 'is EMPTY'}` })),
    sprints: active,
    created: created.length, resolved: resolved.length, perDay,
    links: {
      open: searchUrl(base), overdue: searchUrl(`${base} AND duedate < startOfDay()`), unassigned: searchUrl(`${base} AND assignee is EMPTY`),
      created: searchUrl(`project = ${q(project)} AND created >= -${days}d`), resolved: searchUrl(`project = ${q(project)} AND resolved >= -${days}d`),
    },
  };
}

// Time logged in the period: per person, and per person per week
async function hoursBlock(project, days, tz, now) {
  const since = now - days * DAY;
  const issues = await searchAll(`project = ${q(project)} AND worklogDate >= -${days}d`, ['summary'], MAX_WORKLOG_ISSUES);
  const logs = (await mapLimit(issues, 5, async i => {
    const r = await jira('GET', `/rest/api/3/issue/${encodeURIComponent(i.key)}/worklog?startedAfter=${since}&maxResults=1000`);
    return (r.worklogs || []).map(w => ({ who: w.author?.displayName || '?', at: Date.parse(w.started), seconds: w.timeSpentSeconds || 0 }));
  })).flat().filter(w => w.at >= since);

  const people = new Map();
  for (const w of logs) {
    const p = people.get(w.who) || { name: w.who, hours: 0, weeks: {} };
    p.hours += w.seconds / 3600;
    const wk = weekOf(w.at, tz);
    p.weeks[wk] = (p.weeks[wk] || 0) + w.seconds / 3600;
    people.set(w.who, p);
  }
  const round = h => Math.round(h * 10) / 10;
  const weeks = [...new Set(logs.map(w => weekOf(w.at, tz)))].sort();
  return {
    total: round(logs.reduce((s, w) => s + w.seconds, 0) / 3600),
    thisWeek: round(logs.filter(w => weekOf(w.at, tz) === weekOf(now, tz)).reduce((s, w) => s + w.seconds, 0) / 3600),
    weeks,
    people: [...people.values()].sort((a, b) => b.hours - a.hours)
      .map(p => ({ name: p.name, hours: round(p.hours), weeks: weeks.map(wk => round(p.weeks[wk] || 0)) })),
    capped: issues.length >= MAX_WORKLOG_ISSUES,
  };
}

// Sends to Jira only: the sheet being updated from Jira, and conflict notes, aren't sends
export const isSend = e => e.source !== 'jira' && !(e.actions || []).some(a => a === 'conflict' || a === 'row-removed');

export async function activitySince(from) {
  const items = [];
  let before = '';
  while (items.length < MAX_ACTIVITY) {
    const page = await listActivity({ from, before, limit: 500 });
    items.push(...page.items);
    if (!page.more) break;
    before = page.next;
  }
  return items;
}

async function activityBlock(days, tz, now) {
  const from = now - days * DAY;
  const items = (await activitySince(from)).filter(isSend);
  const perDay = daysOf(days, tz, now).map(day => ({ day, sent: 0, failed: 0 }));
  const at = new Map(perDay.map(d => [d.day, d]));
  for (const e of items) { const d = at.get(dayOf(Date.parse(e.at), tz)); if (d) d[e.ok ? 'sent' : 'failed']++; }
  const failed = items.filter(e => !e.ok);
  return {
    sent: items.length - failed.length, failed: failed.length, capped: items.length >= MAX_ACTIVITY, perDay,
    bySource: countBy(items, e => e.source),
    byPerson: countBy(items.filter(e => e.ok), e => e.by || '(no name)'),
    errors: countBy(failed, e => String(e.error || (e.refused ? 'Refused by the checks' : 'Unknown error')).replace(/\s+/g, ' ').slice(0, 160)).slice(0, 5),
  };
}

export async function dashboard({ days = 7, tz = 0 } = {}) {
  days = Number(days) === 30 ? 30 : 7;
  tz = Math.max(-840, Math.min(840, Math.round(Number(tz) || 0)));
  return cached(`dash:${days}:${tz}`, async () => {
    const now = Date.now(), failed = [];
    const late = name => new Promise((_, no) => setTimeout(() => no(new Error(`${name}: Jira took too long`)), BLOCK_MS));
    const get = (name, p, fallback = null) => Promise.race([p, late(name)]).catch(e => { failed.push(name); logError('dashboard', e, { block: name }); return fallback; });
    const [jiraData, hours, activity, sheet] = await Promise.all([
      get('jira', jiraBlock(JIRA_PROJECT_KEY, days, tz, now)),
      get('hours', hoursBlock(JIRA_PROJECT_KEY, days, tz, now)),
      get('activity', activityBlock(days, tz, now)),
      get('sheet', sheetStatus()),
    ]);
    return { project: JIRA_PROJECT_KEY, days, at: new Date(now).toISOString(), jira: jiraData, hours, activity,
      sheet: sheet?.configured ? { url: sheet.url, lastPoll: sheet.lastPoll } : null, failed };
  }, 120000);
}
