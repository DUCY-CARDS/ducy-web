// Wiping a test relay (relay/src/reset.js): only where RESETTABLE is on,
// and only with the token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clubCodes, resetRefusal } from '../relay/src/reset.js';

const TOKEN = 'a'.repeat(40);

test('a relay without RESETTABLE has no reset at all', () => {
  assert.equal(resetRefusal({RESET_TOKEN: TOKEN}, `Bearer ${TOKEN}`).status, 404);
  assert.equal(resetRefusal({RESETTABLE: 'yes', RESET_TOKEN: TOKEN}, `Bearer ${TOKEN}`).status, 404);
  assert.equal(resetRefusal(undefined, '').status, 404);
});

test('a resettable relay needs a long token, and the right one', () => {
  assert.equal(resetRefusal({RESETTABLE: 'on'}, 'Bearer ').status, 403);
  assert.equal(resetRefusal({RESETTABLE: 'on', RESET_TOKEN: 'short'}, 'Bearer short').status, 403);
  assert.equal(resetRefusal({RESETTABLE: 'on', RESET_TOKEN: TOKEN}, '').status, 403);
  assert.equal(resetRefusal({RESETTABLE: 'on', RESET_TOKEN: TOKEN}, `Bearer ${'b'.repeat(40)}`).status, 403);
  assert.equal(resetRefusal({RESETTABLE: 'on', RESET_TOKEN: TOKEN}, `Bearer ${TOKEN}`, 'GET').status, 405);
  assert.equal(resetRefusal({RESETTABLE: 'on', RESET_TOKEN: TOKEN}, `Bearer ${TOKEN}`), null);
});

test('the club codes come from the registry record', () => {
  assert.deepEqual(clubCodes(undefined), []);
  assert.deepEqual(clubCodes({'ABCD-EFGH': {owner: 'x'}, 'JKMN-PQRS': {code: 'JKMN-PQRS'}}), ['ABCD-EFGH', 'JKMN-PQRS']);
});

test('only the sandbox relay is resettable', () => {
  const toml = readFileSync(new URL('../relay/wrangler.toml', import.meta.url), 'utf8');
  const sections = toml.split(/^\[env\./m);
  const [top, ...envs] = sections;
  assert.doesNotMatch(top, /RESETTABLE/);
  for (const e of envs) {
    const named = e.match(/^(\w+)/)[1];
    if (/RESETTABLE\s*=\s*"on"/.test(e)) assert.equal(named, 'sandbox');
  }
  assert.match(toml, /\[env\.sandbox\.vars\][^[]*RESETTABLE = "on"/);
});
