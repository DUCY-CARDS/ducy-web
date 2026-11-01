// The Quest terms and rooms the page keeps in JS are ducy-quest's (#466).
// Run with: node --test test/quest-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { quest } from '../wasm/ducy_wasm.js';
import {
  AWAY_CAP_DAYS, AWAY_MS, CALL_MINUTES, GOAL, MAX_BUY_IN_BB, MAX_TABLE_MINUTES, MILESTONES, MIN_BUY_IN_BB, QUEST_SPEED,
  SLEEP_MINUTES, START_BANKROLL, TABLE_IDLE_MS, TIRED_MINUTES,
} from '../src/quest.js';
import { ROOMS, STAKES, cheapestBuyIn } from '../src/quest-rooms.js';
import { READ_HANDS, TAGS } from '../src/quest-reads.js';
import { NEVER } from '../src/quest-backer.js';

test('the terms kept here are ducy-quest’s', () => {
  const r = quest({op: 'rules'});
  assert.deepEqual(
    {startBankroll: r.startBankroll, goal: r.goal, questSpeed: r.questSpeed, awayCapDays: r.awayCapDays, minBuyInBb: r.minBuyInBb, maxBuyInBb: r.maxBuyInBb,
      tableIdleMs: r.tableIdleMs, awayMs: r.awayMs, maxTableMinutes: r.maxTableMinutes, tiredMinutes: r.tiredMinutes, sleepMinutes: r.sleepMinutes,
      callMinutes: r.callMinutes, milestones: r.milestones, tags: r.tags, readHands: r.readHands, never: r.never},
    {startBankroll: START_BANKROLL, goal: GOAL, questSpeed: QUEST_SPEED, awayCapDays: AWAY_CAP_DAYS, minBuyInBb: MIN_BUY_IN_BB, maxBuyInBb: MAX_BUY_IN_BB,
      tableIdleMs: TABLE_IDLE_MS, awayMs: AWAY_MS, maxTableMinutes: MAX_TABLE_MINUTES, tiredMinutes: TIRED_MINUTES, sleepMinutes: SLEEP_MINUTES,
      callMinutes: CALL_MINUTES, milestones: MILESTONES, tags: TAGS, readHands: READ_HANDS, never: NEVER},
  );
  assert.equal(r.cheapest, cheapestBuyIn());
});

test('the rooms kept here are ducy-quest’s', () => {
  const r = quest({op: 'rules'});
  assert.deepEqual(r.stakes, Object.entries(STAKES));
  assert.deepEqual(r.rooms, ROOMS.map(room => ({
    id: room.id, city: room.city, name: room.name, local: !!room.local, min_buy_in: room.minBuyIn ?? null, max_buy_in: room.maxBuyIn ?? null,
    games: room.games.map(g => ({stakes: g.stakes, game: g.game || 'nlhe', tables: g.tables, chance: g.chance ?? null, when: g.when ?? null})),
  })));
});
