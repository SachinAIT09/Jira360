// Settings changed from the page's Settings tab (admin passcode), kept in the store as
// config:settings. A value set there wins over .env; cleared, the .env value applies again.
// Keys are never sent back to the page, only a hint (last 4 characters).
//
//   portal: { requireApproval }
//   ai:     { enabled, apiKey, model, dailyLimit }
//   sheet:  { saJson, sheetId, tab, pollMinutes }

import crypto from 'node:crypto';
import { store } from './store.js';

const env = process.env;
const yes = v => /^(1|true|yes|on)$/i.test(String(v ?? ''));
const KEY = 'config:settings';
export const adminPasscode = () => env.ADMIN_PASSCODE || '';

let saved = {}, loadedAt = 0;
const listeners = [];
// Modules that must rebuild something when settings change (the AI client, the sheet timer)
export const onSettingsChange = fn => { listeners.push(fn); };

// Re-read from the store at most every 15 s (on Netlify another instance may have saved them)
export async function refreshSettings(force = false) {
  if (!force && Date.now() - loadedAt < 15000) return;
  loadedAt = Date.now();
  const next = (await store.get(KEY).catch(() => null)) || {};
  if (JSON.stringify(next) === JSON.stringify(saved)) return;
  saved = next;
  for (const fn of listeners) await Promise.resolve(fn()).catch(e => console.error('settings listener failed:', e.message));
}

// The values in use: saved here, else .env, else the default
const pick = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v);
export function effective() {
  const s = saved;
  return {
    portal: { requireApproval: s.portal?.requireApproval ?? yes(env.PORTAL_REQUIRE_APPROVAL) },
    ai: {
      enabled: s.ai?.enabled ?? yes(env.AI_ENABLED),
      apiKey: pick(s.ai?.apiKey, env.ANTHROPIC_API_KEY || ''),
      model: pick(s.ai?.model, env.AI_MODEL || 'claude-opus-5-5'),
      dailyLimit: Number(pick(s.ai?.dailyLimit, env.AI_DAILY_LIMIT || 200)),
    },
    sheet: {
      saJson: pick(s.sheet?.saJson, env.GOOGLE_SA_JSON || ''),
      saFile: s.sheet?.saJson ? '' : env.GOOGLE_SA_FILE || '',
      sheetId: pick(s.sheet?.sheetId, env.SHEET_ID || ''),
      tab: pick(s.sheet?.tab, env.SHEET_TAB || 'Sheet1'),
      pollMinutes: Number(pick(s.sheet?.pollMinutes, env.SHEET_POLL_MINUTES ?? 5)),
    },
  };
}

const hint = v => (v ? `…${String(v).slice(-4)}` : '');
const from = (savedValue, envValue) => (savedValue !== undefined && savedValue !== null && savedValue !== '' ? 'page' : envValue ? 'env' : 'default');

// What the Settings tab shows: values, where each comes from, and no secrets
export function settingsForPage() {
  const e = effective(), s = saved;
  let saEmail = '';
  try { saEmail = e.sheet.saJson ? JSON.parse(e.sheet.saJson).client_email || '' : ''; } catch { saEmail = '(not valid JSON)'; }
  return {
    portal: { requireApproval: e.portal.requireApproval, source: { requireApproval: from(s.portal?.requireApproval, env.PORTAL_REQUIRE_APPROVAL) } },
    ai: {
      enabled: e.ai.enabled, model: e.ai.model, dailyLimit: e.ai.dailyLimit,
      hasKey: !!e.ai.apiKey, keyHint: hint(e.ai.apiKey),
      source: { enabled: from(s.ai?.enabled, env.AI_ENABLED), apiKey: from(s.ai?.apiKey, env.ANTHROPIC_API_KEY), model: from(s.ai?.model, env.AI_MODEL), dailyLimit: from(s.ai?.dailyLimit, env.AI_DAILY_LIMIT) },
    },
    sheet: {
      sheetId: e.sheet.sheetId, tab: e.sheet.tab, pollMinutes: e.sheet.pollMinutes,
      hasKey: !!(e.sheet.saJson || e.sheet.saFile), serviceAccount: saEmail || (e.sheet.saFile ? `(from file ${e.sheet.saFile})` : ''),
      source: { saJson: from(s.sheet?.saJson, env.GOOGLE_SA_JSON || env.GOOGLE_SA_FILE), sheetId: from(s.sheet?.sheetId, env.SHEET_ID), tab: from(s.sheet?.tab, env.SHEET_TAB), pollMinutes: from(s.sheet?.pollMinutes, env.SHEET_POLL_MINUTES) },
    },
    adminConfigured: !!adminPasscode(),
    updatedBy: s.updatedBy || '', updatedAt: s.updatedAt || '',
  };
}

const bad = msg => Object.assign(new Error(msg), { status: 400 });

// patch: only the fields sent change. A key sent as '' is kept; { clear: ['ai.apiKey', ...] } removes
// a saved value (the .env one applies again).
export async function saveSettings(patch = {}, by = '') {
  await refreshSettings(true);
  const next = JSON.parse(JSON.stringify(saved));
  const set = (section, field, value) => { (next[section] ||= {})[field] = value; };
  const p = patch;
  if (p.portal && 'requireApproval' in p.portal) set('portal', 'requireApproval', !!p.portal.requireApproval);
  if (p.ai) {
    if ('enabled' in p.ai) set('ai', 'enabled', !!p.ai.enabled);
    if (p.ai.apiKey) {
      const k = String(p.ai.apiKey).trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw bad('That doesn\'t look like an Anthropic API key (it starts with sk-ant-)');
      set('ai', 'apiKey', k);
    }
    if (p.ai.model) {
      if (!/^claude-[a-z0-9.-]+$/.test(p.ai.model)) throw bad('Model ids look like claude-opus-5-5');
      set('ai', 'model', p.ai.model);
    }
    if (p.ai.dailyLimit !== undefined && p.ai.dailyLimit !== '') {
      const n = Number(p.ai.dailyLimit);
      if (!Number.isInteger(n) || n < 0 || n > 100000) throw bad('Daily limit must be a whole number from 0 to 100000');
      set('ai', 'dailyLimit', n);
    }
  }
  if (p.sheet) {
    if (p.sheet.saJson) {
      let sa;
      try { sa = JSON.parse(p.sheet.saJson); } catch { throw bad('The service account key is not valid JSON (paste the whole downloaded .json file)'); }
      if (!sa.client_email || !sa.private_key) throw bad('That JSON is not a service account key (no client_email / private_key)');
      try { crypto.createPrivateKey(sa.private_key); } catch { throw bad('The private_key in that JSON can\'t be read'); }
      set('sheet', 'saJson', JSON.stringify(sa));
    }
    if (p.sheet.sheetId !== undefined && p.sheet.sheetId !== '') {
      // Accept the whole sheet address too
      const id = String(p.sheet.sheetId).trim().match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] || String(p.sheet.sheetId).trim();
      if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw bad('That isn\'t a Google Sheet id or address');
      set('sheet', 'sheetId', id);
    }
    if (p.sheet.tab !== undefined && p.sheet.tab !== '') set('sheet', 'tab', String(p.sheet.tab).trim().slice(0, 100));
    if (p.sheet.pollMinutes !== undefined && p.sheet.pollMinutes !== '') {
      const n = Number(p.sheet.pollMinutes);
      if (!Number.isInteger(n) || n < 0 || n > 1440) throw bad('Check every … minutes must be a whole number from 0 to 1440');
      set('sheet', 'pollMinutes', n);
    }
  }
  for (const path of Array.isArray(p.clear) ? p.clear : []) {
    const [section, field] = String(path).split('.');
    if (next[section] && field in next[section]) delete next[section][field];
  }
  next.updatedBy = by;
  next.updatedAt = new Date().toISOString();
  await store.set(KEY, next);
  await refreshSettings(true);
  return settingsForPage();
}
