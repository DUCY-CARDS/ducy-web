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
const { chargeText, clubChargeHtml, contributionsHtml, readCharge } = await import('../src/club-rake.js');
const { command } = await import('../src/club-commands.js');
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
  // 1/2, 10% capped at 3 BB (6).
  const t = newTable(club, {name: 'Main', sb: 100, bb: 200, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0, charge: {percent: 1000, capBB: 300}});
  assert.deepEqual(t.charge, {percent: 1000, capBB: 300, timeBB: 0});
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
  // ¼ BB a hand: 0.50 at 1/2.
  const t = newTable(club, {name: 'Timed', sb: 100, bb: 200, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0, charge: {timeBB: 25}});
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

test('the club’s rake is new tables’, unless a table sets its own, within the limits', {skip: !haveWasm && 'no wasm build'}, () => {
  const club = clubWith([]);
  // None to start.
  assert.equal(newTable(club, {sb: 100, bb: 200}).charge, undefined);
  command(club, 'settings', {charge: {percent: 450, capBB: 250}});
  assert.deepEqual(club.charge, {percent: 450, capBB: 250, timeBB: 0});
  assert.deepEqual(newTable(club, {sb: 100, bb: 200}).charge, club.charge);
  assert.deepEqual(newTable(club, {sb: 100, bb: 200, charge: {timeBB: 20}}).charge, {percent: 0, capBB: 0, timeBB: 20});
  assert.equal(newTable(club, {sb: 100, bb: 200, charge: null}).charge, undefined);
  const bad = charge => assert.throws(() => newTable(club, {sb: 100, bb: 200, charge}));
  bad({percent: 500, timeBB: 10});
  bad({percent: 1001});
  bad({timeBB: 26});
  bad({timeBB: 4});
  assert.throws(() => command(club, 'settings', {charge: {timeBB: 50}}), /0\.05 to 0\.25/);
  command(club, 'settings', {charge: null});
  assert.equal(club.charge, undefined);
});

test('the fields, and what members and the owner are told', () => {
  const form = (house, extra = {}) => ({elements: {house: {value: house}, rakePct: {value: '4.5'}, rakeCap: {value: '3'}, timeBB: {value: '0.25'}, ...extra}});
  assert.deepEqual(readCharge(form('rake')), {charge: {percent: 450, capBB: 300, timeBB: 0}});
  assert.deepEqual(readCharge(form('rake', {rakeCap: {value: ''}})), {charge: {percent: 450, capBB: 0, timeBB: 0}});
  assert.deepEqual(readCharge(form('time')), {charge: {percent: 0, capBB: 0, timeBB: 25}});
  assert.deepEqual(readCharge(form('none')), {charge: null});
  assert.match(readCharge(form('rake', {rakePct: {value: '12'}})).error, /at most 10%/);
  assert.match(readCharge(form('rake', {rakePct: {value: '0'}})).error, /more than 0%/);
  assert.match(readCharge(form('rake', {rakeCap: {value: '-1'}})).error, /cap/);
  assert.match(readCharge(form('time', {timeBB: {value: '0.5'}})).error, /0\.05 to 0\.25/);
  assert.match(readCharge(form('time', {timeBB: {value: '0.04'}})).error, /0\.05 to 0\.25/);
  assert.deepEqual(readCharge(form('time', {timeBB: {value: '0.05'}})), {charge: {percent: 0, capBB: 0, timeBB: 5}});
  assert.equal(chargeText({charge: {percent: 500, capBB: 300}}), 'Rake 5% · cap 3 BB');
  assert.equal(chargeText({charge: {percent: 250, capBB: 0}}), 'Rake 2.5%');
  assert.equal(chargeText({charge: {timeBB: 25}}), 'Time 0.25 BB a hand');
  assert.equal(chargeText({}), '');
  assert.match(clubChargeHtml({charge: {percent: 500, capBB: 300}}), /Rake 5% · cap 3 BB/);
  assert.match(clubChargeHtml({}), /No rake/);
  assert.equal(contributionsHtml({players: []}), '');
});
