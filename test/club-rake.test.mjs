// Rake and time at a club's cash tables (#449): the table's setting, ducy's
// engine taking it from each hand in the host (src/club-host.js), each
// player's share booked and in the ledger when they leave, the books still
// adding up, and what the owner, agents and the hand log show. Needs the
// wasm build in wasm/.
// Run with: node --test test/club-rake.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue, totals } = await import('../src/club-chips.js');
const { newTable } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');
const { contributions } = await import('../src/club-agents.js');
const { handRecord, replayFrames } = await import('../src/hand-replay.js');
const { handText } = await import('../src/replayer.js');
const { chargeSpec, chargeText, contributionsHtml, readCharge } = await import('../src/club-rake.js');
const { ledgerView } = await import('../src/club-money.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 20_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function clubWith(ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 100_000, 0);
  }
  return club;
}

// Runs table `t` with everyone seated for `buyIn`, each acting by `play(id,
// legal)`; the host's hand views go to `hands`.
async function running(tc, club, t, ids, buyIn, play) {
  const engine = clubEngine();
  const hands = [];
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = msg.update;
    if (u.type === 'state' && u.view.legal && !u.view.complete) host.handle(t.id, to, {type: 'act', seq: u.seq, ...play(to, u.view.legal)});
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {},
    onHand: (tid, view) => hands.push(view),
    call: async (op, ...args) => engine.ops[op](...args), nextHandMs: 50,
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  await host.start(t);
  tc.after(() => host.close(t.id));
  for (const id of ids) {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: buyIn});
    await until(`${id} seated`, () => club.members[id].seat?.stack === buyIn);
  }
  return {host, hands};
}

// Every chip is somewhere, and the rake adds up: what each player paid is
// the house's ledger entries plus what's on their seats.
function addsUp(club) {
  assert.ok(totals(club).conserved, JSON.stringify(totals(club)));
  const booked = Object.values(club.rakeBook?.total || {}).reduce((s, x) => s + x, 0);
  const house = ledgerView(club).filter(e => e.kind === 'rake').reduce((s, e) => s + e.amount, 0);
  const seated = Object.values(club.members).reduce((s, m) => s + (m.seat?.rake || 0), 0);
  assert.equal(booked, house + seated);
  return booked;
}

test('a raked table takes its share of each pot, and each player’s goes in the ledger when they leave', {skip: !haveWasm && 'no wasm build'}, async tc => {
  const club = clubWith(['ann', 'bob']);
  // 1/2, 10% capped at 6, raked before the flop too.
  const t = newTable(club, {name: 'Main', sb: 100, bb: 200, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0, rake: {percent: 1000, cap: 600, noFlop: false}});
  assert.deepEqual(t.charge, {percent: 1000, cap: 600, noFlop: false, time: 0});
  // Everyone all in, every hand: a 400 pot, 6 of it the club's, 3 from each.
  const {host, hands} = await running(tc, club, t, ['ann', 'bob'], 20_000, (id, legal) => (legal.call != null && legal.raise == null ? {kind: 'call', amount: 0} : {kind: 'allin', amount: 0}));
  const view = await until('a hand over', () => hands[0]);
  assert.equal(view.rake, 600);
  assert.deepEqual(view.seats.filter(s => s.rake).map(s => s.rake), [300, 300]);
  assert.ok(view.events.some(e => e.type === 'rake' && e.amount === 600));
  // Stood up: one has nothing left, the other everything less the rake.
  for (const id of ['ann', 'bob']) await host.handle(t.id, id, {type: 'leave'});
  await until('both stood up', () => !club.members.ann.seat && !club.members.bob.seat);
  assert.equal(club.members.ann.balance + club.members.bob.balance, 200_000 - 600 * hands.length);
  const paid = ledgerView(club).filter(e => e.kind === 'rake');
  assert.deepEqual(paid.map(e => e.from).sort(), ['ann', 'bob']);
  assert.ok(paid.every(e => e.member === 'house' && e.about === t.id));
  assert.equal(addsUp(club), 600 * hands.length);

  // The owner sees what each paid.
  const c = contributions(club);
  assert.equal(c.totals.all, 600 * hands.length);
  assert.deepEqual(c.players.map(p => p.all), [300 * hands.length, 300 * hands.length]);
  const html = contributionsHtml(c);
  assert.match(html, /Rake and time/);
  assert.match(html, /Ann/);

  // The hand log and replay show it.
  const rec = handRecord({club: club.code, table: t.id, tableName: 'Main', game: 'nlhe', view, who: 'host'});
  assert.equal(rec.rake, 600);
  const frames = replayFrames(rec);
  assert.ok(frames.some(f => f.text === 'Rake 6'));
  assert.match(handText(rec, frames), /Total pot 400 \| Rake 6/);
});

test('a table charging time takes it from each player dealt in, every hand', {skip: !haveWasm && 'no wasm build'}, async tc => {
  const club = clubWith(['ann', 'bob']);
  const t = newTable(club, {name: 'Timed', sb: 100, bb: 200, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0, time: 50});
  // The small blind folds every hand: the blinds go back and forth.
  const {host, hands} = await running(tc, club, t, ['ann', 'bob'], 20_000, (id, legal) => (legal.can_check ? {kind: 'check', amount: 0} : {kind: 'fold', amount: 0}));
  await until('three hands', () => hands.length >= 3);
  const view = hands[0];
  assert.deepEqual(view.events.filter(e => e.type === 'time').map(e => e.amount), [50, 50]);
  assert.equal(view.rake, 100);
  for (const id of ['ann', 'bob']) await host.handle(t.id, id, {type: 'leave'});
  await until('both stood up', () => !club.members.ann.seat && !club.members.bob.seat);
  assert.equal(addsUp(club), 100 * hands.length);
  assert.equal(club.members.ann.balance + club.members.bob.balance, 200_000 - 100 * hands.length);
});

test('a table takes rake or time, never both, within its limits', {skip: !haveWasm && 'no wasm build'}, () => {
  const club = clubWith([]);
  const bad = spec => assert.throws(() => newTable(club, {sb: 100, bb: 200, ...spec}));
  bad({rake: {percent: 500}, time: 100});
  bad({rake: {percent: 1500}});
  bad({time: 10_000_000});
  const none = newTable(club, {sb: 100, bb: 200});
  assert.equal(none.charge, undefined);
});

test('the form’s choices, and what members are told', () => {
  const form = (house, extra = {}) => ({elements: {house: {value: house}, rakePct: {value: '500'}, rakeCap: {value: '3'}, noFlop: {checked: true}, timeBB: {value: '0.5'}, ...extra}});
  assert.deepEqual(readCharge(form('rake'), 200).spec, {rake: {percent: 500, cap: 600, noFlop: true}});
  assert.deepEqual(readCharge(form('rake', {rakeCap: {value: '0'}}), 200).spec, {rake: {percent: 500, cap: 0, noFlop: true}});
  assert.deepEqual(readCharge(form('time'), 200).spec, {time: 100});
  assert.deepEqual(readCharge(form('none'), 200).spec, {});
  assert.equal(chargeText({rake: {percent: 500, cap: 600, noFlop: true}}), 'Rake 5% · cap 6 · no flop, no drop');
  assert.equal(chargeText({charge: {percent: 250, cap: 0, noFlop: false}}), 'Rake 2.5%');
  assert.equal(chargeText({time: 100}), 'Time 1 a hand');
  assert.equal(chargeText({}), '');
  assert.deepEqual(chargeSpec({percent: 500, cap: 600, noFlop: true, time: 0}), {rake: {percent: 500, cap: 600, noFlop: true}});
  assert.deepEqual(chargeSpec({time: 50}), {time: 50});
  assert.deepEqual(chargeSpec(undefined), {});
  assert.equal(contributionsHtml({players: []}), '');
});
