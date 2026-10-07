// Club tables (#68): table settings, joining, and chips between the club
// ledger and a table. Run with: node --test test/club-tables.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { approve, newClub } from '../src/club.js';
import { issue, totals } from '../src/club-chips.js';
import {
  canJoin, cashOutEveryone, chipsForTable, leftTable, limits, newTable, openTables, syncStacks, tablesBody,
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
  assert.equal(t.name, 'Table 1');
  assert.deepEqual(limits(t), {min: 100, max: 200});
  assert.throws(() => newTable(club, {game: 'stud'}), /Pick a game/);
  assert.throws(() => newTable(club, {sb: 5, bb: 2}), /big blind/);
  assert.throws(() => newTable(club, {minBB: 100, maxBB: 50}), /maximum buy-in/);
  assert.throws(() => newTable(club, {seats: 11}), /2 to 10/);
  newTable(club, {name: 'High stakes', sb: 5, bb: 10});
  const body = tablesBody(club, {[t.id]: 2});
  assert.equal(body.tables.length, 2);
  assert.deepEqual(body.tables[0], {id: t.id, name: 'Table 1', game: 'plo4', sb: 1, bb: 2, min: 100, max: 200, seats: 6, taken: 2});
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
  assert.throws(() => chipsForTable(club, 'ann', t, 2000), /You have 1,?000/);
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
