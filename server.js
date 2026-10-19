// Runs the app on this computer: npm start (reads .env).
// On Netlify the same app runs from netlify/functions/api.mjs instead.

import { fileURLToPath } from 'node:url';
import express from 'express';
import app, { missingEnv, whoAmI } from './app.js';
import { enableSheetTimer } from './lib/sheet.js';
import { refreshSettings } from './lib/settings.js';

const { PORT = 8080, HOST = '127.0.0.1' } = process.env; // HOST 0.0.0.0 lets others on the network open the form

if (missingEnv.length) {
  for (const k of missingEnv) console.error(`Missing env var ${k}`);
  process.exit(1);
}

// Serve only public/ (the page, its styles and scripts), never the project folder, so .env and
// the server code can't be downloaded. Netlify publishes the same folder.
// no-cache: browsers check for a newer version on every load, so an update is never half-applied
// (a new page with old scripts).
app.use(express.static(fileURLToPath(new URL('./public/', import.meta.url)), {
  dotfiles: 'deny',
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}));

// Without passcodes anyone who can open the page can send to Jira (and change Settings)
if (!process.env.UI_PASSCODE || !process.env.ADMIN_PASSCODE) {
  const open = [!process.env.UI_PASSCODE && 'the page', !process.env.ADMIN_PASSCODE && 'Settings'].filter(Boolean).join(' and ');
  console.warn(`No passcode for ${open}` + (HOST === '127.0.0.1' || HOST === 'localhost' ? ' (only this computer can open it)' : `: anyone on your network can use ${open} at port ${PORT}`));
}

app.listen(PORT, HOST, async () => {
  try { await whoAmI(); } catch (e) { console.error('Jira auth check failed:', e.message); }
  console.log(`portal-jira-sync listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
});

// Settings saved in the page (keys, sheet), then the Google Sheet timer, which follows them
await refreshSettings(true);
enableSheetTimer();
