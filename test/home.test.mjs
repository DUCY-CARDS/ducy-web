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
  for (const p of ['join', 'clubs', 'practice']) assert.equal(crumbFor(p)[0].href, '#lobby', p);
  assert.deepEqual(crumbFor('nowhere'), []);
  // Start a game is gone (#643).
  assert.deepEqual(crumbFor('host'), []);
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

test('the beta opens on a club code, clubs and the Regulars, and nothing else (#564, #643)', () => {
  const h = hubHtml('home', hubData(store()));
  assert.match(h, /Pull up a chair\./);
  assert.match(h, /Club code/);
  assert.doesNotMatch(h, /#host/);
  const links = [...h.matchAll(/href="(#[a-z0-9-]+)"/g)].map(m => m[1]);
  assert.deepEqual(links, ['#practice']);
  assert.doesNotMatch(h, /Start a game|Study|Quest|training|Heads-up challenge|Ducybot|play money/i);
  assert.doesNotMatch(h, />[^<]*\bBeta\b/, 'no Beta notice (#566)');
});

// Your clubs are on the front page, with no page of them (#611).
const NIGHT = {name: 'Night Owls', href: '#clubs/c/ABCD-EFGH', who: 'Member'};
const MINE = {name: 'Back Room', href: 'manage.html#clubs/own', who: 'You run it'};
test('with no clubs, the front page has no clubs tile: its code box joins one (#611)', () => {
  const h = hubHtml('home', {...hubData(store()), clubs: []});
  assert.doesNotMatch(h, /v3-clubs|href="#clubs|Private clubs/);
  // The join tile is headed Clubs (#650), its button Join.
  assert.match(h, /v3-tile-name">Clubs<\/span><\/span><form class="v3-join"/);
  assert.match(h, /<button type="submit">Join<\/button>/);
  assert.match(h, /Club code/);
});

test('with one club, its tile opens the club (#611)', () => {
  const h = hubHtml('home', {...hubData(store()), clubs: [NIGHT]});
  assert.match(h, /<a class="v3-tile v3-tile-cream" href="#clubs\/c\/ABCD-EFGH">.*Night Owls/);
  assert.doesNotMatch(h, /href="#clubs"|Private clubs|Start a club|Create your own/);
});

test('with several clubs, the front page lists them, each opening its page (#611)', () => {
  for (const hub of ['home', 'lobby']) {
    const h = hubHtml(hub, {...hubData(store()), clubs: [MINE, NIGHT]});
    assert.match(h, /<span class="v3-tile-name">Clubs<\/span>/, hub);
    const links = [...h.matchAll(/<li><a href="([^"]+)">/g)].map(m => m[1]);
    assert.deepEqual(links, ['manage.html#clubs/own', '#clubs/c/ABCD-EFGH'], hub);
    assert.match(h, /You run it/);
    assert.doesNotMatch(h, /href="#clubs"|Private clubs|Start a club|Create your own/, hub);
  }
});

test('club names are escaped on the front page', () => {
  const h = hubHtml('home', {...hubData(store()), clubs: [{...NIGHT, name: '<b>x</b>'}, NIGHT]});
  assert.match(h, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(h, /<b>x<\/b>/);
});

test('a club page\'s breadcrumb is under Play, called Clubs until its name arrives (#611)', () => {
  assert.deepEqual(crumbFor('clubs'), [{href: '#lobby', label: 'Play'}, {href: null, label: 'Clubs'}]);
});

test('the full landing page moved to #welcome, with Study, Play and Quest', () => {
  const h = hubHtml('welcome', hubData(store()));
  assert.match(h, /Pull up a chair\./);
  const links = [...h.matchAll(/href="(#[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(links, ['#study', '#lobby', '#quest']);
});

test('each hub links where it should', () => {
  const d = hubData(store());
  const links = name => [...hubHtml(name, d).matchAll(/href="(#[a-z0-9-]*)"/g)].map(m => m[1]);
  // After the spade home and any way back.
  assert.deepEqual(links('study'), ['#', '#equity', '#trainer', '#challenge', '#charts']);
  assert.deepEqual(links('challenge'), ['#', '#study', '#codedoug', '#gto-plo4', '#gto-plo5', '#gto-plo6']);
  assert.deepEqual(links('lobby'), ['#', '#practice']);
  assert.equal(HUBS.length, 5);
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

test('the Play page: a code box, and no heads-up challenge in the beta (#564)', () => {
  const h = hubHtml('lobby', {mastered: 3, skills: 28, rung: 5, rungs: 20});
  assert.doesNotMatch(h, /Heads-up challenge|Rung 5 of 20/);
  // Enter a code (#393): one box for a game or a club, with room for a word back.
  assert.match(h, /Club code/);
  assert.match(h, /data-v3note[^>]*hidden/);
  assert.doesNotMatch(h, /club manager|Start a club|trial/i);
});

test('which side each page is on; the beta shows no way across (#551)', () => {
  for (const p of ['study', 'challenge', 'equity', 'trainer']) assert.equal(sideOf(p), 'study', p);
  for (const p of ['lobby', 'practice', 'ladder', 'join', 'clubs']) assert.equal(sideOf(p), 'play', p);
  assert.equal(sideOf('play', 'clubs'), 'play');
  assert.equal(sideOf('home'), '');
  assert.equal(sideOf('quest'), 'quest');
  assert.deepEqual(crumbFor('quest'), [{href: null, label: 'Bankroll Quest'}]);
  assert.equal(sideSwitch('play'), '');
  // The full landing page has a door to Quest beside Study and Play.
  assert.match(hubHtml('welcome', {}), /class="v3-door v3-door-quest" href="#quest"/);
  for (const hub of ['home', 'study', 'challenge', 'lobby']) assert.doesNotMatch(hubHtml(hub, {mastered: 0, skills: 28, rung: 1, rungs: 20}), /v3-switch/, hub);
});
