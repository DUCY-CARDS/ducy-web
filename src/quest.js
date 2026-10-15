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
  return {v: 1, seed, bankroll: START_BANKROLL, clock: {real: now, game: START_MINUTES}, seat: null, room: null, best: START_BANKROLL, history: []};
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

// Spends game time without real time passing (travelling between rooms).
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

// Sits down at `table` ({room, stakes, id}) with `amount` chips from the
// bankroll, kept within the buy-in range. Returns the new quest, or null if
// the bankroll can't cover the minimum (or already seated).
export function sitDown(q, table, amount, room) {
  const {min, max} = buyInRange(table.stakes, room);
  if (q.seat || q.bankroll < min) return null;
  const chips = Math.max(min, Math.min(max, q.bankroll, Math.round(amount)));
  return {...q, bankroll: q.bankroll - chips, room: table.room, seat: {table: table.id, room: table.room, stakes: table.stakes, stack: chips, bought: chips}};
}

// The stack at the table after a hand.
export function setStack(q, stack) {
  return q.seat ? {...q, seat: {...q.seat, stack: Math.max(0, Math.round(stack))}} : q;
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

// Leaves the table: the stack goes back to the bankroll, and the session
// (what was bought in and taken away) goes into the history.
export function leave(q, now = Date.now()) {
  if (!q.seat) return q;
  const {stack, bought, stakes, room} = q.seat;
  const bankroll = q.bankroll + stack;
  const session = {at: Math.floor(gameMinutes(q, now)), room, stakes, net: stack - bought};
  return {...q, bankroll, seat: null, best: Math.max(q.best, bankroll), history: [...q.history, session].slice(-500)};
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

// Loads the saved quest, or null. A quest saved while seated comes back
// with the stack returned to the bankroll (no hands are played away), and
// the clock moved on for the time away.
export function loadQuest(storage = globalThis.localStorage, now = Date.now()) {
  let q = null;
  try {
    q = JSON.parse(storage.getItem(QUEST_KEY) || 'null');
  } catch {}
  if (!q || q.v !== 1 || !Number.isFinite(q.bankroll) || !q.clock) return null;
  q = {...newQuest(now, q.seed), ...q, history: Array.isArray(q.history) ? q.history : []};
  if (q.seat) q = leave(q, now);
  return syncClock(q, now);
}

export function saveQuest(q, storage = globalThis.localStorage) {
  try { storage.setItem(QUEST_KEY, JSON.stringify(q)); } catch {}
}
