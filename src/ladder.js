// The heads-up ladder (#212), Train's Punch-Out: play the bots one at a time,
// easiest first, up to the GTO bot at the top. Each rung is a best-of-3
// series of heads-up freezeouts: both players buy in for START_BB big blinds,
// no rebuys. Every STAKES_EVERY hands the bot offers to double the blinds.
// Your chips carry over from game to game: you start with two of the first
// rung's buy-ins, each game won adds a buy-in and each game lost takes one,
// and every rung up doubles the stakes. Win two games to move up a rung. Lose
// the series, or be left unable to buy in for the next game, and you drop to
// the highest rung below whose buy-in you can pay; when you can't pay any,
// you start over at the bottom with the starting chips.
// Progress (your rung, your chips, the series under way, the game under way
// with both stacks and its blinds, your best, your record against each bot)
// is kept on this device, so a game left in the middle picks up where it was.
// This file is the rules and the record; play.js plays the games.

export const LADDER_KEY = 'ducyLadder';
export const START_BB = 200;
export const WINS_TO_TAKE = 2; // of 3
// The first rung's blinds, in chips (hundredths: 100/200 shows as 1/2). Each
// rung up doubles them.
export const BLINDS = [100, 200];
// How many hands go by between offers to double the blinds.
export const STAKES_EVERY = 100;

// A rung's stakes: its blinds, and the buy-in for each game (START_BB big blinds).
export const blindsAt = level => BLINDS.map(b => b * 2 ** level);
export const buyInAt = level => START_BB * blindsAt(level)[1];
// The chips you start the ladder with, and start over with: two first-rung buy-ins.
export const START_CHIPS = 2 * buyInAt(0);

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
// The games themselves are 200 BB deep; the order is from 100 BB.
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

// `chips` are yours away from the table: a game under way has a buy-in of them
// at the table. `game` is the game under way, kept so it can be left and
// resumed: {stacks: [yours, theirs], hands, blinds: [sb, bb], offerAt}, or null.
// offerAt is the hand count at which the bot next offers to raise the
// stakes. A game kept before the stakes could rise has neither: it goes on
// at its rung's blinds, with the first offer at STAKES_EVERY.
export function newProgress() {
  return {v: 2, level: 0, best: 0, wins: 0, losses: 0, chips: START_CHIPS, playing: false, titles: 0, record: {}, game: null};
}

// The chips at the table in a game at this rung: both players' buy-ins.
export const tableChipsAt = level => 2 * buyInAt(level);

export function loadProgress(storage = globalThis.localStorage) {
  try {
    const p = JSON.parse(storage.getItem(LADDER_KEY) || 'null');
    if (p && p.v === 2 && Number.isInteger(p.level) && Number.isFinite(p.chips)) return {...newProgress(), ...p, record: {...p.record}};
    if (p && p.v === 1 && Number.isInteger(p.level)) return fromV1({...newProgress(), ...p, record: {...p.record}});
  } catch {}
  return newProgress();
}

// Progress from before chips carried over (every rung played at 1/2): you
// keep your rung, with two of its buy-ins, and a paused game goes on at its
// rung's stakes, each player keeping their share of the chips.
function fromV1(p) {
  const q = {...p, v: 2, chips: 2 * buyInAt(p.level)};
  const s = p.game?.stacks;
  if (!Array.isArray(s) || s.length !== 2) return {...q, game: null};
  const total = s[0] + s[1];
  if (!(total > 0)) return q;
  const all = tableChipsAt(p.level);
  const m = Math.max(0, Math.min(all, Math.round(s[0] * all / total)));
  const blinds = p.game.blinds?.map(b => b * 2 ** p.level);
  return {...q, game: {...p.game, stacks: [m, all - m], ...(blinds ? {blinds} : {})}};
}

export function saveProgress(p, storage = globalThis.localStorage) {
  try { storage.setItem(LADDER_KEY, JSON.stringify(p)); } catch {}
}

// Your rung, kept on the ladder (it can get shorter: no GTO bot here).
export const levelOf = (p, rungs) => Math.max(0, Math.min(rungs.length - 1, p.level));
export const opponentOf = (p, rungs) => rungs[levelOf(p, rungs)];

// A game is starting, or resuming where it was left: a fresh one at your
// rung's stakes, each player buying in.
export function startGame(p, rungs) {
  const level = levelOf(p, rungs);
  const fresh = {stacks: [buyInAt(level), buyInAt(level)], hands: 0, blinds: blindsAt(level), offerAt: STAKES_EVERY};
  return {...p, level, playing: true, game: p.game ? {blinds: blindsAt(level), offerAt: STAKES_EVERY, ...p.game} : fresh};
}

// The game so far, after each action: your chips behind, and theirs (all the
// rest). Leaving in the middle of a hand folds it: what you'd put in the pot
// is theirs. The game's blinds and next offer stay as they are.
export function keepGame(p, mine, hands) {
  const all = p.game ? p.game.stacks[0] + p.game.stacks[1] : tableChipsAt(p.level);
  const m = Math.max(0, Math.min(all, Math.round(mine)));
  return {...p, game: {...p.game, stacks: [m, all - m], hands}};
}

// The game's blinds now.
export const gameBlinds = p => p.game?.blinds || blindsAt(p.level);

// The bot's offer to raise the stakes, once the game has reached its next
// offer: the doubled blinds, or null. Both players need more than the new big
// blind behind, or there's nothing to raise.
export function stakesOffer(p) {
  const g = p.game;
  if (!p.playing || !g || g.hands < (g.offerAt ?? STAKES_EVERY)) return null;
  const [sb, bb] = gameBlinds(p);
  const next = [sb * 2, bb * 2];
  return Math.min(...g.stacks) > next[1] ? next : null;
}

// Your answer to the offer: accepted, the blinds double from the next hand.
// Either way the next offer is STAKES_EVERY hands on.
export function answerStakes(p, yes) {
  const offer = stakesOffer(p);
  const g = {...p.game, offerAt: p.game.hands + STAKES_EVERY};
  if (yes && offer) g.blinds = offer;
  return {...p, game: g};
}

// A game was left (or the page closed) and is waiting to be resumed.
export const pausedGame = p => (p.playing && p.game ? p.game : null);

// Your chips as they stand: with a game under way, the buy-in is what you have
// at the table.
export const chipsNow = p => (p.game ? p.chips - (p.game.stacks[0] + p.game.stacks[1]) / 2 + p.game.stacks[0] : p.chips);

// The rung you drop to with these chips after losing at `level`: the highest
// one below whose buy-in you can pay, or -1 when you can't pay any.
export function dropTo(level, chips) {
  for (let j = level - 1; j >= 0; j--) if (buyInAt(j) <= chips) return j;
  return -1;
}

// A game is over: `won` is whether you took all the chips, and with them a
// buy-in from the bot (lost, your buy-in is gone). Returns the new progress
// and what happened: 'game' (the series goes on), 'up' (series won, on to the
// next rung), 'champion' (series won at the top), 'down' (series lost, or no
// chips left for the next game: down to the rung you can pay for), 'stay'
// (series lost on the bottom rung, with a buy-in left) or 'bust' (no buy-in
// left for any rung: start over at the bottom with START_CHIPS).
export function finishGame(p, rungs, won) {
  const level = levelOf(p, rungs);
  const opp = rungs[level];
  const stake = p.game ? (p.game.stacks[0] + p.game.stacks[1]) / 2 : buyInAt(level);
  const q = {
    ...p, level, playing: false, game: null, chips: p.chips + (won ? stake : -stake),
    wins: p.wins + (won ? 1 : 0), losses: p.losses + (won ? 0 : 1), record: {...p.record},
  };
  const broke = q.chips < buyInAt(level);
  if (q.wins < WINS_TO_TAKE && q.losses < WINS_TO_TAKE && !broke) return {progress: q, outcome: 'game'};
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
  if (level === 0 && !broke) return {progress: q, outcome: 'stay'};
  // `short`: the series ended because you couldn't buy in for the next game.
  const short = p.losses + 1 < WINS_TO_TAKE;
  const to = dropTo(level, q.chips);
  if (to < 0) {
    q.level = 0;
    q.chips = START_CHIPS;
    return {progress: q, outcome: 'bust', short};
  }
  q.level = to;
  return {progress: q, outcome: 'down', short};
}
