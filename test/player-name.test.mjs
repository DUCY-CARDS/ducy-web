// The player's name after a passkey restore (#619, src/player-name.js):
// the relay's copy comes back unless this browser has a name of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, keepName, NAME_KEY, restoreName, storedName } from '../src/player-name.js';

const store = new Map();
globalThis.localStorage = {getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};

test('a restore brings the kept name back to a browser with none', () => {
  store.clear();
  assert.equal(storedName(), '');
  assert.equal(restoreName('  Ava  '), 'Ava');
  assert.equal(store.get(NAME_KEY), 'Ava');
});

test('a browser’s own name stays; nothing kept leaves it blank, to be asked for', () => {
  store.clear();
  keepName('Bo');
  assert.equal(restoreName('Ava'), 'Bo');
  store.clear();
  assert.equal(restoreName(''), '');
  assert.equal(restoreName(undefined), '');
  assert.equal(store.has(NAME_KEY), false);
});

test('names are trimmed and cut to 20', () => {
  assert.equal(cleanName('  Ann Lee, the very long name '), 'Ann Lee, the very lo');
  assert.equal(cleanName(null), '');
});

test('storage that throws reads as no name', () => {
  const was = globalThis.localStorage;
  globalThis.localStorage = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  try {
    assert.equal(storedName(), '');
    keepName('Ava');
    assert.equal(restoreName('Ava'), '');
  } finally {
    globalThis.localStorage = was;
  }
});
