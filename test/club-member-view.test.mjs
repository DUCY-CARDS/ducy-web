// What a member sees of their chips (#398, #404, src/club-member-view.js):
// a table session as one line, and the result when they stand up.
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { chipLines, leftSummary } from '../src/club-member-view.js';
import { buyIn, cashOut, ensureChips, issue, setStack, topUp } from '../src/club-chips.js';
import { setCredit, settleDebt } from '../src/club-credit.js';

const L = {min: 8000, max: 20_000};

test('a credit player’s chips: sessions as lines, a debt settled', () => {
  const c = ensureChips({code: 'C', hostId: 'h', members: {ann: {id: 'ann', name: 'Ann', status: 'member'}, bo: {id: 'bo', name: 'Bo', status: 'member'}}});
  issue(c, 'bo', 100_000, 1);
  issue(c, 'ann', 5000, 2);
  setCredit(c, 'ann', 50_000);
  // Sits with 200 (50 own + 150 credit), tops up 100, stands up with 80: down 220, owes 170.
  buyIn(c, 'ann', 'main', 20_000, L, 10);
  setStack(c, 'ann', 0);
  topUp(c, 'ann', 10_000, 20_000, 11); // (50 own, 250 on credit in all)
  setStack(c, 'ann', 8000);
  cashOut(c, 'ann', 20);
  const out = c.chips.ledger.at(-1).n;
  // Back at it, still seated.
  buyIn(c, 'ann', 'plo', 10_000, L, 30);
  const mine = () => c.chips.ledger.filter(e => e.member === 'ann');
  assert.deepEqual(chipLines(mine()).map(l => [l.kind, l.table ?? '', l.amount, l.balance]), [
    ['at', 'plo', -10_000, -27_000],
    ['left', 'main', -22_000, -17_000],
    ['issue', '', 5000, 5000],
  ]);
  assert.deepEqual(leftSummary(mine(), out), {table: 'main', net: -22_000, balance: -17_000, owes: 17_000});
  assert.equal(leftSummary(mine(), 999), null);
  // Stands up from PLO with 150: still owes 120; the manager records 100 settled.
  setStack(c, 'ann', 15_000);
  cashOut(c, 'ann', 40);
  settleDebt(c, 'ann', 10_000, 50, 'Cash');
  const lines = chipLines(mine());
  assert.deepEqual(lines.slice(0, 2).map(l => [l.kind, l.amount, l.balance, l.note ?? '']), [['settle', 10_000, -2000, 'Cash'], ['left', 5000, -12_000, '']]);
});

test('a top-up handed back belongs to its session, and one with none is skipped', () => {
  const entries = [
    {n: 1, kind: 'issue', amount: 50_000, balance: 50_000, at: 1},
    {n: 2, kind: 'top_up_refund', amount: 100, balance: 50_100, at: 2},
    {n: 3, kind: 'buy_in', table: 't', amount: 20_000, balance: 30_100, at: 3},
    {n: 4, kind: 'top_up', table: 't', amount: 5000, balance: 25_100, at: 4},
    {n: 5, kind: 'top_up_refund', table: 't', amount: 1000, balance: 26_100, at: 5},
    {n: 6, kind: 'cash_out', table: 't', amount: 30_000, balance: 56_100, at: 6},
  ];
  assert.deepEqual(chipLines(entries).map(l => [l.kind, l.amount, l.balance]), [['left', 6000, 56_100], ['issue', 50_000, 50_000]]);
});
