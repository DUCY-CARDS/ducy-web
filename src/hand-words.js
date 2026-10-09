// Your hand in words at the table, like "Straight, 8 high" or "Pair of
// aces": the best five cards your hole cards make with the board so far, as
// ducy's evaluator finds them (Hold'em: any five of seven; Omaha: exactly
// two of yours and three of the board).

import { HoldemGame, OmahaGame } from '../wasm/ducy_wasm.js';

const NAMES = {A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: '10'};
// One rank, and several: faces in words ("ace", "aces"), numbers as digits ("8", "8s").
const one = r => NAMES[r] || r;
const many = r => (NAMES[r] && r !== 'T' ? `${NAMES[r]}s` : `${one(r)}s`);
const cap = s => s[0].toUpperCase() + s.slice(1);

// ducy's name for a hand ("Straight 8 high", "Pair of 8, 9 7 2", "Full House
// 9 full of 2") in words; null if it isn't one.
export function handText(engine) {
  const t = String(engine || '').trim();
  let m;
  if ((m = t.match(/^High Card (\w)/))) return `${cap(one(m[1]))} high`;
  if ((m = t.match(/^Pair of (\w)/))) return `Pair of ${many(m[1])}`;
  if ((m = t.match(/^Two Pair (\w) over (\w)/))) return `Two pair, ${many(m[1])} and ${many(m[2])}`;
  if ((m = t.match(/^Three of a Kind (\w)/))) return `Three of a kind, ${many(m[1])}`;
  if ((m = t.match(/^Straight Flush (\w) high/))) return m[1] === 'A' ? 'Royal flush' : `Straight flush, ${one(m[1])} high`;
  if ((m = t.match(/^Straight (\w) high/))) return `Straight, ${one(m[1])} high`;
  if ((m = t.match(/^Flush (\w)/))) return `Flush, ${one(m[1])} high`;
  if ((m = t.match(/^Full House (\w) full of (\w)/))) return `Full house, ${many(m[1])} full of ${many(m[2])}`;
  if ((m = t.match(/^Four of a Kind (\w)/))) return `Four of a kind, ${many(m[1])}`;
  return null;
}

let last = {key: '', text: null};

// What `hole` (["As", "Kd"]) makes with `board` (3 to 5 cards), in words;
// null before the flop or if it can't be worked out.
export function handWords(hole, board) {
  if (!hole?.length || hole.some(c => !c) || !board || board.length < 3) return null;
  const key = `${hole.join('')}|${board.join('')}`;
  if (key === last.key) return last.text;
  let text = null;
  try {
    const game = hole.length === 2 ? new HoldemGame() : new OmahaGame(hole.length);
    try {
      game.add_player(hole.join(' '));
      game.set_flop(board.slice(0, 3).join(' '));
      if (board[3]) game.set_turn(board[3]);
      if (board[4]) game.set_river(board[4]);
      text = handText(game.evaluate_winners()[0]?.hand);
    } finally {
      game.free();
    }
  } catch {
    text = null;
  }
  last = {key, text};
  return text;
}
