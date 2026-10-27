// The host's heartbeat to the relay (src/play-net.js connect) and how a
// club's tables stop their clocks when no one can be reached (src/club-host.js).
// Run with: node --test test/heartbeat.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

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

// ---- club tables (club-host.js) against a scripted engine ----

// A table that answers like an idle one where one member is seated and it's
// their turn.
const { fakeTables } = await import('./fake-table.mjs');
const { calls, call } = fakeTables(() => ({out: [], state: {complete: false, hand_number: 1}, players: [{client_id: 'ann', seat: 0, chips: 100}], turnMsLeft: 1000, seq: calls.length}));
const { createTableHost } = await import('../src/club-host.js');

test('a club table stops its clock while the relay is unreachable or no one seated is connected', async t => {
  t.mock.timers.enable({apis: ['setInterval', 'setTimeout', 'Date']});
  const table = {id: 't1', name: 'One', seats: 6, sb: 1, bb: 2, game: 'nlhe', turnSecs: 1, status: 'open', minBB: 20, maxBB: 100};
  const club = {tables: [table], members: {ann: {name: 'Ann', status: 'member'}}, chips: {ledger: [], balances: {}}};
  const here = new Set(['ann']);
  const th = createTableHost({
    club: () => club, save() {}, sendTable() {}, chipsChanged() {}, tablesChanged() {},
    online: id => here.has(id), call,
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => queueMicrotask(r)); };
  await th.start(table);
  await th.handle('t1', 'ann', {type: 'hello'});
  await settle();
  const ticks = () => calls.filter(c => c.method === 'tick').length;

  // Running normally: the turn clock ticks.
  t.mock.timers.tick(1100);
  await settle();
  assert.ok(ticks() >= 1, 'the turn clock runs');

  // The host loses the relay: the clock stops, and nothing ticks however long it lasts.
  th.setLink(false);
  await settle();
  const before = ticks();
  for (let i = 0; i < 60; i++) { t.mock.timers.tick(5_000); await settle(); }
  assert.equal(ticks(), before, 'no tick (no timeout, no sit-out expiry) while the link is down');

  // Back: the clock restarts and ticks again.
  th.setLink(true);
  await settle();
  t.mock.timers.tick(1100);
  await settle();
  assert.ok(ticks() > before, 'the turn clock runs again');

  // Everyone seated drops while the host's link is fine: stopped too.
  here.delete('ann');
  th.presence('ann');
  await settle();
  const quiet = ticks();
  for (let i = 0; i < 30; i++) { t.mock.timers.tick(5_000); await settle(); }
  assert.equal(ticks(), quiet, 'nobody to hear from: nobody is folded');
  here.add('ann');
  th.presence('ann');
  await settle();
  t.mock.timers.tick(1100);
  await settle();
  assert.ok(ticks() > quiet, 'back: it runs again');
});
