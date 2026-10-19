// Netlify Function: runs the same app as server.js. netlify.toml sends /ui/*, /portal/*,
// /jira/* and /health here. Settings (JIRA_*, UI_PASSCODE, ...) come from the site's
// environment variables in Netlify, not from a .env file.
import serverless from 'serverless-http';
import app from '../../app.js';

export const handler = serverless(app);
