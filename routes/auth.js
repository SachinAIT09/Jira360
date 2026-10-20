// Signing in and out, the first admin, your own password, and (admin) everyone's accounts.

import crypto from 'node:crypto';
import express from 'express';
import { adminPasscode } from '../lib/settings.js';
import { need, signIn, clearSessionCookie, currentUser, userOf } from '../lib/auth.js';
import { hasUsers, createFirstAdmin, verifyLogin, changeOwnPassword, publicUser, listUsers, createUser, updateUser, deleteUser, MIN_PASSWORD } from '../lib/users.js';
import { log, fail, logError } from '../lib/log.js';

const router = express.Router();
export default router;

export const onNetlify = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
const fromPage = req => req.get('X-J360') === '1';
const replyError = (res, e, source) => {
  if ([400, 401, 403, 404, 409, 429].includes(e.status)) return fail(res, e.status, e.status === 429 ? 'locked' : e.status === 409 ? 'conflict' : 'invalid', e.message);
  logError(source, e);
  fail(res, 500, 'server_error', 'Something went wrong; try again');
};

// What the page shows first: "create the first admin", "sign in", or the app
router.get('/ui/auth', async (req, res) => {
  try {
    const u = await currentUser(req, res);
    res.json({ needsSetup: !(await hasUsers()), setupCode: onNetlify || !!adminPasscode(), minPassword: MIN_PASSWORD, me: publicUser(u) || null });
  } catch (e) { replyError(res, e, 'auth'); }
});

// The first admin. While nobody has an account, whoever opens the page could do this, so it asks
// for the ADMIN_PASSCODE from the server's settings (always on Netlify, where the page is public).
router.post('/ui/setup', async (req, res) => {
  if (!fromPage(req)) return fail(res, 403, 'forbidden', 'Request refused (reload the page)');
  try {
    const code = adminPasscode();
    if (onNetlify && !code) return fail(res, 503, 'not_configured', 'Set ADMIN_PASSCODE on the server first: it is asked once, to create the first admin');
    const given = String(req.body?.setupCode || '');
    if (code && (given.length !== code.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(code)))) {
      await new Promise(r => setTimeout(r, 600));
      return fail(res, 401, 'unauthorized', 'Wrong setup code (it is the ADMIN_PASSCODE in the server settings)');
    }
    const u = await createFirstAdmin(req.body || {});
    await signIn(req, res, u);
    log('auth', { firstAdmin: u.email });
    res.json({ me: publicUser(u) });
  } catch (e) { replyError(res, e, 'auth'); }
});

router.post('/ui/login', async (req, res) => {
  if (!fromPage(req)) return fail(res, 403, 'forbidden', 'Request refused (reload the page)');
  try {
    const u = await verifyLogin(req.body?.email, req.body?.password);
    await signIn(req, res, u);
    log('auth', { signedIn: u.email });
    res.json({ me: publicUser(u) });
  } catch (e) {
    if (e.status === 401) log('auth', { wrongPassword: String(req.body?.email || '').slice(0, 100), ip: req.ip });
    replyError(res, e, 'auth');
  }
});

router.post('/ui/logout', (req, res) => {
  if (!fromPage(req)) return fail(res, 403, 'forbidden', 'Request refused (reload the page)');
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

router.get('/ui/me', need('viewer'), (req, res) => res.json({ me: publicUser(req.user) }));

// A new password signs out every other browser (the account version changes), so this one signs in again
router.post('/ui/me/password', need('viewer'), async (req, res) => {
  try {
    const u = await changeOwnPassword(req.user.email, req.body?.current, req.body?.password);
    await signIn(req, res, u);
    res.json({ me: publicUser(u) });
  } catch (e) { replyError(res, e, 'auth'); }
});

// ---------- Accounts (admin) ----------
router.get('/ui/users', need('admin'), async (_req, res) => {
  try { res.json({ users: (await listUsers()).map(publicUser) }); } catch (e) { replyError(res, e, 'users'); }
});

router.post('/ui/users', need('admin'), async (req, res) => {
  try {
    const out = await createUser(req.body || {}, userOf(req));
    log('users', { added: out.user.email, role: out.user.role, by: userOf(req) });
    res.json(out);
  } catch (e) { replyError(res, e, 'users'); }
});

router.post('/ui/users/:email', need('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const out = b.delete
      ? (await deleteUser(req.params.email), { deleted: true })
      : await updateUser(req.params.email, { name: b.name, role: b.role, disabled: b.disabled, resetPassword: !!b.resetPassword, signOut: !!b.signOut }, userOf(req));
    log('users', { changed: req.params.email, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'name')), by: userOf(req) });
    res.json(out);
  } catch (e) { replyError(res, e, 'users'); }
});
