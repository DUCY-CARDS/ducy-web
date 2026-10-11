// A member's view of the club's tournaments (#189): the calls (started while
// you're away, starting soon), the lobby details, how a running one is
// going, and a cancelled one's refund. Run with:
// node --test test/club-tourneys-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { memberTourneysHtml, tourneyCallsFor } from '../src/club-tourneys-ui.js';

const NOW = 1_000_000_000;
const structure = [{sb: 25, bb: 50, ante: 0, minutes: 10}, {break: true, minutes: 5}, {sb: 50, bb: 100, ante: 10, minutes: 10}];

function tourney(over = {}) {
  return {
    id: 't1', name: 'Friday Freezeout', game: 'nlhe', buyIn: 10000, added: 0, stack: 1500,
    opensAt: NOW - 1000, startsAt: NOW + 60 * 60_000, minPlayers: 2, maxPlayers: 20, tableSize: 9,
    lateLevel: 2, reentry: false, maxReentries: 0, status: 'scheduled', why: '',
    entries: 2, players: [{id: 'me', name: 'Ann'}, {id: 'bo', name: 'Bo'}], in: ['me', 'bo'], places: [],
    pool: 20000, prizes: [14000, 6000], structure, ...over,
  };
}
const member = tourneys => ({code: 'ABCD-EFGH', name: 'Friday Game', status: 'member', tourneys});

test('calls: started while you are away, or starting within the window', () => {
  const soon = 5 * 60_000;
  const running = tourney({status: 'running'});
  const starting = tourney({id: 't2', startsAt: NOW + 3 * 60_000});
  const later = tourney({id: 't3', startsAt: NOW + 30 * 60_000});
  const notMine = tourney({id: 't4', status: 'running', in: ['bo'], players: [{id: 'bo', name: 'Bo'}]});
  const calls = tourneyCallsFor([member([running, starting, later, notMine])], 'me', null, soon, NOW);
  assert.deepEqual(calls.map(c => [c.kind, c.t.id]), [['started', 't1'], ['soon', 't2']]);
  assert.equal(new Set(calls.map(c => c.key)).size, 2);
  // At its table: no call. Not yet a member: no calls.
  const seated = {code: 'ABCD-EFGH', table: 'tourney:t1'};
  assert.deepEqual(tourneyCallsFor([member([running])], 'me', seated, soon, NOW), []);
  assert.deepEqual(tourneyCallsFor([{...member([running]), status: 'pending'}], 'me', null, soon, NOW), []);
});

test('lobby: format, payouts, who is registered and the blinds', () => {
  const h = memberTourneysHtml(member([tourney()]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(h, /<details class="cl-tdetails" data-keep="tl:ABCD-EFGH:t1">/);
  assert.match(h, /starting stack 1,500 · 9 a table · at least 2 players · late registration until the end of level 2/);
  assert.match(h, /Payouts \(for the entries so far\)/);
  assert.match(h, /<th>1st<\/th><td>140<\/td>/);
  assert.match(h, /Registered \(2\)/);
  assert.match(h, /<b>Ann \(you\)<\/b>, Bo/);
  assert.match(h, /<td>1<\/td><td>25\/50<\/td><td>–<\/td><td>10<\/td>/);
  assert.match(h, /Break<\/td><td>5<\/td>/);
  assert.match(h, /<td>2<\/td><td>50\/100<\/td><td>10<\/td>/);
});

test('running: level, players left, average, places paid, your stack and rank', () => {
  const live = {
    level: 0, onBreak: false, stepEndsAt: NOW + 4 * 60_000, playersLeft: 3, handForHand: false, tables: [{id: 0, players: 3}],
    standings: [{id: 'bo', name: 'Bo', stack: 2000}, {id: 'me', name: 'Ann', stack: 1500}, {id: 'cy', name: 'Cy', stack: 1000}],
  };
  const t = tourney({status: 'running', entries: 3, live});
  const h = memberTourneysHtml(member([t]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(h, /Level 1 · 25\/50 · next in 4 min · 3 left · average 1,500 · 2 paid/);
  assert.match(h, /You: <b>1,500<\/b>, 2nd of 3/);
  const bubble = memberTourneysHtml(member([{...t, live: {...live, playersLeft: 2}}]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(bubble, /in the money/);
});

test('cancelled: your buy-in is back', () => {
  const t = tourney({status: 'cancelled', why: 'fewer than 2 players'});
  const h = memberTourneysHtml(member([t]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(h, /cancelled \(fewer than 2 players\)/);
  assert.match(h, /Your 100 buy-in is back in your balance/);
  assert.doesNotMatch(h, /cl-tdetails/);
  const other = memberTourneysHtml(member([t]), 'zed', {hostHere: true, playing: null}, NOW);
  assert.doesNotMatch(other, /buy-in is back/);
});
