// Relay addresses and invite links for multiplayer (src/play-net.js).
// Run with: node --test test/play-net.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// The page's globals, enough for play-net.js.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
function at(url) {
  globalThis.location = new URL(url);
}
at('https://ducy.example/');
const { wsUrl, relayUrl, joinLink, normCode } = await import('../src/play-net.js');

const SITE_RELAY = 'wss://ducy-relay.ducy.workers.dev';

test('relay addresses become WebSocket URLs', () => {
  assert.equal(wsUrl('https://ducy-relay.ducy.workers.dev/'), SITE_RELAY);
  assert.equal(wsUrl('http://localhost:8787'), 'ws://localhost:8787');
  assert.equal(wsUrl(' wss://x.dev// '), 'wss://x.dev');
});

test('the site relay is the default', () => {
  store.clear();
  at('https://ducy.example/#play');
  assert.equal(relayUrl(), SITE_RELAY);
  // Invite links don't need to name it.
  at('https://ducy.example/#play');
  const link = new URL(joinLink('ABCD-EFGH'));
  assert.equal(link.searchParams.get('table'), 'ABCD-EFGH');
  assert.equal(link.searchParams.get('relay'), null);
  assert.equal(link.hash, '#play');
});

test('?relay= is remembered, carried in invite links, and ?relay=default clears it', () => {
  store.clear();
  at('https://ducy.example/?relay=http://localhost:8787#play');
  assert.equal(relayUrl(), 'ws://localhost:8787');
  at('https://ducy.example/#play'); // later visits remember it
  assert.equal(relayUrl(), 'ws://localhost:8787');
  const link = new URL(joinLink('ABCD-EFGH'));
  assert.equal(link.searchParams.get('relay'), 'ws://localhost:8787');
  assert.equal(normCode(link.searchParams.get('table')), 'ABCD-EFGH');
  at('https://ducy.example/?relay=default#play');
  assert.equal(relayUrl(), SITE_RELAY);
  at('https://ducy.example/#play');
  assert.equal(relayUrl(), SITE_RELAY);
});

test('table codes read in any case, and never contain I, L, O, 0 or 1', () => {
  assert.equal(normCode('abcd-efgh'), 'ABCD-EFGH');
  assert.equal(normCode(' AbCd eFgH '), 'ABCD-EFGH');
  assert.equal(normCode('abcdefgh'), 'ABCD-EFGH');
  for (const bad of ['ABCD-EFG0', 'ABCD-EFGO', 'ABCD-EFG1', 'ABCD-EFGI', 'abcd-efgl', 'ABCD-EFG', 'ABCD-EFGHJ']) assert.equal(normCode(bad), '', bad);
});
