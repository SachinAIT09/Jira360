// Checks a task against Jira without changing anything (used by the form, bulk upload and,
// later, the portal and the Google Sheet).

import { BASE, JIRA_PROJECT_KEY, STATUS_MAP } from './config.js';
import { jira, lists, list, estimate, userForEmail } from './jira.js';
import { findIssue, CLEARABLE } from './sync.js';

export const FIELD_LABELS = {
  taskId: 'Task ID', jiraKey: 'Jira key', title: 'Title', description: 'Description', assigneeEmail: 'Assignee email',
  parentKey: 'Parent ticket', startDate: 'Start date', dueDate: 'End date', originalEstimate: 'Original estimate',
  sprint: 'Sprint', labels: 'Labels', fixVersions: 'Fix version', priority: 'Priority', status: 'Status',
};

export const isoDay = d => d.toISOString().slice(0, 10);

// Accepts YYYY-MM-DD, DD/MM/YYYY (also with - or .), or an Excel day number
const ymd = (y, m, d) => {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d ? isoDay(dt) : null;
};
export function normDate(v) {
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return ymd(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) return ymd(m[3], m[2], m[1]);
  if (/^\d{5}$/.test(s)) return isoDay(new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000));
  return null;
}

const ESTIMATE_RE = /^(\d+(\.\d+)?[wdhm]?\s*)+$/i;

// Lists used to check rows (see `lists` in jira.js)
export function previewContext(project = JIRA_PROJECT_KEY) {
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
export async function checkTask(input, ctx) {
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

export const normTitle = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Tickets in the project whose title is exactly this one (ignoring case and extra spaces)
export async function sameTitleTickets(title, project = JIRA_PROJECT_KEY) {
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
