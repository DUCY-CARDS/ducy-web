// The relay's queue mode (clubs, #66) against the Node dev relay, and club
// connections proving their player ID (#577).
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIdentity, signMessage } from '../src/identity.js';
import { relayClient } from './relay-helper.mjs';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(PORT)], {stdio: ['ignore', 'pipe', 'inherit']});
await new Promise(resolve => server.stdout.once('data', resolve));
test.after(() => server.kill());

const relay = relayClient(PORT);
// A queue-mode connection (a club member's): it proves its player ID; a
// browser-run club needs no passkey unlock.
const open = (path, ident = null) => relay.open(path, ident, {unlock: false});
const wait = ms => new Promise(r => setTimeout(r, ms));

test('a plain guest is still refused when there is no host', async () => {
  const g = open('/room/AAAA-AAAA?role=guest&id=g1');
  assert.equal(await g.closed, 4004);
});

test('queued messages wait for the host and are deleted when acked', async () => {
  const ann = await createIdentity();
  const g = open(`/room/BBBB-BBBB?role=guest&id=${ann.id}&queue=1`, ann);
  await g.ready;
  assert.deepEqual(await g.next(), {type: 'host_away'});
  g.send({hello: 1});
  g.send({hello: 2});
  await wait(50);

  const h = open('/room/BBBB-BBBB?role=host');
  await h.ready;
  assert.deepEqual(await h.next(), {from: ann.id, event: 'open'});
  const q1 = await h.next(), q2 = await h.next();
  assert.deepEqual([q1.data, q2.data], [{hello: 1}, {hello: 2}]);
  assert.equal(q1.from, ann.id);
  assert.deepEqual(await g.next(), {type: 'host_back'});

  // Live messages now, both ways.
  g.send({live: true});
  assert.deepEqual(await h.next(), {from: ann.id, data: {live: true}});
  h.send({to: ann.id, data: {ok: 1}});
  assert.deepEqual(await g.next(), {ok: 1});

  // Ack only the first; the second is delivered again to the next host.
  h.send({ack: q1.queued});
  await wait(50);
  h.ws.close();
  assert.deepEqual(await g.next(), {type: 'host_gone'});
  const h2 = open('/room/BBBB-BBBB?role=host');
  await h2.ready;
  assert.deepEqual(await h2.next(), {from: ann.id, event: 'open'});
  const again = await h2.next();
  assert.deepEqual(again, {from: ann.id, data: {hello: 2}, queued: q2.queued});
  h2.ws.close();
  g.ws.close();
});

test('a queue-mode guest stays connected when the host leaves; plain guests are closed', async () => {
  const q1 = await createIdentity();
  const h = open('/room/CCCC-CCCC?role=host');
  await h.ready;
  const q = open(`/room/CCCC-CCCC?role=guest&id=${q1.id}&queue=1`, q1);
  const p = open('/room/CCCC-CCCC?role=guest&id=p');
  await Promise.all([q.ready, p.ready]);
  h.ws.close();
  assert.deepEqual(await q.next(), {type: 'host_gone'});
  assert.equal(await p.closed, 4002);
  q.send({while: 'away'});
  const h2 = open('/room/CCCC-CCCC?role=host');
  await h2.ready;
  assert.deepEqual(await h2.next(), {from: q1.id, event: 'open'});
  assert.deepEqual((await h2.next()).data, {while: 'away'});
  h2.ws.close();
  q.ws.close();
});

test('each guest can queue only a few messages', async () => {
  const spam = await createIdentity();
  const g = open(`/room/DDDD-DDDD?role=guest&id=${spam.id}&queue=1`, spam);
  await g.ready;
  await g.next(); // host_away
  for (let i = 0; i < 11; i++) g.send({i});
  assert.deepEqual(await g.next(), {type: 'queue_full'});
  g.ws.close();
});

test('a connection sending too fast is closed (4008); others are unaffected', async () => {
  const h = open('/room/EEEE-EEEE?role=host');
  await h.ready;
  const calm = open('/room/EEEE-EEEE?role=guest&id=calm');
  const flood = open('/room/EEEE-EEEE?role=guest&id=flood');
  await Promise.all([calm.ready, flood.ready]);
  // Well past the burst of 50, all at once.
  for (let i = 0; i < 200; i++) flood.send({i});
  assert.equal(await flood.closed, 4008);
  // The calm guest still gets through.
  calm.send({hello: 'still here'});
  for (let m = await h.next(); ; m = await h.next()) {
    if (m.from === 'calm' && m.data) { assert.deepEqual(m.data, {hello: 'still here'}); break; }
  }
  h.ws.close();
  calm.ws.close();
});

test('pings are answered by the relay, never forwarded or queued', async () => {
  const pinger = await createIdentity();
  const g = open(`/room/FFFF-FFFF?role=guest&id=${pinger.id}&queue=1`, pinger);
  await g.ready;
  assert.deepEqual(await g.next(), {type: 'host_away'});
  g.send({type: 'ping', t: 7});
  assert.deepEqual(await g.next(), {type: 'pong', t: 7});
  const h = open('/room/FFFF-FFFF?role=host');
  await h.ready;
  assert.deepEqual(await h.next(), {from: pinger.id, event: 'open'});
  h.send({type: 'ping', t: 1});
  assert.deepEqual(await h.next(), {type: 'pong', t: 1}, 'nothing was queued, and the host gets its own pong');
  g.ws.close();
  h.ws.close();
});

// ---- proving the player's ID (#577) ----

test('someone who only knows a player’s ID can’t knock them off, or hear what’s sent to them', async () => {
  const ann = await createIdentity(), eve = await createIdentity();
  const h = open('/room/GGGG-GGGG?role=host');
  await h.ready;
  const a = open(`/room/GGGG-GGGG?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  assert.deepEqual(await h.next(), {from: ann.id, event: 'open'});

  // Eve connects with Ann's ID and never proves it: Ann stays.
  const e1 = open(`/room/GGGG-GGGG?role=guest&id=${ann.id}&queue=1`);
  await e1.ready;
  assert.equal((await e1.next()).type, 'prove');
  e1.send({hello: 'as ann'});
  h.send({to: ann.id, data: {secret: 1}});
  assert.deepEqual(await a.next(), {secret: 1}, 'Ann still gets her messages');
  // Eve signs with her own key: closed, and Ann stays.
  const e2 = open(`/room/GGGG-GGGG?role=guest&id=${ann.id}&queue=1`);
  const ch = await e2.next();
  e2.send({type: 'prove', env: await signMessage(eve, {type: 'prove', room: 'GGGG-GGGG', challenge: ch.challenge})});
  assert.equal(await e2.closed, 4000);
  // Nor does Ann's own proof for another room, or an old challenge, do.
  const e3 = open(`/room/GGGG-GGGG?role=guest&id=${ann.id}&queue=1`);
  await e3.next();
  e3.send({type: 'prove', env: await signMessage(ann, {type: 'prove', room: 'HHHH-HHHH', challenge: ch.challenge})});
  assert.equal(await e3.closed, 4000);
  a.send({still: 'here'});
  for (let m = await h.next(); ; m = await h.next()) {
    assert.notDeepEqual(m.data, {hello: 'as ann'}, 'nothing from the unproven connection reached the host');
    if (m.data?.still) break;
  }
  e1.ws.close();
  a.ws.close();
  h.ws.close();
});

test('a reload, or a second tab, proves the ID and takes the player’s place back', async () => {
  const ann = await createIdentity();
  const h = open('/room/JJJJ-JJJJ?role=host');
  await h.ready;
  const a = open(`/room/JJJJ-JJJJ?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  assert.deepEqual(await h.next(), {from: ann.id, event: 'open'});
  // The page reloads: its new connection proves the ID, and the old one goes.
  const a2 = open(`/room/JJJJ-JJJJ?role=guest&id=${ann.id}&queue=1`, ann);
  await a2.ready;
  assert.equal(await a.closed, 4009);
  assert.deepEqual(await h.next(), {from: ann.id, event: 'open'}, 'the same player, here again; no close');
  h.send({to: ann.id, data: {to: 'the new one'}});
  assert.deepEqual(await a2.next(), {to: 'the new one'});
  // Reconnecting after the connection drops: the same, with what was queued.
  a2.ws.close();
  assert.deepEqual(await h.next(), {from: ann.id, event: 'close'});
  const a3 = open(`/room/JJJJ-JJJJ?role=guest&id=${ann.id}&queue=1`, ann);
  await a3.ready;
  assert.deepEqual(await h.next(), {from: ann.id, event: 'open'});
  a3.send({back: true});
  assert.deepEqual(await h.next(), {from: ann.id, data: {back: true}});
  a3.ws.close();
  h.ws.close();
});

test('friends tables’ guests aren’t asked to prove anything', async () => {
  const h = open('/room/KKKK-KKKK?role=host');
  await h.ready;
  const g = open('/room/KKKK-KKKK?role=guest&id=client-1');
  await g.ready;
  assert.deepEqual(await h.next(), {from: 'client-1', event: 'open'});
  g.send({hi: 1});
  assert.deepEqual(await h.next(), {from: 'client-1', data: {hi: 1}});
  g.ws.close();
  h.ws.close();
});
