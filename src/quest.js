// Bankroll Quest (#299): turn $1,000 into $1,000,000 across a world of card
// rooms. This file is the bankroll, the world clock and the save (#300);
// quest-rooms.js is the rooms and their schedules (#301). Amounts are in
// hundredths, like the rest of the page (100 is $1).
//
// The clock runs QUEST_SPEED times real time, while the page is open and
// while it's closed, so a game day is six real hours; a long absence counts
// for at most AWAY_CAP_DAYS game days. Game time is minutes since the world
// began, a Monday at midnight.

export const QUEST_KEY = 'ducyQuest';
export const START_BANKROLL = 100000; // $1,000
export const GOAL = 100000000; // $1,000,000
export const QUEST_SPEED = 4;
export const AWAY_CAP_DAYS = 7;
// Buy-ins, in big blinds, unless a room sets its own.
export const MIN_BUY_IN_BB = 40;
export const MAX_BUY_IN_BB = 200;
// The world starts on a Friday evening, when the rooms are busiest.
const START_MINUTES = 4 * 1440 + 18 * 60;

const DAY = 1440;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// A new quest: the starting bankroll, the clock anchored at `now` (real
// milliseconds), and the seed its world is built from.
export function newQuest(now = Date.now(), seed = (Math.random() * 2 ** 32) >>> 0) {
  // No room yet: a run starts by choosing where to put down roots (startIn).
  return {v: 1, seed, bankroll: START_BANKROLL, clock: {real: now, game: START_MINUTES}, seat: null, room: null, trip: null, lists: [], best: START_BANKROLL, history: [], runs: []};
}

// Game minutes at real time `now`: the anchor plus QUEST_SPEED times the
// real time since, capped at AWAY_CAP_DAYS game days.
export function gameMinutes(q, now = Date.now()) {
  const elapsed = Math.max(0, now - q.clock.real) / 60000 * QUEST_SPEED;
  return q.clock.game + Math.min(elapsed, AWAY_CAP_DAYS * DAY);
}

// Moves the anchor to `now`, so the cap counts from here: called on load
// and while playing (a long session isn't an absence).
export function syncClock(q, now = Date.now()) {
  return {...q, clock: {real: now, game: gameMinutes(q, now)}};
}

// Spends game time without real time passing.
export function spendMinutes(q, minutes, now = Date.now()) {
  const s = syncClock(q, now);
  return {...s, clock: {real: now, game: s.clock.game + minutes}};
}

// Day of the week (0 Monday) and hour, and the clock as shown: "Fri 9:40 pm".
export function dayHour(minutes) {
  const m = Math.floor(minutes);
  return {day: Math.floor(m / DAY) % 7, hour: Math.floor((m % DAY) / 60), minute: m % 60};
}
export function clockText(minutes) {
  const {day, hour, minute} = dayHour(minutes);
  const h12 = hour % 12 || 12;
  return `${DAYS[day]} ${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

// The buy-in range at stakes `[sb, bb]`, in chips: `room` may set its own
// limits in big blinds ({minBuyIn, maxBuyIn}).
export function buyInRange(stakes, room = {}) {
  const bb = stakes[1];
  return {min: (room.minBuyIn ?? MIN_BUY_IN_BB) * bb, max: (room.maxBuyIn ?? MAX_BUY_IN_BB) * bb};
}

// Whether the bankroll covers a seat at these stakes.
export const canSit = (q, stakes, room) => q.bankroll >= buyInRange(stakes, room).min;

// Sits down at `table` ({room, stakes, id, game}; Hold'em unless `game`
// says 'plo4') with `amount` chips from the bankroll, kept within the buy-in
// range. Returns the new quest, or null if the bankroll can't cover the
// minimum (or already seated).
export function sitDown(q, table, amount, room) {
  const {min, max} = buyInRange(table.stakes, room);
  if (q.seat || q.bankroll < min) return null;
  const chips = Math.max(min, Math.min(max, q.bankroll, Math.round(amount)));
  const game = table.game || 'nlhe';
  // Sitting down takes your name off every list.
  return {
    ...q, bankroll: q.bankroll - chips, room: table.room, lists: [],
    seat: {table: table.id, room: table.room, stakes: table.stakes, game, stack: chips, bought: chips, hands: 0, bigWin: 0, bigLoss: 0, with: table.with || []},
  };
}

// The stack at the table (after a top-up, or when leaving).
export function setStack(q, stack) {
  return q.seat ? {...q, seat: {...q.seat, stack: Math.max(0, Math.round(stack))}} : q;
}

// A hand played: the stack after it, the hand counted, and its result kept
// if it's the session's biggest pot won or lost.
export function recordHand(q, stack) {
  if (!q.seat) return q;
  const after = Math.max(0, Math.round(stack));
  const net = after - q.seat.stack;
  const s = q.seat;
  return {...q, seat: {...s, stack: after, hands: (s.hands || 0) + 1, bigWin: Math.max(s.bigWin || 0, net), bigLoss: Math.min(s.bigLoss || 0, net)}};
}

// Tops up between hands to `to` chips (at most the maximum buy-in), from the
// bankroll as far as it goes.
export function topUp(q, to, room) {
  if (!q.seat) return q;
  const {max} = buyInRange(q.seat.stakes, room);
  const add = Math.max(0, Math.min(Math.round(to), max) - q.seat.stack);
  const paid = Math.min(add, q.bankroll);
  return {...q, bankroll: q.bankroll - paid, seat: {...q.seat, stack: q.seat.stack + paid, bought: q.seat.bought + paid}};
}

// The stacks you can top up to at the table, from `stack` chips: 40, 100
// and 200 big blinds and the room's maximum buy-in, as far as the bankroll
// pays. [{bbs, to, all}]: `to` the stack after it, `all` when the bankroll
// can't pay the whole way and this takes all of it.
export function topUpChoices(q, stack, room) {
  if (!q.seat) return [];
  const bb = q.seat.stakes[1];
  const {max} = buyInRange(q.seat.stakes, room);
  const levels = [...new Set([40, 100, 200].map(b => b * bb).filter(x => x <= max).concat(max))].sort((a, b) => a - b);
  const out = [];
  for (const level of levels) {
    const to = Math.min(level, stack + q.bankroll);
    if (to <= stack || out.some(o => o.to === to)) continue;
    out.push({bbs: Math.round(level / bb), to, all: to < level});
  }
  return out;
}

// Leaves the table: the stack goes back to the bankroll, and the session
// (what was bought in and taken away) goes into the history.
export function leave(q, now = Date.now()) {
  if (!q.seat) return q;
  const {stack, bought, stakes, room, game = 'nlhe', hands = 0, bigWin = 0, bigLoss = 0, with: regulars = []} = q.seat;
  const bankroll = q.bankroll + stack;
  const session = {at: Math.floor(gameMinutes(q, now)), room, stakes, game, net: stack - bought, hands, bigWin, bigLoss, with: regulars, bankroll};
  return {
    ...q, bankroll, seat: null, best: Math.max(q.best, bankroll), hands: (q.hands || 0) + hands,
    history: [...q.history, session].slice(-500),
  };
}

// Milestones on the way to GOAL, each announced once a run.
export const MILESTONES = [
  {at: 500000, text: '$5,000: five times what you started with.'},
  {at: 2500000, text: '$25,000: the big games in the Ivory Room are within reach.'},
  {at: 10000000, text: '$100,000: six figures.'},
  {at: 25000000, text: '$250,000: a quarter of a million.'},
  {at: 50000000, text: '$500,000: halfway there, in dollars.'},
];

// Milestones the bankroll (with any stack at a table) has just reached:
// {q, reached}, the quest with them marked done and the new ones in order.
export function checkMilestones(q) {
  const total = q.bankroll + (q.seat?.stack || 0);
  const done = new Set(q.milestones || []);
  const reached = MILESTONES.filter(m => total >= m.at && !done.has(m.at));
  if (!reached.length) return {q, reached};
  return {q: {...q, milestones: [...done, ...reached.map(m => m.at)]}, reached};
}

// The quest's state: 'playing', 'won' (the bankroll, with any stack at the
// table, reached GOAL) or 'broke' (can't cover any seat and has no chips at
// a table; `cheapest` is the smallest minimum buy-in in the world).
export function status(q, cheapest) {
  const total = q.bankroll + (q.seat?.stack || 0);
  if (total >= GOAL) return 'won';
  if (!q.seat && q.bankroll < cheapest) return 'broke';
  return 'playing';
}

// Starts a run in region `regionId`'s small town (`roomId`, its room): where
// you put down roots. Only before you're anywhere.
export function startIn(q, regionId, roomId) {
  if (q.room || q.trip) return q;
  return {...q, home: regionId, room: roomId};
}

// Sets off for room `roomId`, a trip of `minutes` game minutes. The trip takes
// real time (the clock runs four times real time, so six game minutes is a
// minute and a half): you're on the road until it's over, and you can't skip
// it. Your places on waitlists are given up. Not while seated, already on
// the road, or to the room you're in.
export function travel(q, roomId, minutes, now = Date.now()) {
  if (q.seat || q.trip || q.room === roomId) return q;
  const at = gameMinutes(q, now);
  return {...q, trip: {from: q.room, to: roomId, start: at, end: at + minutes}, lists: []};
}

// The trip over, if it is: you're in the room you were going to.
export function arrive(q, now = Date.now()) {
  if (!q.trip || gameMinutes(q, now) < q.trip.end) return q;
  return {...q, room: q.trip.to, trip: null};
}

// ---- Waitlists ----
// Every game has a list of players waiting for a seat; you join it in the
// room you're in and wait your turn (study while you wait). When your name
// is called you have CALL_MINUTES to take the seat, or you lose it.
export const CALL_MINUTES = 8;

// Puts your name on a game's list in this room: `game` is {key, stakes,
// game}, `ahead` the players waiting before you and `gap` the game minutes
// between seats opening. Your name is called when they've all been seated.
export function joinList(q, game, ahead, gap, now = Date.now()) {
  if (q.seat || q.trip || !q.room || (q.lists || []).some(l => l.key === game.key)) return q;
  const at = gameMinutes(q, now);
  const entry = {key: game.key, stakes: game.stakes, game: game.game || 'nlhe', room: q.room, joined: at, gap, callAt: at + (ahead + 1) * gap};
  return {...q, lists: [...(q.lists || []), entry]};
}

/** Takes your name off a game's list. */
export const leaveList = (q, key) => ({...q, lists: (q.lists || []).filter(l => l.key !== key)});

/**
 * Where you stand on your lists at real time `now`: [{...entry, called,
 * ahead, wait}]: `called` once your seat is ready, `ahead` the players still
 * before you, `wait` game minutes until you're called (or, called, left to
 * take the seat). Lists in other rooms, and calls not taken in time, drop off.
 */
export function listStatus(q, now = Date.now()) {
  const at = gameMinutes(q, now);
  return (q.lists || [])
    .filter(l => l.room === q.room && at < l.callAt + CALL_MINUTES)
    .map(l => {
      const called = at >= l.callAt;
      return {...l, called, ahead: called ? 0 : Math.max(0, Math.ceil((l.callAt - at) / l.gap) - 1), wait: called ? l.callAt + CALL_MINUTES - at : l.callAt - at};
    });
}

/** Calls that ran out (you didn't take the seat in time): the lists without them. */
export function dropMissed(q, now = Date.now()) {
  const at = gameMinutes(q, now);
  const kept = (q.lists || []).filter(l => l.room === q.room && at < l.callAt + CALL_MINUTES);
  return kept.length === (q.lists || []).length ? q : {...q, lists: kept};
}

// ---- Study ----
// Questions answered while travelling or waiting (quest-study.js): how many,
// and how many right.
export function recordStudy(q, right) {
  const s = q.study || {n: 0, right: 0};
  return {...q, study: {n: s.n + 1, right: s.right + (right ? 1 : 0)}};
}

// The record of a run that's ended: its peak, sessions and how long it ran.
export const runRecord = (q, now = Date.now(), result = 'broke') => ({
  result, peak: q.best, sessions: q.history.length, hands: q.hands || 0,
  minutes: Math.floor(gameMinutes(q, now) - (q.started ?? START_MINUTES)), ended: now,
});

// A run that's over (broke, or won) starts again at $1,000 in the same
// world, on the same clock, with the past runs kept (the newest 20). What
// you know about the players (reads) carries over: it's the same world.
export function newRun(q, now = Date.now(), result = 'broke') {
  const fresh = newQuest(now, q.seed);
  const clock = syncClock(q, now).clock;
  // You start again where you are; after a trip, where it was going.
  const room = q.trip ? q.trip.to : q.room;
  return {
    ...fresh, clock, started: clock.game, room, home: q.home, runs: [...(q.runs || []), runRecord(q, now, result)].slice(-20),
    reads: q.reads || {}, readStats: q.readStats, people: q.people || {}, study: q.study,
  };
}

// Loads the saved quest, or null. A quest saved while seated comes back
// with the stack returned to the bankroll (no hands are played away), and
// the clock moved on for the time away.
export function loadQuest(storage = globalThis.localStorage, now = Date.now()) {
  let q = null;
  try {
    q = JSON.parse(storage.getItem(QUEST_KEY) || 'null');
  } catch {}
  if (!q || q.v !== 1 || !Number.isFinite(q.bankroll) || !q.clock) return null;
  q = {...newQuest(now, q.seed), ...q, history: Array.isArray(q.history) ? q.history : [], runs: Array.isArray(q.runs) ? q.runs : []};
  if (q.seat) q = leave(q, now);
  return arrive(syncClock(q, now), now);
}

export function saveQuest(q, storage = globalThis.localStorage) {
  try { storage.setItem(QUEST_KEY, JSON.stringify(q)); } catch {}
}
