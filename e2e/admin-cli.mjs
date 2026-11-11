// A test admin for the browser tests' relays (#636), as a command, so the
// Playwright runner never loads ducy's engine itself (grant.mjs runs it):
//   node e2e/admin-cli.mjs new                         → {file, key}: an admins.json
//                                                        listing a new admin, and its key
//   node e2e/admin-cli.mjs call <key> <port> <path> [data-json]
//                                                      → the relay's answer to that
//                                                        signed admin request
// <key>: the admin's identity as exportIdentity writes it (a file path).
import '../test/wasm.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { exportIdentity, importIdentity } from '../src/identity.js';
import { adminFetch, testAdmin } from '../test/admin-helper.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'new') {
  const {ident, file} = await testAdmin('E2E admin');
  const key = join(dirname(file), 'admin-key.json');
  writeFileSync(key, await exportIdentity(ident));
  process.stdout.write(JSON.stringify({file, key}));
} else if (cmd === 'call') {
  const [key, port, path, data = '{}'] = args;
  const ident = await importIdentity(readFileSync(key, 'utf8'));
  process.stdout.write(JSON.stringify(await adminFetch(Number(port), ident)(path, JSON.parse(data))));
} else {
  console.error('usage: admin-cli.mjs new | call <key> <port> <path> [data]');
  process.exit(2);
}
