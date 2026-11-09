// The check for real-time assistance (#591, relay/src/assist.js): which
// decisions it scores against ducy's preflop charts and which it skips, and
// on made-up club weeks (test/assist-sim.mjs), that honest players aren't
// flagged and a player using a solver is, in plain words with hand numbers
// and never a card. Needs the wasm build in wasm/.
// Run with: node --test test/assist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { assistReport, chartFor, decisionsOf, handClass, LIMITS, sixmaxSizes, statsOf, tooClose } from '../relay/src/assist.js';
import { CHARTS, INDEX, MODEL } from '../relay/src/gto-charts.js';
import { fairPlayReport } from '../relay/src/fair-play.js';
import { keepFullHand } from '../relay/src/hand-records.js';
import { fairPlayNotices, flagText } from '../src/club-fair-play.js';
import { makePlayer, playWeek, random } from './assist-sim.mjs';

const NAMES = ['Ava', 'Bo', 'Cy', 'Dee', 'Eli', 'Flo'];

// A hand at a table with these seats' cards (by seat), the button at
// `button`, everyone `depth` big blinds deep (bb 2 chips), and these
// actions after the blinds.
function hand({cards, button = cards.length - 1, depth = 100, actions, game = 'nlhe', hand = 1, extra = {}}) {
  const n = cards.length, sb = n === 2 ? button : (button + 1) % n, bb = n === 2 ? 1 - button : (button + 2) % n;
  const all = [{type: 'small_blind', seat: sb, amount: 1}, {type: 'big_blind', seat: bb, amount: 2}, ...actions];
  return {
    id: `T:${hand}`, at: 1_000_000 + hand * 60_000, club: 'C', table: 't1', tableName: 'Main', game, hand, sb: 1, bb: 2, button,
    seats: cards.map((c, i) => ({seat: i, id: `id-${NAMES[i]}`, name: NAMES[i], cards: c, folded: false, net: 0, won: 0, stackEnd: depth * 2})),
    actions: all, times: all.map((_, i) => i * 1000), how: all.map((_, i) => (i < 2 ? null : 'player')), away: all.map(() => false),
    board: [], board2: [], pot: 0, showdown: false, pots: [], deal: null, ...extra,
  };
}
const cellOf = (format, depth, id, cards) => MODEL()[format].find(t => t.bb === depth).spots.get(id).cells[handClass(cards)];
const SIX = [['7c', '2d'], ['9h', '4s'], ['Ah', 'Kh'], ['Td', '3c'], ['8s', '5h'], ['Qs', 'Qd']]; // SB, BB, UTG, HJ, CO, BTN

test('the bundled charts are every one charts/index.json lists', () => {
  assert.deepEqual(CHARTS.sixmax.map(c => c.bb).sort((a, b) => a - b), INDEX.ducybot);
  assert.deepEqual(CHARTS.hu.map(c => c.bb).sort((a, b) => a - b), INDEX.ducybotHu);
  for (const f of [...CHARTS.sixmax, ...CHARTS.hu]) for (const s of f.spots) assert.equal(s.cells.length, 169, s.id);
});

test('hands as chart cells, depths, and the six-handed raise sizes', () => {
  assert.equal(handClass(['As', 'Ad']), 0);
  assert.equal(handClass(['Ks', 'As']), 1); // AKs
  assert.equal(handClass(['Ad', 'Kc']), 13); // AKo
  assert.equal(handClass(['2c', '2d']), 168);
  assert.equal(handClass(['3h', '2d']), 167); // 32o
  assert.equal(handClass(['Ah', 'Kh', 'Qh', 'Jh']), -1);
  assert.equal(chartFor(MODEL().sixmax, 112).bb, 100);
  assert.equal(chartFor(MODEL().sixmax, 70), null); // between 50 and 100: not covered
  assert.equal(chartFor(MODEL().hu, 13), null); // between 10 and 25
  assert.deepEqual(sixmaxSizes('open-UTG'), [2.5]);
  assert.deepEqual(sixmaxSizes('open-SB'), [3]);
  assert.deepEqual(sixmaxSizes('vs-open-BTN-CO'), [7.5]); // in position: 3 times
  assert.deepEqual(sixmaxSizes('vs-open-BB-BTN'), [9]); // out of position: 3.5 times, to the half big blind
  assert.deepEqual(sixmaxSizes('vs-open-BB-SB'), [9]);
  assert.deepEqual(sixmaxSizes('vs-3bet-CO-BTN'), [17.5]); // 2.3 times the 7.5 3-bet
  assert.deepEqual(sixmaxSizes('vs-limp-BB-SB'), [3.5]);
});

test('six-handed: an open, a 3-bet and the opener facing it are scored against the chart', () => {
  // UTG opens to 2.5, HJ and CO fold, the button 3-bets to 7.5, the blinds fold, UTG calls.
  const rec = hand({cards: SIX, actions: [
    {type: 'raise', seat: 2, to: 5, all_in: false}, {type: 'fold', seat: 3}, {type: 'fold', seat: 4},
    {type: 'raise', seat: 5, to: 15, all_in: false}, {type: 'fold', seat: 0}, {type: 'fold', seat: 1},
    {type: 'call', seat: 2, amount: 10, all_in: false},
    {type: 'board', street: 'flop', cards: ['2h', '7s', 'Jd']}, {type: 'bet', seat: 2, to: 10, all_in: false},
  ]});
  const ds = decisionsOf(rec);
  // The blinds facing an open and a 3-bet: no chart has that spot.
  assert.deepEqual(ds.map(d => [d.name, d.spot, d.act]), [
    ['Cy', 'open-UTG', 2], ['Dee', 'vs-open-HJ-UTG', 0], ['Eli', 'vs-open-CO-UTG', 0],
    ['Flo', 'vs-open-BTN-UTG', 2], ['Cy', 'vs-3bet-UTG-BTN', 1],
  ]);
  assert.deepEqual(ds[0].probs, cellOf('sixmax', 100, 'open-UTG', SIX[2]));
  assert.equal(ds[0].sizeOk, true);
  assert.equal(ds[3].sizeOk, true);
  assert.equal(ds[1].sizeOk, null);
  assert.equal(ds[3].time, 1000);
  assert.equal(ds[0].ref.hand, 1);
});

test('six-handed: a line the model doesn’t play is scored only up to where it leaves', () => {
  // UTG opens to 3 big blinds: theirs is scored (not the model's size); no one after is.
  const big = hand({cards: SIX, actions: [{type: 'raise', seat: 2, to: 6, all_in: false}, {type: 'fold', seat: 3}, {type: 'call', seat: 4, amount: 6, all_in: false}]});
  assert.deepEqual(decisionsOf(big).map(d => [d.spot, d.sizeOk]), [['open-UTG', false]]);
  // A limp: UTG's is scored, then nobody's (the charts have no limped pots but the small blind's).
  const limp = hand({cards: SIX, actions: [{type: 'call', seat: 2, amount: 2, all_in: false}, {type: 'fold', seat: 3}]});
  assert.deepEqual(decisionsOf(limp).map(d => d.spot), ['open-UTG']);
  // Folded to the small blind, who completes; the big blind checks.
  const sbLimp = hand({cards: SIX, actions: [2, 3, 4, 5].map(seat => ({type: 'fold', seat})).concat([{type: 'call', seat: 0, amount: 1, all_in: false}, {type: 'check', seat: 1}])});
  assert.deepEqual(decisionsOf(sbLimp).map(d => d.spot).slice(-2), ['open-SB', 'vs-limp-BB-SB']);
  // A shove leaves the tree.
  const shove = hand({cards: SIX, actions: [{type: 'raise', seat: 2, to: 200, all_in: true}, {type: 'fold', seat: 3}]});
  assert.deepEqual(decisionsOf(shove).map(d => [d.spot, d.act]), [['open-UTG', 3]]);
});

test('heads-up: every chart spot, both lines', () => {
  const cards = [['Ah', 'Kd'], ['9c', '9d']]; // seat 0 the button (small blind), seat 1 the big blind
  const raised = hand({cards, button: 0, actions: [
    {type: 'raise', seat: 0, to: 5, all_in: false}, {type: 'raise', seat: 1, to: 15, all_in: false},
    {type: 'raise', seat: 0, to: 35, all_in: false}, {type: 'call', seat: 1, amount: 20, all_in: false},
  ]});
  assert.deepEqual(decisionsOf(raised).map(d => [d.spot, d.sizeOk]), [['hu-open-BTN', true], ['hu-vs-open-BB-BTN', true], ['hu-vs-3bet-BTN-BB', true], ['hu-vs-4bet-BB-BTN', null]]);
  assert.deepEqual(decisionsOf(raised)[1].probs, cellOf('hu', 100, 'hu-vs-open-BB-BTN', cards[1]));
  const limped = hand({cards, button: 0, actions: [{type: 'call', seat: 0, amount: 1, all_in: false}, {type: 'raise', seat: 1, to: 5, all_in: false}, {type: 'fold', seat: 0}]});
  assert.deepEqual(decisionsOf(limped).map(d => d.spot), ['hu-open-BTN', 'hu-vs-limp-BB-BTN', 'hu-vs-iso-BTN-BB']);
});

test('what isn’t covered is skipped, not guessed', () => {
  const open = [{type: 'raise', seat: 2, to: 5, all_in: false}];
  assert.equal(decisionsOf(hand({cards: SIX, actions: open})).length, 1);
  // Omaha, a depth with no chart, five dealt in, antes, unknown cards, a timed-out turn.
  assert.equal(decisionsOf(hand({cards: SIX, actions: open, game: 'plo4'})).length, 0);
  assert.equal(decisionsOf(hand({cards: SIX, actions: open, depth: 70})).length, 0);
  assert.equal(decisionsOf(hand({cards: SIX.slice(0, 5), button: 4, actions: open})).length, 0);
  const ante = hand({cards: SIX, actions: open});
  ante.actions.unshift({type: 'ante', seat: 0, amount: 1});
  assert.equal(decisionsOf(ante).length, 0);
  const hidden = hand({cards: SIX, actions: open});
  hidden.seats[2].cards = null;
  assert.equal(decisionsOf(hidden).length, 0);
  const clock = hand({cards: SIX, actions: [...open, {type: 'fold', seat: 3}]});
  clock.how[2] = 'clock';
  assert.deepEqual(decisionsOf(clock).map(d => d.name), ['Dee']);
});

// One made-up week at a six-handed club: the first seat plays as `spec`,
// the rest as honest players of mixed skill.
function week(spec, seed, hands = 800) {
  const R = random(seed);
  const specs = [spec, ...['strong', 'average', 'average', 'weak', 'elite'].map(skill => ({type: 'human', skill}))];
  return playWeek({players: specs.map(s => makePlayer(R, s)), hands, seed: seed + 1, names: NAMES});
}

test('honest players aren’t flagged', () => {
  for (const seed of [1, 2, 3, 4]) {
    const r = assistReport(week({type: 'human', skill: ['elite', 'strong', 'average', 'weak'][seed - 1]}, seed));
    assert.ok(r.players >= 5, `week ${seed}: ${r.players} players judged`);
    assert.deepEqual(r.flagged, [], `week ${seed}`);
  }
});

test('a player using a solver is flagged, in plain words, with hand numbers and no cards', () => {
  for (const [seed, mode] of [[11, 'sample'], [12, 'top']]) {
    const recs = week({type: 'solver', mode}, seed);
    const r = assistReport(recs);
    assert.deepEqual(r.flagged.map(e => e.ids), [['id-Ava']], `${mode}`);
    const e = r.flagged[0];
    const kinds = e.flags.map(f => f.kind);
    assert.ok(kinds.includes('gto-top') && kinds.includes('gto-off'), kinds.join());
    assert.ok(kinds.some(k => ['gto-pace', 'gto-even', 'gto-away'].includes(k)), kinds.join());
    const top = e.flags.find(f => f.kind === 'gto-top');
    assert.ok(top.with.n >= LIMITS.MIN_DECISIONS && top.club > 0 && top.club < top.with.k / top.with.n);
    assert.ok(top.hands.length > 0 && top.hands.every(h => h.table === 'Main' && Number.isInteger(h.hand)));
    const text = flagText(top, {'id-Ava': 'Ava'});
    assert.match(text, /^Ava matched the solver’s top play in \d+% of [\d,]+ preflop decisions; the club’s average is \d+%$/);
    // Nothing about cards leaves: no card, no chart cell.
    const json = JSON.stringify(r);
    assert.doesNotMatch(json, /"[2-9TJQKA][shdc]"/);
    assert.doesNotMatch(json, /"cls"|"cells"|"probs"/);
  }
});

test('a player who starts using a solver partway is flagged for the jump', () => {
  const recs = week({type: 'switch', at: 501, before: {type: 'human', skill: 'average'}, after: {type: 'solver', mode: 'sample'}}, 21, 1000);
  const r = assistReport(recs);
  const e = r.flagged.find(x => x.ids[0] === 'id-Ava');
  assert.ok(e, 'flagged');
  const jump = e.flags.find(f => f.kind === 'gto-jump');
  assert.ok(jump && jump.after.off < jump.before.off, JSON.stringify(e.flags.map(f => f.kind)));
  assert.match(flagText(jump, {'id-Ava': 'Ava'}), /^Ava’s top-play rate jumped from \d+% \([\d,]+ decisions\) to \d+% \([\d,]+\); plays the solver never makes: \d+, then \d+$/);
  assert.deepEqual(r.flagged.map(x => x.ids[0]), ['id-Ava']);
});

test('too few decisions: nobody is judged', () => {
  const r = assistReport(week({type: 'solver', mode: 'top'}, 31, 200));
  assert.equal(r.players, 0);
  assert.deepEqual(r.flagged, []);
});

test('closeness needs both: few plays the model never makes, and its top play as often', () => {
  const st = {n: 400, off: 4, top: 300, expTop: 305};
  assert.equal(tooClose(st), true);
  assert.equal(tooClose({...st, off: 5}), false);
  assert.equal(tooClose({...st, top: 296}), false);
  assert.equal(tooClose({...st, n: 299}), false);
  assert.equal(statsOf([]).n, 0);
});

test('every line reads plainly', () => {
  const names = {a: 'Cy'};
  const w = {k: 560, n: 620};
  assert.equal(flagText({kind: 'gto-top', who: 'a', with: w, club: 0.58}, names), 'Cy matched the solver’s top play in 90% of 620 preflop decisions; the club’s average is 58%');
  assert.equal(flagText({kind: 'gto-top', who: 'a', with: w, club: null, solver: 0.88}, names), 'Cy matched the solver’s top play in 90% of 620 preflop decisions; the solver itself: 88%');
  assert.equal(flagText({kind: 'gto-off', who: 'a', with: {k: 2, n: 620}, club: 0.05}, names), 'Cy made 2 plays the solver never makes in 620 preflop decisions (0%); the club’s average is 5%');
  assert.equal(flagText({kind: 'gto-mix', who: 'a', with: {k: 40, n: 130}, solver: 0.33, club: 0.12}, names), 'Cy took the less common play in close spots 31% of 130 times, as the solver would (33%); the club’s average is 12%');
  assert.equal(flagText({kind: 'gto-sizes', who: 'a', with: {k: 97, n: 100}, club: null}, names), 'Cy raised the solver’s exact size 97% of 100 times; no club average yet');
  assert.equal(flagText({kind: 'gto-pace', who: 'a', clear: 6.1, hard: 6.3, club: {clear: 1.4, hard: 4.2}}, names), 'Cy took as long on clear decisions as harder ones: 6.1 s and 6.3 s; the club: 1.4 s and 4.2 s');
  assert.equal(flagText({kind: 'gto-even', who: 'a', median: 5.9, spread: 0.8, n: 410}, names), 'Cy took 5.9 s give or take 0.8 s over 410 decisions');
  assert.equal(flagText({kind: 'gto-away', who: 'a', with: {k: 230, n: 600}, club: 0.04}, names), 'Cy’s tab was hidden while deciding 38% of 600 times; the club’s average is 4%');
  const notes = fairPlayNotices({at: 1, flagged: [{ids: ['a'], names, flags: [{kind: 'gto-top'}, {kind: 'gto-off'}]}]}, {names});
  assert.deepEqual(notes.map(x => [x.name, x.key]), [['Cy', 'fair:a|gto-off,gto-top']]);
});

test('the club’s fair play run reads the records once and reports both checks', async () => {
  const data = new Map();
  const storage = {get: async k => structuredClone(data.get(k)), put: async (k, v) => { data.set(k, structuredClone(v)); }, delete: async k => { data.delete(k); }};
  const recs = week({type: 'solver', mode: 'sample'}, 41);
  const now = recs[recs.length - 1].at + 1000;
  for (const rec of recs) await keepFullHand(storage, rec, {days: 7}, now);
  const report = await fairPlayReport(storage, {now, days: 7});
  assert.equal(report.hands, recs.length);
  assert.ok(report.assist.decisions > 0 && report.assist.players >= 5);
  const e = report.flagged.find(x => x.ids.length === 1);
  assert.deepEqual(e?.ids, ['id-Ava']);
  assert.doesNotMatch(JSON.stringify(report), /"[2-9TJQKA][shdc]"/);
});
