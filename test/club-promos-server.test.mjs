// High Hand promotions in an always-on club's server (#267): the owner sets
// one up, members get the promotions, and a period's high hand pays on the
// room's alarm, or when the room wakes after being evicted.
// Needs the wasm build in wasm/. Run with: node --test test/club-promos-server.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { MultiTable } from '../wasm/ducy_wasm.js';
import { createIdentity, signMessage } from '../src/identity.js';
import { createClub, openClub } from '../relay/src/club-room.js';
import { processHand } from '../src/club-promos.js';
import { totals } from '../src/club-chips.js';

function memoryStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
  };
}

// The Worker's alarm-backed timers, in memory (as in club-alarms.test.mjs).
function alarmTimers() {
  let map = new Map(), n = 0;
  return {
    timers: {
      set: (fn, ms) => { map.set(++n, {at: Date.now() + Math.max(0, ms), fn}); return n; },
      clear: h => { map.delete(h); },
    },
    pump() { const now = Date.now(); for (const [h, t] of [...map]) if (t.at <= now) { map.delete(h); t.fn(); } },
    evict() { map = new Map(); },
  };
}

const T0 = Date.UTC(2026, 9, 14, 12, 10);
// Signed messages go out after signing: a moment for them (real timers; only Date is mocked).
const wait = () => new Promise(r => setTimeout(r, 150));
const H = 3600e3;

test('a promotion pays its high hand on the alarm, and after the room wakes', async () => {
  mock.timers.enable({apis: ['Date'], now: T0});
  try {
    const storage = memoryStorage();
    const owner = await createIdentity(), ann = await createIdentity(), bob = await createIdentity();
    const code = 'PROM-OTES';
    const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Promos'}), code);
    const sent = [];
    const send = (to, data) => sent.push({to, data});
    let clock = alarmTimers();
    let server = await openClub({storage, send, online: [], MultiTable, timers: clock.timers});
    const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
    for (const p of [owner, ann, bob]) await server.message({from: p.id, event: 'open'});
    await say(owner, {type: 'owner_hello'});
    let id = 1;
    for (const [p, name] of [[ann, 'Ann'], [bob, 'Bob']]) {
      await say(p, {type: 'join', invite, name});
      await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: p.id}, id: id++});
    }
    // The owner sets up an hourly high hand.
    await say(owner, {type: 'owner_cmd', op: 'new_promo', args: {promo: {kind: 'high_hand', name: 'Hourly', games: ['nlhe'], every: 'hour', prizes: [1000], minCategory: 'pair', minPlayers: 2, tz: 0}}, id: id++});
    await wait();
    const result = sent.filter(s => s.to === owner.id && s.data.body?.type === 'owner_result').at(-1).data.body;
    assert.equal(result.error, '');
    const promoId = result.value;
    // A member checking in gets the promotions.
    sent.length = 0;
    await say(ann, {type: 'hello'});
    await wait();
    const promos = sent.find(s => s.to === ann.id && s.data.body?.type === 'promos')?.data.body;
    assert.equal(promos.promos[0].name, 'Hourly');
    assert.match(promos.promos[0].rules, /Best Hold’em hand each hour wins 10/);

    // A hand at a table (as the club server's onHand passes it on).
    const hand = at => ({
      id: `${code}:t:${at}`, club: code, table: 't', game: 'nlhe', at, showdown: true, pot: 400, board: ['Kh', 'Ks', '8d', '7c', '9h'],
      seats: [{i: 0, name: 'Ann', cards: ['Kc', 'Kd'], inHand: true}, {i: 1, name: 'Bob', cards: ['2c', '3d'], inHand: true}],
    });
    const seats = [{seat: 0, client_id: ann.id}, {seat: 1, client_id: bob.id}];
    processHand(server.club, hand(T0), seats);
    // Pausing and resuming saves the club and sets the timer for the hour's end.
    await say(owner, {type: 'owner_cmd', op: 'promo_status', args: {id: promoId, status: 'paused'}, id: id++});
    await say(owner, {type: 'owner_cmd', op: 'promo_status', args: {id: promoId, status: 'running'}, id: id++});
    mock.timers.setTime(T0 + H);
    clock.pump();
    await server.flush();
    await wait();
    assert.equal(server.club.members[ann.id].balance, 1000, 'paid on the alarm');
    assert.equal(server.club.chips.ledger.at(-1).kind, 'promo');
    assert.ok(totals(server.club).conserved);
    assert.ok(sent.some(s => s.to === ann.id && s.data.body?.type === 'promo_event' && /you won 10/.test(s.data.body.text)));

    // The next hour: a hand, then the room is evicted and wakes after the hour ends.
    processHand(server.club, hand(T0 + H + 60e3), seats);
    await say(owner, {type: 'owner_cmd', op: 'promo_status', args: {id: promoId, status: 'running'}, id: id++});
    await server.flush();
    clock.evict();
    server = null;
    mock.timers.setTime(T0 + 3 * H);
    clock = alarmTimers();
    server = await openClub({storage, send, online: [owner.id, ann.id, bob.id], MultiTable, timers: clock.timers});
    await server.flush();
    assert.equal(server.club.members[ann.id].balance, 2000, 'paid when the room woke');

    // The owner voids the second prize; the chips go back.
    const awards = server.club.promos.awards;
    await server.message({from: owner.id, data: await signMessage(owner, {club: code, type: 'owner_cmd', op: 'void_award', args: {id: awards.at(-1).id, why: 'test'}, id: 99})});
    await server.flush();
    assert.equal(server.club.members[ann.id].balance, 1000);
    assert.equal(server.club.chips.ledger.at(-1).kind, 'promo_void');
    for (const t of server.club.tables || []) t.status = 'closed';
  } finally {
    mock.timers.reset();
  }
});
