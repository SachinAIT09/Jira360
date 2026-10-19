// The only code that writes to Jira: create/update the issue, move its status, comment, log work.

import { JIRA_ISSUE_TYPE, JIRA_PROJECT_KEY, STATUS_MAP } from './config.js';
import { jira, adf, portalLabel, list, estimate, badRequest, customFieldIds, sprintId, accountIdForEmail, readIssue } from './jira.js';
import { store } from './store.js';
import { toJira } from './fields.js';

// Ticket key per task, by label, kept in the store. Jira's search can take a few seconds to see a
// new ticket; without this, a quick second send of the same task would create it again.
const issueKeyFor = label => store.get(`issue:${label}`).catch(() => null);
const rememberIssueKey = (label, key) => store.set(`issue:${label}`, key)
  .catch(e => console.error('store: could not save ticket key:', e.message));

export async function findIssue(task) {
  if (task.jiraKey) {
    try { return await jira('GET', `/rest/api/3/issue/${encodeURIComponent(task.jiraKey)}?fields=status,labels`); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  if (!task.taskId) return null;
  const label = portalLabel(task.taskId);
  const known = await issueKeyFor(label);
  if (known) {
    try { return await jira('GET', `/rest/api/3/issue/${encodeURIComponent(known)}?fields=status,labels`); }
    catch (e) { if (e.status !== 404) throw e; await store.del(`issue:${label}`).catch(() => {}); }
  }
  const project = task.projectKey || JIRA_PROJECT_KEY;
  const res = await jira('POST', '/rest/api/3/search/jql', {
    jql: `project = "${project}" AND labels = "${label}" ORDER BY created ASC`,
    fields: ['status', 'labels'],
    maxResults: 1,
  });
  return res.issues?.[0] || null;
}

// ---------- Write operations ----------
// Fields the form can empty in Jira (task.clear lists them)
export const CLEARABLE = ['assigneeId', 'startDate', 'dueDate', 'sprint', 'labels', 'fixVersions'];

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
  if (task.fields && typeof task.fields === 'object') Object.assign(f, await toJira(task.fields));
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
export function syncTaskQueued(task) {
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
    await rememberIssueKey(portalLabel(task.taskId), created.key);
    issue = { key: created.key };
    currentStatus = (await jira('GET', `/rest/api/3/issue/${created.key}?fields=status`)).fields.status.name;
    result.actions.push('created');
  } else {
    // What the ticket held before, for the history. Not part of the reply (not enumerable), and a
    // failed read only means the history shows no "before"
    Object.defineProperty(result, 'before', { value: await readIssue(issue.key).catch(() => null) });
    const { fields, update } = await buildFields(task, false, issue);
    if (Object.keys(fields).length || Object.keys(update).length) {
      await jira('PUT', `/rest/api/3/issue/${issue.key}`, { fields, update });
      result.actions.push('updated');
    }
    // Only for tickets this task created (or that carry its label): a Jira key given for some
    // other ticket must not become that task's ticket
    if ((issue.fields?.labels || []).includes(portalLabel(task.taskId))) await rememberIssueKey(portalLabel(task.taskId), issue.key);
  }
  result.jiraKey = issue.key;

  const tr = await transitionTo(issue.key, currentStatus, task.status);
  if (tr?.to) result.actions.push(`transitioned:${tr.to}`);
  if (tr?.warning) result.warning = tr.warning;

  if (task.comment) {
    await jira('POST', `/rest/api/3/issue/${issue.key}/comment`, { body: adf(task.comment) });
    result.actions.push('commented');
  }

  // Log work, like Jira's "Log work" box: time spent in Jira's format ("2h 30m"; Jira applies its own
  // hours per day), or hoursSpent as a number of hours (the portal's older field); when it started;
  // a description; and what happens to the remaining estimate.
  const hours = Number(task.hoursSpent);
  if (task.timeSpent || hours > 0) {
    const wl = task.timeSpent ? { timeSpent: task.timeSpent } : { timeSpentSeconds: Math.round(hours * 3600) };
    if (task.workDate) wl.started = new Date(task.workDate).toISOString().replace('Z', '+0000');
    if (task.worklogNote || task.comment) wl.comment = adf(task.worklogNote || task.comment);
    const q = new URLSearchParams();
    if (task.adjustEstimate && task.adjustEstimate !== 'auto') q.set('adjustEstimate', task.adjustEstimate);
    if (task.adjustEstimate === 'new') q.set('newEstimate', task.newEstimate);
    if (task.adjustEstimate === 'manual') q.set('reduceBy', task.reduceBy);
    await jira('POST', `/rest/api/3/issue/${issue.key}/worklog${q.size ? '?' + q : ''}`, wl);
    result.actions.push(`worklog:${task.timeSpent || hours + 'h'}`);
  }
  return result;
}
