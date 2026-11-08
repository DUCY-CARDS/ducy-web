// Fair deals and private cards (#136, #580). Every hand at a club or friends
// table is dealt from a seed the players' pages helped make (commit, then
// reveal), and a page that never answers doesn't hold the table up. After a
// hand a player's page has its own cards, the board and the cards shown
// down, and nothing more: no deal's seed (from which every seat's cards
// could be dealt out again) and no folded hand. Checked at a club table
// (club-host.js), at a club on the relay (club-room.js, as the Worker runs
// it) and at a friends table (its host's runner, as play.js runs it).
// Needs the wasm build in wasm/.
// Run with: node --test test/fair-deal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import * as ducy from '../wasm/ducy_wasm.js';
import { approve, newClub } from '../src/club.js';
import { issue } from '../src/club-chips.js';
import { newTable } from '../src/club-tables.js';
import { clubEngine } from '../src/club-engine.js';
import { createTableHost } from '../src/club-host.js';
import { fairPlayer } from '../src/fair-check.js';
import { createIdentity, signMessage } from '../src/identity.js';
import { newKeyPair, open as openBox, sharedKey } from '../src/e2e.js';
import { createClub, openClub } from '../relay/src/club-room.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
// Timers that don't keep the test running once it's done.
const timers = {set: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clear: h => clearTimeout(h)};

// ducy's table runner, with every seed it deals from noted: the host's side
// knows them, and no player should ever see one.
function watchedTables(seeds) {
  const wrap = t => t && {
    event(ev, at) {
      const step = t.event(ev, at);
      for (const a of step.actions) if (a.type === 'engine' && a.res.seed) seeds.add(a.res.seed);
      return step;
    },
    save: at => t.save(at),
    free: () => t.free(),
  };
  return {
    create: (id, c) => wrap(ducy.ClubTable.create(id, c)),
    restore: (id, json, c, now) => wrap(ducy.ClubTable.restore(id, json, c, now)),
    friends: (id, c) => wrap(ducy.ClubTable.friends(id, c)),
    restoreFriends: (id, json, c, now) => wrap(ducy.ClubTable.restoreFriends(id, json, c, now)),
  };
}

// What a player's page got, checked: no seed anywhere in it, no fair-deal
// result, and no cards for another seat that folded. Returns how many
// folded seats it saw.
function checkPrivate(name, got, seeds) {
  assert.ok(seeds.size > 0, 'hands were dealt from fair-deal seeds');
  let folds = 0;
  for (const u of got) {
    const text = JSON.stringify(u);
    for (const s of seeds) assert.ok(!text.includes(s), `${name} got a deal's seed`);
    assert.ok(!/"seed"/.test(text), `${name} got a seed: ${text.slice(0, 200)}`);
    if (u.type === 'fair') assert.ok(u.step === 'commit' || u.step === 'reveal', `${name} got a fair-deal ${u.step}`);
    if (u.type !== 'state') continue;
    u.view.seats.forEach((s, i) => {
      if (i === 0 || !s.folded) return;
      folds++;
      assert.ok(!s.cards?.length, `${name} saw seat ${i}'s folded cards: ${JSON.stringify(s.cards)}`);
    });
  }
  return folds;
}

const finished = got => new Set(got.filter(u => u.type === 'state' && u.view.complete && Number(u.view.hand_number)).map(u => u.view.hand_number)).size;
const checkCall = l => ({kind: l.can_check ? 'check' : 'call', amount: 0});
const checkFold = l => ({kind: l.can_check ? 'check' : 'fold', amount: 0});

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id, status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  return club;
}

test('every hand is dealt from a seed the players helped make; a page that never answers doesn’t hold the table up', async () => {
  const ids = ['ann', 'bob', 'cy', 'dee'];
  const club = clubWith(...ids);
  const t = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 6});
  const seeds = new Set();
  const engine = clubEngine(watchedTables(seeds));
  // Ann folds to any bet; the rest check or call.
  const players = Object.fromEntries(ids.map(id => [id, {fair: fairPlayer(), got: [], play: id === 'ann' ? checkFold : checkCall}]));
  // Dee never answers a fair-deal round (an old page, or a cheat).
  const silent = 'dee';
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const p = players[to], u = msg.update;
    if (!p || !u) return;
    p.got.push(JSON.parse(JSON.stringify(u)));
    if (u.type === 'fair') {
      if (to !== silent) p.fair.message(u, cmd => host.handle(t.id, to, cmd));
    } else if (u.type === 'state' && u.view.legal && !u.view.complete) {
      host.handle(t.id, to, {type: 'act', seq: u.seq, ...p.play(u.view.legal)});
    }
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {}, onHand() {},
    call: async (op, ...args) => engine.ops[op](...args),
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
    timers,
  });
  await host.start(t);
  for (const id of ids) {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: 150});
  }
  const start = Date.now();
  await until('three hands', () => finished(players.bob.got) >= 3, 60_000);
  assert.ok(Date.now() - start < 45_000, 'the silent player didn’t hold the table up');
  // Each answering page revealed its value for the deals.
  for (const id of ['ann', 'bob', 'cy']) assert.ok(players[id].got.some(u => u.type === 'fair' && u.step === 'reveal'), id);
  let folds = 0;
  for (const id of ids) folds += checkPrivate(id, players[id].got, seeds);
  assert.ok(folds > 0, 'someone folded, and no one else saw those cards');
  await host.close(t.id);
});

test('at a club on the relay, no player gets a seed or anyone else’s folded cards', async () => {
  const store = new Map();
  const storage = {get: async k => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async k => { store.delete(k); }};
  const code = 'PRIV-CARD';
  const owner = await createIdentity();
  const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Card Room'}), code);
  const seeds = new Set();
  const people = {};
  let server = null;
  const send = (to, data) => {
    const p = people[to];
    if (!p) return;
    const env = JSON.parse(JSON.stringify(data));
    p.wire.push(env);
    p.inbox = p.inbox.then(() => p.receive(env)).catch(e => console.warn(e));
  };
  const person = async (name, play) => {
    const ident = await createIdentity(), keys = await newKeyPair();
    const p = {ident, keys, name, wire: [], got: [], inbox: Promise.resolve(), out: Promise.resolve(), aes: null, table: null, fair: fairPlayer()};
    // One message at a time, so the club sees them in the order signed.
    p.say = body => (p.out = p.out.then(async () => server.message({from: ident.id, data: await signMessage(ident, {club: code, ...body})})));
    p.cmd = cmd => p.say({type: 'table', table: p.table, cmd});
    p.receive = async env => {
      if (env.body?.type === 'host_key') {
        p.aes = await sharedKey(keys, env.body.key, {context: `club:${code}`, hostId, playerId: ident.id, hostPub: env.body.key, playerPub: keys.pub});
        return;
      }
      if (env.type !== 'table' || !env.enc || !p.aes) return;
      const u = await openBox(p.aes, env.enc);
      p.got.push(u);
      if (u.type === 'fair') p.fair.message(u, p.cmd);
      else if (u.type === 'state' && u.view.legal && !u.view.complete) p.cmd({type: 'act', seq: u.seq, ...play(u.view.legal)});
    };
    people[ident.id] = p;
    return p;
  };
  const ann = await person('Ann', checkFold);
  const bob = await person('Bob', checkCall);
  const cy = await person('Cy', checkCall);
  const players = [ann, bob, cy];

  server = await openClub({storage, send, online: [], ClubTable: watchedTables(seeds), timers});
  let n = 0;
  const ownerSays = async (op, args) => server.message({from: owner.id, data: await signMessage(owner, {club: code, type: 'owner_cmd', op, args, id: ++n})});
  await server.message({from: owner.id, event: 'open'});
  await ownerSays('new_table', {table: {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 3, turnSecs: 30}});
  const tid = server.club.tables.find(t => t.name === 'Main').id;
  for (const p of players) {
    await server.message({from: p.ident.id, event: 'open'});
    await p.say({type: 'join', invite, name: p.name, key: p.keys.pub});
    await ownerSays('approve', {id: p.ident.id});
    await ownerSays('give', {id: p.ident.id, amount: 1000});
    await p.say({type: 'hello', key: p.keys.pub});
  }
  await until('the host key', () => players.every(p => p.aes));
  for (const p of players) {
    p.table = tid;
    await p.cmd({type: 'join'});
    await p.cmd({type: 'request_chips', amount: 150});
  }
  await until('three hands', () => finished(bob.got) >= 3, 120_000);

  let folds = 0;
  for (const p of players) folds += checkPrivate(p.name, p.got, seeds);
  assert.ok(folds > 0, 'someone folded, and no one else saw those cards');
  // Nothing the relay carried to them holds a seed either.
  for (const p of players) for (const s of seeds) assert.ok(!JSON.stringify(p.wire).includes(s));
  for (const p of players) assert.ok(p.got.some(u => u.type === 'fair' && u.step === 'reveal'), `${p.name} helped make the seeds`);

  await ownerSays('close_table', {table: tid});
  await server.flush();
});

test('at a friends table, no guest gets a seed or anyone else’s folded cards, the host’s included', async () => {
  const seeds = new Set();
  const {ops} = clubEngine(watchedTables(seeds));
  const T = 'friends';
  // As play.js's host runs it, with auto-deal on; the host's own seat checks,
  // or folds to a bet.
  ops.runnerFriends(T, {seats: 4, hostName: 'Hana', hostChips: 200, minBuyIn: 40, maxBuyIn: 400, sb: 1, bb: 2, seed: 7, game: 'nlhe', turnMs: 3000, autoDeal: true, nextHandMs: 300});
  const guests = {gus: {got: [], fair: fairPlayer(), play: checkFold}, ivy: {got: [], fair: fairPlayer(), play: checkCall}};
  let chain = Promise.resolve(), wakeT = null, done = false;
  const run = ev => (chain = chain.then(() => (done ? null : apply(ops.runnerEvent(T, ev)))).catch(e => console.warn(e)));
  function deliver(to, u) {
    const g = guests[to];
    if (!g) return;
    u = JSON.parse(JSON.stringify(u));
    g.got.push(u);
    if (u.type === 'fair') g.fair.message(u, cmd => run({type: 'cmd', id: to, cmd, online: true}));
    else if (u.type === 'state' && u.view.legal && !u.view.complete) run({type: 'cmd', id: to, cmd: {type: 'act', seq: u.seq, ...g.play(u.view.legal)}, online: true});
  }
  function apply(step) {
    for (const a of step.actions) {
      if (a.type === 'engine') {
        for (const m of a.res.out) deliver(m.to, m.data);
        for (const r of a.res.chipRequests || []) run({type: 'chips', seat: r.seat, ok: true});
        const v = a.res.state;
        if (!v.complete && v.to_act === 0 && v.legal) run({type: 'host', cmd: {type: 'act', ...checkFold(v.legal)}});
      } else if (a.type === 'send') deliver(a.to, a.update);
    }
    timers.clear(wakeT);
    if (step.wake != null) wakeT = timers.set(() => run({type: 'wake'}), Math.max(0, step.wake - Date.now()));
  }
  for (const [id, name] of [['gus', 'Gus'], ['ivy', 'Ivy']]) {
    run({type: 'presence', id, on: true});
    run({type: 'cmd', id, cmd: {type: 'join', name}, online: true});
    run({type: 'cmd', id, cmd: {type: 'request_chips', amount: 200}, online: true});
  }
  await until('three hands', () => finished(guests.ivy.got) >= 3, 120_000);
  done = true;
  timers.clear(wakeT);
  await chain;
  let folds = 0;
  for (const [name, g] of Object.entries(guests)) folds += checkPrivate(name, g.got, seeds);
  assert.ok(folds > 0, 'someone folded, and no guest saw those cards');
  for (const g of Object.values(guests)) assert.ok(g.got.some(u => u.type === 'fair' && u.step === 'reveal'), 'each guest helped make the seeds');
  ops.runnerDrop(T);
});
