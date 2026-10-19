// Google Sheets access with a service account (no Google package needed: the sign-in token is
// signed here with Node's crypto). Share the sheet with the service account's email (Editor).
// Set in the page's Settings tab, or in .env:
//   GOOGLE_SA_JSON  the service account key file's contents (or GOOGLE_SA_FILE: its path)
//   SHEET_ID        the id in the sheet's address: docs.google.com/spreadsheets/d/<SHEET_ID>/edit
//   SHEET_TAB       the tab to read (default: Sheet1)

import crypto from 'node:crypto';
import fs from 'node:fs';
import { effective, onSettingsChange } from './settings.js';

const { SHEETS_API_URL = 'https://sheets.googleapis.com', DRIVE_API_URL = 'https://www.googleapis.com' } = process.env; // changed only by tests
// Sheets, plus Drive for files this app created (to share a sheet it made); nothing else in Drive
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

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
    iss: account.client_email, scope: SCOPE, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url')}`;
  const res = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${out.error_description || out.error || ''}`);
  token = { value: out.access_token, until: Date.now() + (out.expires_in || 3600) * 1000 };
  return token.value;
}

const needKey = () => { if (!account) throw Object.assign(new Error(problem ? `Google Sheet key problem: ${problem}` : 'Add the service account key in Settings first'), { status: 503 }); };

async function google(method, url, body) {
  const res = await fetch(url, {
    method, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Google ${res.status}: ${out.error?.message || ''}`), { status: res.status, google: out.error });
  return out;
}

// id: the linked sheet unless given (creating / setting up a sheet before it is linked)
async function sheets(method, path, body, id = SHEET_ID) {
  if (!id && !isSheetConfigured()) throw Object.assign(new Error(problem ? `Google Sheet key problem: ${problem}` : 'Google Sheet not set up: add the service account key and sheet in Settings'), { status: 503 });
  needKey();
  try { return await google(method, `${SHEETS_API_URL}/v4/spreadsheets/${encodeURIComponent(id)}${path}`, body); }
  catch (e) { if (e.status === 403) e.message += ` (share the sheet with ${account.client_email})`; throw e; }
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

// ---------- Making the sheet ----------
export const serviceAccountEmail = () => account?.client_email || '';

// A new spreadsheet owned by the service account. Newer service accounts often have no Drive
// storage; Google then answers 403 "storage quota" and the page offers "Set up the linked sheet".
export async function createSpreadsheet(title, tab, columnCount) {
  needKey();
  try {
    const out = await google('POST', `${SHEETS_API_URL}/v4/spreadsheets`, {
      properties: { title },
      sheets: [{ properties: { title: tab, gridProperties: { frozenRowCount: 1, rowCount: 1000, columnCount: Math.max(26, columnCount) } } }],
    });
    return { id: out.spreadsheetId, url: out.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${out.spreadsheetId}/edit` };
  } catch (e) {
    if (/quota|storage/i.test(e.message) || e.status === 403)
      throw Object.assign(new Error('Google did not let the service account create a file (it has no Drive storage of its own). Create a blank Google Sheet yourself, share it with ' +
        account.client_email + ' as Editor, paste its link above, save, then use "Set up the linked sheet".'), { status: 409, code: 'no_drive_storage' });
    throw e;
  }
}

// Share a sheet this app created with a person (Drive API; needs it enabled in the Google project)
export async function shareFile(id, email) {
  needKey();
  try {
    await google('POST', `${DRIVE_API_URL}/drive/v3/files/${encodeURIComponent(id)}/permissions?sendNotificationEmail=true`, { role: 'writer', type: 'user', emailAddress: email });
  } catch (e) {
    throw Object.assign(new Error(`The sheet was made but could not be shared with ${email}: ${e.message}. Turn on the "Google Drive API" in the Google Cloud project, or share it from the sheet's Share button.`), { status: 502 });
  }
}

// Title, tabs (with their numeric ids) and protected ranges of a sheet
export async function sheetMeta(id = SHEET_ID) {
  const out = await sheets('GET', '?fields=properties.title,spreadsheetUrl,sheets(properties(sheetId,title),protectedRanges(description))', null, id);
  return { title: out.properties?.title || '', url: out.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`,
    tabs: (out.sheets || []).map(x => ({ id: x.properties.sheetId, title: x.properties.title, protected: (x.protectedRanges || []).map(p => p.description) })) };
}

// The header row: the first row with anything in it (as the sync reads it), within the first 50
export async function readHeader(id, tab) {
  const out = await sheets('GET', `/values/${encodeURIComponent(`'${tab.replace(/'/g, "''")}'!1:50`)}`, null, id);
  const rows = out.values || [], row = Math.max(0, rows.findIndex(r => r.some(c => String(c ?? '').trim())));
  return { row, values: (rows[row] || []).map(v => String(v ?? '')) };
}
export async function writeRange(id, tab, a1, values) {
  await sheets('POST', '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data: [{ range: `'${tab.replace(/'/g, "''")}'!${a1}`, values }] }, id);
}
export const batchUpdate = (id, requests) => sheets('POST', ':batchUpdate', { requests }, id);
