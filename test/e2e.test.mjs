// End-to-end encryption of table updates (e2e.js).
// Run with: node --test test/e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicKey, newKeyPair, open, seal, sharedKey } from '../src/e2e.js';

const ctx = (host, player) => ({context: 'club:ABCD-EFGH', hostId: 'HOSTHOST', playerId: 'PLAYERID', hostPub: host.pub, playerPub: player.pub});

async function pair() {
  const host = await newKeyPair(), player = await newKeyPair();
  const hk = await sharedKey(host, player.pub, ctx(host, player));
  const pk = await sharedKey(player, host.pub, ctx(host, player));
  return {host, player, hk, pk};
}

const update = {type: 'state', seq: 3, view: {seats: [{name: 'Ann', cards: ['As', 'Kd']}]}};

test('host and player derive the same key; sealed updates open on the other side', async () => {
  const {hk, pk} = await pair();
  const box = await seal(hk, update);
  assert.deepEqual(await open(pk, box), update);
  // The ciphertext doesn't show the cards. (Quoted: the base64 ciphertext
  // is random letters, so a bare "As" turns up in it now and then.)
  assert.ok(!JSON.stringify(box).includes('"As"'));
  assert.ok(!JSON.stringify(box).includes('"cards"'));
});

test('every update gets a fresh IV, so equal updates look different', async () => {
  const {hk} = await pair();
  const a = await seal(hk, update), b = await seal(hk, update);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('a tampered update, or one sealed for someone else, doesn’t open', async () => {
  const {hk, pk} = await pair();
  const box = await seal(hk, update);
  const flipped = box.ct.slice(0, -2) + (box.ct.at(-2) === 'A' ? 'B' : 'A') + box.ct.at(-1);
  await assert.rejects(open(pk, {...box, ct: flipped}));
  const other = await pair();
  await assert.rejects(open(other.pk, box));
});

test('a relay swapping in its own key gets a different key than the real pair', async () => {
  // The relay can't sign as the host, so the player only accepts the host's
  // real key; if the relay gave the host its own key instead of the
  // player's, the host's updates wouldn't open for the player.
  const host = await newKeyPair(), player = await newKeyPair(), relay = await newKeyPair();
  const hostSide = await sharedKey(host, relay.pub, {...ctx(host, relay)});
  const playerSide = await sharedKey(player, host.pub, ctx(host, player));
  await assert.rejects(open(playerSide, await seal(hostSide, update)));
});

test('the context is part of the key', async () => {
  const host = await newKeyPair(), player = await newKeyPair();
  const a = await sharedKey(host, player.pub, ctx(host, player));
  const b = await sharedKey(player, host.pub, {...ctx(host, player), context: 'club:OTHER-CLUB'});
  await assert.rejects(open(b, await seal(a, update)));
});

test('public keys are checked', async () => {
  assert.ok(isPublicKey((await newKeyPair()).pub));
  assert.equal(isPublicKey('nope'), false);
  assert.equal(isPublicKey(42), false);
});
