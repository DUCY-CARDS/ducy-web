// The club manager's Overview and notifications (#398): the numbers, the
// dealing-time clock, the member filters, today's tournaments and the
// notices with their quick actions (src/club-overview.js, src/club-notices.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY, dealClock, dealingMs, durationText, isDealing, lastPlayed, memberFilter, overviewNumbers, tableSummaries, todaysTourneys,
} from '../src/club-overview.js';
import { clearableKeys, managerNotices, raiseTo } from '../src/club-notices.js';
import { buyIn, cashOut, ensureChips, issue, requestChips, setStack } from '../src/club-chips.js';
import { newTable } from '../src/club-tables.js';
import { setCredit } from '../src/club-credit.js';

const NOW = Date.UTC(2026, 9, 25, 12);
const MIN = 60_000;

function club() {
  const c = ensureChips({code: 'AAAA-BBBB', name: 'C', hostId: 'host', members: {}, tables: []});
  const add = (id, name, extra = {}) => { c.members[id] = {id, name, status: 'member', joinedAt: NOW - 60 * DAY, ...extra}; };
  add('ann', 'Ann');
  add('ben', 'Ben', {joinedAt: NOW - 2 * DAY});
  add('cy', 'Cy');
  add('dee', 'Dee');
  c.members.eve = {id: 'eve', name: 'Eve', status: 'pending', requestedAt: NOW - 5 * MIN};
  ensureChips(c);
  return c;
}

test('the dealing clock runs only while dealing, and adds up', () => {
  let c = dealClock(null, false, NOW);
  assert.deepEqual(c, {ms: 0, since: null});
  c = dealClock(c, true, NOW);
  assert.ok(isDealing(c));
  assert.equal(dealingMs(c, NOW + 30 * MIN), 30 * MIN);
  // Still dealing: nothing changes.
  assert.deepEqual(dealClock(c, true, NOW + 10 * MIN), c);
  // Fewer than two in hands: it stops, and keeps what it dealt.
  c = dealClock(c, false, NOW + 40 * MIN);
  assert.deepEqual(c, {ms: 40 * MIN, since: null, stoppedAt: NOW + 40 * MIN});
  assert.equal(dealingMs(c, NOW + 120 * MIN), 40 * MIN, 'no time while stopped');
  c = dealClock(c, true, NOW + 60 * MIN);
  assert.equal(dealingMs(c, NOW + 75 * MIN), 55 * MIN);
  assert.equal(durationText(dealingMs(c, NOW + 75 * MIN)), '55 m');
  assert.equal(durationText(134 * MIN + 59_000), '2 h 14 m');
  assert.equal(durationText(0), '0 m');
});

test('the overview: tables active, chips out, members, joined, inactive, owed each way', () => {
  const c = club();
  const t1 = newTable(c, {name: 'Main', sb: 100, bb: 200}, NOW);
  const t2 = newTable(c, {name: 'PLO', game: 'plo4', sb: 100, bb: 200}, NOW);
  t1.dealing = dealClock(null, true, NOW - 47 * MIN);
  t2.dealing = dealClock(dealClock(null, true, NOW - 60 * MIN), false, NOW - 18 * MIN);
  issue(c, 'ann', 100_000, NOW - 40 * DAY);
  issue(c, 'cy', 50_000, NOW - 40 * DAY);
  // Cy played 10 days ago; Ann last 40 days ago; Dee never; Ben joined lately.
  buyIn(c, 'cy', t1.id, 20_000, {min: 8000, max: 20_000}, NOW - 10 * DAY);
  cashOut(c, 'cy', NOW - 10 * DAY);
  // Dee plays on credit and stands up owing 150.
  setCredit(c, 'dee', 20_000);
  buyIn(c, 'dee', t1.id, 20_000, {min: 8000, max: 20_000}, NOW - DAY);
  setStack(c, 'dee', 5000);
  issue(c, 'ann', 15_000, NOW - DAY); // (the chips Dee lost, so the books add up)
  cashOut(c, 'dee', NOW - DAY);
  const n = overviewNumbers(c, NOW);
  assert.deepEqual(n, {tablesActive: 1, tables: 2, chipsOut: 165_000, members: 4, joined: 1, inactive: 1, owedToClub: 15_000, owedToPlayers: 165_000});
  assert.deepEqual(lastPlayed(c), {cy: NOW - 10 * DAY, dee: NOW - DAY});
  // Each number opens Members filtered to match.
  assert.deepEqual(memberFilter(c, 'new', NOW).map(m => m.name), ['Ben']);
  assert.deepEqual(memberFilter(c, 'inactive', NOW).map(m => m.name), ['Ann']);
  assert.deepEqual(memberFilter(c, 'owes', NOW).map(m => m.name), ['Dee']);
  assert.equal(memberFilter(c, 'all', NOW).length, 4, 'not the one asking to join');
  // Someone seated isn't inactive, however long ago they sat.
  buyIn(c, 'ann', t1.id, 20_000, {min: 8000, max: 20_000}, NOW - 45 * DAY);
  assert.deepEqual(memberFilter(c, 'inactive', NOW).map(m => m.name), []);
  const rows = tableSummaries(c, {[t1.id]: 6}, NOW);
  assert.deepEqual(rows.map(r => [r.name, r.dealing, r.ms, r.taken, r.stoppedAt]), [['Main', true, 47 * MIN, 6, 0], ['PLO', false, 42 * MIN, 0, NOW - 18 * MIN]]);
});

test('today’s tournaments: running ones, then today’s by start', () => {
  const c = club();
  const local = (h, m = 0) => { const d = new Date(NOW); d.setHours(h, m, 0, 0); return d.getTime(); };
  c.tourneys = [
    {id: 'a', name: 'Late', status: 'scheduled', startsAt: local(21)},
    {id: 'b', name: 'Turbo', status: 'running', startsAt: local(10)},
    {id: 'c', name: 'Early', status: 'scheduled', startsAt: local(19)},
    {id: 'd', name: 'Tomorrow', status: 'scheduled', startsAt: local(19) + DAY},
    {id: 'e', name: 'Done', status: 'finished', startsAt: local(9)},
  ];
  assert.deepEqual(todaysTourneys(c, local(12)).map(t => t.name), ['Turbo', 'Early', 'Late']);
});

test('notifications: each kind, newest first, with what its quick actions need', () => {
  const c = club();
  const t = newTable(c, {name: 'Main', sb: 100, bb: 200}, NOW);
  issue(c, 'ann', 10_000, NOW - DAY);
  requestChips(c, 'ann', 50_000, 'for tonight', NOW - 4 * MIN);
  // At the limit: asks for more than credit leaves available.
  setCredit(c, 'ben', 50_000);
  requestChips(c, 'ben', 80_000, '', NOW - 3 * MIN, {table: 'Main'});
  c.help = [{id: 'h1', from: 'cy', name: 'Cy', text: 'Seat 4 keeps timing out', table: 'Main', at: NOW - 2 * MIN, handled: null}];
  c.members.cy.seat = {table: t.id, stack: 0, put: 0};
  c.promos = {awards: [{id: 'w1', status: 'held', member: 'dee', name: 'Dee', amount: 5000, promoName: 'High hand', hand: 'h:1', handName: 'Four nines', at: NOW - MIN}, {id: 'w2', status: 'paid', at: NOW}]};
  t.dealing = {ms: 30 * MIN, since: null, stoppedAt: NOW - 30_000};
  // Dee stood up owing.
  setCredit(c, 'dee', 20_000);
  buyIn(c, 'dee', t.id, 20_000, {min: 8000, max: 20_000}, NOW - 20 * MIN);
  setStack(c, 'dee', 0);
  issue(c, 'ann', 20_000, NOW - 20 * MIN);
  cashOut(c, 'dee', NOW - 10_000);
  const list = managerNotices(c, {seated: {[t.id]: 1}});
  assert.deepEqual(list.map(n => n.kind), ['left_owing', 'stopped', 'prize', 'help', 'at_limit', 'chips', 'join']);
  const by = Object.fromEntries(list.map(n => [n.kind, n]));
  assert.equal(by.join.member, 'eve');
  assert.deepEqual([by.chips.member, by.chips.amount, by.chips.note], ['ann', 50_000, 'for tonight']);
  assert.deepEqual([by.at_limit.member, by.at_limit.asked, by.at_limit.credit, by.at_limit.available, by.at_limit.table], ['ben', 80_000, 50_000, 50_000, 'Main']);
  // Raising the limit by what's short covers the ask: 500 + (800 − 500).
  assert.equal(raiseTo(by.at_limit), 80_000);
  assert.deepEqual([by.help.id, by.help.watch], ['h1', t.id], 'Watch: the table they’re at');
  assert.deepEqual([by.prize.id, by.prize.hand], ['w1', 'h:1']);
  assert.equal(by.stopped.table, t.id);
  assert.equal(by.left_owing.owesNow, 20_000);
  // Clear puts away only the ones that need no answer.
  const cleared = new Set(clearableKeys(list));
  assert.deepEqual([...cleared].map(k => k.split(':')[0]), ['left_owing', 'stopped']);
  assert.deepEqual(managerNotices(c, {cleared}).map(n => n.kind), ['prize', 'help', 'at_limit', 'chips', 'join']);
  // A table dealing again, or a debt settled, says nothing.
  t.dealing = dealClock(t.dealing, true, NOW);
  issue(c, 'dee', 20_000, NOW, 'Settled', 'settle');
  assert.ok(!managerNotices(c).some(n => n.kind === 'stopped' || n.kind === 'left_owing'));
});
