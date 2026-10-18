// Practising Ducybot's ranges (chart-skills.js): which actions are asked, the
// answers, how hands are picked, and the chart files the track relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cellHand } from '../src/charts.js';
import {
  CHART_TRACKS, DEFAULT_BB, chartSkillKey, parseChartKey, chartFile, spotName, spotNameFromId, spotQuestion,
  trainingActions, handMix, fixedAnswers, fixedSeverity, mixDistance, difficulty, obviousCells, pickCell,
  cardsFor, spotFingerprint, fixedPenalty, mixedPenalty, setShare, MIN_ACTION, chartLevel,
} from '../src/chart-skills.js';

const read = name => JSON.parse(readFileSync(new URL(`../charts/${name}`, import.meta.url), 'utf8'));
const cell = h => Array.from({length: 169}, (_, i) => cellHand(i)).indexOf(h);
const spotOf = (table, id, bb = DEFAULT_BB) => read(chartFile(table, bb)).spots.find(s => s.id === id);
const seeded = seed => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test('every spot on the track is in its chart at 100 BB', () => {
  for (const t of CHART_TRACKS) for (const id of t.ids) assert.ok(spotOf(t.table, id), `${t.table} ${id}`);
});

test('skill keys round-trip', () => {
  const k = chartSkillKey('hu', 100, 'hu-vs-open-BB-BTN', 'mixed');
  assert.equal(k, 'chart:hu:100:hu-vs-open-BB-BTN:mixed');
  assert.deepEqual(parseChartKey(k), {table: 'hu', bb: 100, id: 'hu-vs-open-BB-BTN', mode: 'mixed'});
  assert.equal(parseChartKey('holdem:20'), null);
});

test('spot names and questions', () => {
  const btn = spotOf('hu', 'hu-open-BTN');
  assert.equal(spotName(btn), 'BTN open');
  assert.equal(spotQuestion(btn, true), 'You’re on the button, first to act.');
  const bb = spotOf('hu', 'hu-vs-open-BB-BTN');
  assert.equal(spotName(bb), 'BB vs BTN open');
  assert.equal(spotQuestion(bb, true), 'You’re on the big blind. BTN raises to 2.5 BB.');
  assert.equal(spotNameFromId('hu-vs-3bet-BTN-BB'), 'BTN vs BB 3-bet');
  assert.equal(spotNameFromId('open-CO'), 'CO open');
  assert.equal(spotNameFromId('hu-vs-iso-BTN-BB'), 'BTN limped, BB raised');
});

test('rare actions are left out and their share goes to a kept one', () => {
  // UTG at 6-max: a 4% limp and a 0.4% all-in fold into the raise.
  const utg = spotOf('6max', 'open-UTG');
  const ta = trainingActions(utg);
  assert.deepEqual(ta.actions.map(x => x.a), [0, 2]);
  assert.deepEqual(ta.actions.map(x => x.verb), ['Fold', 'Raise']);
  const aa = handMix(utg, cell('AA'), ta);
  assert.ok(aa[1] > 99, `UTG raises AA: ${aa}`);
  // The small blind limps a lot, so its limp stays.
  assert.deepEqual(trainingActions(spotOf('6max', 'open-SB')).actions.map(x => x.verb), ['Fold', 'Limp', 'Raise']);
  // Heads-up, the big blind facing a limp can't fold: check or raise.
  assert.deepEqual(trainingActions(spotOf('hu', 'hu-vs-limp-BB-BTN')).actions.map(x => x.verb), ['Check', 'Raise to 2.5 BB']);
  // Facing a 4-bet there's no raise but all-in, and it's kept.
  assert.deepEqual(trainingActions(spotOf('hu', 'hu-vs-4bet-BB-BTN')).actions.map(x => x.a), [0, 1, 3]);
  // Every kept action is used at least MIN_ACTION% and every mix adds to 100.
  for (const t of CHART_TRACKS) for (const id of t.ids) {
    const s = spotOf(t.table, id), ta2 = trainingActions(s);
    for (const x of ta2.actions) assert.ok(s.overall[x.a] >= MIN_ACTION, `${id} ${x.verb}`);
    assert.ok(ta2.actions.length >= 2, id);
    for (let i = 0; i < 169; i++) assert.ok(Math.abs(handMix(s, i, ta2).reduce((a, b) => a + b, 0) - 100) < 1e-6);
  }
});

test('fixed answers: the main action, and any action taken often enough', () => {
  assert.deepEqual(fixedAnswers([100, 0]), [0]);
  assert.deepEqual(fixedAnswers([45, 55]), [0, 1]);
  assert.deepEqual(fixedAnswers([20, 80]), [1]);
  assert.deepEqual(fixedAnswers([10, 35, 55]), [1, 2]);
  assert.equal(fixedSeverity([0, 100], 1), 0);
  assert.equal(fixedSeverity([0, 100], 0), 1);
  assert.equal(fixedSeverity([20, 80], 0), 0.6);
  assert.ok(fixedPenalty(1, false) === 16 && fixedPenalty(0.05, false) === 2 && fixedPenalty(0.1, true) === 20);
});

test('mixed answers: distance between mixes', () => {
  assert.equal(mixDistance([50, 50], [50, 50]), 0);
  assert.equal(mixDistance([100, 0], [0, 100]), 100);
  assert.equal(mixDistance([60, 40], [50, 50]), 10);
  assert.equal(mixDistance([60, 30, 10], [40, 40, 20]), 20);
  assert.equal(mixedPenalty(20), 0);
  assert.ok(mixedPenalty(30) >= 2 && mixedPenalty(100) === 16);
});

test('sliders: one share set, the rest keep their proportions, whole numbers adding to 100', () => {
  assert.deepEqual(setShare([50, 50], 0, 70), [70, 30]);
  assert.deepEqual(setShare([20, 30, 50], 0, 60), [60, 15, 25]);
  assert.deepEqual(setShare([100, 0, 0], 0, 40), [40, 30, 30]);
  assert.deepEqual(setShare([0, 100], 1, 100), [0, 100]);
  for (const [m, k, v] of [[[33, 33, 34], 1, 55], [[10, 20, 30, 40], 3, 5], [[0, 0, 100], 2, 35]]) {
    const out = setShare(m, k, v);
    assert.equal(out.reduce((a, b) => a + b, 0), 100, String(out));
    assert.equal(out[k], v);
    assert.ok(out.every(x => Number.isInteger(x) && x >= 0));
  }
});

test('difficulty, obvious hands and picking a hand to practise', () => {
  assert.equal(difficulty([100, 0]), 0);
  assert.equal(difficulty([50, 50]), 1);
  const utg = spotOf('6max', 'open-UTG');
  const obvious = obviousCells(utg);
  assert.ok(obvious[cell('72o')], '72o UTG is an obvious fold');
  assert.ok(!obvious[cell('A5s')], 'A5s UTG is near the edge');
  // Practice hands are never obvious ones, and stay in the band when they can.
  const rand = seeded(7);
  for (let n = 0; n < 200; n++) {
    const i = pickCell(utg, {band: [0.4, 1.01], rand});
    assert.ok(!obvious[i], cellHand(i));
    assert.ok(difficulty(handMix(utg, i)) >= 0.4, cellHand(i));
  }
  // Probes are obvious hands.
  for (let n = 0; n < 50; n++) assert.ok(obvious[pickCell(utg, {probe: true, rand})]);
  // A band nothing fits falls back rather than give up.
  assert.ok(pickCell(spotOf('hu', 'hu-vs-limp-BB-BTN'), {band: [2, 3], rand}) >= 0);
  assert.equal(chartLevel('fixed', 85).name, 'Hard');
  assert.equal(chartLevel('mixed', 0).name, 'Easy');
});

test('cards for a hand class', () => {
  const rand = seeded(3);
  for (let n = 0; n < 100; n++) {
    const [a, b] = cardsFor(cell('AKs'), rand);
    assert.ok(a[0] === 'A' && b[0] === 'K' && a[1] === b[1]);
    const [c, d] = cardsFor(cell('AKo'), rand);
    assert.ok(c[0] === 'A' && d[0] === 'K' && c[1] !== d[1]);
    const [e, f] = cardsFor(cell('77'), rand);
    assert.ok(e[0] === '7' && f[0] === '7' && e[1] !== f[1]);
  }
});

test('a spot\'s fingerprint changes with its chart', () => {
  const s = spotOf('hu', 'hu-open-BTN');
  const t = {...s, cells: s.cells.map((c, i) => (i ? c : [1, 18, 80, 1]))};
  assert.equal(spotFingerprint(s), spotFingerprint({...s}));
  assert.notEqual(spotFingerprint(s), spotFingerprint(t));
});
