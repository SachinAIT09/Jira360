// Netlify scheduled function: the alerts' daily summary. Netlify has no timer in the api function,
// so this runs every hour and sends the summary once a day, at the hour set in Settings → Alerts.
// (On your computer server.js does the same.) Run it by hand: npx netlify-cli functions:invoke digest
import { useStore, fileStore, blobStore } from '../../lib/store.js';

export default async () => {
  try {
    const blobs = await import('@netlify/blobs');
    useStore(blobStore(blobs.getStore({ name: 'jira360', consistency: 'strong' })));
  } catch {
    useStore(fileStore('/tmp/jira360-data'));
  }
  const { runDigestIfDue } = await import('../../lib/alerts.js');
  const out = await runDigestIfDue();
  console.log(JSON.stringify({ source: 'digest', ...out }));
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '@hourly' };
