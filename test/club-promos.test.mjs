// High Hand promotions (#267): qualifying hands (#269), settings (#274),
// high hand of the period (#276), hand bonuses (#277).
// Run with: node --test test/club-promos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { approve, newClub } from '../src/club.js';
import { balanceChange, checkOwnLedger, issue, totals } from '../src/club-chips.js';
import {
  approveAward, bestWithTwo, editPromo, handName, newPromo, nextSettle, periodOf, processHand, promosAdmin, promosBody, promoRules,
  score5, setPromoStatus, settlePeriods, shownHands, voidAward,
} from '../src/club-promos.js';

const H = 3600e3, D = 24 * H;
const T0 = Date.UTC(2026, 9, 14, 12); // a Wednesday, noon UTC

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
  }
  return club;
}

// A finished hand's record (hand-replay.js): `hands` is the seats' cards
// (null: mucked or folded), everyone at seats 0…n-1, `extra` seats dealt in
// without cards.
let handN = 0;
function rec({hands, board, board2 = null, game = 'nlhe', at = T0, table = 't1', pot = 1000, extra = 2}) {
  const seats = hands.map((cards, i) => ({i, name: `P${i}`, cards, folded: !cards, inHand: true, stackEnd: 0, net: 0, won: 0}));
  for (let k = 0; k < extra; k++) seats.push({i: seats.length, name: `X${k}`, cards: null, folded: true, inHand: true});
  return {id: `ABCD-EFGH:${table}:${++handN}:${at}`, club: 'ABCD-EFGH', table, game, at, showdown: true, board, ...(board2 ? {board2} : {}), pot, seats};
}
const players = ids => ids.map((client_id, seat) => ({seat, client_id}));

test('five-card scores and names', () => {
  const s = c => score5(c.split(' '));
  assert.equal(s('As Ks Qs Js Ts').cat, 9);
  assert.equal(s('9s Ks Qs Js Ts').cat, 8);
  assert.ok(s('As Ks Qs Js Ts').score > s('9s Ks Qs Js Ts').score);
  assert.equal(s('Ah 2d 3c 4s 5h').cat, 4, 'the wheel');
  assert.ok(s('6h 2d 3c 4s 5h').score > s('Ah 2d 3c 4s 5h').score, 'six-high beats the wheel');
  assert.equal(s('Kh Kd Kc Ks 2h').cat, 7);
  assert.ok(s('Kh Kd Kc Ks 3h').score > s('Kh Kd Kc Ks 2h').score);
  assert.ok(s('Ah Ad Ac Ks Kh').score > s('Kh Kd Kc As Ah').score);
  assert.equal(handName(s('Kh Kd Kc Ks 2h')), 'Quad kings');
  assert.equal(handName(s('Ah Ad Ac Ts Th')), 'A full house, aces full of tens');
  assert.equal(handName(s('As Ks Qs Js Ts')), 'A royal flush');
  assert.equal(handName(s('9s Ks Qs Js Ts')), 'A straight flush, king high');
});

test('qualifying hands use two hole cards and three from the board (#269)', () => {
  // A royal flush on the board alone doesn't count in Hold'em.
  const b = bestWithTwo(['2c', '3d'], ['As', 'Ks', 'Qs', 'Js', 'Ts']);
  assert.notEqual(b.cat, 9);
  // Quads with both hole cards.
  assert.equal(bestWithTwo(['Kc', 'Kd'], ['Kh', 'Ks', '2d', '7c', '9h']).cat, 7);
  // Omaha: exactly two of four.
  assert.equal(bestWithTwo(['Ah', 'Kh', '2c', '3c'], ['Qh', 'Jh', 'Th', '4d', '5s']).cat, 9);
  assert.notEqual(bestWithTwo(['Ah', '2c', '3c', '4c'], ['Kh', 'Qh', 'Jh', 'Th', '5s']).cat, 9, 'one hole card isn’t enough in Omaha');

  // Mucked or folded seats don't count; each board counts.
  const r = rec({hands: [['Kc', 'Kd'], null, ['2c', '3d']], board: ['Kh', 'Ks', '2d', '7c', '9h'], board2: ['Ah', 'Ad', '4c', '5c', '6c'], extra: 0});
  const shown = shownHands(r, players(['ann', 'bob', 'cy']));
  assert.deepEqual(shown.map(h => [h.member, h.board, h.category]), [
    ['ann', 1, 'quads'], ['ann', 2, 'two_pair'], ['cy', 1, 'two_pair'], ['cy', 2, 'straight'],
  ]);
  assert.deepEqual(shownHands({...r, showdown: false}, players(['ann', 'bob', 'cy'])), []);
});

const HH = {kind: 'high_hand', name: 'Daily high hand', games: ['nlhe', 'plo4'], every: 'day', prizes: [5000], minCategory: 'trips', tz: 0};
const BONUS = {kind: 'bonus', name: 'Big hands', games: ['nlhe'], every: 'day', tiers: [{category: 'quads', amount: 1000}, {category: 'straight_flush', amount: 2500}], capPerTier: 2, tz: 0};

test('settings: validated, rules in a sentence', () => {
  const club = clubWith();
  assert.throws(() => newPromo(club, {...HH, games: []}), /at least one game/);
  assert.throws(() => newPromo(club, {...HH, prizes: []}), /first place/);
  assert.throws(() => newPromo(club, {...BONUS, tiers: []}), /at least one bonus/);
  assert.throws(() => newPromo(club, {...BONUS, tiers: [{category: 'quads', amount: 1}, {category: 'quads', amount: 2}]}), /one bonus/);
  assert.throws(() => newPromo(club, {...HH, every: 'session', days: [5], from: 1200, to: 1100}), /end after it starts/);
  const p = newPromo(club, HH, T0);
  assert.equal(p.minPlayers, 4, 'four players dealt in by default');
  assert.equal(promoRules(p), 'Best Hold’em, Omaha 4 hand each day wins 50 (three of a kind or better).');
  assert.equal(promoRules(newPromo(club, BONUS, T0)), 'Hold’em: straight flush 25, four of a kind 10, up to 2 of each a day.');
});

test('periods: hours, days, Monday weeks, sessions, in the manager’s time zone', () => {
  const day = periodOf({every: 'day', tz: 0}, T0);
  assert.equal(day.start, Date.UTC(2026, 9, 14));
  assert.equal(day.end, Date.UTC(2026, 9, 15));
  // New York (UTC−4 in October): the day starts at 04:00 UTC.
  assert.equal(periodOf({every: 'day', tz: -240}, T0).start, Date.UTC(2026, 9, 14, 4));
  assert.equal(periodOf({every: 'week', tz: 0}, T0).start, Date.UTC(2026, 9, 12), 'Monday');
  assert.equal(periodOf({every: 'hour', tz: 0}, T0 + 25 * 60e3).start, T0);
  // Fridays 20:00–23:00 UTC.
  const fri = {every: 'session', tz: 0, days: [5], from: 20 * 60, to: 23 * 60};
  assert.equal(periodOf(fri, T0), null);
  const s = periodOf(fri, Date.UTC(2026, 9, 16, 21));
  assert.deepEqual([s.start, s.end], [Date.UTC(2026, 9, 16, 20), Date.UTC(2026, 9, 16, 23)]);
  assert.equal(periodOf({every: 'day', startsAt: T0 + D}, T0), null);
});

test('high hand of the period: each game’s best, paid at the end; ties split (#276)', () => {
  const club = clubWith('ann', 'bob', 'cy');
  const promo = newPromo(club, HH, T0);
  const ids = players(['ann', 'bob', 'cy']);
  const quads = rec({hands: [['Kc', 'Kd'], ['2c', '3d']], board: ['Kh', 'Ks', '8d', '7c', '9h'], at: T0});
  const lead = processHand(club, quads, ids);
  assert.equal(lead.leads.length, 1);
  assert.equal(lead.leads[0].hand.hand, 'Quad kings');
  // Trips behind the quads; below the minimum (trips) wouldn't show.
  processHand(club, rec({hands: [['Ac', 'Ad'], ['Qs', 'Qd']], board: ['Ah', 'Qh', '8d', '7c', '9h'], at: T0 + H}), ids);
  processHand(club, rec({hands: [['Jc', 'Td'], ['2s', '2d']], board: ['Jh', 'Th', '8d', '7c', '9h'], at: T0 + H}), ids);
  // Omaha's own contest.
  processHand(club, rec({hands: [['Ah', 'Kh', '2c', '3c'], null, ['9s', '9d', '4c', '4d']], board: ['Qh', 'Jh', 'Th', '9c', '5s'], game: 'plo4', at: T0 + 2 * H}), ids);
  // Three players dealt in: below the default four.
  const short = processHand(club, rec({hands: [['As', 'Ad'], ['2c', '3d']], board: ['Ah', 'Ac', '8d', '7c', '9h'], at: T0 + 3 * H, extra: 1}), ids);
  assert.equal(short.leads.length, 0);
  assert.equal(club.promos.hands.at(-1).ineligible, 'fewer than 4 players');

  assert.deepEqual(promosBody(club, T0 + 4 * H).promos[0].leaders.nlhe.map(l => l.hand), ['Quad kings', 'A straight, jack high', 'Three aces']);
  assert.equal(nextSettle(club), Date.UTC(2026, 9, 15));
  assert.deepEqual(settlePeriods(club, T0 + 4 * H), [], 'not over yet');
  const paid = settlePeriods(club, Date.UTC(2026, 9, 15, 1));
  assert.deepEqual(paid.map(a => [a.member, a.amount, a.game]), [['ann', 5000, 'nlhe'], ['ann', 5000, 'plo4']]);
  assert.equal(club.members.ann.balance, 10000);
  assert.ok(totals(club).conserved);
  const mine = club.chips.ledger.filter(e => e.member === 'ann');
  assert.ok(checkOwnLedger(mine, club.members.ann.balance), 'members’ own copies still add up');
  assert.equal(balanceChange(mine[0]), 5000);
  assert.equal(nextSettle(club), null);
  assert.equal(club.promos.history.length, 2);

  // Ties split: two ace-high straights on the next day share the prize.
  const tie = newPromo(club, {...HH, games: ['plo4'], prizes: [3001]}, T0);
  setPromoStatus(club, promo.id, 'paused');
  const day2 = Date.UTC(2026, 9, 15, 12);
  processHand(club, rec({hands: [['Ac', 'Kd', '2c', '3c'], ['As', 'Kh', '2d', '3d']], board: ['Qh', 'Jc', 'Td', '4s', '8h'], game: 'plo4', at: day2}), ids);
  const split = settlePeriods(club, Date.UTC(2026, 9, 16, 1));
  assert.deepEqual(split.filter(a => a.promo === tie.id).map(a => [a.member, a.amount]), [['ann', 1501], ['bob', 1500]]);
});

test('hand bonuses: highest tier once per hand, capped per period and player (#277)', () => {
  const club = clubWith('ann', 'bob');
  const promo = newPromo(club, {...BONUS, capPerPlayer: 0}, T0);
  const ids = players(['ann', 'bob']);
  const sf = () => rec({hands: [['9s', '8s'], ['Kc', 'Kd']], board: ['7s', '6s', '5s', 'Kh', 'Ks'], at: T0});
  const r1 = processHand(club, sf(), ids);
  assert.deepEqual(r1.paid.map(a => [a.member, a.amount, a.category]), [['ann', 2500, 'straight_flush'], ['bob', 1000, 'quads']]);
  processHand(club, sf(), ids);
  // Both tiers have paid twice today: the cap.
  assert.deepEqual(processHand(club, sf(), ids).paid, []);
  assert.deepEqual(promosBody(club, T0).promos[0].caps.map(c => [c.category, c.used, c.cap]), [['straight_flush', 2, 2], ['quads', 2, 2]]);
  // The next day the counters start again.
  settlePeriods(club, T0 + D);
  assert.equal(processHand(club, {...sf(), at: T0 + D}, ids).paid.length, 2);
  assert.ok(totals(club).conserved);

  // Per player, and the budget.
  const club2 = clubWith('ann', 'bob');
  newPromo(club2, {...BONUS, capPerTier: 0, capPerPlayer: 1, budget: 3000}, T0);
  const quads = () => rec({hands: [['Kc', 'Kd'], ['Ac', 'Ad']], board: ['Kh', 'Ks', 'Ah', 'As', '2d'], at: T0});
  assert.equal(processHand(club2, quads(), ids).paid.length, 2);
  assert.equal(processHand(club2, quads(), ids).paid.length, 0, 'one each');
  const club3 = clubWith('ann', 'bob');
  newPromo(club3, {...BONUS, capPerTier: 0, budget: 1500}, T0);
  const b = processHand(club3, quads(), ids);
  assert.equal(b.paid.length, 1);
  assert.deepEqual(b.budget, ['Big hands']);
});

test('voiding: within 24 hours, chips taken back, the next best offered (#276)', () => {
  const club = clubWith('ann', 'bob', 'cy');
  newPromo(club, {...HH, games: ['nlhe']}, T0);
  const ids = players(['ann', 'bob', 'cy']);
  processHand(club, rec({hands: [['Kc', 'Kd'], ['Qc', 'Qd']], board: ['Kh', 'Ks', 'Qh', 'Qs', '2d'], at: T0}), ids);
  const [a] = settlePeriods(club, T0 + D);
  assert.equal(a.member, 'ann');
  const later = T0 + D + 3 * H;
  const {offered} = voidAward(club, a.id, later, 'collusion');
  assert.equal(club.members.ann.balance, 0);
  assert.equal(club.chips.ledger.at(-1).kind, 'promo_void');
  assert.ok(totals(club).conserved);
  assert.ok(checkOwnLedger(club.chips.ledger.filter(e => e.member === 'ann'), 0));
  assert.equal(offered.member, 'bob');
  assert.equal(offered.status, 'held', 'offered, for the manager to approve');
  approveAward(club, offered.id, later);
  assert.equal(club.members.bob.balance, 5000);
  assert.throws(() => voidAward(club, offered.id, later + 2 * D), /within 24 hours/);
  assert.equal(promosAdmin(club, later).awards[0].id, offered.id);
});

test('the members’ panel: rules, leaders and prizes, names escaped (#278)', async () => {
  const {memberPromosHtml} = await import('../src/club-promos-ui.js');
  const club = clubWith('ann', 'bob');
  club.members.ann.name = '<b>Ann</b>';
  newPromo(club, {...HH, games: ['nlhe']}, T0);
  newPromo(club, BONUS, T0);
  processHand(club, rec({hands: [['Kc', 'Kd'], ['2c', '3d']], board: ['Kh', 'Ks', '8d', '7c', '9h'], at: T0}), players(['ann', 'bob']));
  const body = promosBody(club, T0);
  body.recent[0].name = '<b>Ann</b>';
  const h = memberPromosHtml(body, T0);
  assert.match(h, /Daily high hand/);
  assert.match(h, /12 h left/);
  assert.match(h, /quad kings/);
  assert.match(h, /Four of a kind: 1 of 2 paid/);
  assert.ok(!h.includes('<b>Ann</b>') && h.includes('&lt;b&gt;Ann&lt;/b&gt;'));
  assert.equal(memberPromosHtml({promos: [], recent: []}), '');
});

test('changes to a running period wait for the next one (#274)', () => {
  const club = clubWith('ann', 'bob');
  const promo = newPromo(club, {...BONUS, capPerTier: 0}, T0);
  // Nothing has happened yet: the change applies at once.
  editPromo(club, promo.id, {...BONUS, tiers: [{category: 'quads', amount: 2000}]}, T0);
  assert.equal(promo.tiers[0].amount, 2000);
  processHand(club, rec({hands: [['Kc', 'Kd'], ['2c', '3d']], board: ['Kh', 'Ks', '8d', '7c', '9h'], at: T0}), players(['ann', 'bob']));
  editPromo(club, promo.id, {...BONUS, tiers: [{category: 'quads', amount: 3000}]}, T0 + H);
  assert.equal(promo.tiers[0].amount, 2000, 'this period keeps its rules');
  settlePeriods(club, T0 + D);
  assert.equal(promo.tiers[0].amount, 3000);
});
