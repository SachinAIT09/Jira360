// Runs the app on this computer: npm start (reads .env).
// On Netlify the same app runs from netlify/functions/api.mjs instead.

import { fileURLToPath } from 'node:url';
import app, { missingEnv, whoAmI } from './app.js';

const { PORT = 8080, HOST = '127.0.0.1' } = process.env; // HOST 0.0.0.0 lets others on the network open the form

if (missingEnv.length) {
  for (const k of missingEnv) console.error(`Missing env var ${k}`);
  process.exit(1);
}

// Serve only the page, never the folder, so .env and the code can't be downloaded.
const PAGE = fileURLToPath(new URL('./public/index.html', import.meta.url));
app.get(['/', '/index.html'], (_req, res) => res.sendFile(PAGE));

app.listen(PORT, HOST, async () => {
  try { await whoAmI(); } catch (e) { console.error('Jira auth check failed:', e.message); }
  console.log(`portal-jira-sync listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
});
