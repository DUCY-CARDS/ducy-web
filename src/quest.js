// Bankroll Quest (#299): turn $1,000 into $1,000,000 across a world of card
// rooms. This file is the bankroll, the world clock and the save (#300);
// quest-rooms.js is the rooms and their schedules (#301). Amounts are in
// hundredths, like the rest of the page (100 is $1).
//
// The rules live in ducy-quest (Rust, #466); these call its wasm build.
// The clock runs QUEST_SPEED times real time while you're here, so a game
// day is six real hours. Away from the game it stops, except to finish a trip
// or a night's sleep (resume), and then for at most AWAY_CAP_DAYS game days.
// Game time is minutes since the world began, a Monday at midnight.

import { quest as op } from '../wasm/ducy_wasm.js';

export const QUEST_KEY = 'ducyQuest';
// The terms, kept here for the page to read before the wasm loads (a test
// checks they're ducy-quest's: the `rules` op).
export const START_BANKROLL = 100000; // $1,000
export const GOAL = 100000000; // $1,000,000
export const QUEST_SPEED = 4;
export const AWAY_CAP_DAYS = 7;
// Buy-ins, in big blinds, unless a room sets its own.
export const MIN_BUY_IN_BB = 40;
export const MAX_BUY_IN_BB = 200;
// At a table the clock runs only while hands are being played: a minute
// without one finishing and it stops, until the next hand picks it up
// again from the same time (each hand moves the anchor, play.js questHand).
export const TABLE_IDLE_MS = 60000;
// A gap longer than this since the clock's anchor last moved is time away.
export const AWAY_MS = 2 * 60000;
// At most MAX_TABLE_MINUTES at the tables between sleeps (a warning from
// TIRED_MINUTES); then you sleep for SLEEP_MINUTES on the game clock.
export const MAX_TABLE_MINUTES = 12 * 60;
export const TIRED_MINUTES = 10 * 60;
export const SLEEP_MINUTES = 6 * 60;
// When your name is called you have CALL_MINUTES to take the seat, from
// when you see the call, or you lose it.
export const CALL_MINUTES = 8;
// Milestones on the way to GOAL, each announced once a run.
export const MILESTONES = [
  {at: 500000, text: '$5,000: five times what you started with.'},
  {at: 2500000, text: '$25,000: the big games in the Ivory Room are within reach.'},
  {at: 10000000, text: '$100,000: six figures.'},
  {at: 25000000, text: '$250,000: a quarter of a million.'},
  {at: 50000000, text: '$500,000: halfway there, in dollars.'},
];

const limits = room => room || {};

/** A new quest: the starting bankroll, the clock anchored at `now` (real ms), and the seed its world is built from. */
export const newQuest = (now = Date.now(), seed = (Math.random() * 2 ** 32) >>> 0) => op({op: 'newQuest', now, seed});

/** Game minutes at real time `now`. */
export const gameMinutes = (q, now = Date.now()) => op({op: 'gameMinutes', q, now});
/** Moves the clock's anchor to `now`, so the cap counts from here. */
export const syncClock = (q, now = Date.now()) => op({op: 'syncClock', q, now});
/** The game minute time away may run the clock to: the end of a trip (and the sleep after it), a night, or the first call on your lists, else nowhere. */
export const awayUntil = q => op({op: 'awayUntil', q});
/** Back after time away (or a hidden tab): the clock moved on only as far as a trip, a night or a seat's wait needs. */
export const resume = (q, now = Date.now()) => op({op: 'resume', q, now});
/** Spends game time without real time passing. */
export const spendMinutes = (q, minutes, now = Date.now()) => op({op: 'spendMinutes', q, minutes, now});

/** Day of the week (0 Monday), hour and minute of game time `minutes`. */
export function dayHour(minutes) {
  const m = Math.floor(minutes);
  return {day: Math.floor(m / 1440) % 7, hour: Math.floor((m % 1440) / 60), minute: m % 60};
}
/** The clock as shown: "Fri 9:40 pm". */
export const clockText = minutes => op({op: 'clockText', minutes});

/** The buy-in range at stakes `[sb, bb]`, in chips: `room` may set its own limits in big blinds ({minBuyIn, maxBuyIn}). */
export const buyInRange = (stakes, room) => op({op: 'buyInRange', stakes, room: limits(room)});
/** Whether the bankroll covers a seat at these stakes. */
export const canSit = (q, stakes, room) => op({op: 'canSit', q, stakes, room: limits(room)});

/**
 * Sits down at `table` ({room, stakes, id, game, with}) with `amount` chips
 * from the bankroll, kept within the buy-in range. The new quest, or null if
 * the bankroll can't cover the minimum (or already seated, asleep, on the
 * road or played out).
 */
export const sitDown = (q, table, amount, room, now = Date.now()) =>
  op({op: 'sitDown', q, table: {id: table.id, room: table.room, stakes: table.stakes, game: table.game ?? null, with: table.with ?? null}, amount, room: limits(room), now}) ?? null;

/** The stack at the table (after a top-up, or when leaving). */
export const setStack = (q, stack) => (op({op: 'setStack', q, stack}) ?? q);
/** A hand played: the stack after it, counted, and kept if the session's biggest pot won or lost. */
export const recordHand = (q, stack) => (op({op: 'recordHand', q, stack}) ?? q);
/** Tops up between hands to `to` chips (at most the maximum buy-in), from the bankroll as far as it goes. */
export const topUp = (q, to, room) => (op({op: 'topUp', q, to, room: limits(room)}) ?? q);
/** The stacks you can top up to from `stack` chips: [{bbs, to, all}]. */
export const topUpChoices = (q, stack, room) => op({op: 'topUpChoices', q, stack, room: limits(room)});
/** Leaves the table: the stack goes back to the bankroll, and the session into the history. */
export const leave = (q, now = Date.now()) => (op({op: 'leave', q, now}) ?? q);

// ---- Rest (#351) ----
/** Game minutes at the tables since you last slept, the seat you're in included. */
export const tableMinutes = (q, now = Date.now()) => op({op: 'tableMinutes', q, now});
/** Played out: no more tables until you've slept. */
export const exhausted = (q, now = Date.now()) => op({op: 'exhausted', q, now});
/** Goes to sleep where you are, `where` 'home' or 'hotel', paying `cost`. Your places on lists are given up. */
export const sleep = (q, where, cost = 0, now = Date.now()) => (op({op: 'sleep', q, place: where, cost, now}) ?? q);
/** Awake again, if the night's over: the hours at the tables start from zero. */
export const wake = (q, now = Date.now()) => (op({op: 'wake', q, now}) ?? q);
/** Makes city `cityId` home, for `cost` from the bankroll (where you are now). */
export const moveHome = (q, cityId, cost) => (op({op: 'moveHome', q, city: cityId || null, cost}) ?? q);

/** Milestones the bankroll (with any stack at a table) has just reached: {q, reached}. */
export const checkMilestones = q => op({op: 'checkMilestones', q});
/** 'playing', 'won' or 'broke' (`cheapest` the smallest minimum buy-in in the world). */
export const status = (q, cheapest) => op({op: 'status', q, cheapest});
/** Starts a run in region `regionId`'s room `roomId`: where you put down roots. */
export const startIn = (q, regionId, roomId, cityId = null) => (op({op: 'startIn', q, region: regionId, room: roomId, city: cityId}) ?? q);
/** Sets off for room `roomId`, a trip of `minutes` game minutes, paying `cost`; `then` 'sleep' goes to bed on arrival. */
export const travel = (q, roomId, minutes, now = Date.now(), cost = 0, then = null) => (op({op: 'travel', q, room: roomId, minutes, now, cost, then}) ?? q);
/** The trip over, if it is: you're in the room you were going to. */
export const arrive = (q, now = Date.now()) => (op({op: 'arrive', q, now}) ?? q);

// ---- Waitlists ----
/** Puts your name on a game's list in this room: `game` {key, stakes, game}, `ahead` players before you, `gap` minutes between seats opening. */
export const joinList = (q, game, ahead, gap, now = Date.now()) => (op({op: 'joinList', q, game: {key: game.key, stakes: String(game.stakes), game: game.game ?? null}, ahead, gap, now}) ?? q);
/** Takes your name off a game's list. */
export const leaveList = (q, key) => (op({op: 'leaveList', q, key}) ?? q);
/** Where you stand on your lists: [{...entry, called, ahead, wait, expires}] (`expires` Infinity until you've seen the call). */
export const listStatus = (q, now = Date.now()) => op({op: 'listStatus', q, now});
/** Calls that ran out: the lists without them. */
export const dropMissed = (q, now = Date.now()) => (op({op: 'dropMissed', q, now}) ?? q);
/** The lobby is showing your calls: their CALL_MINUTES to take the seat start now. */
export const seeCalls = (q, now = Date.now()) => (op({op: 'seeCalls', q, now}) ?? q);
/** Calls you haven't seen yet. */
export const unseenCalls = (q, now = Date.now()) => op({op: 'unseenCalls', q, now});

/** A study question answered (quest-study.js). */
export const recordStudy = (q, right) => op({op: 'recordStudy', q, right: !!right});
/** The record of a run that's ended: how ('broke', 'won' or 'quit'), its peak and final bankroll, sessions and length. */
export const runRecord = (q, now = Date.now(), result = 'broke') => op({op: 'runRecord', q, now, result});
/** A run that's over starts again at $1,000 in the same world, on the same clock; reads, scenarios and backers carry over. */
export const newRun = (q, now = Date.now(), result = 'broke') => op({op: 'newRun', q, now, result});

// Loads the saved quest, or null. A quest saved while seated comes back
// still seated, with the stack it had after the last finished hand (the
// clock doesn't run away from a table); otherwise the clock is moved on for
// the time away.
export function loadQuest(storage = globalThis.localStorage, now = Date.now()) {
  let q = null;
  try {
    q = JSON.parse(storage.getItem(QUEST_KEY) || 'null');
  } catch {}
  if (!q || q.v !== 1 || !Number.isFinite(q.bankroll) || !q.clock) return null;
  q = {...newQuest(now, q.seed), ...q, history: Array.isArray(q.history) ? q.history : [], runs: Array.isArray(q.runs) ? q.runs : []};
  // Time away stops the clock, but for a trip or a night under way.
  q = resume(q, now);
  // Saved at a table: still there (a refresh shouldn't stand you up). The
  // page sits you back down with the stack you had after the last hand
  // finished; a hand cut off in the middle doesn't count.
  if (q.seat) return q;
  return wake(arrive(q, now), now);
}

export function saveQuest(q, storage = globalThis.localStorage) {
  try { storage.setItem(QUEST_KEY, JSON.stringify(q)); } catch {}
}
