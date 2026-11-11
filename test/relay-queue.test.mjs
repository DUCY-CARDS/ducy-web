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

test('a plain guest is refused where there is no club', async () => {
  const g = open('/room/AAAA-AAAA?role=guest&id=g1');
  assert.equal(await g.closed, 4004);
});

test('no one can host a table or a tournament on the relay (#643)', async () => {
  const h = open('/room/BBBB-BBBB?role=host');
  assert.equal(await h.closed, 4000);
  const anything = open('/room/BBBB-BBBB?role=other');
  assert.equal(await anything.closed, 4000);
});

test('a queue-mode guest hears there is no club yet, and its messages are kept', async () => {
  const ann = await createIdentity();
  const g = open(`/room/CCCC-CCCC?role=guest&id=${ann.id}&queue=1`, ann);
  await g.ready;
  assert.deepEqual(await g.next(), {type: 'host_away'});
  g.send({hello: 1});
  g.send({type: 'ping', t: 3});
  assert.deepEqual(await g.next(), {type: 'pong', t: 3}, 'nothing else comes back');
  g.ws.close();
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
  const a = await createIdentity(), b = await createIdentity();
  const calm = open(`/room/EEEE-EEEE?role=guest&id=${a.id}&queue=1`, a);
  const flood = open(`/room/EEEE-EEEE?role=guest&id=${b.id}&queue=1`, b);
  await Promise.all([calm.ready, flood.ready]);
  // Well past the burst of 50, all at once.
  for (let i = 0; i < 200; i++) flood.send({type: 'ping', t: i});
  assert.equal(await flood.closed, 4008);
  // The calm guest still gets through.
  assert.deepEqual(await calm.next(), {type: 'host_away'});
  calm.send({type: 'ping', t: 9});
  assert.deepEqual(await calm.next(), {type: 'pong', t: 9});
  calm.ws.close();
});

// ---- proving the player's ID (#577) ----

test('someone who only knows a player’s ID can’t knock them off', async () => {
  const ann = await createIdentity(), eve = await createIdentity();
  const a = open(`/room/GGGG-GGGG?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  assert.deepEqual(await a.next(), {type: 'host_away'});

  // Eve connects with Ann's ID and never proves it: Ann stays.
  const e1 = open(`/room/GGGG-GGGG?role=guest&id=${ann.id}&queue=1`);
  await e1.ready;
  assert.equal((await e1.next()).type, 'prove');
  e1.send({hello: 'as ann'});
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
  a.send({type: 'ping', t: 5});
  assert.deepEqual(await a.next(), {type: 'pong', t: 5}, 'Ann is still connected');
  e1.ws.close();
  a.ws.close();
});

test('a reload, or a second tab, proves the ID and takes the player’s place back', async () => {
  const ann = await createIdentity();
  const a = open(`/room/JJJJ-JJJJ?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  // The page reloads: its new connection proves the ID, and the old one goes.
  const a2 = open(`/room/JJJJ-JJJJ?role=guest&id=${ann.id}&queue=1`, ann);
  await a2.ready;
  assert.equal(await a.closed, 4009);
  assert.deepEqual(await a2.next(), {type: 'host_away'});
  a2.ws.close();
});
