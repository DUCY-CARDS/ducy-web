// Player identity (#65): IDs, signed messages, the host's Verifier, backups.
// Run with: node --test test/identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_LENGTH, Verifier, backupNeedsPassword, canonical, checkSignature, createIdentity, exportIdentity, exportLockedIdentity,
  importIdentity, isPlayerId, parseShownId, playerIdFor, fromB64url, showId, signMessage,
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

test('a backup is locked with a password: the private key isn’t in it, and the right password restores the same ID', async () => {
  const me = await createIdentity();
  const text = await exportLockedIdentity(me, 'correct horse');
  const f = JSON.parse(text);
  assert.equal(f.v, 2);
  assert.equal(f.id, me.id, 'the file says whose it is');
  assert.equal(f.key, undefined);
  assert.ok(!text.includes((await crypto.subtle.exportKey('jwk', me.privateKey)).d), 'no private key in the clear');
  assert.ok(f.lock.iterations >= 100_000 && f.lock.salt && f.lock.iv && f.lock.ct);
  assert.ok(backupNeedsPassword(text));
  assert.ok(!backupNeedsPassword(await exportIdentity(me)));

  const copy = await importIdentity(text, 'correct horse');
  assert.equal(copy.id, me.id);
  assert.ok((await new Verifier().verify(await signMessage(copy, {hi: 1}))).ok);
  // Two backups of the same identity differ (fresh salt and IV).
  assert.notEqual(JSON.parse(await exportLockedIdentity(me, 'correct horse')).lock.ct, f.lock.ct);
});

test('a locked backup refuses a missing or wrong password, a short new one, and tampering', async () => {
  const me = await createIdentity();
  await assert.rejects(exportLockedIdentity(me, 'short'), /at least 8/);
  const text = await exportLockedIdentity(me, 'correct horse');
  await assert.rejects(importIdentity(text), /locked with a password/);
  await assert.rejects(importIdentity(text, 'wrong horse'), /Wrong password/);
  // The ID, algorithm and seq are bound to the encrypted key.
  for (const change of [f => { f.id = 'XXXXXXXX'; }, f => { f.seq = 99; }, f => { f.lock.ct = f.lock.ct.slice(0, -4) + 'AAAA'; }]) {
    const f = JSON.parse(text);
    change(f);
    await assert.rejects(importIdentity(JSON.stringify(f), 'correct horse'), /Wrong password|damaged/);
  }
  const bad = JSON.parse(text);
  bad.lock.iterations = 1e12;
  await assert.rejects(importIdentity(JSON.stringify(bad), 'correct horse'), /isn’t a ducy identity file/);
});

test('older backups without a password (version 1) still restore', async () => {
  const me = await createIdentity();
  const v1 = await exportIdentity(me);
  assert.equal(JSON.parse(v1).v, 1);
  assert.equal((await importIdentity(v1)).id, me.id);
  assert.equal((await importIdentity(v1, 'ignored')).id, me.id);
});

test('player IDs are shown in capitals and digits without I, L, O, 0 or 1, and read back in any case', async () => {
  for (let i = 0; i < 50; i++) {
    const me = await createIdentity();
    const shown = showId(me.id);
    assert.match(shown, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    assert.equal(parseShownId(shown), me.id);
    assert.equal(parseShownId(shown.toLowerCase()), me.id, 'lower case');
    assert.equal(parseShownId(` ${shown.replace('-', '')} `), me.id, 'no dash, spaces around');
    assert.equal(parseShownId(me.id), me.id, 'the stored form still works');
  }
  // The smallest and largest IDs.
  assert.equal(showId('11111111'), 'AAAAA-AAAAA');
  assert.equal(parseShownId(showId('zzzzzzzz')), 'zzzzzzzz');
  assert.equal(parseShownId('99999-99999'), null, 'past the largest ID');
  assert.equal(parseShownId('AAAAA-AAAAO'), null, 'O is never used');
  assert.equal(parseShownId('AAAA-AAAA'), null, 'too short');
});
