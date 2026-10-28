// The club's activity log: big chip moves (#190), and clubs saved with
// managers, who were removed (#454).
// Run with: node --test test/club-log.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { approve, newClub } from '../src/club.js';
import { newTable } from '../src/club-tables.js';
import { bigMove, dropManagers, isBigMove, logAction, MAX_LOG } from '../src/club-log.js';

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id, status: 'pending', requestedAt: 0};
    approve(club, id, 0);
  }
  return club;
}

test('big chip moves: logged with their amount, measured against the biggest open table (#190)', () => {
  const club = clubWith('ann', 'bob');
  logAction(club, 'HOSTHOST', 'ann joined');
  assert.equal(bigMove(club), null, 'no open table to measure by');
  newTable(club, {sb: 1, bb: 2, maxBB: 100});
  const t = newTable(club, {sb: 5, bb: 10, maxBB: 200});
  assert.equal(bigMove(club), 2000, 'a full buy-in at the biggest table');
  logAction(club, 'HOSTHOST', 'Gave bob 5', 1, 500);
  logAction(club, 'HOSTHOST', 'Gave bob 25', 2, 2500);
  const gives = club.log.filter(l => l.amount != null);
  assert.deepEqual(gives.map(l => l.amount), [500, 2500]);
  assert.deepEqual(gives.map(l => isBigMove(l, bigMove(club))), [false, true]);
  assert.equal(isBigMove(club.log[0], bigMove(club)), false, 'entries without chips never count');
  t.status = 'closed';
  assert.equal(bigMove(club), 200, 'closed tables don’t count');
});

test('the log keeps the last MAX_LOG lines', () => {
  const club = clubWith();
  for (let i = 0; i < MAX_LOG + 5; i++) logAction(club, 'HOSTHOST', `line ${i}`, i);
  assert.equal(club.log.length, MAX_LOG);
  assert.equal(club.log[0].text, 'line 5');
});

test('a club saved with managers: they’re plain members now (#454)', () => {
  const club = clubWith('ann', 'bob', 'cy');
  club.members.ann.role = 'assistant';
  club.members.bob.role = 'offered';
  assert.equal(dropManagers(club), true);
  assert.ok(Object.values(club.members).every(m => !('role' in m)));
  assert.equal(club.members.ann.status, 'member');
  assert.equal(dropManagers(club), false, 'nothing left to change');
});
