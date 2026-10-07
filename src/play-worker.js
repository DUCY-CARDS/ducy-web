// Runs the bot table (ducy-wasm's BotTable) off the main thread, so the page
// stays responsive while a bot thinks; Omaha decisions can take a second or
// two. Protocol: each request {id, op, args} gets {id, result} or {id, error}.
//   ops: personalities | create(bots, buyIn, sb, bb, seed, game) |
//        newHand(reset) | advance | act(kind, amount) | loadGto(manifestUrl) |
//        review
// Every table op returns {state, botToAct}. newHand(true) puts every stack
// back to the buy-in first (GTO training plays every hand at 100 BB).
// review returns the last finished hand's review against the GTO bot (see
// play-review.js), or null.
// Hosting a table for friends uses MultiTable (ops starting with "host"):
//   hostFriends(seats, name, hostChips, minBuyIn, maxBuyIn, sb, bb, seed,
//     game, turnMs) | hostNewHand | hostAdvance | hostAct(kind, amount) |
//   hostHandle(client, msg) | hostDisconnected(client) | hostTick |
//   hostApprove(seat) | hostDeny(seat) | hostChips(amount) | hostRemove(seat)
// Those return {seq, state, botToAct, turnMsLeft, openSeats, playersIn,
// chipRequests, buyIn, hostPendingChips, out}, where out lists {to, data}
// messages for the page to relay to each player.
// A club's tables (clubs.js) are MultiTable.club instances kept by id:
//   clubCreate(id, seats, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs) |
//   clubCall(id, method, ...args) for handle, disconnected, newHand,
//     advance, tick, approveChips, denyChips, remove, state (the time is
//     added) | clubDrop(id)
// clubCall results also carry `players` and `departed`.
import init, { BotTable, MultiTable, botPersonalities, loadGto } from '../wasm/ducy_wasm.js';

const ready = init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)});
let table = null;
let host = null;

const snapshot = state => ({state, botToAct: table.botToAct()});

// The GTO bot's files are big (a few MB), so they're kept in Cache Storage:
// downloaded once, then read from disk on later visits. Each model lives in
// its own folder, so a cached file never goes stale.
const GTO_CACHE = 'ducy-gto';
let gtoLoaded = '';

async function cachedBytes(url) {
  let cache = null;
  try { cache = await caches.open(GTO_CACHE); } catch {}
  let res = cache && await cache.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    if (cache) { try { await cache.put(url, res.clone()); } catch {} }
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Loads the model named by the manifest ({dir, cards, blueprint}), once.
async function loadGtoModel(manifestUrl) {
  const res = await fetch(manifestUrl, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`no GTO bot here (${res.status})`);
  const m = await res.json();
  const base = new URL(`${m.dir}/`, manifestUrl);
  if (gtoLoaded === base.href) return true;
  const [cards, blueprint] = await Promise.all([
    cachedBytes(new URL(m.cards, base).href),
    cachedBytes(new URL(m.blueprint, base).href),
  ]);
  loadGto(cards, blueprint);
  gtoLoaded = base.href;
  // Drop older models from the cache.
  try {
    const cache = await caches.open(GTO_CACHE);
    for (const req of await cache.keys()) if (!req.url.startsWith(base.href)) await cache.delete(req);
  } catch {}
  return true;
}

const ops = {
  personalities: () => botPersonalities(),
  create: (bots, buyIn, sb, bb, seed, game) => {
    table = new BotTable(bots, BigInt(buyIn), BigInt(sb), BigInt(bb), BigInt(seed), game);
    return snapshot(table.newHand());
  },
  // resetStacks and reviewLastHand came with ducy's hand review; with an
  // older ducy-wasm, stacks carry over and there's no review.
  newHand: reset => {
    if (reset && table.resetStacks) table.resetStacks();
    return snapshot(table.newHand());
  },
  review: () => (table.reviewLastHand ? table.reviewLastHand() : null),
  advance: () => snapshot(table.advance()),
  act: (kind, amount) => snapshot(table.act(kind, BigInt(amount))),
  loadGto: manifestUrl => loadGtoModel(manifestUrl),
  hostCreate: (bots, open, name, buyIn, sb, bb, seed, game, turnMs) => {
    host = new MultiTable(bots, Uint8Array.from(open, o => (o ? 1 : 0)), name, BigInt(buyIn), BigInt(sb), BigInt(bb), BigInt(seed), game, BigInt(turnMs));
    return host.state(now('host')); // deal once the players are in
  },
  // Friends: empty seats people take as they join, and real chips the host
  // hands out on request.
  hostFriends: (seats, name, hostChips, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs) => {
    clocks.delete('host');
    host = MultiTable.friends(seats, name, BigInt(hostChips), BigInt(minBuyIn), BigInt(maxBuyIn), BigInt(sb), BigInt(bb), BigInt(seed), game, BigInt(turnMs));
    return host.state(now('host'));
  },
  hostApprove: seat => host.approveChips(seat, now('host')),
  hostDeny: seat => host.denyChips(seat, now('host')),
  hostChips: amount => host.hostChips(BigInt(amount), now('host')),
  hostRemove: seat => host.remove(seat, now('host')),
  hostNewHand: () => host.newHand(now('host')),
  hostAdvance: () => host.advance(now('host')),
  hostAct: (kind, amount) => host.act(kind, BigInt(amount), now('host')),
  hostHandle: (client, msg) => host.handle(client, msg, now('host')),
  hostDisconnected: client => host.disconnected(client, now('host')),
  hostTick: () => host.tick(now('host')),
  clubCreate: (id, seats, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs) => {
    clubTables.get(id)?.free();
    const t = MultiTable.club(seats, BigInt(minBuyIn), BigInt(maxBuyIn), BigInt(sb), BigInt(bb), BigInt(seed), game, BigInt(turnMs));
    clubTables.set(id, t);
    return t.state(now(id));
  },
  clubCall: (id, method, ...args) => {
    const t = clubTables.get(id);
    if (!t || !CLUB_METHODS.has(method)) throw new Error(`no table ${id} or method ${method}`);
    return t[method](...args, now(id));
  },
  clubDrop: id => { clubTables.get(id)?.free(); clocks.delete(id); return clubTables.delete(id); },
  // How long someone may sit out at table id before their seat goes (ms; 0: no limit).
  clubSitOutLimit: (id, ms) => { clubTables.get(id)?.setSitOutLimit(ms); return true; },
  // Stops (on) or restarts a table's clock: 'host' for the friends table,
  // else a club table's id. While stopped no time passes for it, so no turn
  // runs out and no sit-out expires; it resumes with the time that was left.
  clockPause: (key, on) => {
    const c = clocks.get(key) || {at: null, lost: 0};
    if (on && c.at == null) c.at = Date.now();
    if (!on && c.at != null) { c.lost += Date.now() - c.at; c.at = null; }
    clocks.set(key, c);
    return true;
  },
};

const clubTables = new Map();

// The time each table's engine sees: real time, minus the time its clock was
// stopped (clockPause) because the host couldn't reach anyone.
const clocks = new Map();
function now(key) {
  const c = clocks.get(key);
  return c ? (c.at ?? Date.now()) - c.lost : Date.now();
}
const CLUB_METHODS = new Set(['handle', 'disconnected', 'newHand', 'advance', 'tick', 'approveChips', 'denyChips', 'remove', 'state']);

self.onmessage = async e => {
  const {id, op, args = []} = e.data;
  await ready;
  try {
    postMessage({id, result: await ops[op](...args)});
  } catch (err) {
    postMessage({id, error: String(err && err.message || err)});
  }
};
