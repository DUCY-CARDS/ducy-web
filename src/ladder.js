// The heads-up ladder (#212), Train's Punch-Out: play the bots one at a time,
// easiest first, up to the GTO bot at the top. Each rung is a best-of-3
// series of heads-up freezeouts: everyone starts with START_BB big blinds, no
// rebuys, and the blinds stay the same until someone has all the chips. Win
// the series to move up a rung; lose it and drop one.
// Progress (your rung, the series under way, your best, your record against
// each bot) is kept on this device. This file is the rules and the record;
// play.js plays the games.

export const LADDER_KEY = 'ducyLadder';
export const START_BB = 100;
export const WINS_TO_TAKE = 2; // of 3
// The blinds of every hand, in chips (hundredths: 100/200 shows as 1/2).
export const BLINDS = [100, 200];

// The bots, easiest to hardest: by how much the GTO bot wins from each,
// heads-up No-limit Hold'em at 100 BB, 40,000 duplicate hands each (ducy-gto's
// gto_match against the gto-hunl-300m model). The GTO bot is the champion.
// Its win rate in bb/100 (± 95%) against each, from rampart at the bottom:
//   rampart 107 ± 24, nik_airbag 99 ± 25, bungleman 98 ± 20, milk_king 72 ± 16,
//   chris_moneybags 51 ± 13, robin_jane_lewd 50 ± 16, gus_bluffsen 37 ± 10,
//   tom_collins 33 ± 16, mister_cheating 31 ± 18, jen_silly 29 ± 10,
//   jonny_slow 25 ± 6, brad_owned 24 ± 9, andrew_favorable 24 ± 9,
//   doug_poker 21 ± 11, tommy_sweeden 20 ± 13, michael_miserable 19 ± 10,
//   danny_smallball 18 ± 12, the_mathematician 17 ± 13, phil_bigmouth 10 ± 12.
// Neighbours in the upper half are often within each other's intervals, so
// the top six (all within 17–21 but Phil's 10) are in the order chosen for
// the ladder rather than measured: the Mathematician, Tommy Sweeden, Phil
// Bigmouth, Danny Smallball, Michael Miserable, then Doug Poker at the top.
export const ORDER = [
  'rampart', 'nik_airbag', 'bungleman', 'milk_king', 'chris_moneybags', 'robin_jane_lewd', 'gus_bluffsen',
  'tom_collins', 'mister_cheating', 'jen_silly', 'jonny_slow', 'brad_owned', 'andrew_favorable',
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

export function newProgress() {
  return {v: 1, level: 0, best: 0, wins: 0, losses: 0, playing: false, titles: 0, record: {}};
}

export function loadProgress(storage = globalThis.localStorage) {
  try {
    const p = JSON.parse(storage.getItem(LADDER_KEY) || 'null');
    if (p && p.v === 1 && Number.isInteger(p.level)) return {...newProgress(), ...p, record: {...p.record}};
  } catch {}
  return newProgress();
}

export function saveProgress(p, storage = globalThis.localStorage) {
  try { storage.setItem(LADDER_KEY, JSON.stringify(p)); } catch {}
}

// Your rung, kept on the ladder (it can get shorter: no GTO bot here).
export const levelOf = (p, rungs) => Math.max(0, Math.min(rungs.length - 1, p.level));
export const opponentOf = (p, rungs) => rungs[levelOf(p, rungs)];

// A game is starting. Until it's finished, leaving counts as losing it.
export function startGame(p) {
  return {...p, playing: true};
}

// A game is over: `won` is whether you took all the chips. Returns the new
// progress and what happened: 'game' (the series goes on), 'up' (series won,
// on to the next rung), 'champion' (series won at the top), 'down' (series
// lost, down a rung) or 'stay' (series lost on the bottom rung).
export function finishGame(p, rungs, won) {
  const level = levelOf(p, rungs);
  const opp = rungs[level];
  const q = {...p, level, playing: false, wins: p.wins + (won ? 1 : 0), losses: p.losses + (won ? 0 : 1), record: {...p.record}};
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

// A game left unfinished (the page closed, or you left the table) is lost.
// Returns {progress, outcome} as finishGame does, or null if none was.
export function forfeitUnfinished(p, rungs) {
  return p.playing ? finishGame(p, rungs, false) : null;
}
