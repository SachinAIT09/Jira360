// People who can sign in to the page, with a role each:
//   viewer  sees everything (tickets, Activity, Inbox, Dashboard), changes nothing
//   editor  also sends to Jira, approves / rejects the Inbox, syncs the sheet, uses AI
//   admin   also Settings, the fields shown to everyone, making the sheet, and these accounts
//
// One store entry per person: user:<email>  { email, name, role, pass, disabled, mustChange, ver, ... }
// Passwords are kept as scrypt hashes. Sign-in gives a signed token (no session list on the
// server, so it works the same on every Netlify instance); the person is read again on every
// request, so disabling them, changing their role or resetting their password applies at once.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { store } from './store.js';

const scrypt = promisify(crypto.scrypt);
const PREFIX = 'user:';
export const ROLES = ['viewer', 'editor', 'admin'];
export const roleAtLeast = (role, min) => ROLES.indexOf(role) >= ROLES.indexOf(min);
export const MIN_PASSWORD = 10;
const SESSION_MS = 12 * 3600000;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const norm = email => String(email || '').trim().toLowerCase();
const validEmail = email => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email);
// What the page may see: never the password hash
export const publicUser = u => u && ({ email: u.email, name: u.name, role: u.role, disabled: !!u.disabled,
  mustChange: !!u.mustChange, createdAt: u.createdAt, createdBy: u.createdBy || '', lastLogin: u.lastLogin || '' });

// ---------- Passwords ----------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(got, want);
}
function checkStrength(password) {
  if (String(password || '').length < MIN_PASSWORD) throw bad(`Use a password of at least ${MIN_PASSWORD} characters`);
}
// Temporary passwords given out by an admin (the person changes it at first sign-in)
const tempPassword = () => crypto.randomBytes(9).toString('base64url');

// ---------- Accounts ----------
export const getUser = async email => (norm(email) ? store.get(PREFIX + norm(email)) : null);
const saveUser = u => store.set(PREFIX + u.email, u);

let known = false; // once someone exists, the store isn't asked again on every request
export async function hasUsers() {
  if (known) return true;
  known = (await store.list(PREFIX)).length > 0;
  return known;
}

export async function listUsers() {
  const keys = await store.list(PREFIX);
  const all = (await Promise.all(keys.map(k => store.get(k).catch(() => null)))).filter(Boolean);
  return all.sort((a, b) => a.email.localeCompare(b.email));
}

const activeAdmins = async () => (await listUsers()).filter(u => u.role === 'admin' && !u.disabled);

function cleanFields({ email, name, role }) {
  const e = norm(email);
  if (!validEmail(e)) throw bad('Enter a valid email address');
  if (!ROLES.includes(role)) throw bad('Role must be viewer, editor or admin');
  return { email: e, name: String(name || '').trim().slice(0, 80) || e.split('@')[0], role };
}

// An admin adds someone: they get a temporary password, shown once, to change at first sign-in
export async function createUser(fields, by = '') {
  const f = cleanFields(fields);
  if (await getUser(f.email)) throw bad('Someone with that email already has an account', 409);
  const password = tempPassword();
  await saveUser({ ...f, pass: await hashPassword(password), disabled: false, mustChange: true, ver: 1,
    createdAt: new Date().toISOString(), createdBy: by });
  known = true;
  return { user: publicUser(await getUser(f.email)), tempPassword: password };
}

// The very first account (the page offers this only while there is none)
export async function createFirstAdmin({ email, name, password }) {
  if (await hasUsers()) throw bad('The first admin already exists: sign in instead', 409);
  checkStrength(password);
  const f = cleanFields({ email, name, role: 'admin' });
  await saveUser({ ...f, pass: await hashPassword(password), disabled: false, mustChange: false, ver: 1,
    createdAt: new Date().toISOString(), createdBy: 'setup' });
  known = true;
  return getUser(f.email);
}

// Role, name, disabled; resetPassword gives a new temporary password; signOut ends their sessions
export async function updateUser(email, patch = {}, by = '') {
  const u = await getUser(email);
  if (!u) throw bad('No such account', 404);
  const next = { ...u };
  if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 80) || u.name;
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw bad('Role must be viewer, editor or admin');
    next.role = patch.role;
  }
  if (patch.disabled !== undefined) next.disabled = !!patch.disabled;
  // Never leave the site without an admin who can sign in
  if (u.role === 'admin' && !u.disabled && (next.role !== 'admin' || next.disabled) && (await activeAdmins()).length <= 1)
    throw bad('This is the only admin: make someone else admin first', 409);
  let password;
  if (patch.resetPassword) { password = tempPassword(); next.pass = await hashPassword(password); next.mustChange = true; }
  if (patch.resetPassword || patch.signOut || next.disabled || next.role !== u.role) next.ver = (u.ver || 1) + 1;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = by;
  await saveUser(next);
  return { user: publicUser(next), ...(password && { tempPassword: password }) };
}

export async function deleteUser(email) {
  const u = await getUser(email);
  if (!u) throw bad('No such account', 404);
  if (u.role === 'admin' && !u.disabled && (await activeAdmins()).length <= 1) throw bad('This is the only admin: make someone else admin first', 409);
  await store.del(PREFIX + u.email);
}

export async function changeOwnPassword(email, current, password) {
  const u = await getUser(email);
  if (!u || !(await checkPassword(current, u.pass))) throw bad('Your current password is not right', 401);
  checkStrength(password);
  if (current === password) throw bad('Choose a new password, different from the current one');
  const next = { ...u, pass: await hashPassword(password), mustChange: false, ver: (u.ver || 1) + 1, updatedAt: new Date().toISOString() };
  await saveUser(next);
  return next;
}

// ---------- Signing in: wrong guesses are slowed down and an account locked for 10 minutes ----------
// The count is kept in the store, so it holds across Netlify instances too.
const FAIL_PREFIX = 'loginfail:';
const MAX_FAILS = 10, LOCK_MS = 600000;

export async function verifyLogin(email, password) {
  const e = norm(email);
  let fails = (await store.get(FAIL_PREFIX + e).catch(() => null)) || { n: 0, until: 0 };
  if (fails.until && fails.until <= Date.now()) fails = { n: 0, until: 0 }; // the lock is over: count from zero
  if (fails.until > Date.now()) throw bad('Too many wrong passwords: try again in 10 minutes', 429);
  const u = e ? await getUser(e) : null;
  // A missing account takes as long as a wrong password, so the answer doesn't tell which emails exist
  const ok = u ? await checkPassword(password, u.pass) : (await hashPassword(password), false);
  if (!ok || u.disabled) {
    if (e) {
      const n = (fails.n || 0) + 1;
      await store.set(FAIL_PREFIX + e, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 600));
    throw bad(u?.disabled && ok ? 'This account is switched off: ask an admin' : 'Wrong email or password', 401);
  }
  if (fails.n) await store.del(FAIL_PREFIX + e).catch(() => {});
  const next = { ...u, lastLogin: new Date().toISOString() };
  await saveUser(next).catch(() => {});
  return next;
}

// ---------- Session tokens: signed { email, account version, expiry } ----------
let secret = null;
async function sessionSecret() {
  if (secret) return secret;
  if (process.env.SESSION_SECRET) return (secret = process.env.SESSION_SECRET);
  // Made once and kept in the store, so every server instance and restart shares it
  let s = await store.get('config:session-secret').catch(() => null);
  if (!s) {
    await store.set('config:session-secret', crypto.randomBytes(32).toString('base64url'));
    s = await store.get('config:session-secret'); // read back: if two servers made one at once, both use the one kept
  }
  return (secret = s);
}
export const resetSecretCache = () => { secret = null; }; // tests

const sign = async body => crypto.createHmac('sha256', await sessionSecret()).update(body).digest('base64url');

export async function makeToken(u, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ e: u.email, v: u.ver || 1, x: now + SESSION_MS })).toString('base64url');
  return `${body}.${await sign(body)}`;
}

// The signed-in person, or null (bad signature, expired, account gone / off / signed out since)
export async function userFromToken(token, now = Date.now()) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(await sign(body)), got = Buffer.from(mac);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p.x || p.x < now) return null;
  const u = await getUser(p.e);
  if (!u || u.disabled || (u.ver || 1) !== p.v) return null;
  return { user: u, expires: p.x };
}
export const SESSION_LENGTH = SESSION_MS;
