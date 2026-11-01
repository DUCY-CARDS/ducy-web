import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import {
  AWAY_CAP_DAYS, GOAL, QUEST_SPEED, START_BANKROLL, buyInRange, canSit, clockText, dayHour, gameMinutes,
  leave, loadQuest, newQuest, saveQuest, setStack, sitDown, spendMinutes, status, syncClock, topUp, topUpChoices,
} from '../src/quest.js';
import { ROOMS, STAKES, activity, cheapestBuyIn, lobby, roomById, tablesRunning } from '../src/quest-rooms.js';

const MIN = 60000;
const memory = () => {
  const m = new Map();
  return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v))};
};

test('the clock runs four times real time, and an absence counts for at most a week', () => {
  const q = newQuest(0, 7);
  const start = gameMinutes(q, 0);
  assert.equal(gameMinutes(q, 15 * MIN) - start, 60, '15 real minutes is a game hour');
  assert.equal(gameMinutes(q, 6 * 60 * MIN) - start, 1440, 'six real hours is a game day');
  // A month away counts as a week.
  assert.equal(gameMinutes(q, 30 * 24 * 60 * MIN) - start, AWAY_CAP_DAYS * 1440);
  // Syncing while playing keeps the clock running at the same pace.
  const s = syncClock(q, 10 * MIN);
  assert.equal(gameMinutes(s, 20 * MIN), gameMinutes(q, 20 * MIN));
  assert.equal(QUEST_SPEED, 4);
  // Travelling spends game time at once.
  assert.equal(gameMinutes(spendMinutes(q, 30, 0), 0), start + 30);
});

test('the clock reads as a day and a time', () => {
  assert.equal(clockText(0), 'Mon 12:00 am');
  assert.equal(clockText(4 * 1440 + 21 * 60 + 40), 'Fri 9:40 pm');
  assert.deepEqual(dayHour(7 * 1440 + 90), {day: 0, hour: 1, minute: 30});
  // A new quest starts on a Friday evening.
  assert.match(clockText(gameMinutes(newQuest(0, 1), 0)), /^Fri 6:00 pm$/);
});

test('buy-ins run 40 to 200 big blinds, or a room’s own limits', () => {
  assert.deepEqual(buyInRange(STAKES['1/2']), {min: 8000, max: 40000});
  assert.deepEqual(buyInRange(STAKES['10/20'], roomById('ivory')), {min: 100000, max: 500000});
});

test('top-up choices: 40, 100 and 200 BB above your stack, as far as the bankroll pays', () => {
  const table = {room: 'deuce', stakes: STAKES['1/2'], id: 'deuce-1/2-1'};
  let q = sitDown(newQuest(0, 3), table, 20000);
  assert.deepEqual(topUpChoices(q, 15000), [{bbs: 100, to: 20000, all: false}, {bbs: 200, to: 40000, all: false}]);
  // At the maximum there's nothing to top up to.
  assert.deepEqual(topUpChoices(q, 40000), []);
  // A short bankroll: the top choice takes all of it, and choices it can't
  // reach drop out.
  q = {...q, bankroll: 3000};
  assert.deepEqual(topUpChoices(q, 15000), [{bbs: 100, to: 18000, all: true}]);
  assert.deepEqual(topUpChoices({...q, bankroll: 0}, 15000), []);
  assert.deepEqual(topUpChoices(newQuest(0, 3), 0), [], 'not seated');
});

test('chips go from the bankroll to the table and back', () => {
  let q = newQuest(0, 3);
  const table = {room: 'deuce', stakes: STAKES['1/2'], id: 'deuce-1/2-1'};
  // Asking for more than the maximum buys in for the maximum.
  q = sitDown(q, table, 99999999);
  assert.equal(q.seat.stack, 40000);
  assert.equal(q.bankroll, START_BANKROLL - 40000);
  assert.equal(sitDown(q, table, 10000), null, 'already seated');
  q = setStack(q, 25000);
  q = topUp(q, 40000);
  assert.equal(q.seat.stack, 40000);
  assert.equal(q.bankroll, START_BANKROLL - 55000);
  q = setStack(q, 70000);
  q = leave(q, 0);
  assert.equal(q.seat, null);
  assert.equal(q.bankroll, START_BANKROLL + 15000);
  assert.equal(q.history.at(-1).net, 15000);
  assert.equal(q.best, START_BANKROLL + 15000);
});

test('a seat needs the minimum buy-in', () => {
  const q = {...newQuest(0, 3), bankroll: 7999};
  assert.equal(canSit(q, STAKES['1/2']), false);
  assert.equal(sitDown(q, {room: 'deuce', stakes: STAKES['1/2'], id: 'x'}, 8000), null);
  assert.equal(status(q, cheapestBuyIn()), 'broke');
  assert.equal(status({...q, bankroll: GOAL}, cheapestBuyIn()), 'won');
  assert.equal(status(newQuest(0, 3), cheapestBuyIn()), 'playing');
});

test('a save round trips, and a refresh at a table keeps you in your seat', () => {
  const store = memory();
  let q = sitDown(newQuest(0, 9), {room: 'deuce', stakes: STAKES['1/2'], id: 'x'}, 20000);
  q = setStack(q, 26000);
  saveQuest(q, store);
  const back = loadQuest(store, 60 * MIN);
  assert.equal(back.seat.table, 'x');
  assert.equal(back.seat.stack, 26000);
  assert.equal(back.bankroll, START_BANKROLL - 20000);
  assert.equal(back.seed, 9);
  // Getting up later: the stack goes back to the bankroll.
  assert.equal(leave(back, 60 * MIN).bankroll, START_BANKROLL + 6000);
  // An hour away from a table barely moves the clock (it waits for play).
  assert.ok(gameMinutes(back, 60 * MIN) - gameMinutes(q, 0) <= 4);
  // Away from the tables, an hour doesn't move it at all (not on a trip or asleep).
  const up = leave(q, 0);
  saveQuest(up, store);
  assert.equal(Math.round(gameMinutes(loadQuest(store, 60 * MIN), 60 * MIN) - gameMinutes(up, 0)), 0);
  assert.equal(loadQuest(memory()), null);
  const bad = memory();
  bad.setItem('ducyQuest', '{broken');
  assert.equal(loadQuest(bad), null);
});

test('rooms are busiest on Friday and Saturday nights', () => {
  assert.ok(activity(4, 21) > activity(1, 21), 'Friday night over Tuesday night');
  assert.ok(activity(1, 21) > activity(1, 9), 'evening over morning');
  const tables = (day, hour) => tablesRunning(5, roomById('deuce'), ROOMS[0].games[0], day * 1440 + hour * 60);
  assert.ok(tables(4, 21) > tables(1, 6), `${tables(4, 21)} vs ${tables(1, 6)}`);
});

test('the big games run only in their windows, and only some of the time', () => {
  const ivory = roomById('ivory');
  const big = ivory.games.find(g => g.stakes === '50/100');
  let inside = 0, outside = 0, windows = 0;
  for (let week = 0; week < 40; week++) {
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const m = (week * 7 + day) * 1440 + hour * 60;
        const n = tablesRunning(11, ivory, big, m);
        const weekendNight = (day === 4 || day === 5) && (hour >= 20 || hour < 3);
        if (weekendNight) { windows++; if (n) inside++; } else if (n) outside++;
      }
    }
  }
  assert.equal(outside, 0);
  assert.ok(inside > 0 && inside < windows, `${inside} of ${windows}`);
});

test('the world is the same on reload, and differs between seeds', () => {
  const at = 4 * 1440 + 21 * 60;
  assert.deepEqual(lobby(42, at), lobby(42, at));
  const counts = seed => JSON.stringify(Array.from({length: 48}, (_, h) => lobby(seed, h * 60).map(r => r.games.map(g => g.tables))));
  assert.notEqual(counts(42), counts(43));
  assert.equal(cheapestBuyIn(), 8000);
});
