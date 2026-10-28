// The manager removes a player from a table without closing it (#414): after
// the hand in play, or now (folding them out of it), with Undo before the
// hand ends; the usual cash-out (credit repaid first), the hit-and-run rule
// overridden, and the log entry. A real club table
// (club-host.js and ducy's engine). Needs the wasm build in wasm/.
// Run with: node --test test/remove-from-table.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
const { MultiTable } = haveWasm ? await import('./wasm.mjs').then(() => import('../wasm/ducy_wasm.js')) : {};
const { approve, newClub } = await import('../src/club.js');
const { issue, totals } = await import('../src/club-chips.js');
const { setCredit } = await import('../src/club-credit.js');
const { newTable } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 30_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// A club with ann, bob, cy and dee. Ann plays on credit.
function setUp() {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ['ann', 'bob', 'cy', 'dee']) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    if (id !== 'ann') issue(club, id, 1000, 0);
  }
  setCredit(club, 'ann', 500);
  const t = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0, stayHands: 5});
  const engine = clubEngine(MultiTable);
  // Each player acts (check or call) only while `acting` says so, so a hand
  // can be held where the test wants it.
  const acting = new Set();
  const got = {ann: [], bob: [], cy: [], dee: []};
  const last = {};
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = msg.update;
    got[to]?.push(u);
    if (u.type === 'state') last[to] = u;
    if (u.type === 'state' && acting.has(to) && u.view.legal && !u.view.complete) {
      host.handle(t.id, to, {type: 'act', seq: u.seq, kind: u.view.legal.can_check ? 'check' : 'call', amount: 0});
    }
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {}, onHand() {},
    call: async (op, ...args) => engine.ops[op](...args),
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  // What the manager watching sees.
  const watch = {};
  return {club, t, host, acting, got, last, watch, act: id => { acting.add(id); const u = last[id]; if (u) deliver(id, {update: u}); }};
}

const seated = (club, id) => club.members[id].seat;

test('removed after the hand, with Undo first; the usual cash-out, credit repaid, logged', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, t, host, got, watch, act} = setUp();
  await host.start(t);
  host.watch(t.id, u => { if (u.type === 'state') Object.assign(watch, u); });
  for (const id of ['ann', 'bob', 'cy']) {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: 150});
  }
  // Ann bought in on credit. (Her result counts from 100.)
  club.members.ann.seat.put = 100;
  await until('a hand in play', () => watch.view && !watch.view.complete && Number(watch.view.hand_number) >= 1);
  assert.equal(club.members.ann.balance, -150, 'she owes her buy-in');
  await host.removePlayer(t.id, 'ann', {by: 'HOSTHOST'});
  assert.ok(seated(club, 'ann')?.removing, 'leaving after this hand');
  assert.ok(watch.players.find(p => p.id === 'ann').removing, 'the watcher sees it');
  // Undo: she stays.
  await host.keepPlayer(t.id, 'ann');
  assert.ok(!seated(club, 'ann').removing);
  assert.ok(!watch.players.find(p => p.id === 'ann').removing);
  // Removed again; the hand plays out and she's stood up.
  await host.removePlayer(t.id, 'ann', {by: 'HOSTHOST'});
  assert.equal(seated(club, 'ann').table, t.id, 'still in the hand');
  for (const id of ['ann', 'bob', 'cy']) act(id);
  await until('ann stood up', () => !seated(club, 'ann'));
  const out = club.chips.ledger.filter(e => e.member === 'ann' && e.kind === 'cash_out').at(-1);
  assert.ok(out && out.table === t.id, 'cashed out at Main');
  assert.equal(out.repaid, Math.min(out.amount, 150), 'what she owed is repaid first');
  assert.equal(club.members.ann.balance, out.amount - 150);
  assert.ok(totals(club).conserved, 'every chip accounted for');
  // Her page hears it, with her result.
  const r = await until('her message', () => got.ann.find(u => u.type === 'removed' && u.chips != null));
  assert.equal(r.name, 'Main');
  assert.equal(r.chips, out.amount);
  assert.equal(r.net, out.amount - 100);
  // The log: who removed whom, from where (and when).
  const log = club.log.at(-1);
  assert.equal(log.text, 'The manager removed Ann from Main');
  assert.ok(log.at > 0);
  // The rathole rule applies when she comes back.
  assert.equal(club.members.ann.left[t.id].stack, out.amount);
  await host.close(t.id);
});

test('a removal never takes anyone out of a hand: they finish it (#476)', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, t, host, watch, act, got} = setUp();
  await host.start(t);
  host.watch(t.id, u => { if (u.type === 'state') Object.assign(watch, u); });
  for (const id of ['bob', 'cy', 'dee']) {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: 150});
  }
  await until('a hand in play', () => watch.view && !watch.view.complete && Number(watch.view.hand_number) >= 1);
  const hand = Number(watch.view.hand_number);
  // An older page asking for "now" gets the same: after the hand.
  await host.removePlayer(t.id, 'bob', {now: true, by: 'HOSTHOST'});
  const bobSeat = watch.players.find(p => p.id === 'bob');
  assert.deepEqual([bobSeat.removing, bobSeat.now], [true, undefined]);
  assert.ok(!watch.view.seats[bobSeat.seat].away, 'still in the hand');
  assert.ok(seated(club, 'bob'));
  // Undo is there until the hand ends.
  host.keepPlayer(t.id, 'bob');
  await host.removePlayer(t.id, 'bob', {by: 'HOSTHOST'});
  for (const id of ['bob', 'cy', 'dee']) act(id);
  await until('bob stood up', () => !seated(club, 'bob'));
  assert.ok(Number(watch.view.hand_number) >= hand, 'once that hand was over');
  assert.ok(got.bob.some(u => u.type === 'removed'));
  assert.equal(club.log.at(-1).text, 'The manager removed Bob from Main');
  assert.ok(totals(club).conserved);
  await host.close(t.id);
});

test('between hands a removal is at once, and overrides the hit-and-run rule', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, t, host, got} = setUp();
  await host.start(t);
  await host.handle(t.id, 'bob', {type: 'join'});
  await host.handle(t.id, 'bob', {type: 'request_chips', amount: 150});
  await until('bob seated', () => seated(club, 'bob'));
  // Up at the table by the ledger: the hit-and-run rule refuses his own leave.
  seated(club, 'bob').put = 100;
  await host.handle(t.id, 'bob', {type: 'join'});
  await host.handle(t.id, 'bob', {type: 'leave'});
  await until('his leave refused', () => got.bob.some(u => u.type === 'stay' && u.refused));
  assert.ok(seated(club, 'bob'));
  // The manager's removal overrides it. Alone at the table, no hand: now.
  await host.removePlayer(t.id, 'bob', {by: 'HOSTHOST'});
  await until('bob stood up', () => !seated(club, 'bob'));
  assert.equal(club.members.bob.balance, 1000);
  assert.equal((await until('his message', () => got.bob.find(u => u.type === 'removed'))).net, 50);
  assert.throws(() => host.removePlayer(t.id, 'bob'), /isn’t at that table/);
  await host.close(t.id);
});
