import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';

const { dashboard } = await import('../lib/dashboard.js');
const { record } = await import('../lib/activity.js');

const DAY = 86400000, now = Date.now();
const iso = ms => new Date(ms).toISOString();
const ada = { accountId: 'a1', displayName: 'Ada' };

// A fake Jira: answers the searches and worklog reads the dashboard makes
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : {};
  const json = data => new Response(JSON.stringify(data), { status: 200 });
  if (u.pathname === '/rest/api/3/field') return json([{ id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]);
  if (u.pathname.endsWith('/worklog')) return json({ worklogs: [
    { author: ada, started: iso(now - DAY), timeSpentSeconds: 7200 },
    { author: { displayName: 'Bo' }, started: iso(now - 2 * DAY), timeSpentSeconds: 1800 },
    { author: ada, started: iso(now - 40 * DAY), timeSpentSeconds: 99999 }, // before the period
  ] });
  if (u.pathname === '/rest/api/3/search/jql') {
    const jql = body.jql;
    if (jql.includes('statusCategory != Done')) return json({ issues: [
      { key: 'T-1', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } }, assignee: ada, priority: { name: 'High' }, duedate: '2020-01-01', customfield_10020: [{ id: 7, name: 'Sprint 7', state: 'active' }] } },
      { key: 'T-2', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } }, assignee: null, priority: { name: 'Low' }, duedate: null } },
      { key: 'T-3', fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, assignee: ada, priority: { name: 'High' }, duedate: '2999-01-01' } },
    ] });
    if (jql.includes('created >=')) return json({ issues: [{ key: 'T-1', fields: { created: iso(now) } }, { key: 'T-2', fields: { created: iso(now - DAY) } }] });
    if (jql.includes('resolved >=')) return json({ issues: [{ key: 'T-9', fields: { resolutiondate: iso(now) } }] });
    if (jql.includes('worklogDate')) return json({ issues: [{ key: 'T-1', fields: {} }] });
  }
  return new Response('not faked: ' + url, { status: 404 });
};
test.after(() => { globalThis.fetch = realFetch; });

test('dashboard numbers', async () => {
  await record({ source: 'ui', by: 'Ada', taskId: 'A', ok: true, actions: ['created'] });
  await record({ source: 'portal', by: '', taskId: 'B', ok: false, error: 'Boom' });
  await record({ source: 'jira', by: 'Jira', taskId: 'C', ok: true, actions: ['updated'] }); // a sheet update, not a send

  const d = await dashboard({ days: 7, tz: 0 });
  assert.deepEqual(d.failed, []);
  const j = d.jira;
  assert.equal(j.open, 3);
  assert.equal(j.overdue, 1);
  assert.equal(j.unassigned, 1);
  assert.deepEqual(j.byStatus.map(s => [s.name, s.n]), [['To Do', 2], ['In Progress', 1]]);
  assert.deepEqual(j.byAssignee.map(s => [s.name, s.n]), [['Ada', 2], ['Unassigned', 1]]);
  assert.match(j.byAssignee[1].jql, /assignee is EMPTY/);
  assert.deepEqual(j.sprints.map(s => [s.name, s.n]), [['Sprint 7', 1]]);
  assert.equal(j.perDay.length, 7);
  assert.equal(j.perDay.at(-1).created, 1);
  assert.equal(j.perDay.at(-1).resolved, 1);

  assert.equal(d.hours.total, 2.5);
  assert.deepEqual(d.hours.people.map(p => [p.name, p.hours]), [['Ada', 2], ['Bo', 0.5]]);

  assert.equal(d.activity.sent, 1);
  assert.equal(d.activity.failed, 1);
  assert.deepEqual(d.activity.byPerson.map(p => [p.name, p.n]), [['Ada', 1]]);
  assert.deepEqual(d.activity.errors.map(e => e.name), ['Boom']);
  assert.equal(d.sheet, null);
});
