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
app.use(express.static(fileURLToPath(new URL('./public/', import.meta.url)), { dotfiles: 'deny' }));

app.listen(PORT, HOST, async () => {
  try { await whoAmI(); } catch (e) { console.error('Jira auth check failed:', e.message); }
  console.log(`portal-jira-sync listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
});

// Settings saved in the page (keys, sheet), then the Google Sheet timer, which follows them
await refreshSettings(true);
enableSheetTimer();
