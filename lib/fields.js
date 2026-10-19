// Jira's own field list for the project and issue type ("create metadata"), so the form can offer
// any field, not only the built-in ones, each with an on/off switch.
//
// Built-in fields keep their special pickers (labels, sprint, ...); any other field of a type the form
// can edit is an "extra" field, sent as task.fields = { <Jira field id>: <text value> }.
// Which fields show is a shared setting (config:fields in the store: { hidden, order }); each person
// can show or hide more for themselves in their browser.

import { JIRA_ISSUE_TYPE, JIRA_PROJECT_KEY } from './config.js';
import { jira, customFieldIds, list, adf, adfToText, lists, badRequest } from './jira.js';
import { store } from './store.js';

// Jira field id -> the form's field (the sprint / start date ids differ per site)
async function builtinIds() {
  const ids = await customFieldIds();
  return {
    summary: 'title', description: 'description', assignee: 'assigneeId', parent: 'parentKey', duedate: 'dueDate',
    priority: 'priority', labels: 'labels', fixVersions: 'fixVersions', timetracking: 'originalEstimate',
    ...(ids.sprint && { [ids.sprint]: 'sprint' }), ...(ids.startDate && { [ids.startDate]: 'startDate' }),
  };
}
// Form-only fields (not Jira fields) that can be switched off too
export const FORM_FIELDS = [
  ['taskId', 'Task ID'], ['jiraKey', 'Jira key'], ['title', 'Title'], ['description', 'Description'], ['assigneeId', 'Assignee'],
  ['parentKey', 'Parent ticket'], ['startDate', 'Start date'], ['dueDate', 'End date'], ['originalEstimate', 'Original estimate'],
  ['sprint', 'Sprint'], ['labels', 'Labels'], ['fixVersions', 'Fix version'], ['priority', 'Priority'], ['status', 'Status'],
  ['comment', 'Comment'], ['hoursSpent', 'Hours spent'],
];
const ALWAYS = ['title']; // a ticket needs a title

const NOT_EDITABLE = new Set(['project', 'issuetype', 'attachment', 'issuelinks', 'issuerestriction']);

// What kind of input a field gets, from Jira's schema; null = not editable here
export function kindOf(schema = {}) {
  const t = schema.type, items = schema.items, custom = (schema.custom || '').split(':').pop();
  if (t === 'string') return custom === 'textarea' ? 'textarea' : 'text';
  if (t === 'number') return 'number';
  if (t === 'date') return 'date';
  if (t === 'datetime') return 'datetime';
  if (t === 'option') return 'option';
  if (t === 'user') return 'user';
  if (t === 'version') return 'version';
  if (t === 'array' && items === 'option') return 'options';
  if (t === 'array' && items === 'string') return 'strings';
  if (t === 'array' && items === 'user') return 'users';
  if (t === 'array' && items === 'component') return 'components';
  if (t === 'array' && items === 'version') return 'versions';
  return null;
}

// Fields of the project's issue type, cached for 10 minutes
let metaCache = null;
export async function fieldMeta(project = JIRA_PROJECT_KEY, issueType = JIRA_ISSUE_TYPE) {
  if (metaCache && metaCache.key === project + issueType && Date.now() - metaCache.at < 600000) return metaCache.p;
  const p = (async () => {
    const types = await jira('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`);
    const type = (types.issueTypes || types.values || []).find(t => t.name.toLowerCase() === issueType.toLowerCase());
    if (!type) throw badRequest(`Issue type "${issueType}" not found in ${project}`);
    const fields = [];
    for (let startAt = 0; startAt < 1000;) {
      const r = await jira('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${type.id}?startAt=${startAt}&maxResults=200`);
      const page = r.fields || r.results || r.values || [];
      fields.push(...page);
      if (!page.length || fields.length >= (r.total ?? fields.length)) break;
      startAt += page.length;
    }
    const builtin = await builtinIds();
    return fields.map(f => ({
      id: f.fieldId || f.key, name: f.name, schema: f.schema || {},
      required: !!f.required && !f.hasDefaultValue, // Jira fills a field that has a default (e.g. Reporter)
      builtin: builtin[f.fieldId || f.key] || null,
      kind: kindOf(f.schema),
      allowed: (f.allowedValues || []).map(v => v.value ?? v.name).filter(Boolean),
    }));
  })();
  metaCache = { key: project + issueType, at: Date.now(), p };
  p.catch(() => { metaCache = null; });
  return p;
}

// The extra fields: not built in, of a kind the form can edit
export async function extraFields() {
  return (await fieldMeta()).filter(f => !f.builtin && f.kind && !NOT_EDITABLE.has(f.id) && !NOT_EDITABLE.has(f.schema.system));
}
const extraById = async () => new Map((await extraFields()).map(f => [f.id, f]));

// ---------- Shared setting: which fields show, in which order ----------
export async function getFieldConfig() {
  const c = await store.get('config:fields').catch(() => null);
  return { hidden: c?.hidden || [], order: c?.order || [], updatedBy: c?.updatedBy || '', updatedAt: c?.updatedAt || '' };
}
export async function setFieldConfig({ hidden = [], order = [] }, by) {
  const all = new Set([...FORM_FIELDS.map(f => f[0]), ...(await extraFields()).map(f => f.id)]);
  const required = new Set([...ALWAYS, ...(await extraFields()).filter(f => f.required).map(f => f.id)]);
  const clean = { hidden: [...new Set(hidden)].filter(k => all.has(k) && !required.has(k)), order: [...new Set(order)].filter(k => all.has(k)),
    updatedBy: by || '', updatedAt: new Date().toISOString() };
  await store.set('config:fields', clean);
  return clean;
}

// Everything the "Customize fields" dialog and the form need
export async function fieldsForPage() {
  const meta = await fieldMeta();
  const extras = await extraFields();
  return {
    form: FORM_FIELDS.map(([key, name]) => ({ key, name, locked: ALWAYS.includes(key) })),
    extra: extras.map(f => ({ id: f.id, name: f.name, kind: f.kind, required: f.required, allowed: f.allowed })),
    // (project and issue type are set by the app itself, so they aren't listed)
    notEditable: meta.filter(f => !f.builtin && (!f.kind || NOT_EDITABLE.has(f.id)) && !['project', 'issuetype'].includes(f.id)).map(f => f.name),
    config: await getFieldConfig(),
  };
}

// ---------- Values: form text <-> Jira ----------
async function userId(v) {
  const users = await lists.users(JIRA_PROJECT_KEY).catch(() => []);
  const s = String(v).trim().toLowerCase();
  const hits = users.filter(u => u.id.toLowerCase() === s || (u.email && u.email.toLowerCase() === s) || u.name.toLowerCase() === s);
  return hits.length === 1 ? hits[0] : null;
}

// Checks and tidies task.fields (used by the preview). Returns { fields, errors, names }.
export async function checkExtraFields(values = {}, isCreate) {
  const byId = await extraById();
  const out = {}, errors = [], names = {};
  for (const [id, raw] of Object.entries(values || {})) {
    const f = byId.get(id);
    if (!f) { errors.push(`Field ${id} can't be set from here`); continue; }
    names[id] = f.name;
    const v = String(raw ?? '').trim();
    if (!v) { if (!isCreate) out[id] = ''; continue; } // empty on an update = remove the value
    const pick = x => f.allowed.find(a => a.toLowerCase() === x.toLowerCase());
    switch (f.kind) {
      case 'number': if (Number.isFinite(Number(v))) out[id] = v; else errors.push(`${f.name}: "${v}" is not a number`); break;
      case 'date': { const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; if (d || !Number.isNaN(Date.parse(v))) out[id] = d || new Date(v).toISOString().slice(0, 10); else errors.push(`${f.name}: "${v}" is not a date`); break; }
      case 'datetime': if (!Number.isNaN(Date.parse(v))) out[id] = v; else errors.push(`${f.name}: "${v}" is not a date and time`); break;
      case 'option': case 'version':
        if (!f.allowed.length || pick(v)) out[id] = pick(v) || v; else errors.push(`${f.name}: "${v}" is not one of ${f.allowed.join(', ')}`); break;
      case 'options': case 'components': case 'versions': {
        const want = list(v), bad = want.filter(x => f.allowed.length && !pick(x));
        if (bad.length) errors.push(`${f.name}: ${bad.join(', ')} not allowed (use ${f.allowed.join(', ')})`); else out[id] = want.map(x => pick(x) || x).join(', ');
        break;
      }
      case 'user': { const u = await userId(v); if (u) out[id] = u.id; else errors.push(`${f.name}: no one called "${v}" can be chosen`); break; }
      case 'users': {
        const found = await Promise.all(list(v).map(userId));
        if (found.some(u => !u)) errors.push(`${f.name}: some people in "${v}" can't be chosen`); else out[id] = found.map(u => u.id).join(', ');
        break;
      }
      default: out[id] = v;
    }
  }
  if (isCreate) for (const f of byId.values()) if (f.required && !out[f.id]) errors.push(`${f.name} is required by Jira for a new ticket`);
  return { fields: out, errors, names };
}

// Checked text value -> what Jira's API expects ('' -> null, which empties the field)
export async function toJira(values = {}) {
  const byId = await extraById();
  const out = {};
  for (const [id, v] of Object.entries(values)) {
    const f = byId.get(id);
    if (!f) continue;
    if (v === '' || v == null) { out[id] = ['options', 'strings', 'users', 'components', 'versions'].includes(f.kind) ? [] : null; continue; }
    switch (f.kind) {
      case 'textarea': out[id] = adf(v); break;
      case 'number': out[id] = Number(v); break;
      case 'option': out[id] = { value: v }; break;
      case 'version': out[id] = { name: v }; break;
      case 'options': out[id] = list(v).map(value => ({ value })); break;
      case 'components': case 'versions': out[id] = list(v).map(name => ({ name })); break;
      case 'strings': out[id] = list(v); break;
      case 'user': out[id] = { id: v }; break;
      case 'users': out[id] = list(v).map(id2 => ({ id: id2 })); break;
      default: out[id] = v; // text, date (YYYY-MM-DD), datetime
    }
  }
  return out;
}

// Jira's value -> the text the form shows (people as their names, like the pickers)
export function fromJira(f, v) {
  if (v == null) return '';
  switch (f.kind) {
    case 'textarea': return typeof v === 'string' ? v : adfToText(v).trim();
    case 'option': case 'version': return v.value ?? v.name ?? '';
    case 'options': case 'components': case 'versions': return (v || []).map(x => x.value ?? x.name).join(', ');
    case 'strings': return (v || []).join(', ');
    case 'user': return v.accountId || '';
    case 'users': return (v || []).map(x => x.accountId).join(', ');
    case 'number': return String(v);
    default: return String(v);
  }
}

// Spreadsheet header (normalized) -> extra field id, for bulk uploads and the sheet
export async function extraHeaderMap(normHeader) {
  try { return Object.fromEntries((await extraFields()).map(f => [normHeader(f.name), f.id])); }
  catch { return {}; }
}
