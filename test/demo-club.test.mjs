// The demo club (#406): its relay runs in the page (src/demo-relay.js), with
// the real club room, table, ledger and cash-out code, and only it can choose
// a hand's outcome. A real club's room refuses any such command, and nothing
// a real club runs loads the demo's code.
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/demo-club.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
const ducy = haveWasm ? await import('./wasm.mjs').then(() => import('../wasm/ducy_wasm.js')) : null;
const { createIdentity, signMessage } = await import('../src/identity.js');
const { newKeyPair, open: openBox, sharedKey } = await import('../src/e2e.js');
const { createDemoRelay } = haveWasm ? await import('../src/demo-relay.js') : {};
const { fairPlayer } = haveWasm ? await import('../src/fair-check.js') : {};
const { totals } = await import('../src/club-chips.js');

// The demo clubs' tables keep their clocks going (club-host.js): done once the tests are.
test.after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 90_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

test('Reset puts the demo back to its scenario’s start, in the same session; it never runs out', {skip: !haveWasm && 'no wasm build'}, async () => {
  const { newDemo, resetDemo, demoStorage, isOn, MANAGER } = await import('../src/demo-state.js');
  const { scenarioById } = await import('../src/demo-scenarios.js');
  const d = newDemo('abc123', 'busy');
  d.people.push({key: 'p1', name: 'Player 1', id: 'X'});
  d.current = 'p1';
  const r = resetDemo({...d, setUp: true, resetting: true});
  assert.deepEqual(r, {id: 'abc123', scenario: 'busy', setUp: false, people: [{key: MANAGER, name: 'Manager'}], current: MANAGER});
  // No clock: on until End demo.
  assert.ok(isOn(r) && !('endsAt' in r));
  assert.ok(!isOn({...r, ending: true}));
  // What Reset deletes: the club's database and each person's, and nothing else.
  const s = demoStorage(d);
  for (const n of ['ducyDemoRelay-abc123', 'ducy@demo-abc123-manager', 'ducy@demo-abc123-p1', 'ducy-tables@demo-abc123-p1', 'ducy-hands@demo-abc123-p1']) assert.ok(s.dbs.includes(n), n);
  assert.ok(s.isDemoDb('ducy-hands@demo-abc123-p2') && !s.isDemoDb('ducy') && !s.isDemoDb('ducy@demo-zzz-p1'));
  assert.equal(s.prefix, 'ducyDemo:abc123:');

  // A brand new club's start is no club: with its storage cleared and the
  // scenario loaded again, the relay has none.
  const mem = new Map();
  const storage = {get: async k => structuredClone(mem.get(k)), put: async (k, v) => { mem.set(k, structuredClone(v)); }, delete: async k => { mem.delete(k); }};
  const owner = await createIdentity();
  const relay = createDemoRelay({storage, identity: async () => owner, ready: async () => ducy});
  const o = await person(relay, 'HHHH-JJJJ', owner, 'Manager');
  o.net.send(await signMessage(owner, {type: 'create_club', club: 'HHHH-JJJJ', name: 'Demo Club'}));
  await o.next('club_created');
  assert.equal((await relay.club()).name, 'Demo Club');
  o.net.close();
  await relay.flush();
  mem.clear();
  const again = createDemoRelay({storage, identity: async () => owner, ready: async () => ducy});
  await again.setUp(scenarioById('new'));
  assert.equal(await again.club(), null);
  assert.deepEqual(await again.lookup('HHHH-JJJJ'), {kind: 'game'});
});

// What a demo club's start looks like, without its ids or times.
function shape(club) {
  const table = id => club.tables.find(t => t.id === id)?.name ?? null;
  return {
    name: club.name, temporary: !!club.temporary,
    tables: club.tables.map(t => ({name: t.name, game: t.game, sb: t.sb, bb: t.bb, seats: t.seats, status: t.status})),
    members: Object.values(club.members).filter(m => m.id !== club.ownerId)
      .map(m => ({name: m.name, status: m.status, balance: m.balance || 0, seat: m.seat ? [table(m.seat.table), m.seat.stack] : null, ask: m.request?.amount ?? null}))
      .sort((a, b) => a.name.localeCompare(b.name)),
    help: (club.help || []).filter(h => !h.handled).map(h => h.text),
    tourneys: (club.tourneys || []).map(t => ({name: t.name, status: t.status, entries: t.entries.length})),
    promos: (club.promos?.list || []).map(p => ({name: p.name, status: p.status})),
  };
}

test('each demo club starts in its scenario’s state, and starts again the same', {skip: !haveWasm && 'no wasm build'}, async () => {
  const { SCENARIOS } = await import('../src/demo-scenarios.js');
  const { conservation } = {conservation: club => totals(club).conserved};
  for (const s of SCENARIOS.filter(x => x.club)) {
    const shapes = [];
    for (let round = 0; round < 2; round++) {
      const mem = new Map();
      const storage = {get: async k => structuredClone(mem.get(k)), put: async (k, v) => { mem.set(k, structuredClone(v)); }, delete: async k => { mem.delete(k); }};
      const owner = await createIdentity();
      const people = [];
      for (const p of s.club.people) people.push({...p, ident: await createIdentity()});
      const relay = createDemoRelay({storage, identity: async () => owner, ready: async () => ducy});
      const made = await relay.setUp(s, {owner, people});
      assert.equal(made.name, s.club.name);
      const seated = s.club.bots.filter(b => b.table != null).length;
      await until(`${s.id}: bots seated`, async () => Object.values((await relay.club()).members).filter(m => m.seat).length === seated, 30_000);
      await relay.flush();
      const club = await relay.club();
      assert.equal(club.ownerId, owner.id, 'run by the manager');
      assert.ok(conservation(club), `${s.id}: chips conserved`);
      for (const p of people) assert.equal(club.members[p.ident.id].status, p.status || 'member', `${s.id}: ${p.name}`);
      shapes.push(shape(club));
    }
    assert.deepEqual(shapes[1], shapes[0], `${s.id} starts the same every time`);
    const first = shapes[0];
    assert.equal(first.temporary, false, 'no Temporary banner in a demo');
    if (s.id === 'busy') {
      const members = first.members.filter(m => m.status === 'member').length;
      assert.ok(members >= 40 && members <= 50, `${members} members`);
      assert.ok(first.members.filter(m => m.status === 'pending').length >= 3, 'people asking to join');
      assert.ok(first.members.filter(m => m.ask).length >= 2, 'chip requests');
      assert.equal(first.tables.length, 3);
      for (const t of first.tables) {
        const at = first.members.filter(m => m.seat?.[0] === t.name).length;
        assert.ok(at >= 2 && at < t.seats, `${t.name}: ${at} bots, room to sit`);
      }
      assert.deepEqual(first.tourneys.map(t => t.status), ['scheduled']);
      assert.equal(first.promos[0]?.status, 'running');
      assert.equal(first.help.length, 1, 'a help request');
    }
    if (s.id === 'tourney') {
      assert.equal(first.tourneys[0].status, 'scheduled');
      assert.equal(first.tourneys[0].entries, 18, '17 bots and Player 1 registered');
    }
  }
});

test('only the demo loads the demo relay: no real club or relay code imports it', () => {
  const files = [
    ...readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `src/${f}`),
    ...readdirSync(new URL('../relay/src/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `relay/src/${f}`),
    'relay/dev-server.mjs',
  ];
  const importers = files.filter(f => /['"][./]*(?:src\/)?demo-relay\.js['"]/.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')));
  assert.deepEqual(importers, ['src/demo.js']);
  // demo.js loads it only for a demo, when it runs.
  const demo = readFileSync(new URL('../src/demo.js', import.meta.url), 'utf8');
  assert.doesNotMatch(demo, /^import .*demo-relay/m);
  for (const f of ['relay/src/club-room.js', 'relay/src/worker.js', 'relay/dev-server.mjs', 'src/club-server.js', 'src/club-host.js', 'src/club-engine.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /simulate|riggable|pickSeed/i, f);
  }
});

test('a real club room refuses the demo’s simulate and bot commands', {skip: !haveWasm && 'no wasm build'}, async () => {
  const { default: WebSocket } = await import('../relay/node_modules/ws/index.js');
  const port = 21000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(port)], {stdio: ['ignore', 'pipe', 'inherit']});
  await new Promise(resolve => server.stdout.once('data', resolve));
  try {
    const open = id => {
      const ws = new WebSocket(`ws://localhost:${port}/room/GGGG-GGGG?role=guest&id=${id}&queue=1`);
      const inbox = [], waiting = [];
      ws.on('message', d => { const m = JSON.parse(d); waiting.length ? waiting.shift()(m) : inbox.push(m); });
      const next = async type => { for (;;) { const m = inbox.length ? inbox.shift() : await new Promise(r => waiting.push(r)); if (m.type === type || m.body?.type === type) return m; } };
      return {ws, next, inbox, ready: new Promise(r => ws.on('open', r)), send: o => ws.send(JSON.stringify(o))};
    };
    const owner = await createIdentity(), ann = await createIdentity();
    const o = open(owner.id);
    await o.ready;
    o.send(await signMessage(owner, {type: 'create_club', club: 'GGGG-GGGG', name: 'Real Club'}));
    const made = await o.next('club_created');
    o.send(await signMessage(owner, {club: 'GGGG-GGGG', type: 'owner_hello'}));
    await o.next('owner_view');
    let n = 0;
    for (const op of ['simulate', 'fillSeats', 'fill_seats', 'add_bot', 'rig', 'win', 'lose', 'bust', 'play10']) {
      o.send(await signMessage(owner, {club: 'GGGG-GGGG', type: 'owner_cmd', op, args: {id: ann.id, what: 'win'}, id: ++n}));
      assert.match((await o.next('owner_result')).body.error, /no host action/, op);
    }
    // A member's request for any of it is no message the club knows.
    const a = open(ann.id);
    await a.ready;
    a.send(await signMessage(ann, {club: 'GGGG-GGGG', type: 'join', invite: made.invite, name: 'Ann'}));
    assert.equal((await a.next('status')).body.status, 'pending');
    for (const type of ['simulate', 'demo_sim', 'rig']) a.send(await signMessage(ann, {club: 'GGGG-GGGG', type, what: 'win'}));
    await sleep(300);
    o.send(await signMessage(owner, {club: 'GGGG-GGGG', type: 'owner_hello'}));
    let view;
    do view = await o.next('owner_view'); while (!view.body.data.members[ann.id]);
    assert.equal(view.body.data.members[ann.id].status, 'pending', 'nothing changed for her');
    assert.equal(Object.keys(view.body.data.members).length, 1, 'no bots joined');
    o.ws.close(); a.ws.close();
  } finally {
    server.kill();
  }
});

// A person in the demo: their connection to the in-page relay, signed
// messages, and their side of the table's encryption and fair deals.
async function person(relay, code, ident, name) {
  const keys = await newKeyPair();
  const inbox = [], waiting = [], updates = [], checks = [], results = [];
  const fair = fairPlayer();
  let aes = null, table = null;
  const seen = new Map();
  const p = {ident, keys, updates, checks, results, inbox};
  p.sign = body => signMessage(ident, {club: code, ...body});
  p.net = relay.connect(code, 'guest', ident.id, {
    onOpen() {}, onStatus() {}, onFail(r) { throw new Error(r); },
    async onMessage(m) {
      if (m.type === 'table' && m.enc) {
        if (!aes) return;
        const u = await openBox(aes, m.enc);
        updates.push(u);
        if (u.type === 'fair') {
          if (u.step === 'result') results.push(Number(u.hand));
          const c = fair.message(u, cmd => p.table(cmd), seen.get(Number(u.hand)) || {});
          if (c) checks.push(c);
        } else if (u.type === 'state') {
          const v = u.view;
          if (v.complete && Number(v.hand_number)) seen.set(Number(v.hand_number), {cards: v.seats[0].cards || [], board: v.board || []});
          p.last = u;
          // Between simulated hands, fold to anything (or check), as a person might.
          const st = await relay.status(ident.id);
          if (v.legal && !v.complete && (!st.plan || (st.plan.kind !== 'play10' && !st.plan.dealt))) {
            p.table({type: 'act', seq: u.seq, kind: v.legal.can_check ? 'check' : 'fold', amount: 0});
          }
        }
        return;
      }
      if (m.body?.type === 'host_key') {
        aes = await sharedKey(keys, m.body.key, {context: `club:${code}`, hostId: m.from, playerId: ident.id, hostPub: m.body.key, playerPub: keys.pub});
      }
      waiting.length ? waiting.shift()(m) : inbox.push(m);
    },
  });
  p.send = async body => p.net.send(await p.sign(body));
  p.next = async type => {
    for (;;) {
      const m = inbox.length ? inbox.shift() : await new Promise(r => waiting.push(r));
      if (m.type === type || m.body?.type === type) return m;
    }
  };
  p.table = async cmd => p.send({type: 'table', table, cmd});
  p.sit = id => { table = id; };
  p.name = name;
  return p;
}

test('the demo relay: a club made, joined and played in the page, with chosen outcomes through the real ledger', {skip: !haveWasm && 'no wasm build'}, async () => {
  const mem = new Map();
  const storage = {get: async k => structuredClone(mem.get(k)), put: async (k, v) => { mem.set(k, structuredClone(v)); }, delete: async k => { mem.delete(k); }};
  const owner = await createIdentity(), ann = await createIdentity();
  const relay = createDemoRelay({storage, identity: async () => ann, ready: async () => ducy});
  const code = 'DDDD-EEEE';

  // The manager makes the club, as club-owner.js does, and opens a table.
  const o = await person(relay, code, owner, 'Manager');
  o.net.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Demo Club'}));
  const made = await o.next('club_created');
  await o.send({type: 'owner_hello'});
  await o.next('owner_view');
  const cmd = async (op, args) => {
    const id = Math.random();
    await o.send({type: 'owner_cmd', op, args, id});
    for (;;) { const r = await o.next('owner_result'); if (r.body.id === id) { assert.equal(r.body.error, '', op); return r.body.value; } }
  };
  const tid = await cmd('new_table', {table: {name: 'Main', sb: 100, bb: 200, minBB: 40, maxBB: 100, seats: 3, turnSecs: 30}});
  assert.equal((await relay.lookup(code)).kind, 'club');

  // Ann asks to join with the invite; the manager lets her in and gives her chips.
  const a = await person(relay, code, ann, 'Ann');
  await a.send({type: 'join', invite: made.invite, name: 'Ann', key: a.keys.pub});
  assert.equal((await a.next('status')).body.status, 'pending');
  await cmd('approve', {id: ann.id});
  await cmd('give', {id: ann.id, amount: 50_000});
  await until('the host key', () => a.inbox.some(m => m.body?.type === 'account'));
  a.sit(tid);
  await a.table({type: 'join'});
  await a.table({type: 'request_chips', amount: 20_000});
  const stack = async () => (await relay.club()).members[ann.id].seat?.stack;
  await until('her buy-in', async () => (await stack()) === 20_000);

  // Win this hand: bots fill the empty seats, and she wins.
  await relay.simulate(ann.id, 'win');
  assert.equal((await relay.club()).members[ann.id].seat.table, tid);
  await until('the hand won', async () => !(await relay.status(ann.id)).plan);
  const bots = Object.values((await relay.club()).members).filter(m => m.name.startsWith('Bot '));
  assert.equal(bots.length, 2, 'two bots for the two empty seats');
  const won = await until('the stack after it', async () => (await relay.club()).members[ann.id].seat?.stack !== 20_000 && stack());
  assert.ok(won > 20_000, `won: ${won}`);

  // Lose this hand.
  await relay.simulate(ann.id, 'lose');
  await until('the hand lost', async () => !(await relay.status(ann.id)).plan);
  const lost = await until('the stack after it', async () => (await stack()) !== won && stack());
  assert.ok(lost < won, `lost: ${lost} < ${won}`);

  // Play 10 hands: played for her, ten hands she's dealt into.
  const hands = () => Math.max(0, ...a.updates.filter(u => u.type === 'state' && u.view.complete).map(u => Number(u.view.hand_number)));
  const before = hands();
  await relay.simulate(ann.id, 'play10');
  await until('ten hands played', async () => !(await relay.status(ann.id)).plan, 240_000);
  assert.ok(hands() - before >= 10, `${hands() - before} hands`);

  // Bust: all of it, in up to three hands.
  await relay.simulate(ann.id, 'bust');
  await until('busted', async () => !(await relay.status(ann.id)).plan);
  await until('the stack at 0', async () => (await stack()) === 0);

  // Leaving cashes her out through the real ledger: what she has left is
  // what she was given less what she lost at the table.
  await a.table({type: 'leave'});
  await until('cashed out', async () => !(await relay.club()).members[ann.id].seat);
  const club = await relay.club();
  assert.equal(club.members[ann.id].balance, 30_000);
  assert.ok(totals(club).conserved, 'every chip accounted for');
  assert.ok(club.chips.ledger.some(e => e.member === ann.id && e.kind === 'cash_out'));
  // The hands whose deal was chosen sent her no fair-deal result (it would
  // only say the deal wasn't fair); any other hand she checked is fair.
  for (const c of a.checks) assert.ok(c.ok, `hand ${c.hand}: ${c.why}`);
  await relay.flush();
  o.net.close(); a.net.close();
});
