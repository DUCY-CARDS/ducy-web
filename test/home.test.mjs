import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { HUBS, crumbFor, hubData, hubHtml, sideOf, sideSwitch } from '../src/home.js';
import { ORDER } from '../src/ladder.js';

const store = (items = {}) => ({ getItem: k => (k in items ? items[k] : null), setItem() {} });

test('every older page has a breadcrumb back to Study or Play', () => {
  assert.deepEqual(crumbFor('equity'), [{href: '#study', label: 'Study'}, {href: null, label: 'Equity'}]);
  assert.deepEqual(crumbFor('trainer').map(c => c.label), ['Study', 'Pre-flop ranges']);
  assert.deepEqual(crumbFor('ladder').map(c => c.label), ['Play', 'Heads-up challenge']);
  assert.deepEqual(crumbFor('ladder')[0].href, '#lobby');
  for (const p of ['host', 'join', 'clubs', 'practice']) assert.equal(crumbFor(p)[0].href, '#lobby', p);
  assert.deepEqual(crumbFor('nowhere'), []);
});

test('at a table, the breadcrumb says Table under Play', () => {
  assert.deepEqual(crumbFor('play', 'train').map(c => c.label), ['Play', 'Table']);
  assert.deepEqual(crumbFor('play', 'clubs').map(c => c.label), ['Play', 'Table']);
  // Not seated: the Regulars' setup.
  assert.deepEqual(crumbFor('play', null).map(c => c.label), ['Play', 'Play the Regulars']);
});

test('hub data starts at nothing mastered and the bottom rung', () => {
  const d = hubData(store());
  assert.equal(d.mastered, 0);
  assert.equal(d.skills, 4 * 7);
  assert.equal(d.rung, 1);
  assert.equal(d.rungs, ORDER.length + 1);
});

test('hub data counts mastered skills and the ladder rung', () => {
  const d = hubData(store({
    ducyTrainerProgress: JSON.stringify({'holdem:20': {score: 100, best: 100, answered: 60}, 'omaha:4:10': {score: 40, answered: 12}}),
    ducyLadder: JSON.stringify({v: 1, level: 6, record: {}}),
  }));
  assert.equal(d.mastered, 1);
  assert.equal(d.rung, 7);
});

test('the landing page has only Study, Play and Quest', () => {
  const h = hubHtml('home', hubData(store()));
  assert.match(h, /Pull up a chair\./);
  const links = [...h.matchAll(/href="(#[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(links, ['#study', '#lobby', '#quest']);
});

test('each hub links where it should', () => {
  const d = hubData(store());
  const links = name => [...hubHtml(name, d).matchAll(/href="(#[a-z0-9-]*)"/g)].map(m => m[1]);
  // After the spade home and any way back: Study, Play or Quest.
  assert.deepEqual(links('study'), ['#', '#study', '#lobby', '#quest', '#equity', '#trainer', '#challenge', '#charts']);
  assert.deepEqual(links('challenge'), ['#', '#study', '#study', '#lobby', '#quest', '#codedoug', '#gto-plo4', '#gto-plo5', '#gto-plo6']);
  assert.deepEqual(links('lobby'), ['#', '#study', '#lobby', '#quest', '#host', '#clubs', '#practice', '#ladder', '#quest']);
  assert.equal(HUBS.length, 4);
});

test('your record against the GTO bot is what it lost, per 100 hands', () => {
  const d = hubData(store({ducyPlayStats: JSON.stringify({v: 1, games: {
    nlhe: {gto: {hands: 200, netBB: -8.2}, you: {hands: 900, netBB: 40}},
    plo4: {'gto-plo': {hands: 50, netBB: 6}},
    plo5: {'gto-plo5': {hands: 100, netBB: 3}},
  }})}));
  const [holdem, plo4, plo5, plo6] = d.gto;
  assert.equal(holdem.hands, 200);
  assert.ok(Math.abs(holdem.bb100 - 4.1) < 1e-9);
  assert.ok(Math.abs(plo4.bb100 + 12) < 1e-9);
  assert.equal(plo5.name, 'Omaha 5');
  assert.ok(Math.abs(plo5.bb100 + 3) < 1e-9);
  assert.equal(plo6.hands, 0);
  assert.equal(plo6.bb100, null);
  const h = hubHtml('challenge', d);
  assert.match(h, /\+4\.1 bb\/100/);
  assert.match(h, /−12\.0 bb\/100/);
  assert.match(h, /200 hands/);
  assert.match(h, /Not played yet/);
});

test('the Study page shows progress', () => {
  const h = hubHtml('study', {mastered: 3, skills: 28, rung: 5, rungs: 20});
  assert.match(h, /3 of 28 skills mastered/);
  assert.match(h, /--pct:11%/);
});

test('the Play page shows the heads-up challenge and your rung', () => {
  const h = hubHtml('lobby', {mastered: 3, skills: 28, rung: 5, rungs: 20});
  assert.match(h, /Heads-up challenge/);
  assert.match(h, /Rung 5 of 20/);
  // Enter a code (#393): one box for a game or a club, with room for a word back.
  assert.match(h, /Game or club code/);
  assert.match(h, /data-v3note[^>]*hidden/);
  assert.doesNotMatch(h, /club manager|Start a club|trial/i);
});

test('every page but the landing page can cross between Study, Play and Quest', () => {
  for (const p of ['study', 'challenge', 'equity', 'trainer']) assert.equal(sideOf(p), 'study', p);
  for (const p of ['lobby', 'practice', 'ladder', 'host', 'join', 'clubs']) assert.equal(sideOf(p), 'play', p);
  assert.equal(sideOf('play', 'clubs'), 'play');
  assert.equal(sideOf('home'), '');
  assert.equal(sideOf('quest'), 'quest');
  assert.deepEqual(crumbFor('quest'), [{href: null, label: 'Bankroll Quest'}]);
  assert.match(sideSwitch('play'), /href="#study">Study<\/a><a href="#lobby" aria-current="true">Play<\/a><a href="#quest">Quest/);
  assert.match(sideSwitch('quest'), /href="#quest" aria-current="true">Quest/);
  // The landing page has a door to Quest beside Study and Play.
  assert.match(hubHtml('home', {}), /class="v3-door v3-door-quest" href="#quest"/);
  for (const hub of ['study', 'challenge', 'lobby']) assert.match(hubHtml(hub, {mastered: 0, skills: 28, rung: 1, rungs: 20}), /class="v3-switch"/, hub);
  assert.doesNotMatch(hubHtml('home', {}), /v3-switch/);
});
