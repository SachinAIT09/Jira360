// Portal -> Jira sync: the shared app. Wires the routes together; the logic lives in lib/:
//   lib/jira.js   Jira client, lookups, cached lists
//   lib/sync.js   create/update the issue, status transition, comment, worklog (only writer to Jira)
//   lib/check.js  check a task against Jira without changing anything
//   lib/bulk.js   read .xlsx / CSV uploads into tasks
//   lib/inbox.js  changes waiting for approval before they reach Jira
//   lib/store.js  small key/value store that survives restarts
//   lib/log.js    JSON log lines and the shared error reply shape
//
// Runs two ways: server.js starts it on this computer (npm start), and
// netlify/functions/api.mjs runs it as a Netlify Function. Node 22.12+ (global fetch; @netlify/blobs needs 22.12).

import express from 'express';
import { missingEnv } from './lib/config.js';
import uiRoutes from './routes/ui.js';
import portalRoutes from './routes/portal.js';
import jiraRoutes from './routes/jira.js';

export { missingEnv } from './lib/config.js';
export { whoAmI } from './lib/jira.js';

const app = express();
export default app;

// On Netlify, requests arrive as /.netlify/functions/api/<path>; strip that so routes match either way
app.use((req, _res, next) => { req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '') || '/'; next(); });
app.use((req, res, next) => missingEnv.length && req.path !== '/health'
  ? res.status(503).json({ error: `Server not configured: missing ${missingEnv.join(', ')}` }) : next());
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: !missingEnv.length }));

app.use(uiRoutes, portalRoutes, jiraRoutes);
