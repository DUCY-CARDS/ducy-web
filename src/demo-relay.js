// The demo club's relay (#406): the club-room logic from relay/ (club-room.js,
// as the dev relay runs it) driven inside the page instead of over a
// WebSocket, so a demo uses no relay and leaves nothing on a server. Its
// storage is the demo's own (an IndexedDB database demo.js deletes when the
// demo ends).
//
// Only the demo has this file, and with it two things no real club has:
//   - demo bots: members this relay plays for, so one person can fill a table.
//     Each is one of Bankroll Quest's players, picked for the table's stakes
//     and deciding as Quest's bots do (demo-bots.js, #415); they come and go
//     now and then, and say a word in the lobby after a big pot;
//   - Simulate: the next hand's outcome for the person playing (win, lose,
//     bust), or ten hands played for them. The table, ledger and cash-out are
//     the real ones (club-server.js, club-host.js); what's chosen here is only
//     the deal, through the tables this relay hands the club (riggable), and
//     the actions it sends for the bots and the person, signed like any
//     member's. A real club's room never loads this file, and no message can
//     ask a club for any of it (test/demo-club.test.mjs).
//
//   const relay = createDemoRelay({storage, identity, ready});
//   relay.connect(code, role, id, handlers)  as play-net.js connect, in the page
//   relay.setUp(scenario)     the demo's starting club (demo-scenarios.js)
//   relay.lookup(code)        what the relay's GET /code/<code> answers
//   relay.club()              the demo's club as it is now, or null
//   relay.fillSeats(id)       bots in the empty seats at member id's table
//   relay.simulate(id, what)  'win' | 'lose' | 'bust' | 'play10' at id's table
//   relay.status(id)          {table, plan, left}: for the Simulate panel
//   relay.bots()              [{id, name, quest}]: their Quest players' faces
//   relay.onChange(fn)        the status may have changed
//   relay.flush()             resolves once everything is saved
//
// storage: {get, put, delete}, async, for the whole demo; each room keeps its
// keys under `<code>|`, as club-room.js names them. `identity()` resolves to
// the identity of the person in this page (identity.js), to act for them in
// a simulated hand. `ready()` resolves to the initialised wasm module.
// `think` (optional) decides for a bot as demo-bots.js thinker does; `churn`
// {leave, come} is how often bots come and go (the tests hurry them).

import { codeInfo, createClub, openClub } from '../relay/src/club-room.js';
import { chatLine, fallbackMove, fits, pickPlayer, playerName, stakesOf, thinker } from './demo-bots.js';
import { roll } from './quest-rooms.js';
import { createIdentity, exportIdentity, importIdentity, signMessage } from './identity.js';
import { keyPairFromJSON, keyPairToJSON, newKeyPair, open as openBox, sharedKey } from './e2e.js';
import { fairPlayer } from './fair-check.js';
import { limits as tableLimits, tableById } from './club-tables.js';
import { buyIn, cashOut, setStack } from './club-chips.js';
import { tableChip, toChip } from './chip-format.js';
import { ratholeMin } from './club-chips.js';
import { newCode } from './play-net.js';

// Not limited by plans (#406), and never temporary (#395): its backup
// banner means nothing in a demo.
const LIMITS = {tables: 5, tourneysPerDay: 5};
const DEMO_RECORD = () => ({plan: 'club', limits: LIMITS, temporary: false, at: Date.now()});
// Add bots fills a table's empty seats, up to a full nine-handed table.
const MAX_BOTS = 8;
// How long a bot (or the person, in a simulated hand) takes to act.
const PACE_MS = 600, FAST_MS = 250;
// Deals tried for a chosen outcome before giving up on that hand.
const TRIES = 4000;
const SIM = ['win', 'lose', 'bust', 'play10'];
const GAME_BY_CARDS = {2: 'nlhe', 4: 'plo4', 5: 'plo5', 6: 'plo6'};
// Bots come and go (#415): the chance one gets up after a hand, and that a
// table short of its bots gets one back, each time they're checked (5 s).
const LEAVE_CHANCE = 0.03, COME_CHANCE = 0.25;

const num = v => Number(v) || 0;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
// A scenario's dice, so its bots are the same people every time it starts.
const seedOf = text => Math.floor(roll(0, 'demo', text) * 2 ** 31);

export function createDemoRelay({storage, identity, ready, think = null, churn = {leave: LEAVE_CHANCE, come: COME_CHANCE}}) {
  const rooms = new Map(); // code → room (see roomFor)
  const listeners = new Set();
  const changed = () => { for (const f of listeners) try { f(); } catch (e) { console.warn(e); } };
  let wasm = null;
  const wasmReady = () => (wasm ||= Promise.resolve(ready()));
  think ||= thinker(wasmReady);
  let thinkWarned = false;
  // The Regulars' names (id → name), from the engine.
  let regulars = null;
  const regularNames = async () => (regulars ||= new Map(((await wasmReady()).botPersonalities?.() || []).map(p => [p.id, p.name])));

  function roomFor(code) {
    let room = rooms.get(code);
    if (!room) {
      const key = k => `${code}|${k}`;
      room = {
        code,
        store: {get: k => storage.get(key(k)), put: (k, v) => storage.put(key(k), v), delete: k => storage.delete(key(k))},
        conns: new Map(), // member id → {h, deliver}: the people connected in this page
        server: null, // the club server (club-room.js openClub), once open
        chain: Promise.resolve(),
        bots: new Map(), // member id → bot
        pubs: {}, // members' session keys, to read their table updates (see peek)
        aes: new Map(),
        hostKP: null,
        seqs: {}, // the last seq seen from each person, to sign after it
        plans: new Map(), // member id → {kind, left, hand, opp, tries}
        rigged: new Set(), // `${member}|${hand}`: hands whose deal was chosen here
        seen: new Map(), // member id → {table, view}: their last table update
        targets: {}, // table id → how many bots it keeps (they come and go)
        agents: new Map(), // agent id → identity: agents who back bots (#428)
      };
      rooms.set(code, room);
    }
    return room;
  }

  // One thing at a time per room, as the relays do.
  function inRoom(room, fn) {
    const p = room.chain.then(fn);
    room.chain = p.catch(e => console.warn('demo relay:', e));
    return p;
  }

  async function serverOf(room) {
    if (room.server) return room.server;
    if (!(await room.store.get('club'))) return null;
    room.server ||= open(room).catch(e => { room.server = null; throw e; });
    return room.server;
  }

  async function open(room) {
    const w = await wasmReady();
    let record = (await room.store.get('demoRecord')) || DEMO_RECORD();
    Object.assign(room.pubs, (await room.store.get('memberPubs')) || {});
    for (const b of (await room.store.get('demoBots')) || []) {
      room.bots.set(b.id, newBot(b, await importIdentity(b.identity), false));
      room.pubs[b.id] = b.pub;
    }
    Object.assign(room.targets, (await room.store.get('demoTargets')) || {});
    for (const a of (await room.store.get('demoAgents')) || []) room.agents.set(a.id, await importIdentity(a.identity));
    room.hostKP = await keyPairFromJSON(await room.store.get('hostKey'));
    const server = await openClub({
      storage: room.store,
      send: (to, data) => deliver(room, to, data),
      online: [...room.conns.keys()],
      ClubTable: riggable(w, room),
      record,
      // A backup proved (#395): the demo club isn't temporary any more.
      onProved: async () => {
        record = {...record, temporary: false, provedAt: Date.now()};
        await room.store.put('demoRecord', record);
        return record;
      },
      onDeleted: () => { room.server = null; },
    });
    // Bots follow the people at their tables (see syncBots), checked now and then.
    room.timer ||= setInterval(() => inRoom(room, () => syncBots(room)), 5000);
    room.timer.unref?.(); // (in Node, the tests)
    return server;
  }

  // ---- connections ----

  function connect(code, role, id, h) {
    let closed = false;
    if (role !== 'guest') {
      setTimeout(() => h.onFail('That isn’t part of the demo.'));
      return {send() {}, close() {}, healthy: () => false};
    }
    const room = roomFor(code);
    const conn = {h, deliver: Promise.resolve()};
    inRoom(room, async () => {
      if (closed) return;
      room.conns.set(id, conn);
      h.onStatus('');
      h.onOpen();
      const server = await serverOf(room);
      if (!server) return;
      await server.message({from: id, event: 'open'});
      await syncBots(room);
    });
    return {
      send(obj) { if (!closed) inRoom(room, () => incoming(room, id, obj)); },
      close() {
        if (closed) return;
        closed = true;
        inRoom(room, async () => {
          if (room.conns.get(id) !== conn) return;
          room.conns.delete(id);
          const server = await serverOf(room);
          if (!server) return;
          await server.message({from: id, event: 'close'});
          await syncBots(room);
        });
      },
      healthy: () => !closed,
    };
  }

  // A message from a person in this page: to the club, or a request to make
  // the room one (as dev-server.mjs takes it).
  async function incoming(room, id, msg) {
    if (!msg || msg.type === 'ping') return;
    if (msg.from === id && Number.isSafeInteger(msg.seq)) room.seqs[id] = Math.max(room.seqs[id] || 0, msg.seq);
    if (msg.from === id && typeof msg.body?.key === 'string') room.pubs[id] = msg.body.key;
    const server = await serverOf(room);
    if (server) {
      await server.message({from: id, data: msg});
      if (msg.body?.type === 'table') await syncBots(room);
      return;
    }
    if (msg.body?.type !== 'create_club') return;
    try {
      if (msg.from !== id) throw new Error('The request must come from you.');
      const made = await createClub(room.store, msg, room.code);
      await room.store.put('demoRecord', DEMO_RECORD());
      await storage.put('demoClub', room.code);
      send(room, id, {type: 'club_created', ...made});
      await serverOf(room);
    } catch (e) {
      send(room, id, {type: 'club_error', reason: e.message});
    }
  }

  // To a person connected in this page, in order, as a copy (as off the wire).
  function send(room, to, data) {
    const conn = room.conns.get(to);
    if (!conn) return;
    conn.deliver = conn.deliver.then(() => {
      if (room.conns.get(to) === conn) conn.h.onMessage(JSON.parse(JSON.stringify(data)));
    }).catch(e => console.warn('demo relay:', e));
  }

  // What the club sends: a bot's goes to the bot; a person's goes to their
  // page, except a fair-deal result for a hand whose deal was chosen here,
  // which would only say the deal wasn't fair (#136).
  function deliver(room, to, data) {
    const bot = room.bots.get(to);
    if (bot) { bot.inbox = bot.inbox.then(() => botReceive(room, bot, data)).catch(e => console.warn('demo bot:', e)); return; }
    const conn = room.conns.get(to);
    if (!conn) return;
    // Their chips moved (sitting down, leaving): bots follow at once.
    if (data?.body?.type === 'account') inRoom(room, () => syncBots(room));
    if (data?.type !== 'table' || !data.enc) { send(room, to, data); return; }
    conn.deliver = conn.deliver.then(async () => {
      const u = await peek(room, to, data);
      if (u?.type === 'fair' && u.step === 'result' && room.rigged.has(`${to}|${num(u.hand)}`)) return;
      if (u?.type === 'state') personState(room, to, data.table, u);
      if (room.conns.get(to) === conn) conn.h.onMessage(JSON.parse(JSON.stringify(data)));
    }).catch(e => console.warn('demo relay:', e));
  }

  // A table update for member `id`, read with the club's side of their key
  // (the room holds it, as an always-on club's room does).
  async function peek(room, id, msg) {
    for (let fresh = 0; fresh < 2; fresh++) {
      const pub = room.pubs[id];
      const server = await room.server;
      if (pub && server && room.hostKP) {
        let k = room.aes.get(id);
        if (k?.pub !== pub) {
          const club = server.club;
          k = {pub, key: await sharedKey(room.hostKP, pub, {context: `club:${club.code}`, hostId: club.hostId, playerId: id, hostPub: room.hostKP.pub, playerPub: pub})};
          room.aes.set(id, k);
        }
        try { return await openBox(k.key, msg.enc); } catch {}
      }
      Object.assign(room.pubs, (await room.store.get('memberPubs')) || {});
    }
    return null;
  }

  // ---- bots ----

  // Bots are online while anyone in the demo has a page open, so its club
  // goes on around them (tables, tournaments); with no page, nothing runs.
  // They take their seats in a tournament once it's running.
  async function syncBots(room) {
    const server = await room.server;
    if (!server || !room.bots.size) return;
    const club = server.club;
    const want = [...room.conns.keys()].some(id => !room.bots.has(id));
    const running = (club.tourneys || []).filter(t => t.status === 'running');
    for (const bot of room.bots.values()) {
      if (want && !bot.online) {
        bot.online = true;
        bot.tourneys.clear();
        await server.message({from: bot.id, event: 'open'});
        const seat = club.members[bot.id]?.seat;
        if (seat) await botSends(room, bot, {type: 'table', table: seat.table, cmd: {type: 'join'}});
      } else if (!want && bot.online) {
        bot.online = false;
        await server.message({from: bot.id, event: 'close'});
      }
      if (!bot.online) continue;
      const playing = running.some(t => t.entries.some(e => e.member === bot.id && e.place == null));
      if (bot.home && !club.members[bot.id]?.seat && !playing) await sitHome(room, bot);
      for (const t of running) {
        if (bot.tourneys.has(t.id) || !t.entries.some(e => e.member === bot.id && e.place == null)) continue;
        bot.tourneys.add(t.id);
        await botSends(room, bot, {type: 'table', table: `tourney:${t.id}`, cmd: {type: 'join'}});
      }
    }
    if (want) await comeBack(room);
  }

  // A table short of the bots it keeps (one got up) now and then gets one:
  // a bot member who'd sit in that game and isn't playing, or a new one.
  async function comeBack(room) {
    const server = await room.server;
    const club = server.club;
    for (const [tid, keep] of Object.entries(room.targets)) {
      const t = tableById(club, tid);
      if (!t || t.status !== 'open' || Math.random() >= churn.come) continue;
      const bots = [...room.bots.values()];
      if (bots.filter(b => b.home === tid).length >= keep) continue;
      if (full(room, server, t)) continue;
      const busy = id => (club.tourneys || []).some(x => ['scheduled', 'running'].includes(x.status) && x.entries.some(e => e.member === id && e.place == null));
      const idle = bots.filter(b => b.online && !b.home && b.quest && fits(b.quest, stakesOf(t)) && club.members[b.id]?.status === 'member' && !club.members[b.id].seat && !busy(b.id) && canBuyIn(club, b, t));
      if (!idle.length) { await addBot(room, t); changed(); continue; }
      const bot = idle[Math.floor(Math.random() * idle.length)];
      bot.home = tid;
      await saveBot(room, bot);
      await sitHome(room, bot);
      changed();
    }
  }

  // Whether table `t` has no seat for another bot: one is kept for a person
  // until someone who isn't a bot sits there.
  const full = (room, server, t) => {
    const people = Object.values(server.club.members).some(m => m.seat?.table === t.id && !room.bots.has(m.id));
    return (server.seatedCounts()[t.id] || 0) >= t.seats - (people ? 0 : 1);
  };

  // A bot that has a table of its own (a demo club's start) but isn't at it
  // (the table started again without it) sits down there again.
  async function sitHome(room, bot) {
    const server = await room.server;
    const t = bot.home && tableById(server.club, bot.home);
    if (!t || t.status !== 'open' || server.club.members[bot.id]?.status !== 'member') return;
    if (full(room, server, t)) return;
    if (!canBuyIn(server.club, bot, t)) { bot.home = null; await saveBot(room, bot); return; }
    const {max} = tableLimits(t);
    if (!(await refill(room, bot.id, max))) { bot.home = null; await saveBot(room, bot); return; }
    await botSends(room, bot, {type: 'table', table: t.id, cmd: {type: 'join'}});
    await botSends(room, bot, {type: 'table', table: t.id, cmd: {type: 'request_chips', amount: max}});
  }

  // A bot short of a buy-in of `max` gets more chips: from its agent (#428)
  // when it plays under one, within their credit; otherwise from the
  // manager. False if its agent can't.
  async function refill(room, id, max) {
    const server = await room.server;
    const m = server.club.members[id];
    if (num(m?.balance) >= max) return true;
    const agent = m?.agentOf && room.agents.get(m.agentOf);
    if (!agent) { await server.run('give', {id, amount: max * 5, note: 'Demo bot'}); return true; }
    try { await agentGives(server, agent, id, max - num(m.balance)); return true; } catch { return false; }
  }

  async function botSends(room, bot, body) {
    const server = await room.server;
    await server.message({from: bot.id, data: await signMessage(bot.ident, {club: server.club.code, ...body})});
  }

  // A bot as this relay keeps it, from its saved record: `quest` is the
  // Quest player it is (demo-bots.js) and `seed` its bot's dice.
  const newBot = (b, ident, online) => ({id: b.id, name: b.name, quest: b.quest || null, seed: b.seed || 1, ident, fair: fairPlayer(), online, inbox: Promise.resolve(), asked: 0, tourneys: new Set(), home: b.home || null, hand: 0});

  // A bot's table of its own, kept for the next time the demo opens.
  async function saveBot(room, bot) {
    const saved = (await room.store.get('demoBots')) || [];
    const b = saved.find(x => x.id === bot.id);
    if (b) b.home = bot.home;
    await room.store.put('demoBots', saved);
  }

  // A bot asks to join with the club's invite and, unless it's left asking
  // (`pending`), is let in and given `balance` chips; at table `t` it buys
  // in for the table's maximum (given too). All through the club. A bot
  // added while someone sits at its table (`online`) is there at once;
  // otherwise it comes online with the people (syncBots). It's one of
  // Quest's players who'd sit at `t` (or the club's smallest game), picked
  // with `r` (Math.random, or a scenario's dice).
  async function addBot(room, t, {balance = null, pending = false, online = true, r = Math.random, agent = null} = {}) {
    const server = await room.server;
    const club = server.club;
    const ident = await createIdentity();
    const keys = await newKeyPair({keep: true});
    const saved = (await room.store.get('demoBots')) || [];
    const names = await regularNames();
    const taken = new Set([...saved.map(b => b.quest), ...Object.values(club.members).map(m => m.name)]);
    const stakes = stakesOf(t || [...club.tables || []].sort((a, b) => a.bb - b.bb)[0]);
    const quest = pickPlayer(stakes, r, taken, names) || pickPlayer(stakes, r, new Set(), names);
    const name = playerName(quest, names);
    const rec = {id: ident.id, name, quest, seed: Math.floor(r('seed') * 2 ** 31) + 1, identity: await exportIdentity(ident), pub: keys.pub, keys: await keyPairToJSON(keys), home: t?.id || null};
    saved.push(rec);
    await room.store.put('demoBots', saved);
    const bot = newBot(rec, ident, online);
    room.bots.set(bot.id, bot);
    room.pubs[bot.id] = keys.pub;
    if (online) await server.message({from: bot.id, event: 'open'});
    await botSends(room, bot, {type: 'join', invite: club.invite, name, key: keys.pub});
    if (pending) return bot;
    await server.run('approve', {id: bot.id});
    const max = t ? tableLimits(t).max : 0;
    const amount = (balance ?? max * 4) + max;
    // Under an agent (#428): their player, given their chips by the agent.
    if (agent) {
      await server.run('assign_agent', {id: bot.id, agent: agent.id});
      if (amount > 0) await agentGives(server, agent, bot.id, amount);
    } else if (amount > 0) await server.run('give', {id: bot.id, amount, note: 'Demo bot'});
    if (!t) return bot;
    await botSends(room, bot, {type: 'table', table: t.id, cmd: {type: 'join'}});
    await botSends(room, bot, {type: 'table', table: t.id, cmd: {type: 'request_chips', amount: max}});
    return bot;
  }

  // Agent `agent` (an identity) gives their player `id` chips, as the
  // agent's own page would (signed agent_cmd); throws if the club refused.
  async function agentGives(server, agent, id, amount) {
    const before = num(server.club.members[id]?.balance);
    // After the agent's own last message from their page (as personState signs).
    const room = rooms.get(server.club.code);
    agent.seq = Math.max(agent.seq, room?.seqs[agent.id] || 0);
    await server.message({from: agent.id, data: await signMessage(agent, {club: server.club.code, type: 'agent_cmd', cmd: {op: 'give', id, amount}})});
    if (num(server.club.members[id]?.balance) !== before + amount) throw new Error(`A demo agent couldn’t give ${server.club.members[id]?.name} ${amount}.`);
  }

  async function botReceive(room, bot, data) {
    if (data?.type !== 'table' || !data.enc) return;
    const u = await peek(room, bot.id, data);
    if (!u) return;
    const tid = data.table;
    if (u.type === 'fair') {
      bot.fair.message(u, cmd => inRoom(room, () => botSends(room, bot, {type: 'table', table: tid, cmd})), {});
      return;
    }
    // Too soon for a tournament's table (it was still starting): try again.
    if (u.type === 'rejected' && tid.startsWith('tourney:')) { bot.tourneys.delete(tid.slice(8)); return; }
    if (u.type !== 'state') return;
    bot.view = u;
    const v = u.view, me = v.seats[0];
    const hand = num(v.hand_number);
    if (v.complete && hand && hand !== bot.hand) {
      bot.hand = hand;
      afterHand(room, bot, tid, v);
    }
    // Out of chips between hands: more from its club balance (topped up first).
    if (v.complete && !num(me.stack) && Date.now() - bot.asked > 10_000) {
      bot.asked = Date.now();
      inRoom(room, async () => {
        const server = await room.server;
        const t = tableById(server.club, tid);
        if (!t) return;
        // Its chips just haven't reached this view yet.
        if (num(server.club.members[bot.id]?.seat?.stack)) return;
        const {max} = tableLimits(t);
        // It can't buy in here yet (the rathole rule), or its agent can't
        // back it (#428): it gets up instead.
        if (!canBuyIn(server.club, bot, t) || !(await refill(room, bot.id, max))) { await getUp(room, bot, tid); return; }
        await botSends(room, bot, {type: 'table', table: tid, cmd: {type: 'request_chips', amount: max}});
      });
    }
    if (v.legal && !v.complete) later(room, bot.id, tid, u, cmd => botSends(room, bot, {type: 'table', table: tid, cmd}));
  }

  // After a hand a bot played (#415): a word in the lobby after a big pot,
  // and now and then it gets up and goes (cashing out as anyone does), so a
  // seat opens; comeBack fills it again later. Not while someone's
  // simulating at its table, nor in a tournament.
  function afterHand(room, bot, tid, v) {
    const me = v.seats[0];
    const line = bot.quest && me.cards && chatLine(bot.quest, num(me.net), num(v.big_blind));
    if (line) inRoom(room, () => botSends(room, bot, {type: 'lobby_say', text: line}));
    if (bot.home !== tid || !room.targets[tid] || Math.random() >= churn.leave) return;
    // The game goes on: two bots stay, and no one gets up while someone simulates.
    if ([...room.plans.values()].some(p => p.table === tid)) return;
    if ([...room.bots.values()].filter(b => b.home === tid).length < 3) return;
    inRoom(room, () => getUp(room, bot, tid));
  }

  async function getUp(room, bot, tid) {
    if (bot.home === tid) bot.home = null;
    await saveBot(room, bot);
    await botSends(room, bot, {type: 'table', table: tid, cmd: {type: 'leave'}});
    changed();
  }

  // Whether `bot` can buy in at `t`: someone who left it with more than its
  // maximum can't, until the rathole rule's window has passed.
  const canBuyIn = (club, bot, t) => ratholeMin(club, bot.id, t.id) <= tableLimits(t).max;

  // Acts for `who` after a moment, if the turn is still theirs then. A bot
  // thinks meanwhile (in a worker), so the room goes on.
  function later(room, who, tid, u, sendCmd) {
    const plan = planAt(room, tid, u.view);
    const pace = plan?.kind === 'play10' ? FAST_MS : PACE_MS;
    const start = Date.now();
    decide(room, who, tid, u.view).catch(e => { console.warn('demo bot:', e); return null; }).then(a => {
      setTimeout(() => inRoom(room, async () => {
        const last = room.bots.get(who)?.view || room.seen.get(who)?.u;
        if (last?.seq !== u.seq || !a) return;
        await sendCmd({type: 'act', seq: u.seq, ...a});
      }), Math.max(0, pace - (Date.now() - start)));
    });
  }

  // ---- simulating (the person in this page) ----

  // The plan being played in this hand at table `tid`, with whose it is.
  function planAt(room, tid, view) {
    for (const [id, p] of room.plans) {
      if (p.table === tid && (p.kind === 'play10' || p.hand === num(view.hand_number))) return {...p, target: id};
    }
    return null;
  }

  // A table update for a person in this page: in a simulated hand, they act
  // through it (signed as them); a finished hand moves the plan on.
  function personState(room, id, tid, u) {
    room.seen.set(id, {table: tid, u});
    const plan = room.plans.get(id);
    if (!plan) return;
    const v = u.view, hand = num(v.hand_number);
    if (v.complete && hand && hand !== plan.counted && (plan.kind === 'play10' ? !!v.seats[0].cards : hand === plan.hand)) {
      plan.counted = hand;
      // Out of chips, she's dealt no more hands: Play 10 hands ends there.
      if (plan.kind === 'play10') plan.left = num(v.seats[0].stack) > 0 ? plan.left - 1 : 0;
      else if (plan.kind === 'bust' && num(v.seats[0].stack) > 0 && ++plan.tries < 3) plan.hand = null;
      else plan.left = 0;
      if (plan.left <= 0) room.plans.delete(id);
      changed();
      return;
    }
    if (v.legal && !v.complete && (plan.kind === 'play10' || plan.hand === hand)) {
      later(room, id, tid, u, async cmd => {
        const server = await room.server;
        const me = await identity();
        me.seq = Math.max(me.seq, room.seqs[id] || 0);
        const env = await signMessage(me, {club: server.club.code, type: 'table', table: tid, cmd});
        room.seqs[id] = env.seq;
        await server.message({from: id, data: env});
      });
    }
  }

  // What `who` does now: in a hand whose outcome is chosen, the person and
  // the bot against them bet it in and the rest get out of the way;
  // otherwise a bot plays as its Quest player would (#415), and the person
  // (Play 10 hands) mostly checks and calls.
  async function decide(room, who, tid, v) {
    const L = v.legal;
    if (!L) return null;
    const passive = L.can_check ? {kind: 'check', amount: 0} : {kind: 'call', amount: 0};
    const range = L.raise || L.bet;
    // In whole chips of the table's (as the page's bet buttons are).
    const to = x => ({kind: L.raise ? 'raise' : 'bet', amount: toChip(Math.round(x), tableChip(num(v.small_blind)), num(range.min_to), num(range.max_to))});
    const pot = num(v.pot);
    const plan = planAt(room, tid, v);
    if (plan && plan.kind !== 'play10') {
      const role = who === plan.target ? 'target' : who === plan.opp ? 'opp' : 'other';
      if (role === 'other') return L.can_check ? passive : {kind: 'fold', amount: 0};
      if (plan.kind === 'bust') return role === 'target' && range ? to(num(range.max_to)) : passive;
      // The winner bets into the loser, who calls.
      const bettor = plan.kind === 'win' ? 'target' : 'opp';
      return role === bettor && L.bet ? to(pot * 0.75) : passive;
    }
    const bot = room.bots.get(who);
    if (!bot) {
      // Quest's players bet big: she lets a big bet go rather than call off her stack.
      if (!L.can_check && num(L.call) > num(v.seats[0].stack) / 3) return {kind: 'fold', amount: 0};
      return range && Math.random() < 0.2 ? to(num(v.current_bet) + pot / 2) : passive;
    }
    let m = null;
    if (bot.quest) {
      try {
        m = await think(bot.id, bot.quest, bot.seed, v);
      } catch (e) {
        if (!thinkWarned) console.warn('demo bots play by style:', e.message);
        thinkWarned = true;
      }
    }
    m ||= fallbackMove(bot.quest, v);
    // Kept legal, as the table would: in whole chips, within the range.
    if (m.kind === 'allin') return {kind: 'allin', amount: 0};
    if ((m.kind === 'bet' || m.kind === 'raise') && range) return to(num(m.amount));
    if (m.kind === 'fold' && !L.can_check) return {kind: 'fold', amount: 0};
    return passive;
  }

  // The demo club's tables: ducy's ClubTable, except that a table's next
  // hand is dealt from a seed picked here when someone at it has asked for
  // an outcome (Win this hand, Lose this hand, Bust). ducy's table runner
  // asks before every deal.
  function riggable(w, room) {
    const rig = (t, game) => { t.setSeedPicker(s => pick(s, game)); return t; };
    return {
      create: (id, c) => rig(w.ClubTable.create(id, c), c.game),
      restore: (id, json, c, now) => { const t = w.ClubTable.restore(id, json, c, now); return t && rig(t, c.game); },
    };

    function pick(s, game) {
      const players = s.players || [];
      // Who'll be dealt in, in seat order (as Deal::from_seed deals).
      const dealt = players.filter(p => { const x = s.state.seats[p.seat]; return x && !x.empty && !x.sitting_out && num(x.stack) > 0; })
        .sort((a, b) => a.seat - b.seat).map(p => p.client_id);
      const target = dealt.find(id => { const p = room.plans.get(id); return p && p.kind !== 'play10' && p.hand == null; });
      if (!target) return undefined;
      const plan = room.plans.get(target);
      // Against the bot with the most chips.
      const stack = id => num(s.state.seats[players.find(p => p.client_id === id).seat].stack);
      const opp = dealt.filter(id => room.bots.has(id)).sort((a, b) => stack(b) - stack(a))[0];
      const g = game || GAME_BY_CARDS[num(s.state.hole_cards)] || 'nlhe';
      const want = dealt.indexOf(plan.kind === 'win' ? target : opp);
      const chosen = opp ? pickSeed(g, dealt.length, want) : null;
      if (!chosen) return undefined;
      const hand = num(s.state.hand_number) + 1;
      plan.hand = hand;
      plan.opp = opp;
      for (const id of dealt) room.rigged.add(`${id}|${hand}`);
      changed();
      return chosen;
    }

    // A seed whose deal has player `want` (of n) alone winning at showdown.
    function pickSeed(game, n, want) {
      for (let i = 0; i < TRIES; i++) {
        const seed = hex(crypto.getRandomValues(new Uint8Array(32)));
        const d = w.fairDeal(game, n, seed);
        const g = game === 'nlhe' ? new w.HoldemGame() : new w.OmahaGame(num(game.slice(3)) || 4);
        try {
          for (const h of d.hole_cards) g.add_player(h.join(' '));
          g.set_flop(d.board.slice(0, 3).join(' '));
          g.set_turn(d.board[3]);
          g.set_river(d.board[4]);
          if (num(g.evaluate_equity()[want]) > 0.999) return seed;
        } finally {
          g.free();
        }
      }
      return null;
    }
  }

  // The room holding the demo's club.
  async function demoRoom() {
    const code = await storage.get('demoClub');
    return code ? roomFor(code) : null;
  }

  // The club table member `id` is at, or null.
  async function tableOf(room, id) {
    const server = room && await serverOf(room);
    const seat = server?.club.members[id]?.seat;
    return seat ? tableById(server.club, seat.table) : null;
  }

  return {
    connect,
    // Loads a scenario's starting club (demo-scenarios.js) when a demo
    // starts. A brand new club has none: the manager makes it. Scenarios
    // with a club already running are the next step (#406): the manager's
    // signed create_club, then their tables (new_table), players (bots as
    // addBot, people as their join), balances (give) and requests.
    // A brand new club has none (null): the manager makes it. Otherwise the
    // club is made for `owner` (the manager's identity) and filled through
    // the club itself, as people would: its tables, its bots, `people` (the
    // scenario's people, each with the identity made for them), their
    // requests, a tournament and a promotion. Resolves to {code, hostId,
    // invite, name}.
    async setUp(scenario, {owner, people = []} = {}) {
      const c = scenario?.club;
      if (!c) return null;
      const code = newCode();
      const room = roomFor(code);
      return inRoom(room, async () => {
        const made = await createClub(room.store, await signMessage(owner, {type: 'create_club', club: code, name: c.name}), code);
        await room.store.put('demoRecord', DEMO_RECORD());
        await storage.put('demoClub', code);
        const server = await serverOf(room);
        const as = async (ident, body) => server.message({from: ident.id, data: await signMessage(ident, {club: code, ...body})});
        const tables = [];
        for (const t of c.tables || []) tables.push(tableById(server.club, await server.run('new_table', {table: t})));
        const asks = [], helps = [], registers = [], botIds = [];
        // A person joins with the invite and is let in, given chips and any
        // credit; an agent (#428) accepts the role with their credit limit,
        // and a player under one is given chips by their agent.
        const join = async p => {
          await as(p.ident, {type: 'join', invite: made.invite, name: p.name, key: (await newKeyPair()).pub});
          if (p.status === 'pending') return;
          await server.run('approve', {id: p.ident.id});
          if (p.under != null) {
            await server.run('assign_agent', {id: p.ident.id, agent: people[p.under].ident.id});
            if (p.balance) await agentGives(server, people[p.under].ident, p.ident.id, p.balance);
          } else if (p.balance) await server.run('give', {id: p.ident.id, amount: p.balance});
          // An agent's credit limit is their member one (#445).
          const credit = p.agent || p.credit;
          if (credit) await server.run('set_credit', {id: p.ident.id, amount: credit});
          if (p.agent != null) {
            await server.run('offer_agent', {id: p.ident.id});
            await as(p.ident, {type: 'agent_reply', accept: true});
          }
          if (p.ask) asks.push([p.ident, p.ask]);
          if (p.register) registers.push(p.ident);
        };
        // Agents first: their players, bots among them, join under them. The
        // relay keeps their identities to back their bots later (refill).
        for (const p of people) {
          if (p.agent == null) continue;
          await join(p);
          room.agents.set(p.ident.id, p.ident);
        }
        if (room.agents.size) await room.store.put('demoAgents', await Promise.all([...room.agents].map(async ([id, ident]) => ({id, identity: await exportIdentity(ident)}))));
        // Its bots are Quest's players, the same ones every time it starts.
        const seed = seedOf(scenario.id);
        for (const [i, b] of (c.bots || []).entries()) {
          const t = tables[b.table] ?? null;
          const agent = b.under != null ? people[b.under].ident : null;
          const bot = await addBot(room, t, {balance: b.balance ?? 0, pending: b.status === 'pending', online: false, r: key => roll(seed, i, key), agent});
          botIds.push(bot.id);
          if (t) room.targets[t.id] = (room.targets[t.id] || 0) + 1;
          if (b.ask) asks.push([bot.ident, b.ask]);
          if (b.help) helps.push([bot.ident, b.help]);
          if (b.register) registers.push(bot.ident);
        }
        for (const p of people) if (p.agent == null) await join(p);
        // Table sessions played before the demo starts (a credit player who
        // stood up owing, #404): the ledger's own buy-in and cash-out, the
        // chips lost at one seat won at another.
        const idOf = x => (x.bot != null ? botIds[x.bot] : Object.values(server.club.members).find(m => m.name === x.name)?.id);
        for (const s of c.sessions || []) {
          const t = tables[s.table], at = Date.now() - (s.ago || 0);
          if (s.seats.reduce((n, x) => n + x.buyIn - x.cashOut, 0) !== 0) throw new Error('A demo session’s chips must add up.');
          for (const x of s.seats) buyIn(server.club, idOf(x), t.id, x.buyIn, tableLimits(t), at);
          for (const x of s.seats) { setStack(server.club, idOf(x), x.cashOut); cashOut(server.club, idOf(x), at + 1800e3); }
        }
        if (c.sessions?.length) await server.run('settings', {});
        for (const [ident, amount] of asks) await as(ident, {type: 'chip_request', amount});
        for (const [ident, text] of helps) await as(ident, {type: 'help_ask', text});
        if (c.tourney) {
          const {startsIn, ...t} = c.tourney;
          const now = Date.now();
          const tid = await server.run('new_tourney', {tourney: {...t, opensAt: now, startsAt: now + startsIn}});
          for (const ident of registers) await as(ident, {type: 'tourney', tourney: tid, op: 'register'});
        }
        if (c.promo) await server.run('new_promo', {promo: c.promo});
        await room.store.put('demoTargets', room.targets);
        await server.flush();
        return {code, hostId: made.hostId, invite: made.invite, name: c.name};
      });
    },
    async lookup(code, invite = '') {
      const club = await roomFor(code).store.get('club');
      return club ? codeInfo(club, invite) : {kind: 'game'};
    },
    async club() {
      const room = await demoRoom();
      if (!room) return null;
      return room.server ? (await room.server).club : (await room.store.get('club')) || null;
    },
    async fillSeats(id) {
      const room = await demoRoom();
      return inRoom(room, async () => {
        const t = await tableOf(room, id);
        if (!t) throw new Error('Sit at a table first.');
        const server = await room.server;
        const free = t.seats - (server.seatedCounts()[t.id] || 0);
        const bots = [...room.bots.keys()].filter(b => server.club.members[b]?.seat?.table === t.id).length;
        const n = Math.min(free, MAX_BOTS - bots);
        for (let i = 0; i < n; i++) await addBot(room, t);
        // The table keeps them as they come and go.
        room.targets[t.id] = Math.max(room.targets[t.id] || 0, bots + Math.max(0, n));
        await room.store.put('demoTargets', room.targets);
        changed();
      });
    },
    async simulate(id, what) {
      if (!SIM.includes(what)) throw new Error(`No ${what} here.`);
      const room = await demoRoom();
      const t = await tableOf(room, id);
      if (!t) throw new Error('Sit at a table first.');
      const server = await room.server;
      if (![...room.bots.keys()].some(b => server.club.members[b]?.seat?.table === t.id)) await this.fillSeats(id);
      room.plans.set(id, {kind: what, table: t.id, left: what === 'play10' ? 10 : 1, hand: null, tries: 0});
      changed();
    },
    async status(id) {
      const room = await demoRoom();
      const t = room && await tableOf(room, id);
      const plan = room?.plans.get(id);
      return {table: t ? {id: t.id, name: t.name} : null, plan: plan ? {kind: plan.kind, left: plan.left, dealt: plan.hand != null} : null};
    },
    // Each bot member and its Quest player, for their face at the table
    // (#415): [{id, name, quest}].
    async bots() {
      const room = await demoRoom();
      const saved = room ? (await room.store.get('demoBots')) || [] : [];
      return saved.filter(b => b.quest).map(({id, name, quest}) => ({id, name, quest}));
    },
    onChange(fn) { listeners.add(fn); },
    async flush() {
      for (const room of rooms.values()) {
        await room.chain;
        const server = await room.server;
        await server?.flush();
      }
    },
  };
}
