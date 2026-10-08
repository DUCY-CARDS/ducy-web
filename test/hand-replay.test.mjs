// Hand history (#71) and the replayer (#72); ducy replays the hand, so this
// needs the wasm build in wasm/.
// Run with: node --test test/hand-replay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { handRecord, replayFrames, streetStarts, summary, tableSessions, totalsByMember } from '../src/hand-replay.js';

// A finished heads-up hand as the host sees it: Ann (seat 0, button and small
// blind) raises, Bob calls, flop bet and call, turn checks, Bob bets the
// river and Ann folds. No showdown, so no hole cards.
function view(cards = [null, null]) {
  const ev = [
    {type: 'small_blind', seat: 0, amount: 1}, {type: 'big_blind', seat: 1, amount: 2},
    {type: 'raise', seat: 0, to: 6, all_in: false}, {type: 'call', seat: 1, amount: 4, all_in: false},
    {type: 'board', street: 'flop', cards: ['Ah', '7c', '2d']},
    {type: 'check', seat: 1}, {type: 'bet', seat: 0, to: 8, all_in: false}, {type: 'call', seat: 1, amount: 8, all_in: false},
    {type: 'board', street: 'turn', cards: ['Ks']},
    {type: 'check', seat: 1}, {type: 'check', seat: 0},
    {type: 'board', street: 'river', cards: ['3h']},
    {type: 'bet', seat: 1, to: 20, all_in: false}, {type: 'fold', seat: 0},
    {type: 'award', seat: 1, pot: 0, amount: 48},
  ];
  return {
    hand_number: 7, small_blind: 1, big_blind: 2, button: 0, hole_cards: 2, board: ['Ah', '7c', '2d', 'Ks', '3h'],
    showdown: false, pots: [{amount: 48}], events: ev,
    seats: [
      {name: 'Ann', stack: 186, net: -14, won: 0, folded: true, cards: cards[0], empty: false, sitting_out: false},
      {name: 'Bob', stack: 234, net: 14, won: 48, folded: false, cards: cards[1], empty: false, sitting_out: false},
      {name: '', stack: 0, net: 0, won: 0, folded: false, cards: null, empty: true, sitting_out: false},
    ],
  };
}

test('a record keeps what the viewer saw and nothing else', () => {
  const host = handRecord({club: 'ABCD-EFGH', table: 't1', tableName: 'Main', game: 'nlhe', view: view(), who: 'host'}, 1000);
  assert.equal(host.hand, 7);
  assert.equal(host.pot, 48);
  assert.ok(host.seats.every(s => s.cards === null), 'the host saw no hole cards');
  assert.equal(host.seats[2].inHand, false);
  assert.equal(summary(host), 'Bob +14');
  const mine = handRecord({club: 'ABCD-EFGH', table: 't1', tableName: 'Main', game: 'nlhe', view: view([['As', 'Kd'], null]), who: 'ann'}, 1000);
  assert.deepEqual(mine.seats[0].cards, ['As', 'Kd']);
  assert.equal(mine.seats[1].cards, null);
});

test('replaying rebuilds stacks, bets and the pot action by action, ending where the hand did', () => {
  const rec = handRecord({club: 'c', table: 't', tableName: 'T', game: 'nlhe', view: view(), who: 'host'});
  const f = replayFrames(rec);
  assert.equal(f.length, rec.events.length + 1);
  assert.deepEqual(f[0].seats.slice(0, 2).map(s => s.stack), [200, 220], 'start = end - net');
  const afterCall = f[4];
  assert.deepEqual(afterCall.seats.slice(0, 2).map(s => [s.stack, s.bet]), [[194, 6], [214, 6]]);
  assert.equal(afterCall.pot, 0);
  const flop = f[5];
  assert.equal(flop.pot, 12);
  assert.deepEqual(flop.board, ['Ah', '7c', '2d']);
  assert.equal(flop.text, 'Flop: Ah 7c 2d');
  const last = f.at(-1);
  assert.deepEqual(last.seats.slice(0, 2).map(s => s.stack), [186, 234], 'ends at the final stacks');
  assert.equal(last.pot, 0);
  assert.ok(last.seats[0].folded);
  const starts = streetStarts(f);
  assert.deepEqual(Object.keys(starts), ['preflop', 'flop', 'turn', 'river']);
  assert.equal(f[starts.river].board.length, 5);
});

test('table sessions and totals come from the ledger', () => {
  const entries = [
    {n: 1, at: 1, kind: 'issue', member: 'ann', amount: 1000},
    {n: 2, at: 2, kind: 'buy_in', member: 'ann', table: 't1', amount: 200},
    {n: 3, at: 3, kind: 'buy_in', member: 'bob', table: 't1', amount: 150},
    {n: 4, at: 4, kind: 'top_up', member: 'ann', table: 't1', amount: 50},
    {n: 5, at: 5, kind: 'cash_out', member: 'ann', table: 't1', amount: 310},
    {n: 6, at: 6, kind: 'buy_in', member: 'ann', table: 't2', amount: 100},
    {n: 7, at: 7, kind: 'cash_out', member: 'ann', table: 't2', amount: 40},
  ];
  const s = tableSessions(entries);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map(x => [x.member, x.table, x.put, x.took, x.net, x.open]), [
    ['ann', 't2', 100, 40, -60, false],
    ['bob', 't1', 150, 0, -150, true],
    ['ann', 't1', 250, 310, 60, false],
  ]);
  assert.deepEqual(totalsByMember(s), {ann: 0});
});

test('missed blinds posted on coming back replay as dead (pot) and live (bet)', () => {
  const rec = handRecord({club: 'c', table: 't', tableName: 'T', game: 'nlhe', who: 'host', view: {
    hand_number: 9, small_blind: 1, big_blind: 2, button: 2, hole_cards: 2, board: [], showdown: false, pots: [{amount: 6}],
    events: [
      {type: 'small_blind', seat: 0, amount: 1}, {type: 'big_blind', seat: 1, amount: 2},
      {type: 'post', seat: 2, dead: 1, live: 2},
      {type: 'fold', seat: 2}, {type: 'fold', seat: 0},
      {type: 'award', seat: 1, pot: 0, amount: 6},
    ],
    seats: [
      {name: 'A', stack: 99, net: -1, won: 0, folded: true, cards: null, empty: false, sitting_out: false},
      {name: 'B', stack: 104, net: 4, won: 6, folded: false, cards: null, empty: false, sitting_out: false},
      {name: 'C', stack: 97, net: -3, won: 0, folded: true, cards: null, empty: false, sitting_out: false},
    ],
  }});
  const f = replayFrames(rec);
  const afterPost = f[3];
  assert.equal(afterPost.text, 'C posts missed blinds: 1 dead + 2 live');
  assert.equal(afterPost.pot, 1, 'the dead blind is in the pot');
  assert.deepEqual([afterPost.seats[2].stack, afterPost.seats[2].bet], [97, 2]);
  assert.deepEqual(f.at(-1).seats.map(s => s.stack), [99, 104, 97], 'ends at the final stacks');
});
