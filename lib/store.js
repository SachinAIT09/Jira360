// Small key/value store that survives restarts. On this computer it keeps one JSON file per key
// under data/; on Netlify, netlify/functions/api.mjs switches it to Netlify Blobs (useStore).
// Values are anything JSON can hold; get() returns null for a missing key.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keys may hold ":" or "/" (e.g. "event:abc"), which file names can't, so those become %XX
const toFile = key => key.replace(/[^A-Za-z0-9._-]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const fromFile = name => decodeURIComponent(name.slice(0, -'.json'.length));

export function fileStore(dir) {
  const file = key => path.join(dir, toFile(key) + '.json');
  const missing = e => { if (e.code !== 'ENOENT') throw e; return null; };
  return {
    async get(key) { return JSON.parse(await fs.readFile(file(key), 'utf8').catch(missing) ?? 'null'); },
    async set(key, value) {
      await fs.mkdir(dir, { recursive: true });
      const tmp = file(key) + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, file(key)); // a crash mid-write never leaves half a file
    },
    async del(key) { await fs.unlink(file(key)).catch(missing); },
    async list(prefix = '') {
      const names = await fs.readdir(dir).catch(missing) || [];
      return names.filter(n => n.endsWith('.json')).map(fromFile).filter(k => k.startsWith(prefix));
    },
  };
}

// Netlify Blobs store (from getStore()) with the same four methods
export const blobStore = blobs => ({
  get: key => blobs.get(key, { type: 'json' }),
  set: (key, value) => blobs.setJSON(key, value),
  del: key => blobs.delete(key),
  list: async (prefix = '') => (await blobs.list({ prefix })).blobs.map(b => b.key),
});

let impl = fileStore(fileURLToPath(new URL('../data/', import.meta.url)));
export const useStore = s => { impl = s; };

export const store = {
  get: key => impl.get(key),
  set: (key, value) => impl.set(key, value),
  del: key => impl.del(key),
  list: prefix => impl.list(prefix),
};
