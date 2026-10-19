// Google Sheets access with a service account (no Google package needed: the sign-in token is
// signed here with Node's crypto). Share the sheet with the service account's email (Editor).
// Set in the page's Settings tab, or in .env:
//   GOOGLE_SA_JSON  the service account key file's contents (or GOOGLE_SA_FILE: its path)
//   SHEET_ID        the id in the sheet's address: docs.google.com/spreadsheets/d/<SHEET_ID>/edit
//   SHEET_TAB       the tab to read (default: Sheet1)

import crypto from 'node:crypto';
import fs from 'node:fs';
import { effective, onSettingsChange } from './settings.js';

const { SHEETS_API_URL = 'https://sheets.googleapis.com' } = process.env; // changed only by tests

let account = null, SHEET_ID = '', SHEET_TAB = 'Sheet1', problem = '';
// (Re)reads the settings; called at start and whenever they change in the Settings tab
function configureGoogle() {
  const s = effective().sheet;
  SHEET_ID = s.sheetId; SHEET_TAB = s.tab || 'Sheet1';
  let next = null;
  try {
    const raw = s.saJson || (s.saFile ? fs.readFileSync(s.saFile, 'utf8') : '');
    if (raw) {
      next = JSON.parse(raw);
      if (!next.client_email || !next.private_key) throw new Error('the key is not a service account key (no client_email / private_key)');
    }
    problem = '';
  } catch (e) { problem = e.message; console.error('Google Sheet:', e.message); next = null; }
  if (next?.client_email !== account?.client_email || next?.private_key !== account?.private_key) token = null; // sign in again
  account = next;
}
onSettingsChange(configureGoogle);

export const isSheetConfigured = () => !!(account && SHEET_ID);
export const sheetInfo = () => ({ configured: isSheetConfigured(), tab: SHEET_TAB, ...(problem && { problem }),
  ...(isSheetConfigured() && { url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, serviceAccount: account.client_email }) });

const b64url = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
let token = null;
configureGoogle();
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
  if (!isSheetConfigured()) throw Object.assign(new Error(problem ? `Google Sheet key problem: ${problem}` : 'Google Sheet not set up: add the service account key and sheet in Settings'), { status: 503 });
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
