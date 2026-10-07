// Player identity (#65): IDs, signed messages, the host's Verifier, backups.
// Run with: node --test test/identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_LENGTH, Verifier, canonical, checkSignature, createIdentity, exportIdentity,
  importIdentity, isPlayerId, playerIdFor, fromB64url, signMessage,
} from '../src/identity.js';

test('a new identity has an 8-character Base58 ID derived from its key', async () => {
  const me = await createIdentity();
  assert.equal(me.id.length, ID_LENGTH);
  assert.ok(isPlayerId(me.id));
  assert.ok(!/[0OIl]/.test(me.id));
  assert.equal(await playerIdFor(fromB64url(me.pub)), me.id);
  assert.ok(['ed25519', 'p256'].includes(me.alg));
});

test('different identities get different IDs', async () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add((await createIdentity()).id);
  assert.equal(ids.size, 20);
});

test('canonical JSON ignores key order', () => {
  assert.equal(canonical({b: 1, a: {d: [1, {y: 2, x: 1}], c: 'z'}}), canonical({a: {c: 'z', d: [1, {x: 1, y: 2}]}, b: 1}));
});

test('a host accepts a signed message and returns its body', async () => {
  const me = await createIdentity();
  const host = new Verifier();
  const r = await host.verify(await signMessage(me, {type: 'join', name: 'Ann'}));
  assert.deepEqual(r, {ok: true, from: me.id, body: {type: 'join', name: 'Ann'}});
});

test('a host rejects altered, forged, replayed and mismatched messages', async () => {
  const me = await createIdentity();
  const other = await createIdentity();
  const host = new Verifier();

  const env = await signMessage(me, {type: 'request_chips', amount: 100});
  assert.equal((await host.verify({...env, body: {type: 'request_chips', amount: 1000}})).reason, 'bad signature');
  assert.equal((await host.verify({...env, sig: undefined})).reason, 'malformed');

  // Claims to be `me` but is signed with another key.
  const forged = await signMessage(other, {type: 'request_chips', amount: 100});
  assert.equal((await host.verify({...forged, from: me.id})).reason, 'id does not match key');

  assert.ok((await host.verify(env)).ok);
  assert.equal((await host.verify(env)).reason, 'replayed');
  const older = {...env};
  assert.equal((await host.verify(older)).reason, 'replayed');
  assert.ok((await host.verify(await signMessage(me, {type: 'sit'}))).ok);
});

test('a known ID with a different key is refused as in use', async () => {
  const me = await createIdentity();
  const host = new Verifier();
  assert.ok((await host.verify(await signMessage(me, {}))).ok);
  // Fake a collision: the host already knows this ID with some other key.
  host.senders.set(me.id, {...host.senders.get(me.id), pub: 'AAAA'});
  assert.equal((await host.verify(await signMessage(me, {}))).reason, 'id in use');
});

test('the Verifier survives being saved and restored', async () => {
  const me = await createIdentity();
  const host = new Verifier();
  const env = await signMessage(me, {n: 1});
  assert.ok((await host.verify(env)).ok);
  const restored = new Verifier(JSON.parse(JSON.stringify(host)));
  assert.equal((await restored.verify(env)).reason, 'replayed');
  assert.ok((await restored.verify(await signMessage(me, {n: 2}))).ok);
});

test('sequence numbers keep going up', async () => {
  const me = await createIdentity();
  const a = await signMessage(me, 1), b = await signMessage(me, 2), c = await signMessage(me, 3);
  assert.ok(a.seq < b.seq && b.seq < c.seq);
});

test('an exported identity imports with the same ID and its messages verify', async () => {
  const me = await createIdentity();
  const host = new Verifier();
  assert.ok((await host.verify(await signMessage(me, {type: 'join'}))).ok);

  const copy = await importIdentity(await exportIdentity(me));
  assert.equal(copy.id, me.id);
  assert.equal(copy.pub, me.pub);
  assert.equal(copy.alg, me.alg);
  // The host knows this player already, and accepts the restored browser.
  assert.ok((await host.verify(await signMessage(copy, {type: 'sit'}))).ok);
  assert.equal(await checkSignature(await signMessage(copy, {})), '');
});

test('both key types work, so browsers without Ed25519 fall back to P-256', async () => {
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const p256 = await importIdentity(JSON.stringify({type: 'ducy-identity', v: 1, alg: 'p256', seq: 0, key: jwk}));
  assert.ok(isPlayerId(p256.id));
  assert.ok((await new Verifier().verify(await signMessage(p256, {hi: 1}))).ok);
});

test('importing something else fails clearly', async () => {
  await assert.rejects(importIdentity('not json'), /isn’t a ducy identity file/);
  await assert.rejects(importIdentity('{"type":"other"}'), /isn’t a ducy identity file/);
  const me = await createIdentity();
  const f = JSON.parse(await exportIdentity(me));
  f.id = 'XXXXXXXX';
  await assert.rejects(importIdentity(JSON.stringify(f)), /damaged/);
});
