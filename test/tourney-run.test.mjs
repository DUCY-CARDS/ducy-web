// Running a club tournament (#81, club-tourney-host.js with ducy's engine):
// 30 entrants on 3 tables, played by simulated players who check, call,
// fold and shove, run to a single winner. Chips are conserved throughout,
// at the tables and in the club; tables stay balanced within one player;
// levels change on schedule; absent registrants are blinded off and never
// removed, and one comes back and plays; a late registration (#80) takes a
// seat; and the prizes land in the winners' club balances (#79).
// Needs the wasm build in wasm/. Run with: node --test test/tourney-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import * as ducy from '../wasm/ducy_wasm.js';
import { approve, newClub } from '../src/club.js';
import { issue, totals } from '../src/club-chips.js';
import { clubEngine } from '../src/club-engine.js';
import { newTourney, register, entryCount, tourneysBody } from '../src/club-tourneys.js';
import { createTourneyHost } from '../src/club-tourney-host.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(50);
  return cond();
};

const LEVELS = [
  {sb: 10, bb: 20, ante: 0, minutes: 1}, {sb: 20, bb: 40, ante: 0, minutes: 1}, {break: true, minutes: 1},
  {sb: 50, bb: 100, ante: 10, minutes: 1}, {sb: 100, bb: 200, ante: 25, minutes: 1}, {sb: 200, bb: 400, ante: 50, minutes: 1},
  {sb: 500, bb: 1000, ante: 100, minutes: 1}, {sb: 1000, bb: 2000, ante: 200, minutes: 1}, {sb: 2000, bb: 4000, ante: 500, minutes: 1},
];

test('30 entrants on 3 tables play to a single winner, balanced and conserved, prizes paid', {skip: !ducy.ClubTournament && 'this ducy-wasm has no tournaments'}, async () => {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  const ids = Array.from({length: 31}, (_, i) => `p${i}`);
  for (const id of ids) {
    club.members[id] = {id, name: id.toUpperCase(), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 10000, 0);
  }
  const t = newTourney(club, {
    name: 'Friday Freezeout', buyIn: 100, added: 1000, stack: 1500, structure: LEVELS,
    opensAt: 0, startsAt: Date.now() + 300, minPlayers: 2, maxPlayers: 40, tableSize: 10, lateLevel: 3,
  });
  for (const id of ids.slice(0, 30)) register(club, t.id, id, 10);
  // p24–p29 never come: blinded off. p24 comes back later.
  const absent = new Set(ids.slice(24, 30));
  const engine = clubEngine(ducy.MultiTable);
  const joined = new Set();
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = msg.update;
    if (!joined.has(to) || u?.type !== 'state') return;
    const v = u.view;
    if (!v.legal || v.complete) return;
    // Mostly check or call; sometimes fold or shove, so it ends.
    const r = Math.random();
    const kind = r < 0.12 ? 'allin' : r < 0.3 && v.legal.can_fold ? 'fold' : v.legal.can_check ? 'check' : 'call';
    host.handle(t.id, to, {type: 'act', seq: u.seq, kind, amount: 0});
  });
  const checks = {balanced: 0, unbalanced: [], levels: new Set(), chips: [], maxTables: 0};
  host = createTourneyHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, online: id => joined.has(id),
    call: async (op, ...args) => engine.ops[op](...args),
    turnMs: 3000, nextHandMs: 5, botPaceMs: 5, levelMs: 1500,
    observe: (tid, res) => {
      checks.levels.add(res.level);
      checks.maxTables = Math.max(checks.maxTables, res.tables.length);
      checks.chips.push([Number(res.totalChips), entryCount(t) * t.stack]);
      // Between hands everywhere: tables within one player of each other.
      if (res.tables.length && res.tables.every(x => !x.inHand)) {
        const sizes = res.tables.map(x => x.players);
        if (Math.max(...sizes) - Math.min(...sizes) <= 1) checks.balanced++;
        else checks.unbalanced.push(sizes);
      }
    },
  });
  host.startAll();
  assert.ok(await until(() => host.running(t.id), 5000), 'it started');
  assert.equal(t.status, 'running');
  for (const id of ids.slice(0, 30)) if (!absent.has(id)) { joined.add(id); await host.handle(t.id, id, {type: 'join', name: id}); }
  // A late registration.
  await sleep(500);
  await host.enter(t.id, 'p30');
  joined.add('p30');
  await host.handle(t.id, 'p30', {type: 'join', name: 'p30'});
  assert.equal(entryCount(t), 31);
  // p24 comes back while still in.
  await sleep(1500);
  if (!t.entries.find(e => e.member === 'p24').place) {
    joined.add('p24');
    absent.delete('p24');
    await host.handle(t.id, 'p24', {type: 'join', name: 'p24'});
  }
  assert.ok(await until(() => t.status === 'finished', 240_000), `finished (status ${t.status}, ${t.entries.filter(e => e.place == null).length} left)`);

  // One winner, every entry placed, none removed.
  const places = t.entries.map(e => e.place).sort((a, b) => a - b);
  assert.deepEqual(places, Array.from({length: 31}, (_, i) => i + 1), 'every entry has its own place');
  assert.equal(checks.maxTables, 3, 'three tables (the late entry took a seat at the shortest)');
  // Chips at the tables: always every entry's starting stack.
  for (const [have, want] of checks.chips) assert.equal(have, want);
  assert.ok(checks.balanced > 0, 'balance was checked');
  assert.deepEqual(checks.unbalanced, [], 'tables within one player');
  assert.ok(checks.levels.size >= 3, `levels went up (${[...checks.levels]})`);
  // Prizes: the pool (31 buy-ins and the added chips) went to the places paid.
  const paid = t.paid.reduce((s, p) => s + p.amount, 0);
  assert.equal(paid, 31 * 100 + 1000);
  const winner = t.entries.find(e => e.place === 1).member;
  assert.ok(club.members[winner].balance > 10000 - 100, 'the winner was paid');
  assert.ok(totals(club).conserved, JSON.stringify(totals(club)));
  assert.equal(tourneysBody(club).tourneys[0].status, 'finished');
});
