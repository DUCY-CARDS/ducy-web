import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERVIEW_GAMES, TOP_TARGETS, gameSkills, nextSkill, overviewHtml } from '../src/ranges-overview.js';

const progress = {
  'holdem:10': {score: 95, best: 95, answered: 50},   // mastered
  'holdem:20': {score: 88, best: 91, answered: 60},   // mastered once, a little below now
  'holdem:30': {score: 74, best: 80, answered: 30},   // started
  'omaha:4:15': {score: 90, best: 90, answered: 40},  // mastered at exactly 90
};

test('each game scores the share of its skills mastered (90 or more)', () => {
  const h = gameSkills(progress, 2);
  assert.equal(h.total, TOP_TARGETS.length);
  assert.equal(h.mastered, 2);
  assert.equal(h.score, Math.round(200 / 7));
  assert.equal(h.skills.find(s => s.pct === 30).status, 'started');
  assert.equal(gameSkills(progress, 4).mastered, 1);
  assert.equal(gameSkills(progress, 6).mastered, 0);
});

test('the overview has a tile per game, the open game\'s skills as spades, and the next one up front', () => {
  const h = overviewHtml(progress, 2);
  assert.match(h, /Pre-flop ranges/);
  assert.equal((h.match(/data-ovgame=/g) || []).length, OVERVIEW_GAMES.length);
  // Each skill, plus the button for the next one (top 15%: top 10% is mastered).
  assert.equal((h.match(/data-skill="2:/g) || []).length, TOP_TARGETS.length + 1);
  assert.equal((h.match(/class="v3-spade won"/g) || []).length, 2);
  assert.match(h, /to earn its spade/);
  assert.match(h, /class="v3-skill next" data-skill="2:15"/);
  assert.match(h, /data-skill="2:15">Practice top 15%/);
  // Charts by position wait for standard opening ranges (#249).
  assert.doesNotMatch(h, /data-ovchoice/);
});

test('the next skill is the first not mastered; started ones say how far to go', () => {
  assert.equal(nextSkill(gameSkills(progress, 4)).pct, 10);
  const all = Object.fromEntries(TOP_TARGETS.map(p => [`holdem:${p}`, {score: 92, best: 92, answered: 40}]));
  assert.equal(nextSkill(gameSkills(all, 2)), null);
  assert.match(overviewHtml(all, 2), /Every Hold’em range mastered/);
  const started = {...all, 'holdem:40': {score: 61, best: 61, answered: 20}};
  assert.match(overviewHtml(started, 2), /Practice top 40%.*61 of 90 to earn its spade/s);
});

test('an Omaha game shows its own skills', () => {
  const h = overviewHtml(progress, 4);
  assert.equal((h.match(/data-skill="4:/g) || []).length, TOP_TARGETS.length + 1);
  assert.match(h, /Your ranges/);
  assert.match(h, /Practice top 10%/);
});
