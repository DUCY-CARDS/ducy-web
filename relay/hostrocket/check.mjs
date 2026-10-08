// Checks a deployed backup endpoint (#97): node check.mjs <url> <hmac secret>
// Saves, reads back and deletes a test snapshot for club TEST-TEST, and checks
// that a wrong signature is refused.
import { signature } from '../src/backup.js';

const [url, secret] = process.argv.slice(2);
if (!url || !secret) { console.log('usage: node check.mjs <endpoint url> <hmac secret>'); process.exit(2); }
const club = 'TEST-TEST';

async function call(method, body = '', key = secret) {
  const time = String(Date.now());
  const u = new URL(url);
  u.searchParams.set('club', club);
  const res = await fetch(u, {method, headers: {'x-ducy-time': time, 'x-ducy-sig': await signature(key, time, method, club, body)}, ...(body ? {body} : {})});
  return {status: res.status, text: await res.text()};
}

const snap = JSON.stringify({v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'dGVzdA=='});
const checks = [
  ['save a snapshot', await call('POST', snap), 200],
  ['read it back', await call('GET'), 200],
  ['wrong signature refused', await call('GET', '', secret + 'x'), 403],
  ['delete it', await call('DELETE'), 200],
  ['gone after delete', await call('GET'), 404],
];
let ok = true;
for (const [what, r, want] of checks) {
  const pass = r.status === want && (what !== 'read it back' || r.text === snap);
  ok &&= pass;
  console.log(`${pass ? '✓' : '✗'} ${what}: ${r.status}${pass ? '' : ` (wanted ${want}) ${r.text.slice(0, 200)}`}`);
}
process.exit(ok ? 0 : 1);
