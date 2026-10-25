// A test admin for the dev relay (#401): a new identity, listed in an
// admins.json of its own (dev-server.mjs reads ADMINS_FILE), and signed
// admin requests as admin.html sends them.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, signMessage } from '../src/identity.js';

export async function testAdmin(name = 'Test admin') {
  const ident = await createIdentity();
  const file = join(mkdtempSync(join(tmpdir(), 'ducy-admins-')), 'admins.json');
  writeFileSync(file, JSON.stringify([{id: ident.id, pub: ident.pub, name}]));
  return {ident, file};
}

// A signed request's body for `path`.
export const signAdmin = (ident, path, data = {}) => signMessage(ident, {type: 'admin', path, data});

// POSTs `env` (a signed request, or anything) to the relay on `port`.
export const postAdmin = (port, path, env) => fetch(`http://localhost:${port}${path}`, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(env),
}).then(async r => ({status: r.status, body: await r.json()}));

// (path, data) → {status, body}, signed by `ident`.
export const adminFetch = (port, ident) => async (path, data = {}) => postAdmin(port, path, await signAdmin(ident, path, data));
