// Fair deals at club tables (#136): a real club table (club-host.js and
// ducy's engine) dealing from commit–reveal seeds, players checking each
// hand, a player who never answers not holding the table up, and tampered
// deals failing the check. Needs the wasm build in wasm/.
// Run with: node --test test/fair-deal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { MultiTable, fairDeal, fairSecret, fairSeed } from '../wasm/ducy_wasm.js';
import { approve, newClub } from '../src/club.js';
import { issue } from '../src/club-chips.js';
import { newTable } from '../src/club-tables.js';
import { clubEngine } from '../src/club-engine.js';
import { createTableHost } from '../src/club-host.js';
import { checkDeal, fairPlayer } from '../src/fair-check.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id, status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  return club;
}

test('every hand is dealt from a seed the players helped make, and each player’s page checks it', async () => {
  const ids = ['ann', 'bob', 'cy', 'dee'];
  const club = clubWith(...ids);
  const t = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 6});
  const engine = clubEngine(MultiTable);
  const players = Object.fromEntries(ids.map(id => [id, {fair: fairPlayer(), seen: new Map(), checks: [], commits: 0}]));
  // Dee never answers a fair-deal round (an old page, or a cheat).
  const silent = 'dee';
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const p = players[to], u = msg.update;
    if (!p || !u) return;
    if (u.type === 'fair') {
      if (to === silent) return;
      if (u.step === 'commit') p.commits++;
      const check = p.fair.message(u, cmd => host.handle(t.id, to, cmd), p.seen.get(Number(u.hand)) || {});
      if (check) p.checks.push(check);
    } else if (u.type === 'state') {
      const v = u.view;
      if (v.complete && Number(v.hand_number)) p.seen.set(Number(v.hand_number), {cards: v.seats[0].cards || [], board: v.board || []});
      // Everyone checks or calls, so hands go to a showdown quickly.
      if (v.legal && !v.complete) host.handle(t.id, to, {type: 'act', seq: u.seq, kind: v.legal.can_check ? 'check' : 'call', amount: 0});
    }
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {}, onHand() {},
    call: async (op, ...args) => engine.ops[op](...args),
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  await host.start(t);
  for (const id of ids) {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: 150});
  }
  // Three hands.
  const start = Date.now();
  while (players.ann.checks.length < 3 && Date.now() - start < 60_000) await sleep(200);
  for (const id of ['ann', 'bob', 'cy']) {
    const checks = players[id].checks;
    assert.ok(checks.length >= 3, `${id} checked ${checks.length} hands`);
    for (const c of checks) assert.ok(c.ok, `${id}, hand ${c.hand}: ${c.why}`);
  }
  // Dee was dealt in (and could check the deal too), but never helped make it.
  assert.ok(players.dee.checks.length === 0 || players.dee.checks.every(c => c.ok));
  assert.ok(Date.now() - start < 45_000, 'the silent player didn’t hold the table up');
  await host.close(t.id);
});

test('a tampered deal fails the check', () => {
  const host = fairSecret(), ann = fairSecret();
  const list = [{id: 'host', c: host.commitment}, {id: 'ann', c: ann.commitment}];
  const reveals = [{id: 'host', value: host.value, nonce: host.nonce}, {id: 'ann', value: ann.value, nonce: ann.nonce}];
  const seed = fairSeed(reveals.map(r => r.value));
  const deal = fairDeal('nlhe', 2, seed);
  const m = {hand: 1, game: 'nlhe', dealt: 2, index: 1, seed, list, reveals};
  const mine = {cards: deal.hole_cards[1], board: deal.board.slice(0, 3)};
  assert.ok(checkDeal(m, mine, ann).ok, 'an honest deal passes');
  // Another seed: the host picked the cards.
  const other = fairSeed([fairSecret().value]);
  assert.match(checkDeal({...m, seed: other}, mine, ann).why, /seed/);
  // The host's value swapped after the commitments.
  const fake = fairSecret();
  assert.match(checkDeal({...m, reveals: [{id: 'host', value: fake.value, nonce: fake.nonce}, reveals[1]]}, mine, ann).why, /commitment/);
  // Ann's value left out.
  assert.match(checkDeal({...m, reveals: [reveals[0]], seed: fairSeed([host.value])}, mine, ann).why, /your value/);
  // Cards that aren't the ones the seed deals.
  assert.match(checkDeal(m, {...mine, cards: deal.hole_cards[0]}, ann).why, /your cards/);
  assert.match(checkDeal(m, {...mine, board: ['2c', '3d', '4h']}, ann).why, /board/);
});
