import test from 'node:test';
import assert from 'node:assert/strict';
import { MASTERY, gainFor, answersToMaster, skillKey, parseSkillKey, skillState, skillTable } from '../src/trainer-skills.js';

test('90 masters a skill: about 36 right answers, the last 10 points one at a time', () => {
  assert.equal(MASTERY, 90);
  assert.equal(answersToMaster(0), 36);
  for (let s = 80; s < MASTERY; s++) assert.equal(gainFor(s), 1);
  assert.equal(answersToMaster(80), 10);
});

test('skill keys round-trip, and drill keys are not skills', () => {
  assert.equal(skillKey(2, 15), 'holdem:15');
  assert.equal(skillKey(4, 30), 'omaha:4:30');
  assert.deepEqual(parseSkillKey('holdem:15'), {cards: 2, pct: 15});
  assert.deepEqual(parseSkillKey('omaha:6:25'), {cards: 6, pct: 25});
  assert.equal(parseSkillKey('holdem:15:pairs'), null);
  assert.equal(parseSkillKey('omaha:4:30:ds'), null);
});

test('a skill stays mastered after reaching 90, even if the score drops', () => {
  assert.equal(skillState(undefined).status, 'new');
  assert.equal(skillState({score: 0, best: 0, answered: 0}).status, 'new');
  assert.equal(skillState({score: 62, best: 89, answered: 40}).status, 'started');
  assert.equal(skillState({score: 90, best: 90, answered: 40}).status, 'mastered');
  const s = skillState({score: 84, best: 95, answered: 80});
  assert.equal(s.status, 'mastered');
  assert.equal(s.score, 84);
});

test('the skills table lists every game and target, plus targets already practiced', () => {
  const progress = {
    'holdem:15': {score: 100, best: 100, answered: 60},
    'omaha:4:30': {score: 45, best: 50, answered: 20},
    'omaha:5:33': {score: 12, best: 12, answered: 4},   // a custom target
    'omaha:6:99': {score: 0, best: 0, answered: 0},     // touched but never practiced
    'holdem:15:pairs': {score: 100, best: 100, answered: 30}, // a drill: not a skill
  };
  const t = skillTable(progress, [2, 4, 5, 6], [10, 15, 30]);
  assert.deepEqual(t.rows.map(r => r.pct), [10, 15, 30, 33]);
  assert.equal(t.total, 16);
  assert.equal(t.mastered, 1);
  assert.equal(t.started, 3);
  const cell = (pct, cards) => t.rows.find(r => r.pct === pct).cells.find(c => c.cards === cards);
  assert.equal(cell(15, 2).status, 'mastered');
  assert.equal(cell(30, 4).score, 45);
  assert.equal(cell(10, 6).status, 'new');
});
