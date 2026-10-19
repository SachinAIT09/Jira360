// Google Sheets access with a service account (no Google package needed: the sign-in token is
// signed here with Node's crypto). Share the sheet with the service account's email (Editor).
//   GOOGLE_SA_JSON  the service account key file's contents (or GOOGLE_SA_FILE: its path)
//   SHEET_ID        the id in the sheet's address: docs.google.com/spreadsheets/d/<SHEET_ID>/edit
//   SHEET_TAB       the tab to read (default: Sheet1)

import crypto from 'node:crypto';
import fs from 'node:fs';

const { GOOGLE_SA_JSON = '', GOOGLE_SA_FILE = '', SHEET_ID = '', SHEET_TAB = 'Sheet1',
  SHEETS_API_URL = 'https://sheets.googleapis.com' } = process.env; // the URL is changed only by tests

function serviceAccount() {
  const raw = GOOGLE_SA_JSON || (GOOGLE_SA_FILE ? fs.readFileSync(GOOGLE_SA_FILE, 'utf8') : '');
  if (!raw) return null;
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SA_JSON is not a service account key (no client_email / private_key)');
  return sa;
}

let account;
try { account = serviceAccount(); } catch (e) { console.error('Google Sheet:', e.message); account = null; }
export const sheetConfigured = !!(account && SHEET_ID);
export const sheetInfo = () => ({ configured: sheetConfigured, tab: SHEET_TAB, ...(sheetConfigured && { url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` }) });

const b64url = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
let token = null;
async function accessToken() {
  if (token && token.until > Date.now() + 60000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = account.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url')}`;
  const res = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${out.error_description || out.error || ''}`);
  token = { value: out.access_token, until: Date.now() + (out.expires_in || 3600) * 1000 };
  return token.value;
}

async function sheets(method, path, body) {
  if (!sheetConfigured) throw Object.assign(new Error('Google Sheet not set up (GOOGLE_SA_JSON and SHEET_ID)'), { status: 503 });
  const res = await fetch(`${SHEETS_API_URL}/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}${path}`, {
    method, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${out.error?.message || ''}` + (res.status === 403 ? ` (share the sheet with ${account.client_email})` : ''));
  return out;
}

const tabRange = a1 => `'${SHEET_TAB.replace(/'/g, "''")}'${a1 ? '!' + a1 : ''}`;

// All cells of the tab. Dates come as day numbers (like Excel), so the date format of the
// sheet's locale doesn't matter.
export async function readSheet() {
  const out = await sheets('GET', `/values/${encodeURIComponent(tabRange())}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  return (out.values || []).map(row => row.map(v => (v == null ? '' : String(v))));
}

// [{ row: 5, col: 3, value }] (1-based) -> one batch write; values are entered as if typed
export async function writeCells(cells) {
  if (!cells.length) return;
  await sheets('POST', '/values:batchUpdate', {
    valueInputOption: 'USER_ENTERED',
    data: cells.map(c => ({ range: tabRange(colName(c.col) + c.row), values: [[c.value]] })),
  });
}

export function colName(n) { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
