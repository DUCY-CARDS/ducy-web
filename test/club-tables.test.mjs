// Club tables (#68): table settings, joining, and chips between the club
// ledger and a table. Run with: node --test test/club-tables.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { approve, newClub } from '../src/club.js';
import { issue, totals } from '../src/club-chips.js';
import {
  buyInRange, canJoin, cashOutEveryone, cashOutTable, chipsForTable, defaultSeats, defaultTableName, leftTable, limits, maxSeats, newTable, openTables, syncStacks,
  tableLedgerN, tablesBody,
} from '../src/club-tables.js';

const H = 3600e3;

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id, status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  return club;
}

test('tables: defaults, validation and what members are told', () => {
  const club = clubWith();
  const t = newTable(club, {game: 'plo4', sb: 1, bb: 2, minBB: 50, maxBB: 100, seats: 6});
  assert.equal(t.name, 'PLO - 0.01/0.02'); // in hundredths: 1/2 is 0.01/0.02
  assert.deepEqual(limits(t), {min: 100, max: 200});
  assert.throws(() => newTable(club, {game: 'stud'}), /Pick a game/);
  assert.throws(() => newTable(club, {sb: 5, bb: 2}), /big blind/);
  assert.throws(() => newTable(club, {minBB: 100, maxBB: 50}), /maximum buy-in/);
  assert.throws(() => newTable(club, {seats: 10}), /2 to 9/);
  newTable(club, {name: 'High stakes', sb: 5, bb: 10});
  const body = tablesBody(club, {[t.id]: 2});
  assert.equal(body.tables.length, 2);
  assert.deepEqual(body.tables[0], {id: t.id, name: 'PLO - 0.01/0.02', game: 'plo4', sb: 1, bb: 2, min: 100, max: 200, seats: 6, taken: 2});
});

test('default names: game and blinds, numbered when an open table has the name', () => {
  const club = clubWith();
  const a = newTable(club, {game: 'nlhe', sb: 100, bb: 200});
  assert.equal(a.name, 'NLH - 1/2');
  assert.equal(newTable(club, {game: 'nlhe', sb: 100, bb: 200}).name, 'NLH - 1/2 - #2');
  assert.equal(newTable(club, {game: 'nlhe', sb: 100, bb: 200}).name, 'NLH - 1/2 - #3');
  assert.equal(newTable(club, {game: 'plo6', sb: 25, bb: 50}).name, 'PLO6 - 0.25/0.5');
  // A closed table's name is free again.
  a.status = 'closed';
  assert.equal(newTable(club, {game: 'nlhe', sb: 100, bb: 200}).name, 'NLH - 1/2');
  assert.equal(defaultTableName(club, 'plo5', 500, 1000), 'PLO5 - 5/10');
  // A name the host gives is kept.
  assert.equal(newTable(club, {name: 'Main', game: 'nlhe', sb: 100, bb: 200}).name, 'Main');
});

test('seats: no more than the game can deal to', () => {
  const club = clubWith();
  assert.equal(maxSeats('plo6'), 6);
  assert.equal(maxSeats('plo5'), 8); // running it twice: 52 − 10 board cards = 42 = 8 × 5 + 2
  assert.equal(maxSeats('nlhe'), 9); // 9-handed at most anywhere
  assert.equal(maxSeats('plo4'), 9);
  assert.throws(() => newTable(club, {game: 'plo6', seats: 9}), /PLO 6-card table seats 2 to 6/);
  assert.throws(() => newTable(club, {game: 'plo5', seats: 9}), /2 to 8/);
  assert.equal(newTable(club, {game: 'plo6', seats: 6}).seats, 6);
  // Each game's usual size: Hold'em 9, PLO 8, PLO5 and PLO6 6.
  assert.equal(newTable(club, {game: 'nlhe'}).seats, 9);
  assert.equal(newTable(club, {game: 'plo4'}).seats, 8);
  assert.equal(newTable(club, {game: 'plo5'}).seats, 6);
  assert.equal(newTable(club, {game: 'plo6'}).seats, 6);
  assert.equal(defaultSeats('plo6'), 6);
});

test('members see the rathole window, and the buy-in it means for them (#187)', () => {
  const club = clubWith();
  club.ratholeHours = 2;
  const t = newTable(club, {game: 'nlhe', sb: 100, bb: 200, minBB: 40, maxBB: 100});
  const body = tablesBody(club);
  assert.equal(body.rathole, 2);
  const seen = body.tables[0];
  const H2 = 2 * 3600e3, now = 10 * H2;
  // Never left it: the table's range.
  assert.deepEqual(buyInRange(seen, [], 2, now), {min: 8000, max: 20000, rathole: 0});
  // Left with 150 an hour ago: at least 150 now; another table's cash-out doesn't count.
  const entries = [
    {kind: 'buy_in', table: t.id, amount: 10000, at: now - H2},
    {kind: 'cash_out', table: t.id, amount: 15000, at: now - H2 / 2},
    {kind: 'cash_out', table: 'other', amount: 19000, at: now - 1000},
  ];
  assert.deepEqual(buyInRange(seen, entries, 2, now), {min: 15000, max: 20000, rathole: 15000});
  // After the window, or with the rule off: back to the table's range.
  assert.equal(buyInRange(seen, entries, 2, now + H2).min, 8000);
  assert.equal(buyInRange(seen, entries, 0, now).min, 8000);
  // Never above the table's maximum.
  assert.equal(buyInRange(seen, [{kind: 'cash_out', table: t.id, amount: 50000, at: now}], 2, now).min, 20000);
});

test('who can join: members only, open tables only, one table at a time', () => {
  const club = clubWith('ann');
  const t1 = newTable(club), t2 = newTable(club);
  assert.equal(canJoin(club, 'ann', t1), '');
  assert.match(canJoin(club, 'eve', t1), /members/);
  assert.match(canJoin(club, 'ann', t1, t2.id), /another table/);
  chipsForTable(club, 'ann', t1, 100);
  assert.match(canJoin(club, 'ann', t2), /another table/);
  t2.status = 'closing';
  assert.match(canJoin(club, 'bob', t2), /members/);
  club.members.bob = {id: 'bob', status: 'member', balance: 0};
  assert.match(canJoin(club, 'bob', t2), /isn’t open/);
});

test('buy in, play, top up, leave: the club ledger follows the table and adds up', () => {
  const club = clubWith('ann', 'bob');
  const t = newTable(club, {sb: 1, bb: 2, minBB: 40, maxBB: 100}); // 80 to 200 chips
  assert.equal(chipsForTable(club, 'ann', t, 150, 1).kind, 'buy_in');
  assert.equal(chipsForTable(club, 'bob', t, 200, 1).kind, 'buy_in');
  assert.ok(totals(club).conserved);
  // A hand: Ann wins 60. The ledger catches up between hands.
  syncStacks(club, [{client_id: 'ann', chips: 210}, {client_id: 'bob', chips: 140}]);
  assert.ok(totals(club).conserved);
  assert.equal(chipsForTable(club, 'bob', t, 60, 2).kind, 'top_up');
  assert.equal(club.members.bob.balance, 740);
  // Bob leaves with what the engine says he took.
  const e = leftTable(club, 'bob', 200, 3);
  assert.equal(e.kind, 'cash_out');
  assert.equal(club.members.bob.balance, 940);
  assert.equal(club.members.bob.seat, null);
  assert.ok(totals(club).conserved);
  assert.equal(leftTable(club, 'bob', 0), null, 'only once');
});

test('the rathole rule applies when buying back in at the same table', () => {
  const club = clubWith('ann');
  const t = newTable(club, {sb: 1, bb: 2, minBB: 40, maxBB: 200});
  chipsForTable(club, 'ann', t, 100, 0);
  leftTable(club, 'ann', 300, 10);
  assert.throws(() => chipsForTable(club, 'ann', t, 100, 10 + H), /at least that/);
  assert.equal(chipsForTable(club, 'ann', t, 300, 10 + H).kind, 'buy_in');
});

test('a buy-in beyond the club balance is refused', () => {
  const club = clubWith('ann');
  const t = newTable(club, {sb: 50, bb: 100, minBB: 20, maxBB: 100});
  assert.throws(() => chipsForTable(club, 'ann', t, 2000), /You have 10 chips/);
  assert.equal(club.members.ann.seat, null);
});

test('when the host’s page comes back, everyone seated is cashed out with their last stack', () => {
  const club = clubWith('ann', 'bob');
  const t = newTable(club);
  chipsForTable(club, 'ann', t, 100);
  chipsForTable(club, 'bob', t, 100);
  syncStacks(club, [{client_id: 'ann', chips: 130}, {client_id: 'bob', chips: 70}]);
  t.status = 'closing';
  const out = cashOutEveryone(club);
  assert.equal(out.length, 2);
  assert.equal(club.members.ann.balance, 1030);
  assert.equal(club.members.bob.balance, 970);
  assert.equal(t.status, 'closed');
  assert.equal(openTables(club).length, 0);
  assert.ok(totals(club).conserved);
});

test('sit-out limit: per table, defaulting to the club setting (10 minutes)', () => {
  const club = clubWith();
  assert.equal(newTable(club).sitOutMins, 10);
  club.sitOutMins = 30;
  assert.equal(newTable(club).sitOutMins, 30);
  assert.equal(newTable(club, {sitOutMins: 0}).sitOutMins, 0, 'no limit');
  assert.throws(() => newTable(club, {sitOutMins: -1}), /sit-out limit/);
});

test('resuming tables (#107): cash out everyone but the tables that may resume, and each ledger step', () => {
  const club = clubWith('ann', 'bob', 'cy');
  const a = newTable(club, {name: 'A'});
  const b = newTable(club, {name: 'B'});
  assert.equal(tableLedgerN(club, a.id), 0);
  chipsForTable(club, 'ann', a, 100, 0);
  chipsForTable(club, 'bob', a, 100, 0);
  chipsForTable(club, 'cy', b, 100, 0);
  const n = tableLedgerN(club, a.id);
  assert.ok(n > 0);
  // Other tables' entries don't move table A's step.
  chipsForTable(club, 'cy', b, 20, 0);
  assert.equal(tableLedgerN(club, a.id), n);
  chipsForTable(club, 'ann', a, 20, 0);
  assert.ok(tableLedgerN(club, a.id) > n, 'a top-up at A does');
  // The page reopens: A may resume; B's people are cashed out.
  const out = cashOutEveryone(club, 0, new Set([a.id]));
  assert.deepEqual(out.map(e => e.member), ['cy']);
  assert.equal(club.members.ann.seat.table, a.id);
  // A can't resume after all.
  assert.deepEqual(cashOutTable(club, a.id, 0).map(e => e.member).sort(), ['ann', 'bob']);
  assert.ok(Object.values(club.members).every(m => !m.seat));
  assert.ok(totals(club).conserved);
});

test('a closing table kept for resuming stays closing; others that were closing close (#117)', () => {
  const club = clubWith();
  const a = newTable(club, {name: 'A'}), b = newTable(club, {name: 'B'});
  a.status = 'closing';
  b.status = 'closing';
  cashOutEveryone(club, 0, new Set([a.id]));
  assert.equal(a.status, 'closing', 'A may still finish its hand');
  assert.equal(b.status, 'closed');
});

test('a top-up the table hands back returns to the balance, and the totals still add up (ducy#118)', async () => {
  const {refundTopUp} = await import('../src/club-chips.js');
  const {tableSessions} = await import('../src/hand-replay.js');
  const club = clubWith('ann', 'bob');
  const t = newTable(club, {name: 'T', sb: 1, bb: 2, minBB: 40, maxBB: 100}); // buy-ins up to 200
  chipsForTable(club, 'ann', t, 150, 0);
  chipsForTable(club, 'bob', t, 150, 0);
  // Ann asks to top up 50 during a hand, then wins 30 from Bob: at the deal
  // only 20 fits under 200, and the table hands back 30.
  chipsForTable(club, 'ann', t, 50, 0);
  const before = club.members.ann.balance;
  refundTopUp(club, 'ann', 30, 1);
  assert.equal(club.members.ann.balance, before + 30);
  syncStacks(club, [{client_id: 'ann', chips: 200}, {client_id: 'bob', chips: 120}]);
  assert.ok(totals(club).conserved, 'every chip accounted for');
  const s = tableSessions(club.chips.ledger).find(x => x.member === 'ann');
  assert.equal(s.put, 170, 'the session counts only what stayed on the table');
});
