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
import { adminView, createClub, openClub } from '../relay/src/club-room.js';
import { checkDeal, dropFullHands, fullHands, keepFullHand } from '../relay/src/hand-records.js';
import { readdirSync, readFileSync } from 'node:fs';

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
    holeCards: () => t.holeCards(),
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
      // Ann's page says she looked away while deciding (#582).
      else if (u.type === 'state' && u.view.legal && !u.view.complete) p.cmd({type: 'act', seq: u.seq, ...play(u.view.legal), away: name === 'Ann'});
    };
    people[ident.id] = p;
    return p;
  };
  const ann = await person('Ann', checkFold);
  const bob = await person('Bob', checkCall);
  const cy = await person('Cy', checkCall);
  const players = [ann, bob, cy];

  // Each fair play run's summary for ducy's admin (#612).
  const summaries = [];
  server = await openClub({storage, send, online: [], ClubTable: watchedTables(seeds), timers, onFairPlay: s => summaries.push(JSON.parse(JSON.stringify(s)))});
  let n = 0;
  const ownerSays = async (op, args) => server.message({from: owner.id, data: await signMessage(owner, {club: code, type: 'owner_cmd', op, args, id: ++n})});
  await server.message({from: owner.id, event: 'open'});
  await ownerSays('new_table', {table: {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 3, turnSecs: 30}});
  const tid = server.club.tables.find(t => t.name === 'Main').id;
  // Each connects as the Worker passes it on (worker.js connOf).
  const IP = '203.0.113.7', UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const conn = {ip: IP, ua: UA, asn: 7922, asOrg: 'Comcast', country: 'US', region: 'Texas', city: 'Austin', timezone: 'America/Chicago'};
  for (const p of players) {
    await server.message({from: p.ident.id, event: 'open', conn});
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

  // The room keeps each hand's full record (#580): every seat's player and
  // cards, folded ones too, matching what each was dealt.
  await server.flush();
  const full = await fullHands(storage);
  assert.ok(full.length >= 3, `${full.length} full records`);
  const ids = new Set(players.map(p => p.ident.id));
  const sorted = c => [...c].sort().join(' ');
  let foldedKept = 0;
  for (const rec of full) {
    for (const k of ['id', 'at', 'table', 'hand', 'seats', 'actions', 'board', 'pots', 'deal']) assert.ok(k in rec, k);
    assert.equal(rec.table, tid);
    // When each action came (#591's decision times): one per action, in
    // order, ms since the hand began.
    assert.equal(rec.times.length, rec.actions.length);
    const known = rec.times.filter(x => x != null);
    assert.ok(known.every((x, i) => x >= 0 && (i === 0 || x >= known[i - 1])), JSON.stringify(rec.times));
    for (const s of rec.seats) {
      assert.ok(ids.has(s.id), 'each seat by player ID');
      assert.equal(s.cards?.length, 2, 'each seat’s cards');
      // What that player was dealt, as their own page saw it.
      const p = people[s.id];
      const theirs = p.got.find(u => u.type === 'state' && Number(u.view.hand_number) === rec.hand && u.view.seats[0].cards)?.view.seats[0].cards;
      if (theirs) assert.equal(sorted(s.cards), sorted(theirs), `${p.name}'s cards in hand ${rec.hand}`);
      if (s.folded) foldedKept++;
    }
    // ducy's check of the deal: the seed, the commitments, each seat's
    // cards and the order they were dealt in.
    const c = checkDeal(rec);
    assert.ok(c.ok, `hand ${rec.hand}: ${c.why}`);
    // Anyone whose value wasn't used is named (someone who sat down after
    // the round began, here).
    for (const id of c.missing) assert.ok(rec.seats.some(s => s.id === id));
  }
  assert.ok(full.some(r => checkDeal(r).missing.length === 0), 'once everyone is in, every player’s value is used');
  assert.ok(foldedKept > 0, 'folded hands are in the full record');
  assert.ok(full.some(r => r.times.some(x => x > 0)), 'actions after the first have their times');
  // And the chips each put in, who made it, and whether they looked away.
  for (const rec of full) {
    assert.equal(rec.amounts.length, rec.actions.length);
    rec.actions.forEach((e, i) => {
      if (e.type === 'call' || e.type === 'small_blind' || e.type === 'big_blind') assert.equal(rec.amounts[i], e.amount);
      if (e.type === 'check' || e.type === 'fold') assert.equal(rec.amounts[i], 0);
      const who = people[rec.seats.find(s => s.seat === e.seat)?.id];
      if (rec.how[i] === 'player') assert.equal(rec.away[i], who.name === 'Ann', `${who.name}'s away`);
    });
  }
  assert.ok(full.some(r => r.how.includes('player')), 'players’ own actions are marked');
  // Each seat's connection when the hand began: the IP and user agent only
  // hashed, Cloudflare's network and place, the client's kind.
  for (const rec of full) {
    for (const s of rec.seats) {
      // Not known in the table's first hand here; connected after.
      assert.ok(s.connected === true || (s.connected === null && rec === full[0]), `${rec.hand}: ${s.connected}`);
      assert.match(s.conn.ip, /^[0-9a-f]{32}$/);
      assert.deepEqual({asn: s.conn.asn, country: s.conn.country, city: s.conn.city, timezone: s.conn.timezone}, {asn: 7922, country: 'US', city: 'Austin', timezone: 'America/Chicago'});
      assert.deepEqual(s.conn.client, {browser: 'Safari', os: 'iOS', mobile: true});
    }
  }
  const stored = JSON.stringify([...store.values()]);
  assert.ok(!stored.includes(IP) && !stored.includes(UA), 'no raw IP or user agent kept');
  // ducy's collusion check (#582) reads them on the relay; its report, for
  // the owner, holds no card, and is kept for their view.
  const report = await server.checkFairPlay();
  assert.equal(report.hands, full.length);
  const said = JSON.stringify(report);
  for (const rec of full) for (const s of rec.seats) for (const c of s.cards) assert.ok(!said.includes(`"${c}"`), c);
  await server.flush();
  assert.deepEqual(await storage.get('fairPlay'), report);
  // The admin's summary of the same run (#612): every player's numbers,
  // and no card, folded ones included, and no seed.
  await until('the admin summary', () => summaries.length > 0);
  const summary = summaries[summaries.length - 1];
  assert.equal(summary.hands, full.length);
  assert.deepEqual(summary.players.map(p => p.id).sort(), [...ids].sort());
  assert.ok(summary.players.every(p => p.hands > 0 && p.p && 'vpn' in p.p));
  assert.equal(summary.pairs.length, 3, 'each pair of the three');
  const toAdmin = JSON.stringify(summary);
  for (const rec of full) for (const s of rec.seats) for (const c of s.cards) assert.ok(!toAdmin.includes(`"${c}"`), c);
  for (const s of seeds) assert.ok(!toAdmin.includes(s), 'no seed');
  assert.doesNotMatch(toAdmin, /"(cards|cls|cells|probs|seed|deal|conn|ip|ua)"/);
  assert.ok(!('pairStats' in report) && !('stats' in report), 'the owner’s report is as it was');
  // A deal that doesn't match the cards fails the check.
  const bad = structuredClone(full[0]);
  [bad.seats[0].cards, bad.seats[1].cards] = [bad.seats[1].cards, bad.seats[0].cards];
  assert.equal(checkDeal(bad).ok, false, 'swapped cards');
  const reordered = structuredClone(full[0]);
  reordered.deal.order.reverse();
  assert.equal(checkDeal(reordered).ok, false, 'another dealing order');

  // The owner's history and the admin view show what a player saw: no
  // folded cards. The owner's has player IDs.
  const folded = new Set(full.flatMap(r => r.seats.filter(s => s.folded).map(s => `${r.hand}|${sorted(s.cards)}`)));
  const shown = recs => recs.flatMap(r => r.seats.filter(s => s.cards?.length).map(s => `${r.hand}|${sorted(s.cards)}`));
  const history = await server.run('hands', {limit: 100});
  assert.ok(history.length >= 3);
  for (const r of history) for (const s of r.seats.filter(x => x.inHand)) assert.ok(ids.has(s.id), 'the owner’s history has player IDs');
  for (const x of shown(history)) assert.ok(!folded.has(x), 'no folded cards in the owner’s history');
  const admin = await adminView(storage, 'full', {reveal: true});
  assert.ok(admin.hands.length >= 3);
  for (const x of shown(admin.hands || [])) assert.ok(!folded.has(x), 'no folded cards in the admin view');
  assert.ok(!JSON.stringify(admin).includes('"deal"'), 'no deals in the admin view');

  await ownerSays('close_table', {table: tid});
  await server.flush();
});

test('full hand records are kept for the club’s days, then dropped, and all go with the club', async () => {
  const store = new Map();
  const storage = {get: async k => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async k => { store.delete(k); }};
  const day = 864e5, now = 100 * day;
  for (const ago of [9, 8, 2, 1, 0]) await keepFullHand(storage, {id: `h${ago}`, at: now - ago * day}, {days: 30}, now);
  assert.deepEqual((await fullHands(storage)).map(r => r.id), ['h9', 'h8', 'h2', 'h1', 'h0']);
  assert.deepEqual((await fullHands(storage, {since: now - 2 * day})).map(r => r.id), ['h2', 'h1', 'h0']);
  // The club keeps a week now: what's older goes with the next hand.
  await keepFullHand(storage, {id: 'new', at: now}, {days: 7}, now);
  assert.deepEqual((await fullHands(storage)).map(r => r.id), ['h2', 'h1', 'h0', 'new']);
  assert.equal([...store.keys()].filter(k => k.startsWith('full:')).length, 4);
  await dropFullHands(storage);
  assert.deepEqual([...store.keys()], []);
});

test('only the relay’s hand-records.js reads full hand records, and nothing sends them (#580)', () => {
  const files = [
    ...readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `src/${f}`),
    ...readdirSync(new URL('../relay/src/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `relay/src/${f}`),
    'relay/dev-server.mjs',
  ];
  const text = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  // Their storage keys.
  assert.deepEqual(files.filter(f => /['"`](?:full:|fullHands['"`])/.test(text(f))), ['relay/src/hand-records.js']);
  // The module: only the club's room loads it, to keep and drop records,
  // and ducy's checks, collusion (#582) and real-time assistance (#591,
  // run together by fair-play.js), to read them; they send out counts and
  // hand numbers only (test/collusion.test.mjs, test/assist.test.mjs).
  assert.deepEqual(files.filter(f => /hand-records\.js['"]/.test(text(f))), ['relay/src/club-room.js', 'relay/src/collusion.js', 'relay/src/fair-play.js']);
  const imports = f => text(f).match(/import \{([^}]*)\} from '\.\/hand-records\.js'/)[1].split(',').map(s => s.trim()).sort();
  assert.deepEqual(imports('relay/src/club-room.js'), ['dropFullHands', 'fullRecord', 'keepFullHand']);
  assert.deepEqual(imports('relay/src/collusion.js'), ['fullHands']);
  assert.deepEqual(imports('relay/src/fair-play.js'), ['fullHands']);
  // The engine's every-seat cards: only the club's room asks for them.
  assert.deepEqual(files.filter(f => /runnerCards|\.holeCards\(/.test(text(f))), ['src/club-engine.js', 'src/club-host.js']);
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
