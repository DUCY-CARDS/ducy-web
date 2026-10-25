// The demo club's relay (#406): the club-room logic from relay/ (club-room.js,
// as the dev relay runs it) driven inside the page instead of over a
// WebSocket, so a demo uses no relay and leaves nothing on a server. Its
// storage is the demo's own (an IndexedDB database demo.js deletes when the
// demo ends).
//
// Only the demo has this file, and with it two things no real club has:
//   - demo bots: members this relay plays for, so one person can fill a table;
//   - Simulate: the next hand's outcome for the person playing (win, lose,
//     bust), or ten hands played for them. The table, ledger and cash-out are
//     the real ones (club-server.js, club-host.js); what's chosen here is only
//     the deal, through the engine this relay hands the club (riggable), and
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
//   relay.onChange(fn)        the status may have changed
//   relay.flush()             resolves once everything is saved
//
// storage: {get, put, delete}, async, for the whole demo; each room keeps its
// keys under `<code>|`, as club-room.js names them. `identity()` resolves to
// the identity of the person in this page (identity.js), to act for them in
// a simulated hand. `ready()` resolves to the initialised wasm module.

import { codeInfo, createClub, openClub } from '../relay/src/club-room.js';
import { createIdentity, exportIdentity, importIdentity, signMessage } from './identity.js';
import { keyPairFromJSON, keyPairToJSON, newKeyPair, open as openBox, sharedKey } from './e2e.js';
import { fairPlayer } from './fair-check.js';
import { limits as tableLimits, tableById } from './club-tables.js';
import { tableChip, toChip } from './chip-format.js';

// Not limited by plans (#406).
const LIMITS = {tables: 5, tourneysPerDay: 5};
const MAX_BOTS = 5;
// How long a bot (or the person, in a simulated hand) takes to act.
const PACE_MS = 600, FAST_MS = 250;
// Deals tried for a chosen outcome before giving up on that hand.
const TRIES = 4000;
const SIM = ['win', 'lose', 'bust', 'play10'];
const GAME_BY_CARDS = {2: 'nlhe', 4: 'plo4', 5: 'plo5', 6: 'plo6'};

const num = v => Number(v) || 0;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function createDemoRelay({storage, identity, ready}) {
  const rooms = new Map(); // code → room (see roomFor)
  const listeners = new Set();
  const changed = () => { for (const f of listeners) try { f(); } catch (e) { console.warn(e); } };
  let wasm = null;
  const wasmReady = () => (wasm ||= Promise.resolve(ready()));

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
    let record = (await room.store.get('demoRecord')) || {plan: 'club', limits: LIMITS, temporary: true, at: Date.now()};
    Object.assign(room.pubs, (await room.store.get('memberPubs')) || {});
    for (const b of (await room.store.get('demoBots')) || []) {
      room.bots.set(b.id, {id: b.id, name: b.name, ident: await importIdentity(b.identity), fair: fairPlayer(), online: false, inbox: Promise.resolve(), asked: 0});
      room.pubs[b.id] = b.pub;
    }
    room.hostKP = await keyPairFromJSON(await room.store.get('hostKey'));
    const server = await openClub({
      storage: room.store,
      send: (to, data) => deliver(room, to, data),
      online: [...room.conns.keys()],
      MultiTable: riggable(w, room),
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
      await room.store.put('demoRecord', {plan: 'club', limits: LIMITS, temporary: true, at: Date.now()});
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

  // Bots are online while a person in this page sits at a table, so a
  // table doesn't play on by itself while the demo looks elsewhere.
  async function syncBots(room) {
    const server = await room.server;
    if (!server || !room.bots.size) return;
    const club = server.club;
    const want = [...room.conns.keys()].some(id => !room.bots.has(id) && club.members[id]?.seat);
    for (const bot of room.bots.values()) {
      if (want && !bot.online) {
        bot.online = true;
        await server.message({from: bot.id, event: 'open'});
        const seat = club.members[bot.id]?.seat;
        if (seat) await botSends(room, bot, {type: 'table', table: seat.table, cmd: {type: 'join'}});
      } else if (!want && bot.online) {
        bot.online = false;
        await server.message({from: bot.id, event: 'close'});
      }
    }
  }

  async function botSends(room, bot, body) {
    const server = await room.server;
    await server.message({from: bot.id, data: await signMessage(bot.ident, {club: server.club.code, ...body})});
  }

  // A bot asks to join with the club's invite, is let in, given chips and
  // sat at table `t` with its maximum buy-in, all through the club.
  async function addBot(room, t) {
    const server = await room.server;
    const club = server.club;
    const ident = await createIdentity();
    const keys = await newKeyPair({keep: true});
    const saved = (await room.store.get('demoBots')) || [];
    const name = `Bot ${saved.length + 1}`;
    saved.push({id: ident.id, name, identity: await exportIdentity(ident), pub: keys.pub, keys: await keyPairToJSON(keys)});
    await room.store.put('demoBots', saved);
    const bot = {id: ident.id, name, ident, fair: fairPlayer(), online: true, inbox: Promise.resolve(), asked: 0};
    room.bots.set(bot.id, bot);
    room.pubs[bot.id] = keys.pub;
    await server.message({from: bot.id, event: 'open'});
    await botSends(room, bot, {type: 'join', invite: club.invite, name, key: keys.pub});
    await server.run('approve', {id: bot.id});
    const {max} = tableLimits(t);
    await server.run('give', {id: bot.id, amount: max * 5, note: 'Demo bot'});
    await botSends(room, bot, {type: 'table', table: t.id, cmd: {type: 'join'}});
    await botSends(room, bot, {type: 'table', table: t.id, cmd: {type: 'request_chips', amount: max}});
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
    if (u.type !== 'state') return;
    bot.view = u;
    const v = u.view, me = v.seats[0];
    // Out of chips between hands: more from its club balance (topped up first).
    if (v.complete && !num(me.stack) && Date.now() - bot.asked > 10_000) {
      bot.asked = Date.now();
      inRoom(room, async () => {
        const server = await room.server;
        const t = tableById(server.club, tid);
        if (!t) return;
        const {max} = tableLimits(t);
        if (num(server.club.members[bot.id]?.balance) < max) await server.run('give', {id: bot.id, amount: max * 5, note: 'Demo bot'});
        await botSends(room, bot, {type: 'table', table: tid, cmd: {type: 'request_chips', amount: max}});
      });
    }
    if (v.legal && !v.complete) later(room, bot.id, tid, u, cmd => botSends(room, bot, {type: 'table', table: tid, cmd}));
  }

  // Acts for `who` after a moment, if the turn is still theirs then.
  function later(room, who, tid, u, sendCmd) {
    const plan = planAt(room, tid, u.view);
    setTimeout(() => inRoom(room, async () => {
      const last = room.bots.get(who)?.view || room.seen.get(who)?.u;
      if (last?.seq !== u.seq) return;
      const a = decide(room, who, tid, u.view);
      if (a) await sendCmd({type: 'act', seq: u.seq, ...a});
    }), plan?.kind === 'play10' ? FAST_MS : PACE_MS);
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
      if (plan.kind === 'play10') plan.left--;
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
  // otherwise bots mostly check and call, now and then betting or folding.
  function decide(room, who, tid, v) {
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
    if (!room.bots.has(who)) return range && Math.random() < 0.2 ? to(num(v.current_bet) + pot / 2) : passive;
    const r = Math.random();
    if (range && r < 0.15) return to(num(v.current_bet) + pot * 0.6);
    if (!L.can_check && (r > 0.9 || (num(L.call) > num(v.seats[0].stack) / 2 && r > 0.5))) return {kind: 'fold', amount: 0};
    return passive;
  }

  // The engine for the demo's club: ducy's MultiTable, except that a table's
  // next hand is dealt from a seed picked here when someone at it has asked
  // for an outcome (Win this hand, Lose this hand, Bust).
  function riggable(w, room) {
    const wrap = (t, game) => new Proxy(t, {
      get(target, prop) {
        if (prop === 'newHand') return (now, seed) => dealChosen(target, game, now, seed);
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const M = {club: (...a) => wrap(w.MultiTable.club(...a), a[6])};
    if (w.MultiTable.restore) M.restore = (json, now) => wrap(w.MultiTable.restore(json, now), null);
    return M;

    function dealChosen(t, game, now, seed) {
      const s = t.state(now);
      const players = s.players || [];
      // Who'll be dealt in, in seat order (as Deal::from_seed deals).
      const dealt = players.filter(p => { const x = s.state.seats[p.seat]; return x && !x.empty && !x.sitting_out && num(x.stack) > 0; })
        .sort((a, b) => a.seat - b.seat).map(p => p.client_id);
      const target = dealt.find(id => { const p = room.plans.get(id); return p && p.kind !== 'play10' && p.hand == null; });
      if (!target) return t.newHand(now, seed);
      const plan = room.plans.get(target);
      // Against the bot with the most chips.
      const stack = id => num(s.state.seats[players.find(p => p.client_id === id).seat].stack);
      const opp = dealt.filter(id => room.bots.has(id)).sort((a, b) => stack(b) - stack(a))[0];
      const g = game || GAME_BY_CARDS[num(s.state.hole_cards)] || 'nlhe';
      const want = dealt.indexOf(plan.kind === 'win' ? target : opp);
      const chosen = opp ? pickSeed(g, dealt.length, want) : null;
      if (!chosen) return t.newHand(now, seed);
      const res = t.newHand(now, chosen);
      const hand = num(res.state?.hand_number);
      plan.hand = hand;
      plan.opp = opp;
      for (const id of dealt) room.rigged.add(`${id}|${hand}`);
      changed();
      return res;
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
    async setUp(scenario) {
      if (!scenario?.club) return;
      throw new Error(`The ${scenario.name} demo isn’t ready yet.`);
    },
    async lookup(code) {
      const club = await roomFor(code).store.get('club');
      return club ? codeInfo(club) : {kind: 'game'};
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
        for (let i = 0; i < Math.min(free, MAX_BOTS - bots); i++) await addBot(room, t);
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
