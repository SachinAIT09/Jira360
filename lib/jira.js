// Jira client, text conversion, and the cached lists the form and the checks use.

import { AUTH, BASE, JIRA_ISSUE_TYPE, JIRA_SPRINT_FIELD, JIRA_START_DATE_FIELD } from './config.js';
import { extraFields, fromJira } from './fields.js';

export const browseUrl = key => `${BASE}/browse/${key}`;

// ---------- Jira client with retry on 429/5xx ----------
export async function jira(method, path, body, attempt = 0) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt;
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return jira(method, path, body, attempt + 1);
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = new Error(`Jira ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
const safeJson = t => { try { return JSON.parse(t); } catch { return t; } };

export const badRequest = msg => Object.assign(new Error(msg), { status: 400 });

// Plain text -> Atlassian Document Format (required by REST v3 for description/comment/worklog)
export const adf = text => ({
  type: 'doc', version: 1,
  content: String(text || '').split(/\n{2,}/).map(p => ({
    type: 'paragraph',
    content: p ? [{ type: 'text', text: p }] : [],
  })),
});

// Atlassian Document Format -> plain text (paragraphs separated by blank lines)
export const adfToText = node => {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfToText);
  return ['doc', 'bulletList', 'orderedList'].includes(node.type) ? inner.join('\n\n') : inner.join('');
};

export const portalLabel = taskId => `portal-${String(taskId).replace(/[^A-Za-z0-9_-]/g, '-')}`;

export const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean);

// "4" -> "4h"; Jira formats like "1d 2h" or "30m" pass through
export const estimate = v => /^\d+(\.\d+)?$/.test(String(v).trim()) ? `${String(v).trim()}h` : String(v).trim();

// ---------- Lookups ----------
const userCache = new Map();
export async function userForEmail(email) {
  if (!email) return null;
  if (userCache.has(email)) return userCache.get(email);
  const users = await jira('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  const u = Array.isArray(users) && users[0] ? { accountId: users[0].accountId, displayName: users[0].displayName } : null;
  userCache.set(email, u);
  return u;
}
export const accountIdForEmail = async email => (await userForEmail(email))?.accountId || null;

// Sprint and Start date are custom fields whose ids differ per Jira site
let fieldIds = null;
export async function customFieldIds() {
  if (fieldIds) return fieldIds;
  const fields = await jira('GET', '/rest/api/3/field');
  const byName = n => fields.find(f => f.name?.toLowerCase() === n)?.id;
  fieldIds = {
    sprint: JIRA_SPRINT_FIELD || fields.find(f => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id || byName('sprint'),
    startDate: JIRA_START_DATE_FIELD || byName('start date') || byName('target start'),
  };
  return fieldIds;
}

// The latest few comments / work logs, newest first, as plain text (for the form's side panel)
const RECENT = 5;
const recentOf = f => ({
  comments: (f.comment?.comments || []).slice(-RECENT).reverse().map(c => ({
    author: c.author?.displayName || '', created: c.created, body: adfToText(c.body).trim() })),
  worklogs: (f.worklog?.worklogs || []).slice(-RECENT).reverse().map(w => ({
    author: w.author?.displayName || '', started: w.started,
    timeSpent: w.timeSpent || `${+(w.timeSpentSeconds / 3600).toFixed(2)}h`, comment: adfToText(w.comment).trim() })),
});

// A ticket's current values, keyed by the form's field names (the form shows them; the history
// keeps them as the "before" of an update). recent: also the latest comments and work logs.
export async function readIssue(key, { recent = false } = {}) {
  const ids = await customFieldIds();
  const extras = await extraFields().catch(() => []); // values.fields: { <field id>: text } for the extra fields
  const fieldList = ['summary', 'description', 'assignee', 'parent', 'duedate', 'priority', 'status',
    'labels', 'fixVersions', 'timetracking', 'updated', ids.sprint, ids.startDate, ...(recent ? ['comment', 'worklog'] : []), ...extras.map(x => x.id)].filter(Boolean).join(',');
  const { key: k, fields: f } = await jira('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fieldList}`);
  const sprints = (ids.sprint && f[ids.sprint]) || [];
  const sprint = sprints.find(s => s.state === 'active') || sprints.find(s => s.state === 'future') || sprints.at(-1);
  return {
    jiraKey: k,
    url: browseUrl(k),
    updated: f.updated,
    statusName: f.status?.name || '',
    assignee: f.assignee ? { id: f.assignee.accountId, name: f.assignee.displayName } : null,
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
    sprintState: sprint?.state || '',
    ...(recent && { recent: recentOf(f) }),
    values: {
      title: f.summary || '',
      description: adfToText(f.description).trim(),
      assigneeId: f.assignee?.accountId || '',
      parentKey: f.parent?.key || '',
      startDate: (ids.startDate && f[ids.startDate]) || '',
      dueDate: f.duedate || '',
      originalEstimate: f.timetracking?.originalEstimate || '',
      sprint: sprint?.name || '',
      labels: (f.labels || []).filter(l => !l.startsWith('portal-')).join(', '),
      fixVersions: (f.fixVersions || []).map(v => v.name).join(', '),
      priority: f.priority?.name || '',
      status: f.status?.name || '',
      fields: Object.fromEntries(extras.map(x => [x.id, fromJira(x, f[x.id])])),
    },
  };
}

// The Jira account this app signs in as (also a quick check that the token works)
let selfAccountId = null;
export async function whoAmI() {
  selfAccountId ??= (await jira('GET', '/rest/api/3/myself')).accountId;
  return selfAccountId;
}

// Jira lists, kept for a while: the page asks for them on every load, and a big upload is
// checked in several small requests that would otherwise each load them again.
const listCache = new Map();
export function cached(key, fn, ms = 60000) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn();
  listCache.set(key, { at: Date.now(), p });
  p.catch(() => listCache.delete(key));
  return p;
}
const FIVE_MIN = 5 * 60000;
export const lists = {
  sprints: p => cached(`sprints:${p}`, () => projectSprints(p)),
  versions: p => cached(`versions:${p}`, () => jira('GET', `/rest/api/3/project/${encodeURIComponent(p)}/versions`)
    .then(v => v.filter(x => !x.archived).map(x => ({ name: x.name, released: !!x.released })))),
  priorities: () => cached('priorities', () => jira('GET', '/rest/api/3/priority').then(r => r.map(x => x.name)), FIVE_MIN),
  users: p => cached(`users:${p}`, () => assignableUsers(p), FIVE_MIN),
  parents: p => cached(`parents:${p}`, () => parentCandidates(p)),
  statuses: p => cached(`statuses:${p}`, () => projectStatuses(p, JIRA_ISSUE_TYPE), FIVE_MIN),
  labels: () => cached('labels', allLabels, FIVE_MIN),
};

// Open sprints (active + future) across the project's boards. Not filtered to type=scrum:
// team-managed projects report their board as "simple"; boards without sprints just return nothing.
export async function projectSprints(project) {
  const boards = await jira('GET', `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}`);
  const sprints = new Map();
  for (const b of boards.values || []) {
    const r = await jira('GET', `/rest/agile/1.0/board/${b.id}/sprint?state=active,future&maxResults=50`).catch(() => null);
    for (const sp of r?.values || []) sprints.set(sp.id, { id: sp.id, name: sp.name, state: sp.state });
  }
  return [...sprints.values()];
}

// ---------- Jira lists for the form's pickers (cached: see cached() above) ----------
async function assignableUsers(project) {
  const users = await jira('GET', `/rest/api/3/user/assignable/search?project=${encodeURIComponent(project)}&maxResults=1000`);
  return users.filter(u => u.accountType === 'atlassian' && u.active !== false)
    .map(u => ({ id: u.accountId, name: u.displayName, email: u.emailAddress || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Open tickets that can be a parent (epics, or whatever sits one level above a task)
async function parentCandidates(project) {
  const p = await jira('GET', `/rest/api/3/project/${encodeURIComponent(project)}`);
  const types = (p.issueTypes || []).filter(t => t.hierarchyLevel === 1).map(t => `"${t.name}"`);
  if (!types.length) return [];
  const res = await jira('POST', '/rest/api/3/search/jql', {
    jql: `project = "${project}" AND issuetype in (${types.join(',')}) AND statusCategory != Done ORDER BY updated DESC`,
    fields: ['summary'],
    maxResults: 100,
  });
  return (res.issues || []).map(i => ({ key: i.key, summary: i.fields.summary }));
}

// Statuses of the workflow used by the default issue type
async function projectStatuses(project, issueType) {
  const types = await jira('GET', `/rest/api/3/project/${encodeURIComponent(project)}/statuses`);
  const type = types.find(t => t.name.toLowerCase() === issueType.toLowerCase());
  return [...new Set((type ? type.statuses : types.flatMap(t => t.statuses)).map(st => st.name))];
}

async function allLabels() {
  const out = [];
  for (let startAt = 0; startAt < 5000;) {
    const r = await jira('GET', `/rest/api/3/label?startAt=${startAt}&maxResults=1000`);
    out.push(...(r.values || []));
    if (r.isLast !== false || !r.values?.length) break;
    startAt += r.values.length;
  }
  return out.filter(l => !l.startsWith('portal-')).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// Accepts a sprint id ("42") or its name ("PCAI Sprint 7")
export async function sprintId(project, value) {
  if (/^\d+$/.test(String(value))) return Number(value);
  const sp = (await projectSprints(project)).find(x => x.name.toLowerCase() === String(value).trim().toLowerCase());
  if (!sp) throw badRequest(`Sprint "${value}" not found among active/future sprints of ${project}`);
  return sp.id;
}

// ---------- For the Google Sheet sync ----------
// Keys of the project's tickets changed in the last `minutes` (relative time, so the Jira account's
// time zone can't shift the window)
export async function changedSince(project, minutes) {
  const issues = await searchAll(`project = "${project}" AND updated >= "-${Math.max(1, Math.ceil(minutes))}m" ORDER BY updated DESC`, ['updated'], 2000);
  return new Map(issues.map(i => [i.key, i.fields?.updated || ''])); // key -> updated (ISO)
}

// Every ticket a JQL finds (up to `max`), 100 per request
export async function searchAll(jql, fields, max = 1000) {
  const out = [];
  let nextPageToken;
  while (out.length < max) {
    const r = await jira('POST', '/rest/api/3/search/jql', { jql, fields, maxResults: Math.min(100, max - out.length), ...(nextPageToken && { nextPageToken }) });
    out.push(...(r.issues || []));
    if (!r.nextPageToken || !(r.issues || []).length) break;
    nextPageToken = r.nextPageToken;
  }
  return out;
}

// When each field of a ticket last changed (from its history): { <Jira field id>: ms }
export async function fieldChangeTimes(key) {
  const path = `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`;
  const first = await jira('GET', `${path}?maxResults=100`);
  // The newest changes are on the last page
  const last = first.total > 100 ? await jira('GET', `${path}?startAt=${first.total - 100}&maxResults=100`) : first;
  const times = {};
  for (const h of last.values || []) {
    const at = Date.parse(h.created);
    for (const item of h.items || []) {
      const id = item.fieldId || item.field;
      if (id && (!times[id] || times[id] < at)) times[id] = at;
    }
  }
  return times;
}
