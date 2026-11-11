// The passkey rows of the You page (#575, #646): a first passkey is added
// without an unlock once the relay says this account has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { passkeyRows } from '../src/passkey-rows.js';

const acts = h => [...h.matchAll(/data-ps="(pk-[a-z]+)"/g)].map(m => m[1]);

test('no passkey yet: restore, and Add once the relay has said so', () => {
  assert.deepEqual(acts(passkeyRows({})), ['pk-recover']);
  assert.deepEqual(acts(passkeyRows({checked: true})), ['pk-recover', 'pk-first']);
});

test('enrolled: Unlock, then the list with Add and Remove', () => {
  assert.deepEqual(acts(passkeyRows({checked: true, enrolled: true})), ['pk-show']);
  const one = passkeyRows({enrolled: true, list: [{credId: 'a', name: 'Linux', at: 0, current: true}]});
  assert.deepEqual(acts(one), ['pk-add']);
  assert.match(one, /\(this one\)/);
  const two = passkeyRows({enrolled: true, list: [{credId: 'a', name: 'Linux', at: 0}, {credId: 'b', name: '<iPhone>', at: 0}]});
  assert.deepEqual(acts(two), ['pk-add', 'pk-remove', 'pk-remove']);
  assert.match(two, /&lt;iPhone&gt;/);
});

test('busy: every button disabled', () => {
  assert.ok(passkeyRows({checked: true, busy: true}).match(/disabled/g).length === 2);
});
