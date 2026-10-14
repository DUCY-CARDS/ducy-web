// Club tournaments' rules (club-tourneys.js): registering moves chips and
// the pool is the buy-ins plus the added chips (#77); below the minimum
// it's cancelled with full refunds; registration closes at the maximum;
// payouts add up exactly to the pool for any field, and a custom one that
// doesn't can't be saved; prizes land in winners' balances (#79); late
// registration and re-entries close after the chosen level, each adding an
// entry and a buy-in, within the re-entry limit (#80). Club chips are
// conserved throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, newClub } from '../src/club.js';
import { issue, totals } from '../src/club-chips.js';
import {
  atStart, cancelTourney, defaultPayout, entryCount, finishTourney, knockedOut, lateEntry, newTourney, pool, prizes,
  register, setPayout, startTourney, tourneysBody, unregister,
} from '../src/club-tourneys.js';

const LEVELS = [{sb: 10, bb: 20, ante: 0, minutes: 10}, {sb: 20, bb: 40, ante: 0, minutes: 10}, {break: true, minutes: 5}, {sb: 50, bb: 100, ante: 10, minutes: 10}];

function clubWith(n, balance = 10000) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  const ids = Array.from({length: n}, (_, i) => `p${i}`);
  for (const id of ids) {
    club.members[id] = {id, name: id.toUpperCase(), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, balance, 0);
  }
  return {club, ids};
}

const conserved = club => assert.ok(totals(club).conserved, JSON.stringify(totals(club)));

test('registering takes the buy-in, unregistering refunds it, and the pool is buy-ins plus the added chips', () => {
  const {club, ids} = clubWith(3);
  const t = newTourney(club, {name: 'Sunday', buyIn: 1000, added: 500, stack: 1500, structure: LEVELS, opensAt: 100, startsAt: 1000});
  assert.throws(() => register(club, t.id, 'p0', 50), /isn’t open yet/);
  for (const id of ids) register(club, t.id, id, 200);
  assert.throws(() => register(club, t.id, 'p0', 200), /registered already/);
  assert.equal(club.members.p0.balance, 9000);
  assert.equal(pool(t), 3500);
  conserved(club);
  unregister(club, t.id, 'p2', 300);
  assert.equal(club.members.p2.balance, 10000);
  assert.equal(pool(t), 2500);
  assert.equal(entryCount(t), 2);
  conserved(club);
  // The ledger has both sides.
  const kinds = club.chips.ledger.filter(e => e.member === 'p2').map(e => e.kind);
  assert.deepEqual(kinds, ['issue', 'tourney_buyin', 'tourney_refund']);
  assert.throws(() => register(club, t.id, 'p9', 200), /Not a member/);
});

test('below the minimum at the start time it’s cancelled, with every buy-in back', () => {
  const {club, ids} = clubWith(3);
  const t = newTourney(club, {buyIn: 700, stack: 1500, structure: LEVELS, opensAt: 0, startsAt: 1000, minPlayers: 4});
  for (const id of ids) register(club, t.id, id, 10);
  assert.equal(atStart(t, 999), null);
  assert.equal(atStart(t, 1000), 'cancel');
  cancelTourney(club, t.id, 1000, 'not enough players');
  for (const id of ids) assert.equal(club.members[id].balance, 10000);
  assert.equal(t.status, 'cancelled');
  assert.equal(t.held, 0);
  conserved(club);
});

test('registration closes at the maximum', () => {
  const {club, ids} = clubWith(5);
  const t = newTourney(club, {stack: 1500, structure: LEVELS, opensAt: 0, startsAt: 1000, maxPlayers: 4});
  for (const id of ids.slice(0, 4)) register(club, t.id, id, 10);
  assert.throws(() => register(club, t.id, 'p4', 10), /full/);
  assert.equal(atStart(t, 1000), 'start');
});

test('default payouts add up exactly to the pool for any number of entries', () => {
  for (let n = 1; n <= 300; n++) {
    const bp = defaultPayout(n);
    assert.equal(bp.reduce((a, b) => a + b, 0), 10000, `${n} entries`);
    for (let i = 1; i < bp.length; i++) assert.ok(bp[i] <= bp[i - 1], `${n} entries: falling`);
    assert.ok(bp.length <= Math.max(1, Math.ceil(n * 0.15)) || n <= 10, `${n} entries: about 15% paid`);
    for (const buyIn of [0, 1, 333, 1000, 12345]) {
      const t = {entries: Array.from({length: n}, () => ({})), buyIn, added: 77, payout: null};
      assert.equal(prizes(t).reduce((a, b) => a + b, 0), n * buyIn + 77, `${n} entries at ${buyIn}`);
    }
  }
});

test('a custom payout that doesn’t add up to 100% can’t be saved', () => {
  const {club} = clubWith(2);
  const t = newTourney(club, {stack: 1500, structure: LEVELS, opensAt: 0, startsAt: 1000});
  assert.throws(() => setPayout(club, t.id, [6000, 3000]), /90\.00%/);
  assert.throws(() => setPayout(club, t.id, [3000, 7000]), /more than the one above/);
  assert.throws(() => setPayout(club, t.id, [10000, 0]), /above 0/);
  setPayout(club, t.id, [7000, 3000]);
  assert.deepEqual(t.payout.places, [7000, 3000]);
  setPayout(club, t.id, null);
  assert.equal(t.payout, null);
});

test('prizes land in the winners’ club balances, and the added chips are paid too', () => {
  const {club, ids} = clubWith(10);
  const t = newTourney(club, {buyIn: 1000, added: 2000, stack: 1500, structure: LEVELS, opensAt: 0, startsAt: 100});
  for (const id of ids) register(club, t.id, id, 10);
  setPayout(club, t.id, [5000, 3000, 2000]);
  startTourney(club, t.id, 100);
  // Knocked out from 10th to 2nd; p0 wins.
  ids.slice(1).reverse().forEach((id, k) => knockedOut(club, t.id, id, 10 - k));
  const paid = finishTourney(club, t.id, 'p0', 500);
  assert.deepEqual(paid.map(p => [p.member, p.place, p.amount]), [['p0', 1, 6000], ['p1', 2, 3600], ['p2', 3, 2400]]);
  assert.equal(club.members.p0.balance, 9000 + 6000);
  assert.equal(club.members.p9.balance, 9000);
  assert.equal(t.status, 'finished');
  conserved(club);
  // Members see the result.
  const body = tourneysBody(club, {}, 600).tourneys[0];
  assert.equal(body.places.find(p => p.place === 1).id, 'p0');
});

test('late registration and re-entries close after the chosen level, each a new entry and buy-in, within the limit', () => {
  const {club, ids} = clubWith(4);
  const t = newTourney(club, {buyIn: 100, stack: 1500, structure: LEVELS, opensAt: 0, startsAt: 100, lateLevel: 2, reentry: true, maxReentries: 1});
  for (const id of ids.slice(0, 3)) register(club, t.id, id, 10);
  startTourney(club, t.id, 100);
  // p3 registers late, in level 1 (from 0).
  lateEntry(club, t.id, 'p3', 1, 200);
  assert.equal(entryCount(t), 4);
  assert.throws(() => lateEntry(club, t.id, 'p0', 1, 200), /still in/);
  // p0 busts and re-enters once; not twice.
  knockedOut(club, t.id, 'p0', 4);
  lateEntry(club, t.id, 'p0', 1, 300);
  assert.equal(entryCount(t), 5);
  assert.equal(pool(t), 500);
  knockedOut(club, t.id, 'p0', 4);
  assert.throws(() => lateEntry(club, t.id, 'p0', 1, 400), /1 time at most/);
  // After level 2 it's closed for everyone.
  knockedOut(club, t.id, 'p1', 3);
  assert.throws(() => lateEntry(club, t.id, 'p1', 2, 500), /closed/);
  assert.equal(club.members.p0.balance, 10000 - 200);
  conserved(club);
});

test('settings are checked', () => {
  const {club} = clubWith(1);
  const at = {opensAt: 0, startsAt: 5};
  assert.throws(() => newTourney(club, {...at, stack: 10, structure: LEVELS}), /starting stack/);
  assert.throws(() => newTourney(club, {...at, stack: 1500, structure: []}), /blind level/);
  assert.throws(() => newTourney(club, {stack: 1500, structure: LEVELS, opensAt: 10, startsAt: 5}), /after registration opens/);
  assert.throws(() => newTourney(club, {...at, stack: 1500, structure: LEVELS, minPlayers: 5, maxPlayers: 3}), /maximum/);
  assert.throws(() => newTourney(club, {...at, stack: 1500, structure: LEVELS, buyIn: -1}), /buy-in/);
});

test('a club’s plan limits its tournaments a day (#265)', () => {
  const club = clubWith(0);
  const H = 3600e3, day = 864e5;
  const make = (startsAt, limits) => newTourney(club, {stack: 1500, structure: LEVELS, opensAt: 0, startsAt}, 0, limits);
  const one = {tables: 2, tourneysPerDay: 1};
  const first = make(10 * day, one);
  // Another within 24 hours of it is one too many; a day later is fine.
  assert.throws(() => make(10 * day + 23 * H, one), /1 tournament a day/);
  assert.throws(() => make(10 * day - 5 * H, one), /1 tournament a day/);
  make(12 * day, one);
  // A cancelled one frees its day.
  cancelTourney(club, first.id, 0, 'test');
  make(10 * day + 2 * H, one);
  // Two a day, or none; no limits, no cap.
  make(20 * day, {tourneysPerDay: 2});
  make(20 * day + H, {tourneysPerDay: 2});
  assert.throws(() => make(20 * day + 2 * H, {tourneysPerDay: 2}), /2 tournaments a day/);
  assert.throws(() => make(40 * day, {tourneysPerDay: 0}), /can’t run tournaments/);
  make(20 * day + 3 * H, null);
});
