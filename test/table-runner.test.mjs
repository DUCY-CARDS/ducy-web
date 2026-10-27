// A club table's runner (#452, src/table-runner.js): events in with the
// time, steps out with the next time to wake it. A scripted table and
// made-up fair-deal functions; no timers. ducy-play's runner is ported
// against these. Run with: node --test test/table-runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_MS, BOT_PACE_MS, FAIR_STEP_MS, IDLE_MS, NEXT_HAND_MS, RESUME_GRACE_MS, tableRunner,
} from '../src/table-runner.js';

// A table whose state the test sets; every call is kept, with the engine's time.
function scripted() {
  const calls = [];
  const s = {players: [], complete: true, hand: 0, turnMsLeft: null, playersIn: 0, botToAct: false, seats: []};
  const res = extra => ({
    out: [], seq: calls.length, players: s.players.map(p => ({...p})), playersIn: s.playersIn, turnMsLeft: s.turnMsLeft,
    botToAct: s.botToAct, state: {complete: s.complete, hand_number: s.hand, seats: s.seats}, ...extra,
  });
  const table = {
    calls, s,
    handle(id, cmd, time) {
      calls.push({m: 'handle', id, cmd, time});
      if (cmd.type === 'join' && !s.players.some(p => p.client_id === id)) s.players.push({client_id: id, seat: s.players.length, chips: 100});
      return res();
    },
    newHand(time, seed) {
      calls.push({m: 'newHand', seed, time});
      s.hand++;
      s.complete = false;
      s.seats = s.players.map(() => ({empty: false}));
      // Everyone dealt in sees their own cards.
      return res({out: s.players.map(p => ({to: p.client_id, data: {view: {seats: [{cards: ['As', 'Kd']}]}}}))});
    },
  };
  for (const m of ['disconnected', 'advance', 'tick', 'approveChips', 'denyChips', 'remove', 'state', 'resume']) {
    table[m] = (...args) => { const time = args.pop(); calls.push({m, args, time}); return res(); };
  }
  table.setMustPlay = (id, on, time) => calls.push({m: 'setMustPlay', id, on, time});
  return table;
}

// Fair-deal functions that are easy to follow.
let n = 0;
const fair = {
  secret: () => { n++; return {value: `v${n}`.padEnd(64, '0'), nonce: 'n'.padEnd(64, '0'), commitment: `c${n}`}; },
  commitment: value => 'f' + value.slice(1),
  seed: values => values.join('+'),
};

const hex = c => c.repeat(64);
const sends = step => step.actions.filter(a => a.type === 'send');
const engineCalls = (table, m) => table.calls.filter(c => c.m === m);

function setUp(opts = {}) {
  const table = scripted();
  const runner = tableRunner(table, {id: 't1', fair, ...opts});
  return {table, s: table.s, runner, ev: (e, at) => runner.event(e, at)};
}

test('the engine’s clock stops while no one seated is connected or the host can’t reach the relay, and goes on with the time left', () => {
  const {table, s, ev} = setUp();
  s.turnMsLeft = 1000;
  let step = ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: true}, 10_000);
  assert.equal(step.stopped, false);
  assert.equal(step.wake, 10_000 + 1050, 'woken for the turn clock');
  // The link goes: stopped, and nothing to wake for but the idle check.
  step = ev({type: 'link', ok: false}, 10_500);
  assert.equal(step.stopped, true);
  assert.ok(step.wake >= 10_500 + 30_000, 'no turn clock while stopped');
  // Five minutes later it's back: the engine's time has moved on only by the 500 ms before it stopped.
  step = ev({type: 'link', ok: true}, 310_500);
  assert.equal(step.stopped, false);
  assert.equal(table.calls.at(-1).m, 'state', 'the state again, for the turn clock');
  assert.equal(table.calls.at(-1).time - table.calls[0].time, 500);
  assert.equal(step.wake, 310_500 + 1050);
  // Ann drops off: stopped again; back: going again.
  assert.equal(ev({type: 'presence', id: 'ann', on: false}, 311_000).stopped, true);
  assert.equal(ev({type: 'presence', id: 'ann', on: true}, 400_000).stopped, false);
  assert.equal(table.calls.at(-1).time - table.calls[0].time, 1000);
});

test('one wake time: the turn clock, an away player’s move, the sit-out sweep', () => {
  const {table, s, ev} = setUp();
  s.turnMsLeft = 20_000;
  ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: true}, 0);
  // Nothing sooner than the sweep, every 5 s, for the sit-out limit.
  let step = ev({type: 'state'}, 0);
  assert.equal(step.wake, 5000);
  step = ev({type: 'wake'}, 5000);
  assert.equal(engineCalls(table, 'tick').length, 1);
  assert.equal(step.wake, 10_000);
  // An away player to act: their move comes first.
  s.botToAct = true;
  step = ev({type: 'state'}, 6000);
  assert.equal(step.wake, 6000 + BOT_PACE_MS);
  s.botToAct = false;
  ev({type: 'wake'}, 6000 + BOT_PACE_MS);
  assert.equal(engineCalls(table, 'advance').length, 1);
  // Woken early, nothing happens.
  const before = table.calls.length;
  ev({type: 'wake'}, 6800);
  assert.equal(table.calls.length, before);
});

test('the next hand is dealt from a fair-deal round: commitments, then the list and reveals, then the seed', () => {
  const {table, s, ev} = setUp();
  ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: true}, 0);
  s.playersIn = 2;
  // Two in, between hands: each is asked to commit, and the hand is due.
  let step = ev({type: 'cmd', id: 'bob', cmd: {type: 'join', name: 'Bob'}, online: true}, 1000);
  const asks = sends(step).filter(a => a.update.step === 'commit');
  assert.deepEqual(asks.map(a => a.to).sort(), ['ann', 'bob']);
  const round = asks[0].update.round;
  // Both commit: the list goes to each, host first.
  ev({type: 'cmd', id: 'ann', cmd: {type: 'fair_commit', round, c: fair.commitment(hex('a'))}}, 1100);
  step = ev({type: 'cmd', id: 'bob', cmd: {type: 'fair_commit', round, c: fair.commitment(hex('b'))}}, 1200);
  const lists = sends(step).filter(a => a.update.step === 'reveal');
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[0].update.list.map(e => e.id), ['host', 'ann', 'bob']);
  // A reveal that doesn't open its commitment is left out.
  ev({type: 'cmd', id: 'ann', cmd: {type: 'fair_reveal', round, value: hex('a'), nonce: hex('0')}}, 1300);
  ev({type: 'cmd', id: 'bob', cmd: {type: 'fair_reveal', round, value: hex('d'), nonce: hex('0')}}, 1400);
  // Bob's time is up; the hand is dealt from the host's value and Ann's.
  ev({type: 'wake'}, 1400 + FAIR_STEP_MS);
  ev({type: 'wake'}, 1000 + 500 + FAIR_STEP_MS * 2);
  const dealt = engineCalls(table, 'newHand');
  assert.equal(dealt.length, 1);
  assert.match(dealt[0].seed, new RegExp(`\\+${hex('a')}$`));
  assert.equal(dealt[0].seed.split('+').length, 2);
  // The hand over: each dealt in gets the reveals, after its final state.
  s.complete = true;
  step = ev({type: 'state'}, 30_000);
  const types = step.actions.map(a => a.type);
  assert.equal(types[0], 'engine');
  const results = sends(step).filter(a => a.update.step === 'result');
  assert.deepEqual(results.map(a => [a.to, a.update.index, a.update.dealt]), [['ann', 0, 2], ['bob', 1, 2]]);
  assert.equal(results[0].update.seed, dealt[0].seed);
  // The next hand is due NEXT_HAND_MS on, its round already under way.
  assert.equal(step.wake <= 30_000 + NEXT_HAND_MS, true);
  // Ann comes back to the table later: she gets that result again.
  const again = sends(ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: true}, 31_000));
  assert.ok(again.some(a => a.to === 'ann' && a.update.step === 'result'));
});

test('no commitments in time: the hand is dealt anyway, a little after the round’s wait', () => {
  const {table, s, ev} = setUp();
  ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: true}, 0);
  s.playersIn = 2;
  ev({type: 'cmd', id: 'bob', cmd: {type: 'join', name: 'Bob'}, online: true}, 0);
  for (let t = 0; t <= 10_000; t += 100) ev({type: 'wake'}, t);
  const dealt = engineCalls(table, 'newHand');
  assert.equal(dealt.length, 1);
  assert.equal(dealt[0].seed.split('+').length, 1, 'from the host’s value alone');
  assert.ok(dealt[0].time <= FAIR_STEP_MS * 2 + 300);
});

test('idle seats: asked “Still here?” when connected, stood up when not answered; at once when not connected', () => {
  const {s, ev} = setUp();
  ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: true}, 0);
  ev({type: 'cmd', id: 'bob', cmd: {type: 'join', name: 'Bob'}, online: false}, 0);
  let step = ev({type: 'state'}, 0);
  assert.equal(step.wake, 0 + 5000, 'the sweep first');
  s.playersIn = 0;
  step = ev({type: 'wake'}, IDLE_MS);
  // Bob isn't connected: stood up. Ann is: asked.
  assert.deepEqual(step.actions.filter(a => a.type === 'idle').map(a => a.id), ['bob']);
  assert.deepEqual(sends(step).filter(a => a.update.type === 'idle').map(a => [a.to, a.update.secs]), [['ann', ASK_MS / 1000]]);
  // She answers: the question goes, and she has another while.
  step = ev({type: 'cmd', id: 'ann', cmd: {type: 'still_here'}}, IDLE_MS + 1000);
  assert.deepEqual(sends(step).map(a => a.update), [{type: 'idle', done: true}]);
  assert.deepEqual(step.actions.find(a => a.type === 'active'), {type: 'active', id: 'ann', at: IDLE_MS + 1000});
  // Bob is on his way out: not asked again. Ann is asked again later, and this time doesn't answer.
  step = ev({type: 'wake'}, IDLE_MS * 2 + 1000);
  assert.ok(!step.actions.some(a => a.type === 'idle'));
  step = ev({type: 'wake'}, IDLE_MS * 2 + 1000 + ASK_MS);
  assert.deepEqual(step.actions.filter(a => a.type === 'idle').map(a => a.id), ['ann']);
});

test('idle seats: no one is stood up while the host can’t reach the relay', () => {
  const {ev} = setUp();
  ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: false}, 0);
  ev({type: 'link', ok: false}, 0);
  const step = ev({type: 'wake'}, IDLE_MS * 3);
  assert.ok(!step.actions.some(a => a.type === 'idle'));
  assert.equal(step.wake, IDLE_MS * 3 + 30_000, 'it looks again in a while');
});

test('a restored table waits for its people: going again once everyone’s back, or after the grace time without them', () => {
  // Everyone back.
  {
    const {table, s, ev} = setUp({paused: true});
    s.players = [{client_id: 'ann', seat: 0, chips: 100}, {client_id: 'bob', seat: 1, chips: 100}];
    let step = ev({type: 'state'}, 0);
    assert.equal(step.paused, true);
    ev({type: 'presence', id: 'ann', on: true}, 100);
    assert.equal(engineCalls(table, 'resume').length, 0);
    step = ev({type: 'cmd', id: 'bob', cmd: {type: 'join', name: 'Bob'}, online: true}, 200);
    assert.equal(step.paused, false);
    assert.equal(engineCalls(table, 'resume').length, 1);
    assert.equal(engineCalls(table, 'disconnected').length, 0);
  }
  // Bob never comes back.
  {
    const {table, s, ev} = setUp({paused: true});
    s.players = [{client_id: 'ann', seat: 0, chips: 100}, {client_id: 'bob', seat: 1, chips: 100}];
    ev({type: 'state'}, 0);
    const step = ev({type: 'presence', id: 'ann', on: true}, 100);
    assert.ok(step.wake <= RESUME_GRACE_MS);
    ev({type: 'wake'}, RESUME_GRACE_MS);
    assert.deepEqual(engineCalls(table, 'disconnected').map(c => c.args[0]), ['bob']);
    assert.equal(engineCalls(table, 'resume').length, 1);
  }
});

test('the club’s answers and orders reach the engine', () => {
  const {table, ev} = setUp();
  ev({type: 'cmd', id: 'ann', cmd: {type: 'join', name: 'Ann'}, online: true}, 0);
  ev({type: 'chips', seat: 0, ok: true}, 1);
  ev({type: 'chips', seat: 0, ok: false}, 2);
  ev({type: 'remove', seat: 0}, 3);
  ev({type: 'mustPlay', id: 'ann', on: true}, 4);
  assert.deepEqual(table.calls.slice(1).map(c => c.m).filter(m => m !== 'state'), ['approveChips', 'denyChips', 'remove', 'setMustPlay']);
  assert.throws(() => ev({type: 'nope'}, 5), /no event nope/);
});
