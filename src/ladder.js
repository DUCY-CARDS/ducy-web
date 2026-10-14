// The heads-up ladder (#212), Train's Punch-Out: play the bots one at a time,
// easiest first, up to the GTO bot at the top. Each rung is a best-of-3
// series of heads-up freezeouts: everyone starts with START_BB big blinds, no
// rebuys, and the blinds stay the same until someone has all the chips. Win
// the series to move up a rung; lose it and drop one.
// Progress (your rung, the series under way, the game under way with both
// stacks, your best, your record against each bot) is kept on this device, so
// a game left in the middle picks up where it was. This file is the rules and the record;
// play.js plays the games.

export const LADDER_KEY = 'ducyLadder';
export const START_BB = 200;
export const WINS_TO_TAKE = 2; // of 3
// The blinds of every hand, in chips (hundredths: 100/200 shows as 1/2).
export const BLINDS = [100, 200];

// The bots, easiest to hardest: by how much the GTO bot wins from each,
// heads-up No-limit Hold'em at 100 BB, 40,000 duplicate hands each (ducy-gto's
// gto_match against the gto-hunl-300m model). The GTO bot is the champion.
// Measured again after the bots' tuning and spew guard (ducy #239–#241).
// Its win rate in bb/100 (± 95%) against each, from rampart at the bottom:
//   rampart 72 ± 15, milk_king 67 ± 17, nik_airbag 44 ± 20,
//   chris_moneybags 38 ± 13, jonny_slow 25 ± 8, gus_bluffsen 22 ± 9,
//   brad_owned 22 ± 7, robin_jane_lewd 20 ± 13, bungleman 19 ± 11,
//   tom_collins 18 ± 13, mister_cheating 18 ± 15, the_mathematician 15 ± 14,
//   michael_miserable 14 ± 10, jen_silly 14 ± 10, phil_bigmouth 13 ± 9,
//   tommy_sweeden 12 ± 12, danny_smallball 11 ± 12, doug_poker 9 ± 13,
//   andrew_favorable 7 ± 11.
// The top eight are all within 7–15, inside each other's intervals, so
// they're in the order chosen for the ladder rather than measured: Jen
// Silly, Andrew Favorable, the Mathematician, Tommy Sweeden, Phil Bigmouth,
// Danny Smallball, Michael Miserable, then Doug Poker at the top.
// The games themselves start 200 BB deep; the order is from 100 BB.
export const ORDER = [
  'rampart', 'milk_king', 'nik_airbag', 'chris_moneybags', 'jonny_slow', 'gus_bluffsen', 'brad_owned',
  'robin_jane_lewd', 'bungleman', 'tom_collins', 'mister_cheating', 'jen_silly', 'andrew_favorable',
  'the_mathematician', 'tommy_sweeden', 'phil_bigmouth', 'danny_smallball', 'michael_miserable', 'doug_poker',
];
export const CHAMPION = 'gto';

// The rungs, bottom to top: the ranked bots this engine has, then any it has
// that aren't ranked yet (at the top of the bots), then the GTO bot when it's
// there.
export function rungsFor(ids, gto) {
  const have = new Set(ids);
  const rungs = ORDER.filter(id => have.has(id));
  for (const id of ids) if (!rungs.includes(id) && id !== CHAMPION) rungs.push(id);
  if (gto) rungs.push(CHAMPION);
  return rungs;
}

// `game` is the game under way, kept so it can be left and resumed:
// {stacks: [yours, theirs], hands}, or null.
export function newProgress() {
  return {v: 1, level: 0, best: 0, wins: 0, losses: 0, playing: false, titles: 0, record: {}, game: null};
}

// The chips at the table: both players' starting stacks.
export const TOTAL_CHIPS = 2 * START_BB * BLINDS[1];

export function loadProgress(storage = globalThis.localStorage) {
  try {
    const p = JSON.parse(storage.getItem(LADDER_KEY) || 'null');
    if (p && p.v === 1 && Number.isInteger(p.level)) return fitGame({...newProgress(), ...p, record: {...p.record}});
  } catch {}
  return newProgress();
}

// A game paused when the ladder started shallower (100 BB) goes on at this
// depth, with each player keeping their share of the chips.
function fitGame(p) {
  const s = p.game?.stacks;
  if (!Array.isArray(s) || s.length !== 2) return {...p, game: null};
  const total = s[0] + s[1];
  if (total === TOTAL_CHIPS || !(total > 0)) return p;
  return keepGame(p, s[0] * TOTAL_CHIPS / total, p.game.hands);
}

export function saveProgress(p, storage = globalThis.localStorage) {
  try { storage.setItem(LADDER_KEY, JSON.stringify(p)); } catch {}
}

// Your rung, kept on the ladder (it can get shorter: no GTO bot here).
export const levelOf = (p, rungs) => Math.max(0, Math.min(rungs.length - 1, p.level));
export const opponentOf = (p, rungs) => rungs[levelOf(p, rungs)];

// A game is starting, or resuming where it was left.
export function startGame(p) {
  const fresh = {stacks: [TOTAL_CHIPS / 2, TOTAL_CHIPS / 2], hands: 0};
  return {...p, playing: true, game: p.game || fresh};
}

// The game so far, after each action: your chips behind, and theirs (all the
// rest). Leaving in the middle of a hand folds it: what you'd put in the pot
// is theirs.
export function keepGame(p, mine, hands) {
  const m = Math.max(0, Math.min(TOTAL_CHIPS, Math.round(mine)));
  return {...p, game: {stacks: [m, TOTAL_CHIPS - m], hands}};
}

// A game was left (or the page closed) and is waiting to be resumed.
export const pausedGame = p => (p.playing && p.game ? p.game : null);

// A game is over: `won` is whether you took all the chips. Returns the new
// progress and what happened: 'game' (the series goes on), 'up' (series won,
// on to the next rung), 'champion' (series won at the top), 'down' (series
// lost, down a rung) or 'stay' (series lost on the bottom rung).
export function finishGame(p, rungs, won) {
  const level = levelOf(p, rungs);
  const opp = rungs[level];
  const q = {...p, level, playing: false, game: null, wins: p.wins + (won ? 1 : 0), losses: p.losses + (won ? 0 : 1), record: {...p.record}};
  if (q.wins < WINS_TO_TAKE && q.losses < WINS_TO_TAKE) return {progress: q, outcome: 'game'};
  const r = {won: 0, lost: 0, ...q.record[opp]};
  const took = q.wins >= WINS_TO_TAKE;
  if (took) r.won++; else r.lost++;
  q.record[opp] = r;
  q.wins = 0;
  q.losses = 0;
  if (took) {
    if (level === rungs.length - 1) {
      q.titles++;
      return {progress: q, outcome: 'champion'};
    }
    q.level = level + 1;
    q.best = Math.max(q.best, q.level);
    return {progress: q, outcome: 'up'};
  }
  if (level === 0) return {progress: q, outcome: 'stay'};
  q.level = level - 1;
  return {progress: q, outcome: 'down'};
}
