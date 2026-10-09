// Your hand in words at the table (hand-words.js): ducy's evaluator finds
// the best five cards, and they're named like "Straight, 8 high".
// Needs the wasm build in wasm/. Run with: node --test test/hand-words.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { handText, handWords } from '../src/hand-words.js';

const cards = s => s.match(/../g);

test('Hold’em hands in words', () => {
  const cases = [
    ['AsKd', '2c7h9s', 'Ace high'],
    ['8s8d', '2c7h9s', 'Pair of 8s'],
    ['AsAd', '2c7h9s', 'Pair of aces'],
    ['KsKd', '7c7h2s', 'Two pair, kings and 7s'],
    ['TsTd', 'Tc7h2s', 'Three of a kind, 10s'],
    ['8s7d', '6c5h4s', 'Straight, 8 high'],
    ['Ah2d', '3c4h5s', 'Straight, 5 high'],
    ['AsKs', '2s7s9s', 'Flush, ace high'],
    ['9h9d', '9c2h2s', 'Full house, 9s full of 2s'],
    ['QhQd', 'Qc2h7sQs', 'Four of a kind, queens'],
    ['9h8h', '7h6h5h', 'Straight flush, 9 high'],
    ['AhKh', 'QhJhTh', 'Royal flush'],
  ];
  for (const [hole, board, want] of cases) assert.equal(handWords(cards(hole), cards(board)), want, `${hole} on ${board}`);
});

test('the turn and river count, and before the flop there is nothing to say', () => {
  assert.equal(handWords(cards('AsKd'), cards('2c7h9sAh')), 'Pair of aces');
  assert.equal(handWords(cards('AsKd'), cards('2c7h9sAhKs')), 'Two pair, aces and kings');
  assert.equal(handWords(cards('AsKd'), []), null);
  assert.equal(handWords(cards('AsKd'), cards('2c7h')), null);
  assert.equal(handWords([null, null], cards('2c7h9s')), null, 'cards not seen');
});

test('Omaha uses exactly two of your cards', () => {
  // Four spades between hand and board, but only two from each hand count: no flush.
  assert.equal(handWords(cards('AsKsQd2c'), cards('JsTs3h')), 'Ace high');
  assert.equal(handWords(cards('AsKsQd2c'), cards('JsTs3s')), 'Flush, ace high');
});

test('the engine’s names map one for one', () => {
  assert.equal(handText('Pair of 8, 9 7 2'), 'Pair of 8s');
  assert.equal(handText('Full House K full of T'), 'Full house, kings full of 10s');
  assert.equal(handText('nonsense'), null);
});
