// One-off private tournaments (#394): the stand-in club and its rules
// (registering, names, payouts), the page everyone sees (the lobby, how it's
// going, the results), and a run of 20 players on three tables to a winner,
// with tournament chips only. Needs the wasm build in wasm/. Run with:
// node --test test/private-tourney.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import * as ducy from '../wasm/ducy_wasm.js';
import { clubEngine } from '../src/club-engine.js';
import { createTourneyHost } from '../src/club-tourney-host.js';
import { HOST_ID, joinPrivate, leavePrivate, lobbyBody, newPrivateTourney, paidPlaces, privateClub, results, theTourney } from '../src/private-tourney.js';
import { bannerText, pageHtml, setupHtml } from '../src/private-tourney-ui.js';
import { structureEditor } from '../src/tourney-structure-ui.js';

const LEVELS = [
  {sb: 10, bb: 20, ante: 0, minutes: 1}, {sb: 20, bb: 40, ante: 0, minutes: 1}, {break: true, minutes: 1},
  {sb: 50, bb: 100, ante: 10, minutes: 1}, {sb: 100, bb: 200, ante: 25, minutes: 1}, {sb: 200, bb: 400, ante: 50, minutes: 1},
  {sb: 500, bb: 1000, ante: 100, minutes: 1}, {sb: 1000, bb: 2000, ante: 200, minutes: 1},
];
const setup = (over = {}) => ({name: '', game: 'nlhe', stack: 1500, tableSize: 9, structure: LEVELS, payout: 'default', ...over});

test('the host opens it and is registered; players register with unique names', () => {
  const club = privateClub('ABCD-EFGH', 'Ann', 0);
  const t = newPrivateTourney(club, setup(), 0);
  assert.equal(t.name, 'Ann’s tournament');
  assert.equal(t.buyIn, 0);
  assert.equal(t.status, 'scheduled');
  assert.deepEqual(t.entries.map(e => e.member), [HOST_ID]);
  assert.throws(() => newPrivateTourney(club, setup(), 0), /already/);

  assert.equal(joinPrivate(club, 'g1', '  Bo  ', 1).name, 'Bo');
  assert.equal(joinPrivate(club, 'g2', 'ann', 2).name, 'ann 2', 'the host is Ann already');
  assert.equal(joinPrivate(club, 'g3', 'Bo', 3).name, 'Bo 2');
  // Asking again (a reconnect) keeps the entry and takes the new name.
  assert.equal(joinPrivate(club, 'g1', 'Bobby', 4).name, 'Bobby');
  assert.equal(t.entries.length, 4);
  assert.throws(() => joinPrivate(club, 'g4', '   ', 5), /name/);
  // No balances: everyone has nothing, and it stays that way.
  assert.ok(Object.values(club.members).every(m => m.balance === 0));

  assert.equal(leavePrivate(club, 'g3'), true);
  assert.equal(leavePrivate(club, HOST_ID), false, 'the host can’t leave their own');
  assert.equal(leavePrivate(club, 'nobody'), false);
  assert.deepEqual(t.entries.map(e => e.member), [HOST_ID, 'g1', 'g2']);
  assert.equal(club.members.g3, undefined);

  // Once started, only those registered come back in.
  t.status = 'running';
  assert.throws(() => joinPrivate(club, 'g5', 'Cy', 6), /started/);
  assert.equal(joinPrivate(club, 'g1', 'Bob', 7).name, 'Bobby', 'names are kept once it runs');
});

test('payouts: the defaults follow the entries; a fixed split stays', () => {
  const club = privateClub('ABCD-EFGH', 'Ann', 0);
  const t = newPrivateTourney(club, setup(), 0);
  for (let i = 0; i < 9; i++) joinPrivate(club, `g${i}`, `P${i}`, 1);
  assert.equal(paidPlaces(t).length, 3, '10 players: 3 paid');
  assert.equal(paidPlaces(t).reduce((s, p) => s + p.share, 0), 10000);

  const wta = privateClub('ABCD-EFGJ', 'Ann', 0);
  const w = newPrivateTourney(wta, setup({payout: 'wta'}), 0);
  for (let i = 0; i < 9; i++) joinPrivate(wta, `g${i}`, `P${i}`, 1);
  assert.deepEqual(paidPlaces(w), [{place: 1, share: 10000}]);

  // No more places paid than players.
  const top3 = privateClub('ABCD-EFGK', 'Ann', 0);
  const t3 = newPrivateTourney(top3, setup({payout: 'top3'}), 0);
  joinPrivate(top3, 'g1', 'Bo', 1);
  assert.deepEqual(paidPlaces(t3).map(p => p.share), [5000, 3000]);
});

test('the page: the lobby for the host and a player, then the results', () => {
  const club = privateClub('ABCD-EFGH', 'Ann', 0);
  newPrivateTourney(club, setup({name: 'Friday <b>'}), 0);
  const b = lobbyBody(club);
  assert.equal(b.type, 't_lobby');
  assert.equal(b.code, 'ABCD-EFGH');
  assert.equal(b.host, 'Ann');
  let h = pageHtml(b, {me: HOST_ID, host: true, link: 'https://x/?table=ABCD-EFGH#join'});
  assert.match(h, /Friday &lt;b&gt;/, 'escaped');
  assert.match(h, /ABCD-EFGH/);
  assert.match(h, /data-tz="start" disabled/, 'not alone');
  assert.match(h, /data-tz="copy"/);

  joinPrivate(club, 'g1', 'Bo', 1);
  const b2 = lobbyBody(club);
  h = pageHtml(b2, {me: HOST_ID, host: true});
  assert.match(h, /data-tz="start">Start/);
  assert.match(h, /data-tz="remove" data-id="g1"/);
  assert.match(h, /Registered \(2\)/);
  h = pageHtml(b2, {me: 'g1'});
  assert.match(h, /Waiting for Ann to start/);
  assert.match(h, /Bo <span class="pl-meta">\(you\)/);
  assert.doesNotMatch(h, /data-tz="start"|data-tz="remove"/);

  // Running, with standings; then over.
  const t = theTourney(club);
  t.status = 'running';
  const live = {level: 1, onBreak: false, stepEndsAt: 10 * 60_000, playersLeft: 2, handForHand: false, tables: [{id: 0, players: 2}], standings: [{id: 'g1', name: 'Bo', stack: 2000}, {id: HOST_ID, name: 'Ann', stack: 1000}]};
  const run = lobbyBody(club, live);
  h = pageHtml(run, {me: 'g1'}, 0);
  assert.match(h, /Level 2 · 20\/40/);
  assert.match(h, /2 left on 1 table/);
  assert.match(h, /Go to your table/);
  assert.equal(bannerText(run, 0), 'Friday <b> · Level 2 · 20/40 · next in 10 min · 2 left');

  t.entries.find(e => e.member === HOST_ID).place = 2;
  t.entries.find(e => e.member === 'g1').place = 1;
  t.status = 'finished';
  const done = lobbyBody(club);
  assert.deepEqual(results(done).map(r => [r.place, r.name, r.share]), [[1, 'Bo', 10000], [2, 'Ann', 0]]);
  h = pageHtml(done, {me: 'g1'});
  assert.match(h, /You won!/);
  assert.match(h, /Results/);
  assert.match(h, /100%/);
  assert.match(h, /data-tz="done">Done/);
  h = pageHtml(done, {me: HOST_ID, host: true});
  assert.match(h, /<b>Bo<\/b> won\. You finished 2nd\./);
  assert.match(h, /Close the tournament/);
});

test('the form: game, stack, table size, blinds and payouts', () => {
  const ed = structureEditor({stack: 10000, tableSize: 9});
  const h = setupHtml({name: '', game: 'plo6', stack: 10000, tableSize: 6, payout: 'top2'}, ed, {lead: '<i>lead</i>'});
  assert.match(h, /^<div class="sg-wrap"><div class="sg-form pz-form" data-tzform><i>lead<\/i>/);
  assert.match(h, /data-tzgame="plo6" aria-pressed="true"/);
  assert.doesNotMatch(h, /data-tzsize="8"/, 'PLO6 deals to 6 at most');
  assert.match(h, /data-tzpay="top2" aria-pressed="true"/);
  assert.match(h, /data-ts="preset"/, 'the blind structure editor');
  assert.match(h, /data-tz="open"/);
});

test('20 players on three tables play to a winner, with places and shares for everyone', {skip: !ducy.ClubTournament && 'this ducy-wasm has no tournaments'}, async () => {
  const club = privateClub('ABCD-EFGH', 'Ann', 0);
  const t = newPrivateTourney(club, setup({tableSize: 8, payout: 'top3'}), 0);
  const ids = Array.from({length: 19}, (_, i) => `g${i}`);
  for (const id of ids) joinPrivate(club, id, id.toUpperCase(), 1);
  const engine = clubEngine(ducy.MultiTable);
  let host = null;
  const joined = new Set();
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = msg.update;
    if (!joined.has(to) || u?.type !== 'state' || !u.view.legal || u.view.complete) return;
    const r = Math.random();
    const kind = r < 0.12 ? 'allin' : r < 0.3 && u.view.legal.can_fold ? 'fold' : u.view.legal.can_check ? 'check' : 'call';
    host.handle(t.id, to, {type: 'act', seq: u.seq, kind, amount: 0});
  });
  let maxTables = 0, changes = 0;
  host = createTourneyHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, store: null,
    tourneysChanged: () => { changes++; },
    call: async (op, ...args) => {
      // Not saved: nothing to save it for.
      assert.notEqual(op, 'tourneySave');
      return engine.ops[op](...args);
    },
    turnMs: 3000, nextHandMs: 5, botPaceMs: 5, levelMs: 1500,
    observe: (tid, res) => { maxTables = Math.max(maxTables, res.tables.length); },
  });
  // The host starts it (no start time to wait for).
  t.startsAt = Date.now();
  await host.begin(t.id);
  assert.equal(t.status, 'running');
  for (const id of [HOST_ID, ...ids]) { joined.add(id); await host.handle(t.id, id, {type: 'join', name: id}); }
  const end = Date.now() + 240_000;
  while (t.status === 'running' && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  assert.equal(t.status, 'finished');
  assert.equal(maxTables, 3, '20 players at 8 a table');
  assert.ok(changes > 0, 'the page was told as players went out');

  const b = lobbyBody(club);
  const rows = results(b);
  assert.deepEqual(rows.map(r => r.place), Array.from({length: 20}, (_, i) => i + 1));
  assert.deepEqual(rows.slice(0, 4).map(r => r.share), [5000, 3000, 2000, 0]);
  // Tournament chips only: no club chips moved.
  assert.equal(club.chips.issued, 0);
  assert.deepEqual(club.chips.ledger, []);
  assert.ok(Object.values(club.members).every(m => m.balance === 0));
});
