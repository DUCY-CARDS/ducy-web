// One-off private games' standings (#403): a cash game's ledger (chips the
// host gives out, handed back, taken away), the standings and who owes whom,
// the download, and a tournament's prizes in points (the split of the
// buy-ins, the host's own with an overlay) and its standings. Run with:
// node --test test/oneoff-standings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atTable, cashOut, cashStandings, give, handBack, newLedger, settleUp, standingsCsv } from '../src/oneoff-standings.js';
import { settleHtml, signed, standingsHtml, fileName } from '../src/oneoff-standings-ui.js';
import { HOST_ID, autoPrizes, joinPrivate, lobbyBody, newPrivateTourney, prizeList, prizeTotals, privateClub, results, setPrizes, theTourney, tourneySettle, tourneyStandings } from '../src/private-tourney.js';
import { pageHtml, totalsText } from '../src/private-tourney-ui.js';

const LEVELS = [{sb: 10, bb: 20, ante: 0, minutes: 5}];
const setup = (over = {}) => ({name: '', game: 'nlhe', stack: 1500, tableSize: 9, structure: LEVELS, payout: 'default', buyIn: 100, ...over});
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const net = (rows, id) => rows.find(r => r.id === id).net;

test('a cash game: chips given, rebuys, a hand-back, a cash-out, and the standings', () => {
  const l = newLedger();
  give(l, 'host', 'Ann', 20000);
  give(l, 'b', 'Bo', 10000);
  give(l, 'c', 'Cy', 10000);
  give(l, 'c', 'Cy', 0); // nothing given, nothing recorded
  // Given chips count at once, before the table says so.
  assert.deepEqual(cashStandings(l).map(r => [r.name, r.given, r.now, r.net]), [['Ann', 20000, 20000, 0], ['Bo', 10000, 10000, 0], ['Cy', 10000, 10000, 0]]);

  // A few hands: Cy loses it all and rebuys; Bo is up.
  atTable(l, [{id: 'host', name: 'Ann', chips: 18000}, {id: 'b', name: 'Bo', chips: 22000}, {id: 'c', name: 'Cy', chips: 0}]);
  give(l, 'c', 'Cy', 10000);
  // A top-up that didn't fit under the maximum: some handed back.
  give(l, 'b', 'Bo', 5000);
  handBack(l, 'b', 3000);
  atTable(l, [{id: 'host', name: 'Ann', chips: 15000}, {id: 'b', name: 'Bo', chips: 26000}, {id: 'c', name: 'Cy', chips: 11000}]);
  // Cy leaves with what they have; they stay in the standings.
  cashOut(l, 'c', 11000);
  atTable(l, [{id: 'host', name: 'Ann', chips: 15000}, {id: 'b', name: 'Bobby', chips: 26000}]);

  const rows = cashStandings(l);
  assert.deepEqual(rows.map(r => [r.name, r.given, r.now, r.net]), [
    ['Bobby', 12000, 26000, 14000],
    ['Ann', 20000, 15000, -5000],
    ['Cy', 20000, 11000, -9000],
  ]);
  assert.equal(sum(rows, r => r.net), 0, 'chips are conserved between hands');

  // Who owes whom: the losers pay the winner, as much as they lost.
  const pay = settleUp(rows);
  assert.deepEqual(pay.map(p => [p.fromName, p.toName, p.amount]), [['Cy', 'Bobby', 9000], ['Ann', 'Bobby', 5000]]);
  assert.equal(sum(pay, p => p.amount), 14000);
});

test('settle-up: everyone ends square, in as few payments as it simply can', () => {
  const rows = [
    {id: 'a', name: 'A', net: 5000}, {id: 'b', name: 'B', net: 2500}, {id: 'c', name: 'C', net: -4000},
    {id: 'd', name: 'D', net: -2000}, {id: 'e', name: 'E', net: -1500}, {id: 'f', name: 'F', net: 0},
  ];
  const pay = settleUp(rows);
  const after = Object.fromEntries(rows.map(r => [r.id, r.net]));
  for (const p of pay) { after[p.from] += p.amount; after[p.to] -= p.amount; }
  assert.ok(Object.values(after).every(v => v === 0), 'everyone square');
  assert.ok(pay.length <= rows.filter(r => r.net).length - 1);
  assert.ok(pay.every(p => p.amount > 0 && p.from !== 'f' && p.to !== 'f'), 'someone even pays nothing');
  assert.deepEqual(settleUp([{id: 'a', name: 'A', net: 0}]), []);
  // Nets that don't add up (a pot in play): what can be paid is.
  assert.deepEqual(settleUp([{id: 'a', name: 'A', net: 300}, {id: 'b', name: 'B', net: -200}]).map(p => p.amount), [200]);
});

test('the standings on screen and in the download', () => {
  const rows = [{id: 'me', name: 'Bo <i>', given: 100, now: 250, net: 150}, {id: 'p1', name: 'Cy', given: 200, now: 50, net: -150}];
  const fmt = n => String(n);
  const h = standingsHtml(rows, [['Given', r => r.given], ['Chips', r => r.now]], fmt, 'me');
  assert.match(h, /<th>Player<\/th><th>Given<\/th><th>Chips<\/th><th>\+\/−<\/th>/);
  assert.match(h, /<tr class="oo-me"><th>Bo &lt;i&gt; \(you\)<\/th><td>100<\/td><td>250<\/td><td class="oo-up">\+150<\/td>/);
  assert.match(h, /<td class="oo-down">−150<\/td>/);
  assert.equal(signed(0, fmt), '0');
  const s = settleHtml(settleUp(rows), fmt, 'me');
  assert.match(s, /<b>Cy<\/b> → <b>You<\/b> <span class="oo-amt">150<\/span>/);
  assert.match(settleHtml([], fmt), /Nobody owes anything/);

  const csv = standingsCsv(rows, settleUp(rows), [['Player', r => r.name], ['Net', r => r.net]], fmt);
  assert.equal(csv, 'Player,Net\nBo <i>,150\nCy,-150\n\nPays,To,Amount\nCy,Bo <i>,150\n');
  assert.equal(standingsCsv([{name: 'A, "B"', net: 1}], [], [['Player', r => r.name]], fmt), 'Player\n"A, ""B"""\n');
  assert.equal(fileName('Friday night!', new Date(2026, 9, 5)), 'ducy-friday-night-2026-10-05.csv');
  assert.equal(fileName('', new Date(2026, 9, 5)), 'ducy-game-2026-10-05.csv');
});

// A tournament of `n` players besides the host (who plays if `hostPlays`).
function tourney(n, over = {}, hostPlays = false) {
  const club = privateClub('ABCD-EFGH', 'Ann', 0);
  const t = newPrivateTourney(club, setup(over), 0);
  if (hostPlays) joinPrivate(club, HOST_ID, 'Ann', 1);
  for (let i = 0; i < n; i++) joinPrivate(club, `g${i}`, `P${i}`, 1);
  return {club, t};
}

// Finishes it with places in registration order (the first entry wins).
function finish(club) {
  const t = theTourney(club);
  t.entries.forEach((e, i) => { e.place = i + 1; });
  t.status = 'finished';
}

test('prizes start as the buy-ins split by the payout shares, and follow the entries', () => {
  const {club, t} = tourney(10);
  assert.deepEqual(t.points, {buyIn: 100, prizes: null});
  const auto = autoPrizes(t);
  assert.equal(auto.length, 3, '10 entries: 3 paid');
  assert.equal(sum(auto, x => x), 1000, 'the entries exactly');
  assert.ok(auto[0] > auto[1] && auto[1] > auto[2]);
  assert.deepEqual(prizeTotals(t), {prizes: 1000, entries: 1000, added: 0});
  joinPrivate(club, 'g10', 'P10', 1);
  assert.equal(sum(prizeList(t), x => x), 1100, 'one more entry, 100 more');

  const {t: t2} = tourney(2, {payout: 'top2'});
  assert.deepEqual(prizeList(t2), [130, 70], '65% and 35% of 200');
  const {t: t3} = tourney(3, {payout: 'top3', buyIn: 7});
  assert.deepEqual(prizeList(t3), [11, 6, 4], 'the rounding goes to first');
  const {t: free} = tourney(4, {buyIn: 0});
  assert.deepEqual(prizeList(free), [0, 0], 'a freeroll pays nothing until the host adds some');

  assert.throws(() => newPrivateTourney(privateClub('X', 'Ann'), setup({buyIn: -1})), /buy-in/);
  assert.throws(() => newPrivateTourney(privateClub('X', 'Ann'), setup({buyIn: 1.5})), /buy-in/);
});

test('the host changes the prizes, adds points beyond the entries, and everyone sees them', () => {
  const {club, t} = tourney(10);
  // 1,200 for 1,000 of entries: 200 added.
  setPrizes(club, [700, 400, 100]);
  assert.deepEqual(prizeTotals(t), {prizes: 1200, entries: 1000, added: 200});
  // Places added and taken away; any amounts, any order.
  setPrizes(club, [700, 400, 100, 50]);
  setPrizes(club, [500, 600]);
  assert.deepEqual(prizeList(t), [500, 600]);
  assert.deepEqual(prizeTotals(t), {prizes: 1100, entries: 1000, added: 100});
  // The host's prizes stay as entries come and go.
  joinPrivate(club, 'g10', 'P10', 1);
  assert.deepEqual(prizeTotals(t), {prizes: 1100, entries: 1100, added: 0});
  for (const bad of [[], [-1], [1.5], ['10'], 'x', [1e10]]) assert.throws(() => setPrizes(club, bad), /whole numbers/);
  // Back to the split of the buy-ins.
  setPrizes(club, null);
  assert.equal(t.points.prizes, null);
  assert.equal(sum(prizeList(t), x => x), 1100);

  setPrizes(club, [800, 400, 100]);
  let b = lobbyBody(club);
  assert.equal(b.buyIn, 100);
  assert.deepEqual(b.prizes, [800, 400, 100]);
  assert.equal(b.custom, true);
  assert.equal(totalsText(b), 'Prizes 1,300 · entries 1,100 · 200 added');
  assert.equal(totalsText(b, [500, 100]), 'Prizes 600 · entries 1,100 · 500 under');
  assert.equal(totalsText(b, [1100]), 'Prizes 1,100 · entries 1,100');

  // The host's page has the boxes; a player's has the amounts.
  let h = pageHtml(b, {me: HOST_ID, host: true});
  assert.match(h, /Prizes, in points/);
  assert.match(h, /value="800" data-tzprize="0"/);
  assert.match(h, /data-tz="unplace" data-i="2"/);
  assert.match(h, /data-tz="addplace">Add a place/);
  assert.match(h, /data-tz="autoprizes">Split the buy-ins/);
  assert.match(h, /Prizes 1,300 · entries 1,100 · 200 added/);
  // What the host is typing stays on the page as it's redrawn.
  assert.match(pageHtml(b, {me: HOST_ID, host: true, draft: [900, 400, 100]}), /value="900" data-tzprize="0"[^]*Prizes 1,400 · entries 1,100 · 300 added/);
  h = pageHtml(b, {me: 'g1'});
  assert.doesNotMatch(h, /data-tzprize|data-tz="addplace"/);
  assert.match(h, /<th>1st<\/th><td>800<\/td>/);
  assert.match(h, /Buy-in 100 · 11 entries/);

  // Still while it runs; not once it's over.
  t.status = 'running';
  setPrizes(club, [900, 400, 100]);
  assert.match(pageHtml(lobbyBody(club), {me: HOST_ID, host: true}), /value="900" data-tzprize="0"/);
  finish(club);
  assert.throws(() => setPrizes(club, [1]), /over/);
  h = pageHtml(lobbyBody(club), {me: HOST_ID, host: true});
  assert.doesNotMatch(h, /data-tzprize/);
});

test('a tournament’s standings: buy-in, points won, net; the host pays the overlay', () => {
  // The host runs it without playing and adds 200 to 300 of entries.
  const {club} = tourney(3);
  setPrizes(club, [300, 200]);
  assert.deepEqual(tourneyStandings(lobbyBody(club)), [], 'nothing before the end');
  finish(club);
  const b = lobbyBody(club);
  assert.deepEqual(results(b).map(r => [r.name, r.amount]), [['P0', 300], ['P1', 200], ['P2', 0]]);
  let rows = tourneyStandings(b);
  assert.deepEqual(rows.map(r => [r.name, r.buyIn, r.won, r.added, r.net]), [
    ['P0', 100, 300, 0, 200], ['P1', 100, 200, 0, 100], ['P2', 100, 0, 0, -100], ['Ann', 0, 0, 200, -200],
  ]);
  assert.equal(sum(rows, r => r.net), 0);
  const pay = tourneySettle(b);
  assert.deepEqual(pay.map(p => [p.fromName, p.toName, p.amount]), [['Ann', 'P0', 200], ['P2', 'P1', 100]]);
  let h = pageHtml(b, {me: 'g0'});
  assert.match(h, /Standings, in points/);
  assert.match(h, /<th>Added<\/th>/);
  assert.match(h, /Settle up/);
  assert.match(h, /<b>Ann<\/b> → <b>You<\/b>/);
  assert.match(h, /data-tz="download">Download/);
  assert.match(h, /<th>1st<\/th><td>P0 \(you\)<\/td><td>300<\/td>/);

  // The host plays: the overlay is in their own row.
  const two = tourney(2, {}, true);
  setPrizes(two.club, [250, 150]);
  finish(two.club);
  rows = tourneyStandings(lobbyBody(two.club));
  assert.equal(net(rows, HOST_ID), 250 - 100 - 100);
  assert.equal(rows.length, 3);
  assert.equal(sum(rows, r => r.net), 0);

  // Prizes as the entries: no overlay, no Added column, no host row.
  const even = tourney(2, {payout: 'wta'});
  finish(even.club);
  const eb = lobbyBody(even.club);
  rows = tourneyStandings(eb);
  assert.deepEqual(rows.map(r => [r.name, r.net]), [['P0', 100], ['P1', -100]]);
  h = pageHtml(eb, {me: HOST_ID, host: true});
  assert.doesNotMatch(h, /<th>Added<\/th>/);
});
