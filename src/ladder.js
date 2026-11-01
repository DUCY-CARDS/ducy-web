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
// The rules are ducy-bot-games' ladder (#465); this file keeps the record,
// which the page reads before the engine has loaded. play.js plays the games.

import { botGames } from '../wasm/ducy_wasm.js';

export const LADDER_KEY = 'ducyLadder';
// The ladder's terms, as ducy-bot-games has them (a test checks they agree).
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

// The bots, easiest to hardest, by how much the GTO bot wins from each
// (ducy-bot-games' ORDER has how they were measured). The GTO bot is the
// champion.
export const ORDER = [
  'rampart', 'nik_airbag', 'milk_king', 'bungleman', 'jonny_slow', 'bart_handsome', 'chris_moneybags', 'jen_silly',
  'brad_owned', 'mister_cheating', 'phil_bigmouth', 'tom_collins', 'danny_smallball', 'andrew_favorable',
  'robin_jane_lewd', 'michael_miserable', 'the_mathematician', 'tommy_sweeden', 'gus_bluffsen', 'doug_poker',
];
export const CHAMPION = 'gto';

// The rungs, bottom to top: the ranked bots this engine has, then any it has
// that aren't ranked yet (at the top of the bots), then the GTO bot when it's
// there.
export const rungsFor = (ids, gto) => botGames({op: 'rungsFor', ids: [...ids], gto: !!gto});

// `chips` are yours away from the table: a game under way has a buy-in of them
// at the table. `game` is the game under way, kept so it can be left and
// resumed: {stacks: [yours, theirs], hands, blinds: [sb, bb], offerAt, review}, or null.
// offerAt is the hand count at which the bot next offers to raise the
// stakes. A game kept before the stakes could rise has neither: it goes on
// at its rung's blinds, with the first offer at STAKES_EVERY. `review` is its
// ladder-review.js review so far, once a hand is graded. `lastReview` is the
// last finished game's review, with {at, opp, won, hands}, to read on the
// Ladder tab (absent until there's one).
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

// Whether rung i's bot shows on the ladder. It goes by the rung, not the
// bot: rungs below yours and up to your best show, and your own once you've
// been above it, its series is under way, or you've played its bot before.
export const rungShown = (p, rungs, i) => botGames({op: 'rungShown', p, rungs, i});

// A game is starting, or resuming where it was left: a fresh one at your
// rung's stakes, each player buying in.
export const startGame = (p, rungs) => botGames({op: 'startGame', p, rungs});

// The game so far, after each action: your chips behind, and theirs (all the
// rest). Leaving in the middle of a hand folds it: what you'd put in the pot
// is theirs. The game's blinds, next offer and review stay as they are.
export const keepGame = (p, mine, hands) => botGames({op: 'keepGame', p, mine: Number(mine) || 0, hands});

// The game's blinds now.
export const gameBlinds = p => p.game?.blinds || blindsAt(p.level);

// The bot's offer to raise the stakes, once the game has reached its next
// offer: the doubled blinds, or null.
export const stakesOffer = p => botGames({op: 'stakesOffer', p}) ?? null;

// Your answer to the offer: accepted, the blinds double from the next hand.
// Either way the next offer is STAKES_EVERY hands on.
export const answerStakes = (p, yes) => botGames({op: 'answerStakes', p, yes: !!yes});

// A game was left (or the page closed) and is waiting to be resumed.
export const pausedGame = p => (p.playing && p.game ? p.game : null);

// Your chips as they stand: with a game under way, the buy-in is what you have
// at the table.
export const chipsNow = p => botGames({op: 'chipsNow', p});

// The rung you drop to with these chips after losing at `level`: the highest
// one below whose buy-in you can pay, or -1 when you can't pay any.
export const dropTo = (level, chips) => botGames({op: 'dropTo', level, chips});

// A game is over: `won` is whether you took all the chips. Returns
// {progress, outcome, short}: outcome 'game' (the series goes on), 'up',
// 'champion', 'down', 'stay' (series lost on the bottom rung, with a buy-in
// left) or 'bust' (start over at the bottom with START_CHIPS); `short`, for a
// drop, when it was for want of chips for the next game.
export const finishGame = (p, rungs, won) => botGames({op: 'finishGame', p, rungs, won: !!won});
