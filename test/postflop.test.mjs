// The postflop check for real-time assistance (#615, relay/src/postflop.js):
// which kept hands go to ducy's judge and what of them, that each is scored
// once and its scores kept without cards, and the report: a player as close
// to the model as the model itself is flagged, others aren't, in plain words
// with hand numbers. The judge itself (relay/judge/, rust/ducy-judge) is
// stood in for here; its own tests are rust/ducy-judge/tests/.
// Run with: node --test test/postflop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { dropScores, eligible, judgeInput, judgeVia, LIMITS, postflopReport, postflopRun, scoredHands, scoreNew, statsOf, tooClose } from '../relay/src/postflop.js';
import { fairPlayReport, fairPlayRun } from '../relay/src/fair-play.js';
import { fairHtml, flagRows, playerNumbers } from '../src/admin-fair-play.js';
import { keepFullHand } from '../relay/src/hand-records.js';
import { flagText } from '../src/club-fair-play.js';

const NAMES = ['Ava', 'Bo', 'Cy', 'Dee', 'Eli', 'Flo'];
const CARDS = [['Ah', 'Kd'], ['7c', '2d'], ['9h', '4s'], ['9c', '9s'], ['8s', '5h'], ['Qs', 'Qd']];
const BOARD = ['Ks', '9d', '4c', '2h', '7d'];
const DAY = 864e5;
const NOW = 100 * DAY;

// Hand `n` at a six-handed table, the button on 3: UTG (Ava, seat 0) opens,
// the button (Dee) calls and the rest fold; then a bet and a call on the
// flop, checks on the turn and river. `callers`: more seats calling the
// open (a multiway pot); `flop`: false ends it before the flop.
function rec(n, {callers = [], flop = true, game = 'nlhe', at = NOW - DAY + n * 1000, players = NAMES} = {}) {
  const a = [{type: 'small_blind', seat: 4, amount: 1}, {type: 'big_blind', seat: 5, amount: 2}, {type: 'raise', seat: 0, to: 5, all_in: false}];
  for (const s of [1, 2]) a.push(callers.includes(s) ? {type: 'call', seat: s, amount: 5, all_in: false} : {type: 'fold', seat: s});
  a.push({type: 'call', seat: 3, amount: 5, all_in: false}, {type: 'fold', seat: 4}, {type: 'fold', seat: 5});
  if (flop) {
    a.push({type: 'board', street: 'flop', cards: BOARD.slice(0, 3)}, {type: 'bet', seat: 0, to: 6, all_in: false}, {type: 'call', seat: 3, amount: 6, all_in: false});
    a.push({type: 'board', street: 'turn', cards: [BOARD[3]]}, {type: 'check', seat: 0}, {type: 'check', seat: 3});
    a.push({type: 'board', street: 'river', cards: [BOARD[4]]}, {type: 'check', seat: 0}, {type: 'check', seat: 3});
  }
  return {
    id: `T:${n}`, at, club: 'C', table: 't1', tableName: 'Main', game, hand: n, sb: 1, bb: 2, button: 3,
    seats: CARDS.map((c, i) => ({seat: i, id: `id-${players[i]}`, name: players[i], cards: c, folded: false, net: 0, won: 0, stackEnd: 200, conn: {net: 'secret-net'}})),
    actions: a, times: a.map((_, i) => i * 1000), how: a.map(() => 'player'), away: a.map(() => false),
    board: flop ? BOARD : [], board2: [], pot: 0, showdown: false, pots: [], deal: {seed: 'secret-seed', list: [], reveals: [], order: []}, prox: [],
  };
}

const memory = () => {
  const store = new Map();
  return {store, get: async k => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async k => { store.delete(k); }};
};

// A stand-in judge: three decisions (flop, turn, river) for each of the two
// seats left at the flop. Seat 0 makes the model's top play every time; the
// others make a play it makes 30% of the time, a third of them one it
// rarely makes, losing a big blind there. Keeps what it was sent.
function fakeJudge({fail = () => false} = {}) {
  const calls = [];
  const judge = async inputs => {
    calls.push(inputs);
    if (inputs.some(fail)) throw new Error('too much');
    return inputs.map(h => {
      const folded = new Set(h.actions.filter(e => e.type === 'fold').map(e => e.seat));
      const live = h.seats.map(s => s.seat).filter(s => !folded.has(s));
      return live.flatMap(seat => [1, 2, 3].map(street => (seat === 0
        ? {seat, street, frequency: 0.6, top: 0.6, evLoss: 0, stderr: 0, bbLost: 0}
        : {seat, street, frequency: street === 3 ? 0.02 : 0.3, top: 0.6, evLoss: street === 3 ? 1 : 0.1, stderr: 0.01, bbLost: street === 3 ? 1 : 0})));
    });
  };
  return {judge, calls};
}

test('which hands go to the judge: two players at the flop, a game the models play', () => {
  assert.equal(eligible(rec(1)), true);
  assert.equal(eligible(rec(2, {callers: [1]})), false); // three at the flop
  assert.equal(eligible(rec(3, {flop: false})), false);
  assert.equal(eligible(rec(4, {game: 'plo5'})), true);
  assert.equal(eligible(rec(5, {game: 'stud'})), false);
});

test('what goes to the judge: seats, cards, stacks, actions and the board; no names, IDs, connections or deal', () => {
  const input = judgeInput(rec(1));
  assert.deepEqual(Object.keys(input).sort(), ['actions', 'bb', 'board', 'button', 'game', 'sb', 'seats']);
  assert.deepEqual(Object.keys(input.seats[0]).sort(), ['cards', 'net', 'seat', 'stackEnd']);
  const json = JSON.stringify(input);
  for (const s of ['id-Ava', 'Ava', 'secret-net', 'secret-seed']) assert.ok(!json.includes(s), s);
});

test('each hand is scored once, kept by player without cards, and a failing batch is tried a hand at a time', async () => {
  const storage = memory();
  const recs = [rec(1), rec(2, {callers: [1]}), rec(3), rec(4), rec(5), rec(6), rec(7)];
  const {judge, calls} = fakeJudge({fail: h => h.seats[0].cards[0] === 'Ah' && h.actions.length > 0 && calls.length === 1});
  const out = await scoreNew(storage, recs, judge, {now: NOW, days: 30});
  // Six can be scored. The first batch fails as a whole and goes again one by one.
  assert.equal(out.scored, 6);
  assert.equal(out.left, 0);
  assert.equal(calls[0].length, LIMITS.BATCH);
  assert.ok(calls.slice(1, 1 + LIMITS.BATCH).every(c => c.length === 1));
  const kept = await scoredHands(storage);
  assert.equal(kept.length, 6);
  assert.deepEqual(kept[0].ref, {table: 'Main', hand: 1});
  assert.deepEqual(kept[0].ds.map(d => [d.id, d.street]), [['id-Ava', 1], ['id-Ava', 2], ['id-Ava', 3], ['id-Dee', 1], ['id-Dee', 2], ['id-Dee', 3]]);
  const json = JSON.stringify([...storage.store.entries()]);
  for (const c of [...CARDS.flat(), ...BOARD]) assert.ok(!json.includes(`"${c}"`), c);
  // Nothing new: nothing sent.
  const before = calls.length;
  assert.equal((await scoreNew(storage, recs, judge, {now: NOW, days: 30})).scored, 0);
  assert.equal(calls.length, before);
  // A new hand is.
  assert.equal((await scoreNew(storage, [...recs, rec(8)], judge, {now: NOW, days: 30})).scored, 1);
});

test('a hand the judge fails alone is skipped; at most MAX_PER_RUN a run, the rest next run', async () => {
  const storage = memory();
  const {judge} = fakeJudge({fail: h => h.seats[0].stackEnd === 199});
  const odd = rec(2);
  odd.seats[0].stackEnd = 199;
  const out = await scoreNew(storage, [rec(1), odd, rec(3)], judge, {now: NOW, days: 30});
  assert.deepEqual(out, {scored: 2, skipped: 1, left: 0});

  // The judge down: nothing is skipped, and the hands wait for the next run.
  const s1 = memory();
  const down = async () => { throw new Error('judge: 503'); };
  assert.deepEqual(await scoreNew(s1, [rec(1), rec(2), rec(3), rec(4), rec(5)], down, {now: NOW, days: 30}), {scored: 0, skipped: 0, left: 5});
  assert.deepEqual(await scoreNew(s1, [rec(1), rec(2), rec(3), rec(4), rec(5)], fakeJudge().judge, {now: NOW, days: 30}), {scored: 5, skipped: 0, left: 0});
  // Down after a batch went through: those stay scored, the rest wait.
  const s3 = memory();
  let n = 0;
  const flaky = async inputs => { if (n++ >= 1) throw new Error('judge: 503'); return fakeJudge().judge(inputs); };
  const six = Array.from({length: 6}, (_, k) => rec(k + 1));
  assert.deepEqual(await scoreNew(s3, six, flaky, {now: NOW, days: 30}), {scored: LIMITS.BATCH, skipped: 0, left: 6 - LIMITS.BATCH});
  assert.deepEqual(await scoreNew(s3, six, fakeJudge().judge, {now: NOW, days: 30}), {scored: 6 - LIMITS.BATCH, skipped: 0, left: 0});

  const max = LIMITS.MAX_PER_RUN;
  LIMITS.MAX_PER_RUN = 5;
  try {
    const s2 = memory();
    const recs = Array.from({length: 12}, (_, i) => rec(i + 1));
    assert.deepEqual(await scoreNew(s2, recs, fakeJudge().judge, {now: NOW, days: 30}), {scored: 5, skipped: 0, left: 7});
    assert.deepEqual(await scoreNew(s2, recs, fakeJudge().judge, {now: NOW, days: 30}), {scored: 5, skipped: 0, left: 2});
    assert.equal((await scoredHands(s2)).length, 10);
  } finally {
    LIMITS.MAX_PER_RUN = max;
  }
});

test('without a judge nothing is scored; old scores go with the club’s days, and all of them with the club', async () => {
  const storage = memory();
  assert.deepEqual(await scoreNew(storage, [rec(1)], null, {now: NOW}), {scored: 0, skipped: 0, left: 0});
  await scoreNew(storage, [rec(1, {at: NOW - 10 * DAY}), rec(2)], fakeJudge().judge, {now: NOW, days: 30});
  assert.equal((await scoredHands(storage)).length, 2);
  await scoreNew(storage, [], fakeJudge().judge, {now: NOW, days: 5});
  assert.equal((await scoredHands(storage)).length, 1);
  await dropScores(storage);
  assert.equal([...storage.store.keys()].filter(k => k.startsWith('pf')).length, 0);
});

test('the report: a player as close as the model is flagged, with hand numbers and no cards; others aren’t', () => {
  const hands = [];
  for (let i = 1; i <= 120; i++) {
    // Ava (always the top play) against Dee; Bo against Cy, honest both.
    hands.push({at: i, ref: {table: 'Main', hand: i}, game: 'nlhe', ds: [1, 2, 3].flatMap(street => [
      {id: 'id-Ava', name: 'Ava', street, f: 0.6, top: 0.6, loss: 0, lost: 0},
      {id: 'id-Dee', name: 'Dee', street, f: street === 3 ? 0.02 : 0.3, top: 0.6, loss: 0.5, lost: street === 3 ? 1 : 0},
      {id: 'id-Bo', name: 'Bo', street, f: 0.3, top: 0.6, loss: 0.2, lost: 0.2},
    ])});
  }
  const r = postflopReport(hands);
  assert.equal(r.decisions, 1080);
  assert.equal(r.players, 3);
  assert.deepEqual(r.flagged.map(e => e.ids), [['id-Ava']]);
  const e = r.flagged[0];
  assert.deepEqual(e.flags.map(f => f.kind), ['gto-post-top', 'gto-post-off', 'gto-post-loss']);
  assert.deepEqual(e.flags[0].with, {k: 360, n: 360});
  assert.ok(Math.abs(e.flags[0].solver - 0.6) < 1e-9);
  assert.equal(e.flags[0].hands.length, LIMITS.MAX_HANDS_LISTED);
  assert.deepEqual(e.flags[0].hands.at(-1), {table: 'Main', hand: 120});
  assert.equal(e.flags[2].bb, 0);
  assert.ok(e.flags[2].club > 0);
  assert.match(flagText(e.flags[0], e.names), /^Ava matched the solver’s top play in 100% of 360 decisions after the flop; the club’s average is \d+%$/);
  assert.match(flagText(e.flags[1], e.names), /^Ava made 0 plays the solver rarely makes in 360 decisions after the flop \(0%\)/);
  assert.match(flagText(e.flags[2], e.names), /^Ava gave up 0 big blinds per 100 decisions after the flop by the solver’s values, over 360; the club’s average is [\d.]+$/);
  // Under MIN_DECISIONS, no one is judged.
  assert.equal(postflopReport(hands.slice(0, 50)).flagged.length, 0);
  // Stats for every player, numbers only.
  assert.deepEqual(r.stats.players.map(p => p.id).sort(), ['id-Ava', 'id-Bo', 'id-Dee']);
});

test('closeness: off plays, the top play and the loss each keep a player from being flagged', () => {
  const close = Array.from({length: 400}, () => ({f: 0.5, top: 0.5, loss: 0, lost: 0}));
  assert.ok(tooClose(statsOf(close)));
  const offs = close.map((d, i) => (i % 10 ? d : {...d, f: 0.01}));
  assert.ok(!tooClose(statsOf(offs)));
  const lossy = close.map(d => ({...d, lost: 0.4}));
  assert.ok(!tooClose(statsOf(lossy)));
  // The model's top play less often than the model takes it (90% here).
  const clear = close.map(d => ({...d, f: 0.9, top: 0.9}));
  assert.ok(tooClose(statsOf(clear)));
  const second = clear.map((d, i) => (i % 4 ? d : {...d, f: 0.1}));
  assert.ok(!tooClose(statsOf(second)));
  // Omaha: no values, judged on the plays alone.
  assert.ok(tooClose(statsOf(close.map(d => ({...d, loss: null, lost: 0})))));
});

test('the fair play run scores new hands with the judge and merges its flags into the report', async () => {
  const storage = memory();
  for (let i = 1; i <= 130; i++) await keepFullHand(storage, rec(i), {days: 30}, NOW);
  const {judge} = fakeJudge();
  const report = await fairPlayReport(storage, {now: NOW, days: 30, judge});
  assert.equal(report.postflop.scored, 130);
  assert.equal(report.postflop.decisions, 780);
  const ava = report.flagged.find(e => e.ids.length === 1 && e.ids[0] === 'id-Ava');
  assert.ok(ava.flags.some(f => f.kind === 'gto-post-top'));
  assert.ok(!report.flagged.some(e => e.ids.length === 1 && e.ids[0] === 'id-Dee' && e.flags.some(f => f.kind.startsWith('gto-post'))));
  const json = JSON.stringify(report);
  for (const c of [...CARDS.flat(), ...BOARD]) assert.ok(!json.includes(`"${c}"`), c);
  // The next run has nothing new to score, and still reports.
  const again = await postflopRun(storage, [], {now: NOW, days: 30, judge});
  assert.equal(again.counts.scored, 0);
  assert.equal(again.flagged.length, 1);
  // Without a judge, the run goes on as before.
  const none = await fairPlayReport(memory(), {now: NOW, days: 30});
  assert.equal(none.postflop.decisions, 0);
});

test('ducy’s admin summary carries each player’s numbers after the flop, and the page shows them', async () => {
  const storage = memory();
  for (let i = 1; i <= 130; i++) await keepFullHand(storage, rec(i), {days: 30}, NOW);
  const {summary} = await fairPlayRun(storage, {now: NOW, days: 30, judge: fakeJudge().judge});
  assert.equal(summary.postflop.decisions, 780);
  const ava = summary.players.find(p => p.id === 'id-Ava');
  assert.deepEqual(ava.pf, {n: 390, top: 390, exp: 234, off: 0, valued: 390, lost: 0});
  assert.ok(ava.flags.includes('gto-post-top'));
  const json = JSON.stringify(summary);
  for (const c of [...CARDS.flat(), ...BOARD]) assert.ok(!json.includes(`"${c}"`), c);
  const n = playerNumbers(ava);
  assert.equal(n.pfN, 390);
  assert.equal(n.pfTop, 1);
  assert.equal(n.pfLoss, 0);
  const dee = playerNumbers(summary.players.find(p => p.id === 'id-Dee'));
  assert.ok(Math.abs(dee.pfOff - 1 / 3) < 1e-9);
  assert.equal(dee.pfLoss, 33.3);
  const rows = flagRows([{code: 'C', name: 'Club', flags: summary.flags}]).filter(r => r.kind.startsWith('gto-post'));
  assert.deepEqual(rows.map(r => r.signal), ['Top play after flop', 'Rare plays after flop', 'Loss after flop']);
  assert.equal(rows[2].strength.text, '0 bb/100');
  assert.match(fairHtml({clubs: [{code: 'C', name: 'Club', ...summary}]}), /After flop/);
});

test('the relay reaches the judge through its Durable Object binding', async () => {
  assert.equal(judgeVia(undefined), null);
  const seen = [];
  const ns = {
    idFromName: name => `id:${name}`,
    get: id => ({fetch: async (url, init) => { seen.push({id, url, body: JSON.parse(init.body)}); return Response.json({results: [[]]}); }}),
  };
  assert.deepEqual(await judgeVia(ns)([{game: 'nlhe'}]), [[]]);
  assert.equal(seen[0].id, 'id:judge');
  assert.deepEqual(seen[0].body, {hands: [{game: 'nlhe'}]});
  const bad = {idFromName: () => 'x', get: () => ({fetch: async () => new Response('no', {status: 500})})};
  await assert.rejects(judgeVia(bad)([]), /judge: 500/);
});
