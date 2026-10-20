import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client } from './helpers.js';

const users = await import('../lib/users.js');
const { default: app } = await import('../app.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('passwords are hashed and checked', async () => {
  const h = await users.hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$/);
  assert.ok(await users.checkPassword('correct horse battery', h));
  assert.ok(!(await users.checkPassword('wrong horse battery', h)));
  assert.ok(!(await users.checkPassword('x', 'garbage')));
});

test('accounts, roles and sessions over HTTP', async () => {
  const admin = client(base), viewer = client(base);

  let r = await admin('GET', '/ui/auth');
  assert.equal(r.body.needsSetup, true);

  // Pages from other sites can't create the admin (no X-J360 header)
  r = await admin('POST', '/ui/setup', { name: 'Ada', email: 'ada@example.com', password: 'a-long-password' }, { page: false });
  assert.equal(r.status, 403);
  r = await admin('POST', '/ui/setup', { name: 'Ada', email: 'ada@example.com', password: 'short' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/ui/setup', { name: 'Ada', email: 'Ada@Example.com', password: 'a-long-password' });
  assert.equal(r.status, 200);
  assert.equal(r.body.me.role, 'admin');
  r = await admin('POST', '/ui/setup', { name: 'Eve', email: 'eve@example.com', password: 'a-long-password' });
  assert.equal(r.status, 409, 'only one first admin');

  // Not signed in
  assert.equal((await viewer('GET', '/ui/activity')).status, 401);

  // The admin adds a viewer, who gets a temporary password
  r = await admin('POST', '/ui/users', { email: 'vic@example.com', name: 'Vic', role: 'viewer' });
  assert.equal(r.status, 200);
  const temp = r.body.tempPassword;
  assert.ok(temp.length >= 10);

  assert.equal((await viewer('POST', '/ui/login', { email: 'vic@example.com', password: 'nope-nope-nope' })).status, 401);
  r = await viewer('POST', '/ui/login', { email: 'VIC@example.com', password: temp });
  assert.equal(r.status, 200);
  assert.equal(r.body.me.mustChange, true);

  // Until the temporary password is changed, only the password routes work
  r = await viewer('GET', '/ui/activity');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'must_change');
  r = await viewer('POST', '/ui/me/password', { current: temp, password: 'vics-own-password' });
  assert.equal(r.status, 200);

  // A viewer reads but can't send, approve or open Settings
  assert.equal((await viewer('GET', '/ui/activity')).status, 200);
  assert.equal((await viewer('POST', '/ui/task', { taskId: 'T-1', title: 'x' })).status, 403);
  assert.equal((await viewer('GET', '/ui/settings')).status, 403);
  assert.equal((await viewer('GET', '/ui/users')).status, 403);

  // The admin makes them editor: their old session ends (role change bumps the account version)
  r = await admin('POST', '/ui/users/vic%40example.com', { role: 'editor' });
  assert.equal(r.body.user.role, 'editor');
  assert.equal((await viewer('GET', '/ui/activity')).status, 401);
  r = await viewer('POST', '/ui/login', { email: 'vic@example.com', password: 'vics-own-password' });
  assert.equal(r.body.me.role, 'editor');
  assert.equal((await viewer('POST', '/ui/task', { title: 'x' })).status, 400, 'editor gets past the role check');

  // Switched off: signed out and can't sign in
  await admin('POST', '/ui/users/vic%40example.com', { disabled: true });
  assert.equal((await viewer('GET', '/ui/activity')).status, 401);
  assert.equal((await viewer('POST', '/ui/login', { email: 'vic@example.com', password: 'vics-own-password' })).status, 401);

  // The only admin can't remove themselves
  r = await admin('POST', '/ui/users/ada%40example.com', { role: 'viewer' });
  assert.equal(r.status, 409);
  r = await admin('POST', '/ui/users/ada%40example.com', { delete: true });
  assert.equal(r.status, 409);

  // Sign out
  await admin('POST', '/ui/logout', {});
  assert.equal((await admin('GET', '/ui/settings')).status, 401);
});

test('a broken cookie means signed out, not an error', async () => {
  const res = await fetch(base + '/ui/auth', { headers: { Cookie: 'j360=%E0%A4%A' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).me, null);
});

test('an expired lockout starts counting from zero', async () => {
  const { store } = await import('../lib/store.js');
  await store.set('loginfail:ada@example.com', { n: 10, until: Date.now() - 1000 });
  await assert.rejects(users.verifyLogin('ada@example.com', 'wrong-password-x'), e => e.status === 401);
  assert.deepEqual(await store.get('loginfail:ada@example.com'), { n: 1, until: 0 });
  assert.equal((await users.verifyLogin('ada@example.com', 'a-long-password')).email, 'ada@example.com');
});

test('tokens: tampered or expired ones are refused', async () => {
  const u = await users.getUser('ada@example.com');
  const token = await users.makeToken(u);
  assert.equal((await users.userFromToken(token)).user.email, 'ada@example.com');
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), e: 'vic@example.com' })).toString('base64url');
  assert.equal(await users.userFromToken(`${forged}.${mac}`), null);
  assert.equal(await users.userFromToken(token, Date.now() + 13 * 3600000), null);
});
