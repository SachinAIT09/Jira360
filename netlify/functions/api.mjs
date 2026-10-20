// Netlify Function: runs the same app as server.js. netlify.toml sends /ui/*, /portal/*,
// /jira/* and /health here. Settings (JIRA_*, ADMIN_PASSCODE, ...) come from the site's
// environment variables in Netlify, not from a .env file.
import serverless from 'serverless-http';
import app from '../../app.js';
import { useStore, fileStore, blobStore } from '../../lib/store.js';

// The store lives in Netlify Blobs (npm install @netlify/blobs). Without that package it falls
// back to /tmp, the only writable folder here, which is lost whenever the function restarts.
let blobs = null;
try { blobs = await import('@netlify/blobs'); }
catch { console.warn('@netlify/blobs not installed: using /tmp, which does not survive restarts'); useStore(fileStore('/tmp/jira360-data')); }

const run = serverless(app);
export const handler = (event, context) => {
  if (blobs) {
    blobs.connectLambda(event); // this kind of function must hand each request's Blobs access over first
    useStore(blobStore(blobs.getStore({ name: 'jira360', consistency: 'strong' })));
  }
  return run(event, context);
};
