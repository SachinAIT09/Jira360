// Shared test setup: fake Jira settings (nothing here calls Jira) and a throwaway store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

Object.assign(process.env, {
  JIRA_BASE_URL: 'https://example.invalid', JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: 'x',
  JIRA_PROJECT_KEY: 'TEST', PORTAL_SHARED_SECRET: 'secret', ADMIN_PASSCODE: '', SESSION_SECRET: '',
});

const { useStore, fileStore } = await import('../lib/store.js');
export const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira360-test-'));
useStore(fileStore(dataDir));

// A tiny client that keeps the session cookie, like a browser
export function client(base) {
  let cookie = '';
  return async (method, url, body, { page = true } = {}) => {
    const res = await fetch(base + url, {
      method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(page && { 'X-J360': '1' }), ...(cookie && { Cookie: cookie }) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
