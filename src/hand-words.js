// Your hand in words at the table, like "Straight, 8 high" or "Pair of
// aces": the best five cards your hole cards make with the board so far, as
// ducy's evaluator finds them (Hold'em: any five of seven; Omaha: exactly
// two of yours and three of the board), worded by ducy (ducy_play::hands).

import { handNameWords, handWords as ducyWords } from '../wasm/ducy_wasm.js';

// ducy's name for a hand ("Straight 8 high", "Pair of 8, 9 7 2", "Full House
// 9 full of 2") in words; null if it isn't one.
export function handText(engine) {
  return handNameWords(String(engine || '')) ?? null;
}

let last = {key: '', text: null};

// What `hole` (["As", "Kd"]) makes with `board` (3 to 5 cards), in words;
// null before the flop or if it can't be worked out.
export function handWords(hole, board) {
  if (!hole?.length || hole.some(c => !c) || !board || board.length < 3) return null;
  const key = `${hole.join('')}|${board.join('')}`;
  if (key !== last.key) last = {key, text: ducyWords(hole, board) ?? null};
  return last.text;
}
