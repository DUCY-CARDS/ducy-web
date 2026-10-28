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
const { accountOf } = await import('../src/club-agents.js');
const { fits, pickPlayer, playerName, stakesOf, thinker } = await import('../src/demo-bots.js');
const { personOf } = await import('../src/quest-people.js');
const { ORDER } = await import('../src/ladder.js');
const { botAvatar } = await import('../src/avatars.js');
// The Regulars' names, as the engine has them.
const regulars = () => new Map((ducy?.botPersonalities?.() || []).map(p => [p.id, p.name]));
const { managerNotices } = await import('../src/club-notices.js');

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
      .map(m => ({name: m.name, status: m.status, balance: m.balance || 0, seat: m.seat ? [table(m.seat.table), m.seat.stack] : null, ask: m.request?.amount ?? null, credit: m.credit || 0, atLimit: !!m.request?.atLimit,
        // Agents (#428): an agent's credit limit (their member one, #445), and whose player they are.
        agent: m.agent === 'yes' ? m.credit || 0 : null, under: club.members[m.agentOf]?.name ?? null}))
      .sort((a, b) => a.name.localeCompare(b.name)),
    help: (club.help || []).filter(h => !h.handled).map(h => h.text),
    tourneys: (club.tourneys || []).map(t => ({name: t.name, status: t.status, entries: t.entries.length})),
    promos: (club.promos?.list || []).map(p => ({name: p.name, status: p.status})),
    // The manager's credit notifications (#404).
    notices: managerNotices(club).filter(n => n.kind === 'at_limit' || n.kind === 'left_owing').map(n => n.kind).sort(),
  };
}

test('each demo club starts in its scenario’s state, and starts again the same', {skip: !haveWasm && 'no wasm build'}, async () => {
  const { SCENARIOS } = await import('../src/demo-scenarios.js');
  const { conservation } = {conservation: club => totals(club).conserved};
  for (const s of SCENARIOS.filter(x => x.club)) {
    const shapes = [];
    let agentsClub = null;
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
      // The "You are" switcher (#428): each person you can be is taken to
      // the club's page (a member, an agent too) or their request, never to
      // the invite link as someone new; the manager to the club manager.
      const {whereIs, MANAGER} = await import('../src/demo-state.js');
      assert.deepEqual(whereIs(club, {key: MANAGER, id: owner.id}), {page: 'manager', hash: 'clubs/own'});
      for (const [i, p] of people.entries()) {
        const want = p.status === 'pending' ? 'join' : `clubs/c/${encodeURIComponent(club.code)}`;
        assert.deepEqual(whereIs(club, {key: `p${i + 1}`, id: p.ident.id}), {page: 'player', hash: want}, `${s.id}: switch to ${p.name}`);
      }
      shapes.push(shape(club));
      if (!round) agentsClub = club;
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
    // Credit players (#404): one on credit with nothing of their own, one at
    // their limit asking, one who stood up owing; the books still add up.
    if (s.id === 'credit') {
      const p = name => first.members.find(m => m.name === name);
      assert.deepEqual([p('Player 1').balance, p('Player 1').credit], [0, 50_000]);
      assert.deepEqual([p('Player 2').ask, p('Player 2').atLimit], [40_000, true]);
      assert.deepEqual([p('Player 3').balance, p('Player 3').credit], [-20_000, 20_000]);
      assert.equal(first.members.filter(m => m.balance === 40_000).length, 1, 'a bot won what Player 3 lost');
      assert.deepEqual(first.notices, ['at_limit', 'left_owing']);
    }
    if (s.id === 'tourney') {
      assert.equal(first.tourneys[0].status, 'scheduled');
      assert.equal(first.tourneys[0].entries, 18, '17 bots and Player 1 registered');
    }
    // Agents (#428): five agents with their own limits (one with none), each
    // with 3–6 players; one near the limit and owing, one with players at
    // the tables, one with a player asking; members with no agent.
    if (s.id === 'agents') {
      const club = agentsClub;
      const agents = Object.values(club.members).filter(m => m.agent === 'yes');
      assert.equal(agents.length, 5);
      const limits = agents.map(a => a.credit || 0);
      assert.ok(limits.includes(0) && new Set(limits).size === 5, `limits differ, one 0: ${limits}`);
      const acc = Object.fromEntries(agents.map(a => [a.name, accountOf(club, a.id)]));
      for (const a of agents) {
        const n = acc[a.name].players.length;
        assert.ok(n >= 3 && n <= 6, `${a.name}: ${n} players`);
        assert.ok(a.balance >= -(a.credit || 0), `${a.name} within the limit`);
      }
      // Each agent and two of their players are people you can be.
      const people = new Set(s.club.people.map(p => p.name));
      for (const a of agents) assert.ok(people.has(a.name), a.name);
      assert.ok(s.club.people.filter(p => p.under != null).length >= 1);
      const near = agents.find(a => a.credit && room(acc[a.name]) <= 0.2 * a.credit);
      assert.ok(near, 'one near their limit');
      assert.ok(acc[near.name].creditUsed > 0, `${near.name} owes`);
      assert.ok(agents.some(a => acc[a.name].players.filter(p => p.seat).length >= 2), 'one with players at the tables');
      assert.ok(agents.some(a => acc[a.name].players.some(p => p.request)), 'one with a player asking for chips');
      assert.equal(first.members.find(m => m.name === 'Ivy Chen').ask, 20_000);
      assert.equal(first.members.find(m => m.name === 'Tom Reyes').balance, 30_000, 'Tom has what Marco gave him');
      assert.ok(first.members.filter(m => m.status === 'member' && !m.agent && !m.under).length >= 3, 'members with no agent');
      // The bots under an agent were given their chips by them (transfers), not by the manager.
      for (const a of agents) for (const p of acc[a.name].players) {
        if (p.name !== 'Ivy Chen') assert.ok(club.chips.ledger.some(e => e.member === p.id && e.kind === 'transfer_in' && e.from === a.id), `${p.name} from ${a.name}`);
        assert.ok(!club.chips.ledger.some(e => e.member === p.id && e.kind === 'issue'), `${p.name}: nothing from the manager`);
      }
    }
  }
});
const room = a => a.limit + a.own;

// The page reloads once the demo is set up, and the club opens again from
// storage, its tables resuming from their saved snapshots: as an always-on
// club's room does when it wakes (#107, #135), with the same club-room code.
// A table saved while a bot's buy-in was paid but not yet added there lost
// it (#427). Opened again from storage as it was after each table save, the
// club's chips add up.
test('a demo club opened again from storage, as after the page reloads, loses no chips', {skip: !haveWasm && 'no wasm build'}, async () => {
  const { scenarioById } = await import('../src/demo-scenarios.js');
  const sc = scenarioById('busy');
  const mem = new Map(), copies = [];
  const kv = m => ({get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }});
  const storage = {...kv(mem), put: async (k, v) => {
    mem.set(k, structuredClone(v));
    if (k.includes('|table:')) copies.push(structuredClone(mem));
  }};
  const owner = await createIdentity();
  const people = [];
  for (const p of sc.club.people) people.push({...p, ident: await createIdentity()});
  const noBot = async () => { throw new Error('no SeatBot'); };
  const relay = createDemoRelay({storage, identity: async () => owner, ready: async () => ducy, think: noBot});
  const made = await relay.setUp(sc, {owner, people});
  await relay.flush();
  assert.ok(copies.length >= sc.club.bots.filter(b => b.table != null).length, 'each buy-in saved');
  for (const [i, copy] of copies.entries()) {
    const again = createDemoRelay({storage: kv(copy), identity: async () => owner, ready: async () => ducy, think: noBot});
    const conn = again.connect(made.code, 'guest', owner.id, {onOpen() {}, onStatus() {}, onFail() {}, onMessage() {}});
    await sleep(400);
    await again.flush();
    const club = await again.club();
    assert.ok(totals(club).conserved, `opened after table save ${i + 1}: chips add up`);
    assert.ok(!club.chips.ledger.some(e => e.kind === 'top_up'), `opened after table save ${i + 1}: no one bought in again`);
    conn.close();
    await again.flush();
  }
});

test('Quest’s players fill a demo club’s tables, play through the real table code, come and go, and the books add up', {skip: !haveWasm && 'no wasm build'}, async () => {
  const { scenarioById } = await import('../src/demo-scenarios.js');
  const sc = scenarioById('busy');
  const mem = new Map();
  const storage = {get: async k => structuredClone(mem.get(k)), put: async (k, v) => { mem.set(k, structuredClone(v)); }, delete: async k => { mem.delete(k); }};
  const owner = await createIdentity();
  const people = [];
  for (const p of sc.club.people) people.push({...p, ident: await createIdentity()});
  // Their decisions: ducy's SeatBot, counted (a ducy-wasm without it plays by style).
  const base = thinker(async () => ducy);
  let thought = 0, failed = 0;
  const think = async (...a) => { try { const m = await base(...a); thought++; return m; } catch (e) { failed++; throw e; } };
  const relay = createDemoRelay({storage, identity: async () => people[0].ident, ready: async () => ducy, think, churn: {leave: 0.3, come: 1}});
  const made = await relay.setUp(sc, {owner, people});
  const seated = sc.club.bots.filter(b => b.table != null).length;
  await until('bots seated', async () => Object.values((await relay.club()).members).filter(m => m.seat).length === seated, 30_000);

  // Each is a Quest player who'd sit in that game, under their own name.
  let club = await relay.club();
  const quest = Object.fromEntries((await relay.bots()).map(b => [b.id, b.quest]));
  assert.equal(Object.keys(quest).length, sc.club.bots.length, 'every bot is a Quest player');
  // Their names are their own in the club: the table shows faces by name.
  const names = Object.values(club.members).map(m => m.name);
  assert.equal(new Set(names).size, names.length, 'no two members with one name');
  for (const [id, q] of Object.entries(quest)) {
    const m = club.members[id];
    assert.equal(m.name, playerName(q, regulars()), q);
    const t = m.seat && club.tables.find(x => x.id === m.seat.table);
    if (t) assert.ok(fits(q, stakesOf(t)), `${q} at ${t.name}`);
  }

  // Player 1 opens the club and sits at High 5/10: the bots come online and play.
  const p = await person(relay, made.code, people[0].ident, 'Player 1');
  await p.send({type: 'hello', key: p.keys.pub});
  await until('the host key', () => p.inbox.some(m => m.body?.type === 'host_key'));
  const high = club.tables.find(t => t.name === 'High 5/10');
  p.sit(high.id);
  await p.table({type: 'join'});
  await p.table({type: 'request_chips', amount: 40_000});
  const done = () => p.updates.filter(u => u.type === 'state' && u.view.complete && u.view.seats[0].cards);
  await until('four hands played', () => new Set(done().map(u => u.view.hand_number)).size >= 4, 180_000);
  const acts = done().flatMap(u => u.view.events).filter(e => e.seat !== 0 && ['call', 'bet', 'raise', 'fold', 'check'].includes(e.type));
  assert.ok(acts.length > 0, 'the bots act');
  if (typeof ducy.SeatBot === 'function') assert.ok(thought > 0 && failed === 0, `SeatBot decided: ${thought}, failed: ${failed}`);

  // One gets up (cashing out as anyone does) and a seat opens; one sits down in it later.
  const isBot = e => e.member in quest || (e.member !== people[0].ident.id && !people.some(x => x.ident.id === e.member));
  await until('a bot to leave and one to sit back down', async () => {
    const ledger = (await relay.club()).chips.ledger;
    const out = ledger.findIndex(e => e.kind === 'cash_out' && isBot(e));
    return out >= 0 && ledger.slice(out + 1).some(e => e.kind === 'buy_in' && isBot(e) && e.table === ledger[out].table);
  }, 120_000);

  await p.table({type: 'leave'});
  await until('Player 1 cashed out', async () => !(await relay.club()).members[people[0].ident.id].seat);
  await relay.flush();
  club = await relay.club();
  assert.ok(totals(club).conserved, 'every chip accounted for');
  p.net.close();
  await relay.flush();
});

test('only the demo loads the demo relay: no real club or relay code imports it', () => {
  const files = [
    ...readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `src/${f}`),
    ...readdirSync(new URL('../relay/src/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `relay/src/${f}`),
    'relay/dev-server.mjs',
  ];
  const using = name => files.filter(f => new RegExp(`['"][./]*(?:src/)?${name.replace('.', '\\.')}['"]`).test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')));
  assert.deepEqual(using('demo-relay.js'), ['src/demo.js']);
  // demo.js loads it only for a demo, when it runs.
  const demo = readFileSync(new URL('../src/demo.js', import.meta.url), 'utf8');
  assert.doesNotMatch(demo, /^import .*demo-relay/m);
  // The demo's bot players (#415): only the demo relay and their worker.
  assert.deepEqual(using('demo-bots.js'), ['src/demo-bot-worker.js', 'src/demo-relay.js']);
  assert.deepEqual(files.filter(f => /demo-bot-worker/.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))), ['src/demo-bots.js']);
  for (const f of ['relay/src/club-room.js', 'relay/src/worker.js', 'relay/dev-server.mjs', 'src/club-server.js', 'src/club-host.js', 'src/club-engine.js', 'src/club-log.js', 'src/club.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /simulate|riggable|pickSeed|demo-bots|SeatBot|pickPlayer/i, f);
  }
});

test('demo bots are Quest’s players, picked as Quest’s line-ups pick them for the stakes', () => {
  const regs = new Set([...ORDER]);
  for (const [stakes, bb] of [['1/2', 200], ['2/5', 500], ['5/10', 1000], ['10/20', 2000], ['25/50', 5000], ['50/100', 10000]]) {
    assert.equal(stakesOf({bb}), stakes);
    const picks = [];
    for (let table = 0; table < 20; table++) {
      // A table of nine, no one twice.
      const taken = new Set();
      for (let i = 0; i < 9; i++) {
        const id = pickPlayer(stakes, Math.random, taken);
        assert.ok(id, `${stakes}: someone to sit`);
        assert.ok(fits(id, stakes), `${stakes}: ${id}`);
        assert.ok(!taken.has(playerName(id)), `${stakes}: one ${playerName(id)}`);
        taken.add(id).add(playerName(id));
        picks.push(id);
      }
    }
    const generic = picks.filter(id => personOf(id)).length / picks.length;
    // Low stakes are mostly the rooms' own players; big games all Regulars.
    if (stakes === '1/2') assert.ok(generic > 0.75, `1/2: ${generic} generic`);
    if (stakes === '5/10') assert.ok(generic > 0.3 && generic < 0.75, `5/10: ${generic} generic`);
    if (stakes === '25/50') assert.equal(generic, 0);
    // Everyone has a face: a generic player's drawn one, or a Regular's.
    for (const id of picks) assert.ok(personOf(id)?.avatar || botAvatar(id) || regs.has(id), id);
  }
  // A scenario's dice give the same line-up every time.
  const r = key => [0.1, 0.5, 0.9][key.length % 3];
  assert.equal(pickPlayer('1/2', r), pickPlayer('1/2', r));
  assert.ok(stakesOf({bb: 100}) === '1/2' && stakesOf(null) === '1/2');
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
  // The bots play by style here, as with a ducy-wasm without SeatBot (#415).
  const relay = createDemoRelay({storage, identity: async () => ann, ready: async () => ducy, think: async () => { throw new Error('no SeatBot'); }});
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
  // The managers' copy says when each member was last heard from, for
  // Members' Last active (#426); no one else's.
  await o.send({type: 'owner_hello'});
  let view;
  do view = await o.next('owner_view'); while (!view.body.seen?.[ann.id]);
  assert.ok(Math.abs(view.body.seen[ann.id] - Date.now()) < 60_000);
  assert.ok(!(owner.id in view.body.seen), 'members only');
  a.sit(tid);
  await a.table({type: 'join'});
  await a.table({type: 'request_chips', amount: 20_000});
  const stack = async () => (await relay.club()).members[ann.id].seat?.stack;
  await until('her buy-in', async () => (await stack()) === 20_000);

  // Win this hand: bots fill the empty seats, and she wins.
  await relay.simulate(ann.id, 'win');
  assert.equal((await relay.club()).members[ann.id].seat.table, tid);
  await until('the hand won', async () => !(await relay.status(ann.id)).plan);
  // Add bots: two of Quest's players, under their names (#415).
  const added = await relay.bots();
  assert.equal(added.length, 2, 'two bots for the two empty seats');
  for (const b of added) assert.equal((await relay.club()).members[b.id].name, playerName(b.quest, regulars()), b.quest);
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
  // Quest's players bet big: losing it all ends the ten hands early.
  const out = (await stack()) === 0;
  assert.ok(out || hands() - before >= 10, `${hands() - before} hands`);

  // Bust: all of it, in up to three hands.
  if (!out) {
    await relay.simulate(ann.id, 'bust');
    await until('busted', async () => !(await relay.status(ann.id)).plan);
  }
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

  // Back at the table, the manager removes her (#414): she's told, with her
  // result, and cashed out as when she leaves.
  await a.table({type: 'join'});
  await a.table({type: 'request_chips', amount: 20_000});
  await until('her buy-in again', async () => (await stack()) === 20_000);
  await cmd('remove_player', {table: tid, id: ann.id});
  await until('removed', async () => !(await relay.club()).members[ann.id].seat);
  const told = await until('her message', () => a.updates.find(u => u.type === 'removed' && u.chips != null));
  assert.equal(told.name, 'Main');
  const after = await relay.club();
  assert.equal(after.members[ann.id].balance, 10_000 + told.chips);
  assert.match(after.log.at(-1).text, /removed Ann from Main/);
  assert.ok(totals(after).conserved);
  await relay.flush();
  o.net.close(); a.net.close();
});
