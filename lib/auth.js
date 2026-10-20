// Who is signed in, for the page's routes: a signed token in an HttpOnly cookie (see lib/users.js).
//   need('viewer' | 'editor' | 'admin')  route guard; sets req.user
//   userOf(req)                          the person's name, for the history
//
// Changes (anything but GET) must also carry the X-J360 header, which only the page's own scripts
// send: another site can't add it, so it can't make a signed-in browser change things here.

import { fail } from './log.js';
import { userFromToken, makeToken, roleAtLeast, SESSION_LENGTH } from './users.js';

export const COOKIE = 'j360';

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
}
const isHttps = req => req.secure || String(req.get('X-Forwarded-Proto') || '').split(',')[0].trim() === 'https';

export function setSessionCookie(req, res, token, maxMs = SESSION_LENGTH) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxMs / 1000)}` + (isHttps(req) ? '; Secure' : ''));
}
export const clearSessionCookie = (req, res) => setSessionCookie(req, res, '', 0);

export async function signIn(req, res, user) {
  setSessionCookie(req, res, await makeToken(user));
}

// The signed-in person (or null), renewing the cookie when less than half its time is left
export async function currentUser(req, res) {
  if (req.user !== undefined) return req.user;
  const s = await userFromToken(readCookie(req, COOKIE)).catch(() => null);
  req.user = s?.user || null;
  if (s && res && s.expires - Date.now() < SESSION_LENGTH / 2) await signIn(req, res, s.user).catch(() => {});
  return req.user;
}

const sameSiteCall = req => req.method === 'GET' || req.method === 'HEAD' || req.get('X-J360') === '1';

// Routes a person whose temporary password must be changed can still use
const BEFORE_CHANGE = new Set(['/ui/me', '/ui/me/password', '/ui/logout']);

export const need = min => async (req, res, next) => {
  try {
    const u = await currentUser(req, res);
    if (!u) return fail(res, 401, 'unauthorized', 'Sign in first');
    if (!sameSiteCall(req)) return fail(res, 403, 'forbidden', 'Request refused (reload the page)');
    if (u.mustChange && !BEFORE_CHANGE.has(req.path)) return fail(res, 403, 'must_change', 'Choose a new password first');
    if (!roleAtLeast(u.role, min)) return fail(res, 403, 'forbidden', `Your role (${u.role}) can't do this: it needs ${min}`);
    next();
  } catch (e) {
    next(e);
  }
};

export const userOf = req => req.user?.name || req.user?.email || '';
