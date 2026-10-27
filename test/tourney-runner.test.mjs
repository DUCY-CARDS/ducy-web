// A club tournament's runner (#458, src/tourney-runner.js): events in with
// the time, steps out with the next time to wake it. A scripted tournament;
// no timers. ducy-play's runner is ported against these.
// Run with: node --test test/tourney-runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT_PACE_MS, NEXT_HAND_MS, tourneyRunner } from '../src/tourney-runner.js';

const MIN = 60_000;
// Level 1 (10 min), a break (5), level 2 (10), level 3 (10).
const STRUCTURE = [{minutes: 10}, {minutes: 5, break: true}, {minutes: 10}, {minutes: 10}];

// A tournament whose results the test sets; every call is kept, with the time.
function scripted() {
  const calls = [];
  const s = {level: 0, autoToAct: false, canDeal: false, over: false, tables: [], events: null, views: {}};
  const res = () => ({level: s.level, autoToAct: s.autoToAct, canDeal: s.canDeal, over: s.over, tables: s.tables.map(x => ({...x})), events: s.events, out: []});
  const t = {calls, s, tableView: table => s.views[table] ?? null};
  for (const m of ['handle', 'disconnected', 'addEntry', 'advance', 'tick', 'newHands', 'state']) {
    t[m] = (...args) => { const time = args.pop(); calls.push({m, args, time}); return res(); };
  }
  t.setLevel = (level, time) => { calls.push({m: 'setLevel', args: [level], time}); s.level = level; return res(); };
  return t;
}

const made = (t, m) => t.calls.filter(c => c.m === m);

test('the level clock: each level its time, a break with no new hands, then the next level; the last stays', () => {
  const t = scripted();
  const r = tourneyRunner(t, {id: 'x', structure: STRUCTURE});
  let step = r.event({type: 'begin'}, 0);
  assert.deepEqual(made(t, 'setLevel'), [], 'level 1 is where it starts');
  assert.deepEqual([step.step, step.onBreak, step.stepEndsAt, step.wake], [0, false, 10 * MIN, 10 * MIN]);
  // The break: no hands dealt, though the tables could.
  t.s.canDeal = true;
  step = r.event({type: 'wake'}, 10 * MIN);
  assert.deepEqual([step.step, step.onBreak, step.wake], [1, true, 15 * MIN]);
  assert.equal(made(t, 'newHands').length, 0);
  // Level 2 after it: the engine's level moves, and hands come again.
  step = r.event({type: 'wake'}, 15 * MIN);
  assert.deepEqual(made(t, 'setLevel').map(c => c.args[0]), [1]);
  assert.deepEqual([step.step, step.level, step.wake], [2, 1, 15 * MIN + NEXT_HAND_MS]);
  step = r.event({type: 'wake'}, 15 * MIN + NEXT_HAND_MS);
  assert.equal(made(t, 'newHands').length, 1);
  // Level 3 is the last: it stays, with no end.
  t.s.canDeal = false;
  step = r.event({type: 'wake'}, 25 * MIN);
  assert.deepEqual([step.step, step.level, step.stepEndsAt, step.wake], [3, 2, 35 * MIN, null]);
});

test('resumed: the clock goes on from its step with the time it had left', () => {
  const t = scripted();
  t.s.level = 1;
  const r = tourneyRunner(t, {id: 'x', structure: STRUCTURE, step: 2, stepLeftMs: 4 * MIN, level: 1});
  const step = r.event({type: 'begin'}, 1000);
  assert.equal(made(t, 'setLevel').length, 0, 'already at that level');
  assert.deepEqual([step.step, step.stepEndsAt, step.wake], [2, 1000 + 4 * MIN, 1000 + 4 * MIN]);
});

test('pacing: an absent player’s move, the next hands, and the soonest turn clock', () => {
  const t = scripted();
  const r = tourneyRunner(t, {id: 'x', structure: STRUCTURE, levelMs: 60 * MIN});
  r.event({type: 'begin'}, 0);
  Object.assign(t.s, {autoToAct: true, tables: [{id: 0, inHand: true, turnMsLeft: 9000}, {id: 1, inHand: true, turnMsLeft: 4000}]});
  let step = r.event({type: 'state'}, 100);
  assert.equal(step.wake, 100 + BOT_PACE_MS);
  t.s.autoToAct = false;
  step = r.event({type: 'wake'}, 100 + BOT_PACE_MS);
  assert.equal(made(t, 'advance').length, 1);
  assert.equal(step.wake, 100 + BOT_PACE_MS + 4050, 'the soonest turn clock');
  r.event({type: 'wake'}, 100 + BOT_PACE_MS + 4050);
  assert.equal(made(t, 'tick').length, 1);
  // Woken early, nothing happens.
  const n = t.calls.length;
  r.event({type: 'wake'}, 200);
  assert.equal(t.calls.length, n);
});

test('a table that finished a hand reports it once, when asked to', () => {
  const t = scripted();
  t.s.views = {0: {complete: true, hand_number: 3}, 1: {complete: false, hand_number: 4}};
  t.s.tables = [{id: 0, inHand: false}, {id: 1, inHand: true}];
  const r = tourneyRunner(t, {id: 'x', structure: STRUCTURE, hands: true});
  let step = r.event({type: 'begin'}, 0);
  assert.deepEqual(step.actions.filter(a => a.type === 'hand').map(a => [a.table, a.view.hand_number]), [[0, 3]]);
  step = r.event({type: 'state'}, 1);
  assert.equal(step.actions.filter(a => a.type === 'hand').length, 0, 'not twice');
  const quiet = tourneyRunner(scripted(), {id: 'y', structure: STRUCTURE});
  assert.equal(quiet.event({type: 'begin'}, 0).actions.filter(a => a.type === 'hand').length, 0);
});

test('players’ commands and entries reach the tournament; over, nothing more is due', () => {
  const t = scripted();
  const r = tourneyRunner(t, {id: 'x', structure: STRUCTURE});
  r.event({type: 'begin'}, 0);
  r.event({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}}, 1);
  r.event({type: 'disconnected', id: 'bob'}, 2);
  r.event({type: 'addEntry', id: 'cy', name: 'Cy'}, 3);
  assert.deepEqual(t.calls.slice(1).map(c => [c.m, ...c.args]), [['handle', 'ann', {type: 'join', name: 'Ann'}], ['disconnected', 'bob'], ['addEntry', 'cy', 'Cy']]);
  Object.assign(t.s, {canDeal: true, events: {winner: {id: 'ann'}}});
  assert.equal(r.event({type: 'state'}, 4).wake, null);
  assert.throws(() => r.event({type: 'nope'}, 5), /no event nope/);
});
