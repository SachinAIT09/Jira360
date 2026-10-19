// Portal -> Jira sync: the shared app (routes and Jira logic).
// Creates/updates the matching Jira issue: summary/description/fields, status transition,
// comment, and worklog. Optional: Jira -> portal status callback (set PORTAL_CALLBACK_URL).
//
// Runs two ways: server.js starts it on this computer (npm start), and
// netlify/functions/api.mjs runs it as a Netlify Function. Node 18+ (uses global fetch).

import express from 'express';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';

const {
  JIRA_BASE_URL,                 // https://yourcompany.atlassian.net
  JIRA_EMAIL,                    // integration account email
  JIRA_API_TOKEN,                // API token for that account
  JIRA_PROJECT_KEY,              // default project, e.g. PCAI
  JIRA_ISSUE_TYPE = 'Task',
  PORTAL_SHARED_SECRET,          // HMAC secret shared with the portal
  PORTAL_CALLBACK_URL = '',      // optional: where to POST Jira-side status changes
  JIRA_WEBHOOK_SECRET = '',      // optional: secret query param on the Jira webhook URL
  STATUS_MAP_JSON = '',          // optional override, e.g. {"todo":"To Do","done":"Done"}
  JIRA_SPRINT_FIELD = '',        // optional: e.g. customfield_10020 (auto-detected if empty)
  JIRA_START_DATE_FIELD = '',    // optional: e.g. customfield_10015 (auto-detected if empty)
  UI_PASSCODE = '',              // HTML form - people enter this to use the form
} = process.env;

export const missingEnv = Object.entries({ JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, PORTAL_SHARED_SECRET })
  .filter(([, v]) => !v).map(([k]) => k);

// Portal status -> Jira status name. Keys are lower-cased portal values.
const STATUS_MAP = {
  'todo': 'To Do', 'to do': 'To Do', 'open': 'To Do',
  'in_progress': 'In Progress', 'in progress': 'In Progress', 'wip': 'In Progress',
  'review': 'In Review', 'in review': 'In Review',
  'blocked': 'Blocked',
  'done': 'Done', 'completed': 'Done', 'closed': 'Done',
  ...(STATUS_MAP_JSON ? JSON.parse(STATUS_MAP_JSON) : {}),
};

const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
const BASE = (JIRA_BASE_URL || '').replace(/\/+$/, '');

// ---------- Jira client with retry on 429/5xx ----------
async function jira(method, path, body, attempt = 0) {
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

// Plain text -> Atlassian Document Format (required by REST v3 for description/comment/worklog)
const adf = text => ({
  type: 'doc', version: 1,
  content: String(text || '').split(/\n{2,}/).map(p => ({
    type: 'paragraph',
    content: p ? [{ type: 'text', text: p }] : [],
  })),
});

const portalLabel = taskId => `portal-${String(taskId).replace(/[^A-Za-z0-9_-]/g, '-')}`;

// ---------- Lookups ----------
const userCache = new Map();
async function userForEmail(email) {
  if (!email) return null;
  if (userCache.has(email)) return userCache.get(email);
  const users = await jira('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  const u = Array.isArray(users) && users[0] ? { accountId: users[0].accountId, displayName: users[0].displayName } : null;
  userCache.set(email, u);
  return u;
}
const accountIdForEmail = async email => (await userForEmail(email))?.accountId || null;

// Sprint and Start date are custom fields whose ids differ per Jira site
let fieldIds = null;
async function customFieldIds() {
  if (fieldIds) return fieldIds;
  const fields = await jira('GET', '/rest/api/3/field');
  const byName = n => fields.find(f => f.name?.toLowerCase() === n)?.id;
  fieldIds = {
    sprint: JIRA_SPRINT_FIELD || fields.find(f => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id || byName('sprint'),
    startDate: JIRA_START_DATE_FIELD || byName('start date') || byName('target start'),
  };
  return fieldIds;
}

// Jira lists, kept for a while: the page asks for them on every load, and a big upload is
// checked in several small requests that would otherwise each load them again.
const listCache = new Map();
function cached(key, fn, ms = 60000) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn();
  listCache.set(key, { at: Date.now(), p });
  p.catch(() => listCache.delete(key));
  return p;
}
const FIVE_MIN = 5 * 60000;
const lists = {
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
async function projectSprints(project) {
  const boards = await jira('GET', `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}`);
  const sprints = new Map();
  for (const b of boards.values || []) {
    const r = await jira('GET', `/rest/agile/1.0/board/${b.id}/sprint?state=active,future&maxResults=50`).catch(() => null);
    for (const sp of r?.values || []) sprints.set(sp.id, { id: sp.id, name: sp.name, state: sp.state });
  }
  return [...sprints.values()];
}

const badRequest = msg => Object.assign(new Error(msg), { status: 400 });

// ---------- Jira lists for the form's pickers (cached: see cached() below) ----------
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
async function sprintId(project, value) {
  if (/^\d+$/.test(String(value))) return Number(value);
  const sp = (await projectSprints(project)).find(x => x.name.toLowerCase() === String(value).trim().toLowerCase());
  if (!sp) throw badRequest(`Sprint "${value}" not found among active/future sprints of ${project}`);
  return sp.id;
}

const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean);

// "4" -> "4h"; Jira formats like "1d 2h" or "30m" pass through
const estimate = v => /^\d+(\.\d+)?$/.test(String(v).trim()) ? `${String(v).trim()}h` : String(v).trim();

// Tickets created by this server, by label. Jira's search can take a few seconds to see a new
// ticket; without this, a quick second send of the same task would create it again.
const createdByLabel = new Map();

async function findIssue(task) {
  if (task.jiraKey) {
    try { return await jira('GET', `/rest/api/3/issue/${encodeURIComponent(task.jiraKey)}?fields=status,labels`); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  if (!task.taskId) return null;
  const known = createdByLabel.get(portalLabel(task.taskId));
  if (known) {
    try { return await jira('GET', `/rest/api/3/issue/${known}?fields=status,labels`); }
    catch (e) { if (e.status !== 404) throw e; createdByLabel.delete(portalLabel(task.taskId)); }
  }
  const project = task.projectKey || JIRA_PROJECT_KEY;
  const res = await jira('POST', '/rest/api/3/search/jql', {
    jql: `project = "${project}" AND labels = "${portalLabel(task.taskId)}" ORDER BY created ASC`,
    fields: ['status', 'labels'],
    maxResults: 1,
  });
  return res.issues?.[0] || null;
}

// ---------- Write operations ----------
// Fields the form can empty in Jira (task.clear lists them)
const CLEARABLE = ['assigneeId', 'startDate', 'dueDate', 'sprint', 'labels', 'fixVersions'];

// Returns { fields, update }. Labels and fix versions are added to what the ticket already has,
// unless task.replaceLists is set (the single-ticket form shows the full list, so it replaces it;
// the hidden portal-* label is always kept so the ticket can still be found).
async function buildFields(task, isCreate, issue) {
  const f = {}, update = {};
  const project = task.projectKey || JIRA_PROJECT_KEY;
  const clear = new Set((Array.isArray(task.clear) ? task.clear : []).filter(k => CLEARABLE.includes(k)));
  const labels = list(task.labels).map(l => l.replace(/\s+/g, '-')); // Jira labels can't contain spaces
  const versions = list(task.fixVersions);
  if (isCreate) {
    f.project = { key: project };
    f.issuetype = { name: task.issueType || JIRA_ISSUE_TYPE };
    f.labels = [portalLabel(task.taskId), ...labels];
    if (versions.length) f.fixVersions = versions.map(name => ({ name }));
  } else if (task.replaceLists) {
    const keep = (issue?.fields?.labels || []).filter(l => l.startsWith('portal-'));
    if (labels.length || clear.has('labels')) f.labels = [...new Set([...keep, ...labels])];
    if (versions.length || clear.has('fixVersions')) f.fixVersions = versions.map(name => ({ name }));
  } else {
    if (labels.length) update.labels = labels.map(add => ({ add }));
    if (versions.length) update.fixVersions = versions.map(name => ({ add: { name } }));
  }
  if (!isCreate) {
    if (clear.has('assigneeId')) f.assignee = null;
    if (clear.has('dueDate')) f.duedate = null;
  }
  if (task.title) f.summary = task.title.slice(0, 254);
  if (task.description !== undefined) f.description = adf(task.description);
  if (task.parentKey) f.parent = { key: task.parentKey.toUpperCase() };
  if (task.dueDate) f.duedate = task.dueDate;              // End date, YYYY-MM-DD
  if (task.priority) f.priority = { name: task.priority }; // must exist in your scheme
  if (task.originalEstimate) f.timetracking = { originalEstimate: estimate(task.originalEstimate) };
  const clearStart = !isCreate && clear.has('startDate'), clearSprint = !isCreate && clear.has('sprint');
  if (task.startDate || task.sprint || clearStart || clearSprint) {
    const ids = await customFieldIds();
    if (task.startDate || clearStart) {
      if (!ids.startDate) throw badRequest('No "Start date" field found in Jira; set JIRA_START_DATE_FIELD');
      f[ids.startDate] = task.startDate || null;
    }
    if (task.sprint || clearSprint) {
      if (!ids.sprint) throw badRequest('No Sprint field found in Jira; set JIRA_SPRINT_FIELD');
      f[ids.sprint] = task.sprint ? await sprintId(project, task.sprint) : null;
    }
  }
  if (task.assigneeId) f.assignee = { id: task.assigneeId };
  else if (task.assigneeEmail) {
    const id = await accountIdForEmail(task.assigneeEmail);
    if (!id) throw badRequest(`No Jira user found for ${task.assigneeEmail}`);
    f.assignee = { id };
  }
  return { fields: f, update };
}

async function transitionTo(issueKey, currentStatus, portalStatus) {
  if (!portalStatus) return null;
  const target = STATUS_MAP[String(portalStatus).toLowerCase()] || portalStatus;
  if (currentStatus && currentStatus.toLowerCase() === target.toLowerCase()) return { skipped: 'already in status' };
  const { transitions } = await jira('GET', `/rest/api/3/issue/${issueKey}/transitions`);
  const t = transitions.find(x =>
    x.to?.name?.toLowerCase() === target.toLowerCase() || x.name.toLowerCase() === target.toLowerCase());
  if (!t) return { warning: `No transition to "${target}" from "${currentStatus}". Available: ${transitions.map(x => x.to?.name).join(', ')}` };
  await jira('POST', `/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: t.id } });
  return { to: target };
}

// Requests for the same task run one after another: the second one then finds the ticket
// the first one created instead of creating another.
const taskQueues = new Map();
function syncTaskQueued(task) {
  const k = portalLabel(task.taskId);
  const run = (taskQueues.get(k) || Promise.resolve()).catch(() => {}).then(() => syncTask(task));
  taskQueues.set(k, run);
  run.catch(() => {}).finally(() => { if (taskQueues.get(k) === run) taskQueues.delete(k); });
  return run;
}

async function syncTask(task) {
  const result = { taskId: task.taskId, actions: [] };
  let issue = await findIssue(task);
  let currentStatus = issue?.fields?.status?.name;

  if (!issue) {
    const { fields } = await buildFields(task, true);
    const created = await jira('POST', '/rest/api/3/issue', { fields });
    createdByLabel.set(portalLabel(task.taskId), created.key);
    issue = { key: created.key };
    currentStatus = (await jira('GET', `/rest/api/3/issue/${created.key}?fields=status`)).fields.status.name;
    result.actions.push('created');
  } else {
    const { fields, update } = await buildFields(task, false, issue);
    if (Object.keys(fields).length || Object.keys(update).length) {
      await jira('PUT', `/rest/api/3/issue/${issue.key}`, { fields, update });
      result.actions.push('updated');
    }
  }
  result.jiraKey = issue.key;

  const tr = await transitionTo(issue.key, currentStatus, task.status);
  if (tr?.to) result.actions.push(`transitioned:${tr.to}`);
  if (tr?.warning) result.warning = tr.warning;

  if (task.comment) {
    await jira('POST', `/rest/api/3/issue/${issue.key}/comment`, { body: adf(task.comment) });
    result.actions.push('commented');
  }

  const hours = Number(task.hoursSpent);
  if (hours > 0) {
    const wl = { timeSpentSeconds: Math.round(hours * 3600) };
    if (task.workDate) wl.started = new Date(task.workDate).toISOString().replace('Z', '+0000');
    if (task.worklogNote || task.comment) wl.comment = adf(task.worklogNote || task.comment);
    await jira('POST', `/rest/api/3/issue/${issue.key}/worklog`, wl);
    result.actions.push(`worklog:${hours}h`);
  }
  return result;
}

// ---------- Idempotency (in-memory; use Redis if you run >1 instance) ----------
const seen = new Map();
const MAX_SEEN = 5000;
function alreadyProcessed(eventId) {
  if (!eventId) return false;
  if (seen.has(eventId)) return seen.get(eventId);
  return false;
}
function remember(eventId, result) {
  if (!eventId) return;
  seen.set(eventId, result);
  if (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
}

// ---------- HTTP ----------
const app = express();
export default app;

// On Netlify, requests arrive as /.netlify/functions/api/<path>; strip that so routes match either way
app.use((req, _res, next) => { req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '') || '/'; next(); });
app.use((req, res, next) => missingEnv.length && req.path !== '/health'
  ? res.status(503).json({ error: `Server not configured: missing ${missingEnv.join(', ')}` }) : next());
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

function validSignature(req) {
  const sig = req.get('X-Portal-Signature') || '';
  const expected = crypto.createHmac('sha256', PORTAL_SHARED_SECRET).update(req.rawBody || '').digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

app.get('/health', (_req, res) => res.json({ ok: !missingEnv.length }));

// ---------- HTML form (page served by server.js locally, by Netlify when hosted) ----------
// Suggestions for the form's Sprint and Fix version boxes
function uiAuth(req, res, next) {
  if (!UI_PASSCODE) return res.status(503).json({ error: 'Form disabled: set UI_PASSCODE on the server' });
  const given = req.get('X-UI-Passcode') || '';
  if (given.length !== UI_PASSCODE.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(UI_PASSCODE)))
    return res.status(401).json({ error: 'Wrong passcode' });
  next();
}

// Everything the form's pickers offer, read from Jira. A list that fails comes back empty and is
// named in "failed", so the page can still be used for the rest.
app.get('/ui/options', uiAuth, async (_req, res) => {
  const p = JIRA_PROJECT_KEY, failed = [];
  const get = (name, promise, fallback) => promise.catch(e => { failed.push(name); console.error(`${name}: ${e.message}`); return fallback; });
  const [sprints, versions, priorities, users, parents, statuses, labels] = await Promise.all([
    get('sprints', lists.sprints(p), []), get('versions', lists.versions(p), []), get('priorities', lists.priorities(), []),
    get('users', lists.users(p), []), get('parents', lists.parents(p), []), get('statuses', lists.statuses(p), []),
    get('labels', lists.labels(), []),
  ]);
  res.json({ project: p, issueType: JIRA_ISSUE_TYPE, sprints, versions, priorities, users, parents, statuses, labels, failed });
});

// Atlassian Document Format -> plain text (paragraphs separated by blank lines)
const adfToText = node => {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfToText);
  return ['doc', 'bulletList', 'orderedList'].includes(node.type) ? inner.join('\n\n') : inner.join('');
};

// Current Jira values for the form, keyed by the form's field names (polled by the page)
app.get('/ui/issue', uiAuth, async (req, res) => {
  const { jiraKey, taskId } = req.query;
  if (!jiraKey && !taskId) return res.status(400).json({ error: 'Give a Jira key or task ID' });
  try {
    const found = await findIssue({ jiraKey, taskId: taskId || '' });
    if (!found) return res.status(404).json({ notFound: true });
    const ids = await customFieldIds();
    const fieldList = ['summary', 'description', 'assignee', 'parent', 'duedate', 'priority', 'status',
      'labels', 'fixVersions', 'timetracking', 'updated', ids.sprint, ids.startDate].filter(Boolean).join(',');
    const [{ key, fields: f }, { transitions = [] }] = await Promise.all([
      jira('GET', `/rest/api/3/issue/${encodeURIComponent(found.key)}?fields=${fieldList}`),
      jira('GET', `/rest/api/3/issue/${encodeURIComponent(found.key)}/transitions`).catch(() => ({})),
    ]);
    const sprints = (ids.sprint && f[ids.sprint]) || [];
    const sprint = sprints.find(s => s.state === 'active') || sprints.find(s => s.state === 'future') || sprints.at(-1);
    res.json({
      jiraKey: key,
      url: `${BASE}/browse/${key}`,
      updated: f.updated,
      statusName: f.status?.name || '',
      nextStatuses: [...new Set(transitions.map(t => t.to?.name).filter(Boolean))],
      assignee: f.assignee ? { id: f.assignee.accountId, name: f.assignee.displayName } : null,
      parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
      sprintState: sprint?.state || '',
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
      },
    });
  } catch (e) {
    console.error(e.message);
    res.status(e.status === 404 ? 404 : 502).json({ error: e.message });
  }
});

// ---------- Preview before sending (single form and bulk upload) ----------
const FIELD_LABELS = {
  taskId: 'Task ID', jiraKey: 'Jira key', title: 'Title', description: 'Description', assigneeEmail: 'Assignee email',
  parentKey: 'Parent ticket', startDate: 'Start date', dueDate: 'End date', originalEstimate: 'Original estimate',
  sprint: 'Sprint', labels: 'Labels', fixVersions: 'Fix version', priority: 'Priority', status: 'Status',
};

// Spreadsheet column headers accepted for each field (compared lower-case, letters and digits only)
const HEADER_ALIASES = {
  taskId: ['taskid', 'task', 'id'],
  jiraKey: ['jirakey', 'key', 'jira', 'ticketkey'],
  title: ['title', 'tickettitle', 'summary'],
  description: ['description', 'ticketdescription', 'details'],
  assigneeEmail: ['assignee', 'assigneeemail', 'assignto', 'assign', 'email'],
  parentKey: ['parent', 'parentticket', 'parentkey', 'epic'],
  startDate: ['startdate', 'start'],
  dueDate: ['enddate', 'duedate', 'end', 'due'],
  originalEstimate: ['originalestimate', 'estimate', 'estimatehours'],
  sprint: ['sprint'],
  labels: ['labels', 'label'],
  fixVersions: ['fixversion', 'fixversions', 'version'],
  priority: ['priority'],
  status: ['status'],
};
const HEADER_TO_FIELD = Object.fromEntries(Object.entries(HEADER_ALIASES).flatMap(([f, names]) => names.map(n => [n, f])));
const normHeader = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const nl = text.search(/\r?\n/);
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  // Excel saves CSV with ";" in some regions, so pick whichever separator the header uses most
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const isoDay = d => d.toISOString().slice(0, 10);
function cellText(cell) {
  const v = cell.value;
  if (v instanceof Date) return isoDay(v);
  if (v && typeof v === 'object' && 'result' in v) return v.result instanceof Date ? isoDay(v.result) : String(v.result ?? ''); // formula
  return cell.text ?? '';
}

async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets.find(w => w.actualRowCount > 0);
  if (!ws) return [];
  const rows = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r), cells = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c)));
    rows.push(cells);
  }
  return rows;
}

// Rows of cells -> [{ row, task }], using the first non-empty row as headers
function rowsToTasks(rows) {
  const h = rows.findIndex(r => r.some(c => String(c).trim()));
  if (h < 0) throw badRequest('The file is empty');
  const headers = rows[h].map(x => String(x).trim());
  const fields = headers.map(x => HEADER_TO_FIELD[normHeader(x)] || null);
  if (!fields.includes('title')) throw badRequest('No "Title" column found. Download the template to see the expected columns.');
  const tasks = [];
  for (let i = h + 1; i < rows.length; i++) {
    const task = {};
    fields.forEach((f, c) => { const v = String(rows[i][c] ?? '').trim(); if (f && v) task[f] = v; });
    if (Object.keys(task).length) tasks.push({ row: i + 1, task });
  }
  return { tasks, ignoredColumns: headers.filter((x, i) => x && !fields[i]) };
}

// Accepts YYYY-MM-DD, DD/MM/YYYY (also with - or .), or an Excel day number
const ymd = (y, m, d) => {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d ? isoDay(dt) : null;
};
function normDate(v) {
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return ymd(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) return ymd(m[3], m[2], m[1]);
  if (/^\d{5}$/.test(s)) return isoDay(new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000));
  return null;
}

const ESTIMATE_RE = /^(\d+(\.\d+)?[wdhm]?\s*)+$/i;

// Lists used to check rows (see `lists` above)
function previewContext(project) {
  return {
    sprints: () => lists.sprints(project).catch(() => []),
    versions: () => lists.versions(project).then(v => v.map(x => x.name)).catch(() => null),
    priorities: () => lists.priorities().catch(() => null),
    users: () => lists.users(project).catch(() => null),
    statuses: () => lists.statuses(project).catch(() => null),
    parents: new Map(),
  };
}

const sameName = (list, value) => list.find(x => x.toLowerCase() === String(value).toLowerCase());

// Checks one task against Jira without changing anything. Returns the cleaned-up task to send,
// plus errors (block sending), warnings, and what will happen (create / update <key>).
async function checkTask(input, ctx) {
  const t = {}, errors = [], warnings = [], info = {};
  for (const [k, v] of Object.entries(input)) if (v !== '' && v != null) t[k] = typeof v === 'string' ? v.trim() : v;
  try {
    const existing = (t.jiraKey || t.taskId) ? await findIssue({ jiraKey: t.jiraKey, taskId: t.taskId || '' }) : null;
    if (t.jiraKey && existing?.key !== t.jiraKey.toUpperCase()) errors.push(`Jira key ${t.jiraKey} not found`);
    info.action = existing ? 'update' : 'create';
    info.existingKey = existing?.key || '';
    info.url = existing ? `${BASE}/browse/${existing.key}` : '';
    if (existing && !Object.keys(t).some(k => !['taskId', 'jiraKey', 'replaceLists'].includes(k)))
      errors.push('Nothing to update: only the Jira key / Task ID is filled in');
    if (!existing && !t.title) errors.push('Title is required for a new ticket');
    if (!existing && t.title) {
      const same = await sameTitleTickets(t.title);
      if (same.length) { info.duplicates = same; info.suggestUntick = true; }
    }
    if (t.title?.length > 254) warnings.push('Title is longer than 254 characters and will be cut');

    for (const k of ['startDate', 'dueDate']) if (t[k]) {
      const d = normDate(t[k]);
      if (d) t[k] = d; else errors.push(`${FIELD_LABELS[k]} "${t[k]}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`);
    }
    if (/^\d{4}-/.test(t.startDate) && /^\d{4}-/.test(t.dueDate) && t.startDate > t.dueDate) errors.push('Start date is after end date');

    if (t.originalEstimate) {
      const e = String(t.originalEstimate).replace(/(\d)\s+([wdhm])/gi, '$1$2').trim();
      if (ESTIMATE_RE.test(e)) t.originalEstimate = estimate(e);
      else errors.push(`Original estimate "${t.originalEstimate}" is not valid (examples: 4, 4h, 1d 2h, 30m)`);
    }

    if (t.assigneeId) {
      const users = await ctx.users();
      const u = users?.find(x => x.id === t.assigneeId);
      if (users && !u) errors.push('That person can no longer be assigned in this project');
      else info.assigneeName = u?.name || '';
    } else if (t.assigneeEmail) {
      // A spreadsheet can give an email or a display name
      const v = String(t.assigneeEmail);
      if (v.includes('@')) {
        const u = await userForEmail(v);
        if (u) { t.assigneeId = u.accountId; info.assigneeName = u.displayName; }
        else errors.push(`No Jira user found for ${v}`);
      } else {
        const matches = ((await ctx.users()) || []).filter(x => x.name.toLowerCase() === v.toLowerCase());
        if (matches.length === 1) { t.assigneeId = matches[0].id; info.assigneeName = matches[0].name; }
        else errors.push(matches.length ? `"${v}" matches ${matches.length} people; use their email` : `No one called "${v}" can be assigned in this project`);
      }
    }

    if (t.parentKey) {
      t.parentKey = t.parentKey.toUpperCase();
      if (!ctx.parents.has(t.parentKey)) ctx.parents.set(t.parentKey,
        jira('GET', `/rest/api/3/issue/${encodeURIComponent(t.parentKey)}?fields=summary`)
          .then(i => i.fields.summary, e => (e.status === 404 ? null : Promise.reject(e))));
      const summary = await ctx.parents.get(t.parentKey);
      if (summary == null) errors.push(`Parent ticket ${t.parentKey} not found`); else info.parentSummary = summary;
    }

    if (t.sprint && !/^\d+$/.test(t.sprint)) {
      const open = await ctx.sprints();
      const sp = open.find(x => x.name.toLowerCase() === t.sprint.toLowerCase());
      if (sp) t.sprint = sp.name;
      else errors.push(`Sprint "${t.sprint}" not found (open sprints: ${open.map(x => x.name).join(', ') || 'none'})`);
    }

    if (t.fixVersions) {
      const all = await ctx.versions();
      if (all) {
        const wanted = list(t.fixVersions), missing = wanted.filter(v => !sameName(all, v));
        if (missing.length) errors.push(`Fix version not found: ${missing.join(', ')}`);
        else t.fixVersions = wanted.map(v => sameName(all, v)).join(', ');
      }
    }

    if (t.priority) {
      const all = await ctx.priorities();
      if (all && !sameName(all, t.priority)) errors.push(`Priority "${t.priority}" doesn't exist (use ${all.join(', ')})`);
      else if (all) t.priority = sameName(all, t.priority);
    }

    if (t.status) {
      const all = await ctx.statuses();
      const wanted = String(t.status);
      const name = (all && (sameName(all, wanted) || sameName(all, STATUS_MAP[wanted.toLowerCase()] || ''))) || STATUS_MAP[wanted.toLowerCase()] || wanted;
      if (all && !sameName(all, name)) errors.push(`Status "${wanted}" doesn't exist in this project's workflow`);
      else { t.status = name; info.statusName = name; }
    }

    if (Array.isArray(t.clear)) {
      t.clear = t.clear.filter(k => CLEARABLE.includes(k) && !t[k]);
      if (!t.clear.length) delete t.clear;
    }

    if (list(t.labels).some(l => /\s/.test(l))) warnings.push('Spaces inside labels will become "-"');
  } catch (e) {
    errors.push(e.message);
  }
  return { task: t, errors, warnings, info };
}

const normTitle = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Tickets in the project whose title is exactly this one (ignoring case and extra spaces)
async function sameTitleTickets(title, project = JIRA_PROJECT_KEY) {
  const words = normTitle(title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); // text search can't take symbols
  if (!words) return [];
  const res = await jira('POST', '/rest/api/3/search/jql', {
    jql: `project = "${project}" AND summary ~ "\\"${words}\\"" ORDER BY created DESC`, // phrase search, then exact match below
    fields: ['summary', 'status'],
    maxResults: 50,
  });
  return (res.issues || []).filter(i => normTitle(i.fields.summary) === normTitle(title))
    .map(i => ({ key: i.key, status: i.fields.status?.name || '', url: `${BASE}/browse/${i.key}` }));
}

// Task ID for a row that has none: made from the title (and parent), so uploading the same row
// again finds the ticket it created the first time instead of creating a duplicate
const autoTaskId = t => 'XL-' + crypto.createHash('sha1')
  .update(normTitle(t.title) + '|' + String(t.parentKey || '').trim().toUpperCase()).digest('hex').slice(0, 10).toUpperCase();

// Runs fn over items with at most n in flight, keeping order
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

app.post('/ui/preview', uiAuth, async (req, res) => {
  res.json(await checkTask(req.body || {}, previewContext(JIRA_PROJECT_KEY)));
});

const MAX_BULK_ROWS = 200;
const CHECK_CHUNK = 5;

// Bulk step 1: read the file and find duplicates inside it. No Jira calls, so it is quick.
app.post('/ui/bulk/parse', uiAuth, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'No file received' });
  try {
    let rows;
    if (buf[0] === 0x50 && buf[1] === 0x4b) rows = await parseXlsx(buf);           // .xlsx is a zip ("PK")
    else if (buf[0] === 0xd0 && buf[1] === 0xcf) throw badRequest('Old .xls files are not supported. In Excel use File > Save As > Excel Workbook (.xlsx) or CSV.');
    else rows = parseCsv(buf.toString('utf8'));

    const { tasks, ignoredColumns } = rowsToTasks(rows);
    if (!tasks.length) throw badRequest('No ticket rows found under the header row');
    if (tasks.length > MAX_BULK_ROWS) throw badRequest(`The file has ${tasks.length} rows; the limit is ${MAX_BULK_ROWS} per upload`);

    // Duplicates inside the file. Same Task ID / Jira key (including Task IDs made from the same
    // title) would make the second row overwrite the first, so that's an error; the same title
    // under different Task IDs is allowed but suspicious, so those rows start unticked.
    const generated = new Set();
    for (const { row, task } of tasks) {
      if (task.taskId) continue;
      if (task.jiraKey) task.taskId = task.jiraKey.toUpperCase(); // only used to send; the key finds the ticket
      else { task.taskId = autoTaskId(task); generated.add(row); }
    }
    const firstSeen = new Map(), dupes = new Map(), titleDupes = new Map();
    for (const { row, task } of tasks) {
      for (const id of [task.taskId && `Task ID ${task.taskId}`, task.jiraKey && `Jira key ${task.jiraKey.toUpperCase()}`]) {
        if (!id) continue;
        const first = firstSeen.get(id);
        if (!first) { firstSeen.set(id, row); continue; }
        dupes.set(row, generated.has(row) && generated.has(first)
          ? `Same title as row ${first}. Give each row its own Task ID if both are really needed`
          : `${id} is also on row ${first}`);
      }
      const tKey = task.title && `title ${normTitle(task.title)}`;
      if (tKey && !dupes.has(row)) {
        if (firstSeen.has(tKey)) titleDupes.set(row, firstSeen.get(tKey)); else firstSeen.set(tKey, row);
      }
    }

    res.json({
      project: JIRA_PROJECT_KEY,
      ignoredColumns,
      checkChunk: CHECK_CHUNK,
      rows: tasks.map(({ row, task }) => ({
        row, task,
        errors: dupes.has(row) ? [dupes.get(row)] : [],
        info: {
          ...(titleDupes.has(row) && { sameTitleRow: titleDupes.get(row), suggestUntick: true }),
          ...(generated.has(row) && { autoTaskId: true }),
        },
      })),
    });
  } catch (e) {
    console.error(e.message);
    res.status(e.status === 400 ? 400 : 502).json({ error: e.message });
  }
});

// Bulk step 2: check a few rows against Jira. The page sends the file's rows in chunks so each
// request stays well inside Netlify's ~10 second limit.
app.post('/ui/bulk/check', uiAuth, async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > CHECK_CHUNK)
    return res.status(400).json({ error: `Send 1 to ${CHECK_CHUNK} rows at a time` });
  const ctx = previewContext(JIRA_PROJECT_KEY);
  res.json({ rows: await mapLimit(rows, 5, async r => ({ row: r.row, ...(await checkTask(r.task || {}, ctx)) })) });
});

app.post('/ui/task', uiAuth, async (req, res) => {
  const task = req.body || {};
  if (!task.taskId) return res.status(400).json({ error: 'Task ID is required' });
  try {
    const result = await syncTaskQueued(task);
    console.log(JSON.stringify({ at: new Date().toISOString(), via: 'ui', ...result }));
    res.json({ ...result, url: `${BASE}/browse/${result.jiraKey}` });
  } catch (e) {
    console.error(e.message);
    res.status(e.status === 400 ? 400 : 502).json({ error: e.message });
  }
});

// Portal calls this every time a task is posted/updated.
app.post('/portal/task', async (req, res) => {
  if (!validSignature(req)) return res.status(401).json({ error: 'bad signature' });
  const task = req.body || {};
  if (!task.taskId) return res.status(400).json({ error: 'taskId is required' });

  const eventId = req.get('X-Event-Id');
  const prior = alreadyProcessed(eventId);
  if (prior) return res.json({ ...prior, duplicate: true });

  try {
    const result = await syncTaskQueued(task);
    remember(eventId, result);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    res.json(result);
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: e.message });
  }
});

// Optional reverse sync: register a Jira webhook (issue updated) pointing to
// https://<host>/jira/webhook?secret=<JIRA_WEBHOOK_SECRET>
// The Jira account this app signs in as (also a quick check that the token works)
let selfAccountId = null;
export async function whoAmI() {
  selfAccountId ??= (await jira('GET', '/rest/api/3/myself')).accountId;
  return selfAccountId;
}

app.post('/jira/webhook', async (req, res) => {
  if (!PORTAL_CALLBACK_URL) return res.status(404).end();
  if (JIRA_WEBHOOK_SECRET && req.query.secret !== JIRA_WEBHOOK_SECRET) return res.status(401).end();
  try {
    const { issue, user, changelog } = req.body || {};
    const statusChange = changelog?.items?.find(i => i.field === 'status');
    const label = (issue?.fields?.labels || []).find(l => l.startsWith('portal-'));
    // ignore our own edits (loop guard), non-status changes and tickets the portal didn't create
    if (issue && statusChange && label && user?.accountId !== await whoAmI().catch(() => null)) {
      const body = JSON.stringify({ taskId: label.slice(7), jiraKey: issue.key, status: statusChange.toString });
      const sig = crypto.createHmac('sha256', PORTAL_SHARED_SECRET).update(body).digest('hex');
      await fetch(PORTAL_CALLBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jira-Signature': sig }, body });
    }
  } catch (e) { console.error('portal callback failed:', e.message); }
  res.status(204).end();
});
