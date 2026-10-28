// The host's heartbeat to the relay (src/play-net.js connect) and how a
// club's tables stop their clocks when no one can be reached (src/club-host.js).
// Run with: node --test test/heartbeat.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

globalThis.location = new URL('https://ducy.example/');
globalThis.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};

// A WebSocket the test drives: open(), message(obj), drop(code).
const sockets = [];
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen(); }
  message(obj) { this.onmessage({data: JSON.stringify(obj)}); }
  drop(code = 1006) { this.readyState = 3; this.onclose({code}); }
}
globalThis.WebSocket = FakeSocket;

const { connect, PING_MS, SILENT_MS } = await import('../src/play-net.js');

function host(opts = {}) {
  const log = {health: [], messages: [], fails: []};
  const net = connect('ABCD-EFGH', 'host', null, {
    onOpen() {},
    onMessage: m => log.messages.push(m),
    onStatus() {},
    onFail: r => log.fails.push(r),
    onHealth: ok => log.health.push(ok),
  }, {heartbeat: true, persistent: true, ...opts});
  return {net, log, ws: () => sockets.at(-1)};
}

test('the host pings the relay and is healthy while pongs come back', t => {
  t.mock.timers.enable({apis: ['setInterval', 'setTimeout', 'Date']});
  const {net, log, ws} = host();
  assert.equal(net.healthy(), false, 'not healthy before the socket opens');
  ws().open();
  assert.deepEqual(log.health, [true]);
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(PING_MS);
    const ping = ws().sent.at(-1);
    assert.equal(ping.type, 'ping');
    ws().message({type: 'pong', t: ping.t});
  }
  assert.deepEqual(log.health, [true], 'answered pings keep it healthy');
  assert.equal(log.messages.length, 0, 'pongs are not passed on');
  net.close();
});

test('silence from the relay makes the host unhealthy, and a pong brings it back', t => {
  t.mock.timers.enable({apis: ['setInterval', 'setTimeout', 'Date']});
  const {net, log, ws} = host();
  ws().open();
  t.mock.timers.tick(PING_MS);
  ws().message({type: 'pong'}); // this relay answers pings
  // The socket stays "open" but nothing comes back (a half-dead link).
  t.mock.timers.tick(SILENT_MS + PING_MS);
  assert.deepEqual(log.health, [true, false]);
  assert.equal(net.healthy(), false);
  ws().message({type: 'pong'});
  assert.deepEqual(log.health, [true, false, true]);
  net.close();
});

test('a relay that never answers pings: the socket state alone decides', t => {
  t.mock.timers.enable({apis: ['setInterval', 'setTimeout', 'Date']});
  const {net, log, ws} = host();
  ws().open();
  t.mock.timers.tick(SILENT_MS * 5);
  assert.deepEqual(log.health, [true], 'an older relay without pongs is not taken for an outage');
  net.close();
});

test('a persistent host keeps reconnecting through a long outage', t => {
  t.mock.timers.enable({apis: ['setInterval', 'setTimeout', 'Date']});
  const {net, log, ws} = host();
  ws().open();
  const first = sockets.length;
  for (let i = 0; i < 12; i++) {
    ws().drop();
    t.mock.timers.tick(30_000);
  }
  assert.equal(sockets.length, first + 12, 'one new socket per drop, past the usual six tries');
  assert.deepEqual(log.fails, []);
  assert.deepEqual(log.health, [true, false]);
  ws().open();
  assert.deepEqual(log.health, [true, false, true]);
  // "In use" still fails at once.
  ws().drop(4001);
  assert.equal(log.fails.length, 1);
  net.close();
});

test('without persistent, the old give-up after six tries stands', t => {
  t.mock.timers.enable({apis: ['setInterval', 'setTimeout', 'Date']});
  const {log, ws} = host({persistent: false});
  ws().open();
  for (let i = 0; i < 7; i++) { ws().drop(); t.mock.timers.tick(64_000); }
  assert.deepEqual(log.fails, ['Lost the connection.']);
});

// ---- club tables (club-host.js) on ducy's engine ----

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue } = await import('../src/club-chips.js');
const { newTable } = await import('../src/club-tables.js');
const { isDealing } = await import('../src/club-overview.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 10_000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

test('a club table stops its clock while the relay is unreachable or no one seated is connected', {skip: !haveWasm && 'no wasm build'}, async tc => {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ['ann', 'bob']) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  const t = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 6, turnSecs: 30});
  const engine = clubEngine();
  const here = new Set(['ann', 'bob']);
  const th = createTableHost({
    club: () => club, save() {}, sendTable() {}, chipsChanged() {}, tablesChanged() {}, onHand() {},
    online: id => here.has(id), call: async (op, ...args) => engine.ops[op](...args),
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  await th.start(t);
  tc.after(() => th.close(t.id));
  for (const id of ['ann', 'bob']) {
    await th.handle(t.id, id, {type: 'join'});
    await th.handle(t.id, id, {type: 'request_chips', amount: 150});
    await until(`${id} seated`, () => club.members[id].seat);
  }
  // A hand in play, and no one acting: the clock runs.
  const running = () => isDealing(t.dealing);
  await until('the clock running', running);

  // The host loses the relay: the clock stops. Back: it runs again.
  th.setLink(false);
  await until('the clock stopped', () => !running());
  th.setLink(true);
  await until('the clock running again', running);

  // Everyone seated drops while the host's link is fine: stopped too.
  for (const id of ['ann', 'bob']) { here.delete(id); th.presence(id); }
  await until('stopped with no one to hear from', () => !running());
  here.add('ann');
  th.presence('ann');
  await until('back: it runs again', running);
});
