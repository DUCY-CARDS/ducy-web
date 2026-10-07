// The relay's queue mode (clubs, #66) against the Node dev relay.
// Needs the relay's dependency: npm ci --prefix relay
// Run with: node --test test/relay-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../relay/node_modules/ws/index.js';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(PORT)], {stdio: ['ignore', 'pipe', 'inherit']});
await new Promise(resolve => server.stdout.once('data', resolve));
test.after(() => server.kill());

// A connection that collects messages; next() waits for the next one.
function open(path) {
  const ws = new WebSocket(`ws://localhost:${PORT}${path}`);
  const inbox = [], waiting = [];
  ws.on('message', d => { const m = JSON.parse(d); waiting.length ? waiting.shift()(m) : inbox.push(m); });
  const closed = new Promise(resolve => ws.on('close', code => resolve(code)));
  return {
    ws, closed,
    ready: new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); }),
    next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise(r => waiting.push(r))),
    send: obj => ws.send(JSON.stringify(obj)),
  };
}

test('a plain guest is still refused when there is no host', async () => {
  const g = open('/room/AAAA-AAAA?role=guest&id=g1');
  assert.equal(await g.closed, 4004);
});

test('queued messages wait for the host and are deleted when acked', async () => {
  const g = open('/room/BBBB-BBBB?role=guest&id=ann&queue=1');
  await g.ready;
  assert.deepEqual(await g.next(), {type: 'host_away'});
  g.send({hello: 1});
  g.send({hello: 2});
  await new Promise(r => setTimeout(r, 50));

  const h = open('/room/BBBB-BBBB?role=host');
  await h.ready;
  assert.deepEqual(await h.next(), {from: 'ann', event: 'open'});
  const q1 = await h.next(), q2 = await h.next();
  assert.deepEqual([q1.data, q2.data], [{hello: 1}, {hello: 2}]);
  assert.equal(q1.from, 'ann');
  assert.deepEqual(await g.next(), {type: 'host_back'});

  // Live messages now, both ways.
  g.send({live: true});
  assert.deepEqual(await h.next(), {from: 'ann', data: {live: true}});
  h.send({to: 'ann', data: {ok: 1}});
  assert.deepEqual(await g.next(), {ok: 1});

  // Ack only the first; the second is delivered again to the next host.
  h.send({ack: q1.queued});
  await new Promise(r => setTimeout(r, 50));
  h.ws.close();
  assert.deepEqual(await g.next(), {type: 'host_gone'});
  const h2 = open('/room/BBBB-BBBB?role=host');
  await h2.ready;
  assert.deepEqual(await h2.next(), {from: 'ann', event: 'open'});
  const again = await h2.next();
  assert.deepEqual(again, {from: 'ann', data: {hello: 2}, queued: q2.queued});
  h2.ws.close();
  g.ws.close();
});

test('a queue-mode guest stays connected when the host leaves; plain guests are closed', async () => {
  const h = open('/room/CCCC-CCCC?role=host');
  await h.ready;
  const q = open('/room/CCCC-CCCC?role=guest&id=q&queue=1');
  const p = open('/room/CCCC-CCCC?role=guest&id=p');
  await Promise.all([q.ready, p.ready]);
  h.ws.close();
  assert.deepEqual(await q.next(), {type: 'host_gone'});
  assert.equal(await p.closed, 4002);
  q.send({while: 'away'});
  const h2 = open('/room/CCCC-CCCC?role=host');
  await h2.ready;
  assert.deepEqual(await h2.next(), {from: 'q', event: 'open'});
  assert.deepEqual((await h2.next()).data, {while: 'away'});
  h2.ws.close();
  q.ws.close();
});

test('each guest can queue only a few messages', async () => {
  const g = open('/room/DDDD-DDDD?role=guest&id=spam&queue=1');
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
  const g = open('/room/FFFF-FFFF?role=guest&id=pinger&queue=1');
  await g.ready;
  assert.deepEqual(await g.next(), {type: 'host_away'});
  g.send({type: 'ping', t: 7});
  assert.deepEqual(await g.next(), {type: 'pong', t: 7});
  const h = open('/room/FFFF-FFFF?role=host');
  await h.ready;
  assert.deepEqual(await h.next(), {from: 'pinger', event: 'open'});
  h.send({type: 'ping', t: 1});
  assert.deepEqual(await h.next(), {type: 'pong', t: 1}, 'nothing was queued, and the host gets its own pong');
  g.ws.close();
  h.ws.close();
});
