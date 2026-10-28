// Moving to another table (#425): a player at one table reserves a seat at
// another; it's held for them (no one else takes it) for a while, they
// leave their table after the hand as usual (cash-out, the rathole rule,
// the hit-and-run rule) and sit down there with the usual buy-in. A
// manager can move them. Real club tables (club-host.js and ducy's
// engine). Needs the wasm build in wasm/.
// Run with: node --test test/move-table.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue, reclaim, totals } = await import('../src/club-chips.js');
const { newTable, reservationOf, reservations } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 30_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const PEOPLE = ['ann', 'bob', 'cy', 'dee', 'eve'];

// A club with Main (6 seats), Side (2 seats) and Big.
function newClubWithTables() {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of PEOPLE) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0});
  newTable(club, {name: 'Side', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 2, turnSecs: 0});
  // Big's minimum, 1000, is everything each of them has.
  newTable(club, {name: 'Big', sb: 10, bb: 25, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0});
  return club;
}

// A host for `club`, its tables saved in `store` (a Map). Each player acts
// (check or call) only while `acting` says so, so a hand can be held.
function hostFor(club, {store = new Map(), holdMs = 60_000} = {}) {
  const [main, side, big] = club.tables;
  const engine = clubEngine();
  const acting = new Set();
  const got = Object.fromEntries(PEOPLE.map(id => [id, []]));
  const last = {};
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = {...msg.update, table: msg.table};
    got[to]?.push(u);
    if (u.type === 'state') last[`${to}|${msg.table}`] = u;
    if (u.type === 'state' && acting.has(to) && u.view.legal && !u.view.complete) {
      host.handle(msg.table, to, {type: 'act', seq: u.seq, kind: u.view.legal.can_check ? 'check' : 'call', amount: 0});
    }
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {}, onHand() {},
    call: async (op, ...args) => engine.ops[op](...args),
    store: {get: async (c, t) => store.get(t) || null, put: async (c, t, rec) => { store.set(t, rec); }, drop: async (c, t) => { store.delete(t); }},
    holdMs,
  });
  const act = id => {
    acting.add(id);
    for (const [k, u] of Object.entries(last)) if (k.startsWith(`${id}|`)) deliver(id, {table: u.table, update: u});
  };
  return {club, main, side, big, host, got, act, acting, store};
}

const seated = (club, id) => club.members[id].seat;
async function sit(host, tid, id, amount = 150) {
  await host.handle(tid, id, {type: 'join'});
  await host.handle(tid, id, {type: 'request_chips', amount});
}
const moved = (got, id) => got[id].find(u => u.type === 'moved');

test('between hands: the seat is held, they leave at once, and sit down there with the usual buy-in', {skip: !haveWasm && 'no wasm build'}, async () => {
  const club = newClubWithTables();
  const {main, side, host, got} = hostFor(club);
  await host.start(main);
  await host.start(side);
  await sit(host, main.id, 'bob');
  await sit(host, side.id, 'dee');
  await until('both seated', () => seated(club, 'bob') && seated(club, 'dee'));
  // Bob, alone at Main (no hand), reserves the last seat at Side.
  await host.handle(side.id, 'bob', {type: 'reserve'});
  const r = await until('his message', () => moved(got, 'bob'));
  assert.equal(r.to, side.id);
  assert.equal(r.name, 'Side');
  assert.equal(r.chips, 150);
  // The usual leave: cashed out at Main, the rathole rule there.
  assert.equal(seated(club, 'bob'), null);
  assert.equal(club.members.bob.balance, 1000);
  assert.equal(club.members.bob.left[main.id].stack, 150);
  assert.ok(club.chips.ledger.some(e => e.member === 'bob' && e.kind === 'cash_out' && e.table === main.id));
  assert.ok(!club.chips.ledger.some(e => e.kind === 'move'), 'no move entry: a leave and a join');
  // Side is full meanwhile: Dee and Bob's held seat.
  assert.equal(host.seatedCounts()[side.id], 2);
  await host.handle(side.id, 'eve', {type: 'join'});
  assert.ok((await until('eve refused', () => got.eve.find(u => u.type === 'rejected'))).reason.includes('full'));
  // Bob sits in it, buying in as usual.
  await sit(host, side.id, 'bob', 120);
  await until('bob at Side', () => seated(club, 'bob')?.table === side.id);
  assert.equal(seated(club, 'bob').stack, 120);
  assert.ok(club.chips.ledger.some(e => e.member === 'bob' && e.kind === 'buy_in' && e.table === side.id && e.amount === 120));
  assert.equal(reservationOf(club, side.id, 'bob'), null, 'the hold is used up');
  assert.equal(host.seatedCounts()[side.id], 2);
  assert.ok(totals(club).conserved);
  await host.close(main.id);
  await host.close(side.id);
  assert.ok(totals(club).conserved);
});

test('not in a hand: the time to sit down starts at once, and the hold lapses after it', {skip: !haveWasm && 'no wasm build'}, async () => {
  const club = newClubWithTables();
  const {main, side, host, got} = hostFor(club, {holdMs: 400});
  await host.start(main);
  await host.start(side);
  await sit(host, main.id, 'bob');
  await sit(host, side.id, 'dee');
  await until('both seated', () => seated(club, 'bob') && seated(club, 'dee'));
  const at = Date.now();
  await host.handle(side.id, 'bob', {type: 'reserve'});
  await until('his message', () => moved(got, 'bob'));
  const e = reservationOf(club, side.id, 'bob');
  assert.ok(e.until - at <= 400 + 100, 'held from reserving');
  assert.equal(host.seatedCounts()[side.id], 2);
  await until('the hold lapsed', () => !club.waitlist?.[side.id], 3000);
  assert.ok(Date.now() - at >= 400);
  assert.equal(host.seatedCounts()[side.id], 1);
  // Lapsed: he sits like anyone else, while there's a seat.
  await sit(host, side.id, 'bob');
  await until('bob at Side', () => seated(club, 'bob')?.table === side.id);
  assert.ok(totals(club).conserved);
  await host.close(main.id);
  await host.close(side.id);
});

test('in a hand: the seat is held until it’s over, and the time to sit down starts then', {skip: !haveWasm && 'no wasm build'}, async () => {
  const club = newClubWithTables();
  const {main, side, host, got, act} = hostFor(club, {holdMs: 300});
  await host.start(main);
  await host.start(side);
  for (const id of ['ann', 'bob', 'cy']) await sit(host, main.id, id);
  await sit(host, side.id, 'dee');
  const watch = {};
  host.watch(main.id, u => { if (u.type === 'state') Object.assign(watch, u); });
  await until('a hand in play', () => watch.view && !watch.view.complete && Number(watch.view.hand_number) >= 1);
  await host.handle(side.id, 'bob', {type: 'reserve'});
  assert.ok(got.bob.some(u => u.type === 'reserve' && u.name === 'Side' && !u.refused));
  assert.equal(seated(club, 'bob').moving.to, side.id);
  assert.equal(watch.players.find(p => p.id === 'bob').moving, side.id, 'the manager watching sees it');
  // Past the hold, still in his hand: it's kept.
  await sleep(500);
  assert.ok(reservationOf(club, side.id, 'bob'), 'held while he finishes his hand');
  assert.equal(seated(club, 'bob').table, main.id);
  for (const id of ['ann', 'bob', 'cy']) act(id);
  await until('his message', () => moved(got, 'bob'));
  const left = Date.now();
  assert.equal(seated(club, 'bob'), null);
  const e = reservationOf(club, side.id, 'bob');
  assert.ok(e, 'still held after he left');
  assert.ok(e.until >= left + 300 - 100, 'his time to sit down starts when he leaves');
  // He doesn't sit: it lapses, and the seat is free again.
  await until('the hold lapsed', () => !reservations(club, side.id).length && !club.waitlist?.[side.id]);
  assert.equal(host.seatedCounts()[side.id], 1);
  await sit(host, side.id, 'eve');
  await until('eve at Side', () => seated(club, 'eve')?.table === side.id);
  assert.ok(totals(club).conserved);
  await host.close(main.id);
  await host.close(side.id);
});

test('the hit-and-run rule stops a move as it stops leaving; a manager’s move overrides it and is logged', {skip: !haveWasm && 'no wasm build'}, async () => {
  const club = newClubWithTables();
  const {main, side, host, got} = hostFor(club);
  main.stayHands = 5;
  await host.start(main);
  await host.start(side);
  await sit(host, main.id, 'bob');
  await until('bob seated', () => seated(club, 'bob'));
  // Up at Main by the ledger: he owes hands.
  seated(club, 'bob').put = 100;
  await host.handle(main.id, 'bob', {type: 'join'});
  await host.handle(side.id, 'bob', {type: 'reserve'});
  const r = await until('refused', () => got.bob.find(u => u.type === 'reserve' && u.refused));
  assert.match(r.refused, /play 5 more hands/);
  assert.equal(reservationOf(club, side.id, 'bob'), null);
  assert.ok(!seated(club, 'bob').moving);
  // The manager can move him.
  await host.movePlayer(main.id, 'bob', side.id, {by: 'HOSTHOST'});
  await until('his message', () => moved(got, 'bob'));
  assert.equal(club.log.at(-1).text, 'The manager moved Bob from Main to Side');
  assert.equal(club.log.at(-1).by, 'HOSTHOST');
  assert.ok(reservationOf(club, side.id, 'bob'));
  assert.ok(club.chips.ledger.some(e => e.member === 'bob' && e.kind === 'cash_out' && e.amount === 150));
  assert.ok(totals(club).conserved);
  // The owner's move, between hands, is the manager's.
  await sit(host, side.id, 'bob');
  await until('bob at Side', () => seated(club, 'bob')?.table === side.id);
  await host.movePlayer(side.id, 'bob', main.id);
  await until('back at Main’s door', () => got.bob.filter(u => u.type === 'moved').length === 2);
  assert.equal(club.log.at(-1).text, 'The manager moved Bob from Side to Main');
  assert.ok(totals(club).conserved);
  await host.close(main.id);
  await host.close(side.id);
});

test('too little to buy in there: refused at once, or, short after the hand, they stay where they are', {skip: !haveWasm && 'no wasm build'}, async () => {
  const club = newClubWithTables();
  const {main, big, host, got, act} = hostFor(club);
  await host.start(main);
  await host.start(big);
  for (const id of ['ann', 'bob', 'cy']) await sit(host, main.id, id);
  const watch = {};
  host.watch(main.id, u => { if (u.type === 'state') Object.assign(watch, u); });
  await until('a hand in play', () => watch.view && !watch.view.complete && Number(watch.view.hand_number) >= 1);
  // Ann gave chips away: 999 is less than Big's 1000.
  reclaim(club, 'ann', 1);
  await host.handle(big.id, 'ann', {type: 'reserve'});
  assert.equal((await until('refused', () => got.ann.find(u => u.type === 'reserve' && u.refused))).refused, 'Not enough for Big · Staying here');
  assert.equal(reservationOf(club, big.id, 'ann'), null);
  // The manager can't either.
  assert.throws(() => host.movePlayer(main.id, 'ann', big.id), /Not enough for Big/);
  // Bob has 1000 in all: the seat is held. Cy is moved by the manager.
  await host.handle(big.id, 'bob', {type: 'reserve'});
  await host.movePlayer(main.id, 'cy', big.id, {by: 'HOSTHOST'});
  assert.ok(reservationOf(club, big.id, 'bob') && reservationOf(club, big.id, 'cy'));
  // Then each has less (as if they'd lost a pot; more than this hand's pot,
  // checked and called down, could win back): when it's over, they stay.
  reclaim(club, 'bob', 50);
  reclaim(club, 'cy', 50);
  for (const id of ['ann', 'bob', 'cy']) act(id);
  await until('both refused', () => ['bob', 'cy'].every(id => got[id].some(u => u.type === 'reserve' && u.refused)));
  for (const id of ['bob', 'cy']) {
    assert.equal(got[id].find(u => u.type === 'reserve' && u.refused).refused, 'Not enough for Big · Staying here');
    assert.equal(seated(club, id).table, main.id, 'still at Main');
    assert.ok(!seated(club, id).moving);
    assert.equal(reservationOf(club, big.id, id), null);
    assert.ok(!moved(got, id));
  }
  assert.ok(!club.chips.ledger.some(e => e.kind === 'cash_out'), 'no one stood up');
  assert.equal(host.seatedCounts()[big.id], 0);
  assert.ok(totals(club).conserved);
  await host.close(main.id);
  await host.close(big.id);
});

test('a full table can’t be reserved; nor can your own',{skip: !haveWasm && 'no wasm build'}, async () => {
  const club = newClubWithTables();
  const {main, side, host, got} = hostFor(club);
  await host.start(main);
  await host.start(side);
  await sit(host, main.id, 'ann');
  await sit(host, side.id, 'dee');
  await sit(host, side.id, 'eve');
  await until('seated', () => seated(club, 'ann') && seated(club, 'eve'));
  await host.handle(side.id, 'ann', {type: 'reserve'});
  assert.match((await until('refused', () => got.ann.find(u => u.type === 'reserve' && u.refused))).refused, /full/);
  assert.throws(() => host.reserve(main.id, 'ann'), /at that table already/);
  assert.equal(seated(club, 'ann').table, main.id);
  await host.close(main.id);
  await host.close(side.id);
});

test('a restart mid-move: the resumed table finishes the hand, and they leave for the seat still held', {skip: !haveWasm && 'no wasm build'}, async () => {
  const club = newClubWithTables();
  const one = hostFor(club);
  const {main, side} = one;
  await one.host.start(main);
  await one.host.start(side);
  for (const id of ['ann', 'bob', 'cy']) await sit(one.host, main.id, id);
  const watch = {};
  one.host.watch(main.id, u => { if (u.type === 'state') Object.assign(watch, u); });
  await until('a hand in play', () => watch.view && !watch.view.complete && Number(watch.view.hand_number) >= 1);
  await one.host.handle(side.id, 'bob', {type: 'reserve'});
  await sleep(100);
  // The club stops here: what was saved is what the next start has.
  const saved = JSON.parse(JSON.stringify(club));
  const two = hostFor(saved, {store: new Map(one.store)});
  await one.host.close(main.id);
  await one.host.close(side.id);
  await two.host.start(saved.tables[0], {resume: true});
  await two.host.start(saved.tables[1], {resume: true});
  assert.equal(seated(saved, 'bob').table, main.id, 'still at Main, his hand resumed');
  assert.equal(seated(saved, 'bob').moving.to, side.id);
  assert.ok(reservationOf(saved, side.id, 'bob'));
  for (const id of ['ann', 'bob', 'cy']) await two.host.handle(main.id, id, {type: 'join'});
  for (const id of ['ann', 'bob', 'cy']) two.act(id);
  await until('his message', () => moved(two.got, 'bob'));
  assert.equal(seated(saved, 'bob'), null);
  await sit(two.host, side.id, 'bob');
  await until('bob at Side', () => seated(saved, 'bob')?.table === side.id);
  assert.ok(totals(saved).conserved);
  await two.host.close(main.id);
  await two.host.close(side.id);
  assert.ok(totals(saved).conserved);
});
