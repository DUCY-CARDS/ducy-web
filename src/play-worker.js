// Runs the bot table (ducy-wasm's BotTable) off the main thread, so the page
// stays responsive while a bot thinks; Omaha decisions can take a second or
// two. Protocol: each request {id, op, args} gets {id, result} or {id, error}.
//   ops: personalities | create(bots, buyIn, sb, bb, seed, game, stacks) |
//        newHand(reset) | advance | act(kind, amount) | runTwice(yes) |
//        state | setStack(seat, chips) | setBot(seat, id, chips, seed) |
//        setTopUp(on) |
//        loadGto(manifestUrl) | gtoPloSupported | loadGtoPlo(manifestUrl, bb) |
//        gtoPlo6Supported | loadGtoPlo6(manifestUrl, bb) | review |
//        reviewDecision | setReviewAll(on) | reviewNew
// Every table op returns {state, botToAct}. newHand(true) puts every stack
// back to the buy-in first (GTO training plays every hand at 100 BB).
// review returns the last finished hand's review against the GTO bot (see
// play-review.js), or null.
// Hosting a table for friends uses MultiTable (ops starting with "host"):
//   hostFriends(seats, name, hostChips, minBuyIn, maxBuyIn, sb, bb, seed,
//     game, turnMs) | hostNewHand | hostAdvance | hostAct(kind, amount) |
//   hostRunTwice(yes) |
//   hostHandle(client, msg) | hostDisconnected(client) | hostTick |
//   hostApprove(seat) | hostDeny(seat) | hostChips(amount) | hostRemove(seat)
// Those return {seq, state, botToAct, turnMsLeft, openSeats, playersIn,
// chipRequests, buyIn, hostPendingChips, out}, where out lists {to, data}
// messages for the page to relay to each player.
// A club's tables (club-host.js) use the ops in club-engine.js (clubCreate,
// clubCall, clubSave, clubRestore, ...), the same code an always-on club
// runs in the relay's Worker.
import init, * as wasm from '../wasm/ducy_wasm.js';
import { clubEngine } from './club-engine.js';

// A namespace import, so bindings an older ducy-wasm lacks (loadGtoPlo) are
// just undefined instead of failing the whole module.
const { BotTable, MultiTable, botPersonalities, loadGto } = wasm;

const ready = init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)});
// Club tables, and the clocks every hosted table runs on (the friends
// table's is 'host').
const clubs = clubEngine(MultiTable);
const now = clubs.now;
let table = null;
let host = null;
// The table's hands kept for review that reviewNew has returned.
let reviewedHands = 0;

const snapshot = state => ({state, botToAct: table.botToAct()});

// The GTO bot's files are big (a few MB), so they're kept in Cache Storage:
// downloaded once, then read from disk on later visits. Each model lives in
// its own folder, so a cached file never goes stale. Hold'em's, PLO4's and
// PLO6's models each have their own cache, so loading one doesn't drop another.
const GTO_CACHE = 'ducy-gto';
const GTO_PLO_CACHE = 'ducy-gto-plo';
const GTO_PLO6_CACHE = 'ducy-gto-plo6';
const gtoLoaded = {};

async function cachedBytes(cacheName, url) {
  let cache = null;
  try { cache = await caches.open(cacheName); } catch {}
  let res = cache && await cache.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    if (cache) { try { await cache.put(url, res.clone()); } catch {} }
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Loads the model named by the manifest ({dir, cards, blueprint}) into the
// engine with `load(cards, blueprint)`, once.
async function loadGtoModel(manifestUrl, cacheName, load) {
  const res = await fetch(manifestUrl, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`no GTO bot here (${res.status})`);
  const m = await res.json();
  const base = new URL(`${m.dir}/`, manifestUrl);
  if (gtoLoaded[cacheName] === base.href) return true;
  const [cards, blueprint] = await Promise.all([
    cachedBytes(cacheName, new URL(m.cards, base).href),
    cachedBytes(cacheName, new URL(m.blueprint, base).href),
  ]);
  load(cards, blueprint);
  gtoLoaded[cacheName] = base.href;
  // Drop older models from the cache.
  try {
    const cache = await caches.open(cacheName);
    for (const req of await cache.keys()) if (!req.url.startsWith(base.href)) await cache.delete(req);
  } catch {}
  return true;
}

const ops = {
  personalities: () => botPersonalities(),
  // stacks, if given, are each seat's chips for the first hand (a ladder game
  // resuming); an older ducy-wasm without setStack starts everyone at the buy-in.
  create: (bots, buyIn, sb, bb, seed, game, stacks) => {
    table = new BotTable(bots, BigInt(buyIn), BigInt(sb), BigInt(bb), BigInt(seed), game);
    reviewedHands = 0;
    if (Array.isArray(stacks) && table.setStack) stacks.forEach((chips, seat) => table.setStack(seat, BigInt(chips)));
    return snapshot(table.newHand());
  },
  // resetStacks and reviewLastHand came with ducy's hand review; with an
  // older ducy-wasm, stacks carry over and there's no review.
  newHand: reset => {
    if (reset && table.resetStacks) table.resetStacks();
    return snapshot(table.newHand());
  },
  review: () => (table.reviewLastHand ? table.reviewLastHand() : null),
  // Ladder games (#284): keep heads-up hands against any bot for review
  // (false with a ducy-wasm older than setReviewAll), and the review of the
  // hand just kept, or null when no new hand was kept since the last call.
  setReviewAll: on => (table.setReviewAll ? (table.setReviewAll(!!on), true) : false),
  reviewNew: () => {
    const n = table.reviewableHands ? table.reviewableHands() : 0;
    if (n === reviewedHands) return null;
    reviewedHands = n;
    return table.reviewLastHand();
  },
  // The Regulars (#225), between hands: a seat's chips, a new Regular in a
  // bot seat, and no automatic top-ups (you rebuy when you choose). Each
  // returns whether this ducy-wasm could do it (setBot and setTopUp came
  // with ducy#225).
  state: () => snapshot(table.state()),
  setStack: (seat, chips) => (table.setStack ? (table.setStack(seat, BigInt(chips)), true) : false),
  setBot: (seat, id, chips, seed) => (table.setBot ? (table.setBot(seat, id, BigInt(chips), BigInt(seed)), true) : false),
  setTopUp: on => (table.setTopUp ? (table.setTopUp(!!on), true) : false),
  // A bomb pot every `every` hands (0 for none), on two boards: false with a
  // ducy-wasm older than setBombPots (ducy#238).
  setBombPots: (every, ante) => (table.setBombPots ? (table.setBombPots(BigInt(every), BigInt(ante), true), true) : false),
  // Your latest decision graded as soon as it's made (live feedback); null
  // with a ducy-wasm older than reviewLastDecision.
  reviewDecision: () => (table.reviewLastDecision ? table.reviewLastDecision() : null),
  advance: () => snapshot(table.advance()),
  act: (kind, amount) => snapshot(table.act(kind, BigInt(amount))),
  // All-in with cards to come: run it twice (yes) or once; the bots go along.
  runTwice: yes => snapshot(table.runTwice(!!yes)),
  loadGto: manifestUrl => loadGtoModel(manifestUrl, GTO_CACHE, loadGto),
  // The PLO GTO bot ("gto-plo" at a plo4 table) came later; an older
  // ducy-wasm doesn't have it. Its blueprint is for a depth of `bb` big blinds.
  gtoPloSupported: () => typeof wasm.loadGtoPlo === 'function',
  loadGtoPlo: (manifestUrl, bb) => loadGtoModel(manifestUrl, GTO_PLO_CACHE, (cards, blueprint) => wasm.loadGtoPlo(cards, blueprint, BigInt(bb))),
  // The PLO6 one ("gto-plo6" at a plo6 table) came later still: loadGtoPlo
  // takes its six-card model only in a ducy-wasm that has gtoPlo6Loaded.
  gtoPlo6Supported: () => typeof wasm.gtoPlo6Loaded === 'function',
  loadGtoPlo6: (manifestUrl, bb) => loadGtoModel(manifestUrl, GTO_PLO6_CACHE, (cards, blueprint) => wasm.loadGtoPlo(cards, blueprint, BigInt(bb))),
  hostCreate: (bots, open, name, buyIn, sb, bb, seed, game, turnMs) => {
    host = new MultiTable(bots, Uint8Array.from(open, o => (o ? 1 : 0)), name, BigInt(buyIn), BigInt(sb), BigInt(bb), BigInt(seed), game, BigInt(turnMs));
    return host.state(now('host')); // deal once the players are in
  },
  // Friends: empty seats people take as they join, and real chips the host
  // hands out on request.
  hostFriends: (seats, name, hostChips, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs) => {
    clubs.clocks.delete('host');
    host = MultiTable.friends(seats, name, BigInt(hostChips), BigInt(minBuyIn), BigInt(maxBuyIn), BigInt(sb), BigInt(bb), BigInt(seed), game, BigInt(turnMs));
    return host.state(now('host'));
  },
  // The friends table as JSON, to resume it if the page closes (#117); null
  // with an older ducy-wasm.
  hostSave: () => (host?.save ? host.save(now('host')) : null),
  // A friends table saved with hostSave, paused until hostResume (throws if
  // it can't be loaded).
  hostRestore: json => {
    if (!MultiTable.restore) throw new Error('this ducy-wasm can’t restore tables');
    const t = MultiTable.restore(json, Date.now());
    clubs.clocks.delete('host');
    host?.free();
    host = t;
    return host.state(now('host'));
  },
  hostResume: () => host.resume(now('host')),
  // A bomb pot every `every` hands, on two boards; with a ducy-wasm older
  // than setBombPots, just the state.
  hostBombPots: (every, ante) => (host.setBombPots ? host.setBombPots(BigInt(every), BigInt(ante), true, now('host')) : host.state(now('host'))),
  hostApprove: seat => host.approveChips(seat, now('host')),
  hostDeny: seat => host.denyChips(seat, now('host')),
  hostChips: amount => host.hostChips(BigInt(amount), now('host')),
  hostRemove: seat => host.remove(seat, now('host')),
  hostNewHand: () => host.newHand(now('host')),
  hostAdvance: () => host.advance(now('host')),
  hostAct: (kind, amount) => host.act(kind, BigInt(amount), now('host')),
  hostRunTwice: yes => host.hostRunTwice(!!yes, now('host')),
  hostHandle: (client, msg) => host.handle(client, msg, now('host')),
  hostDisconnected: client => host.disconnected(client, now('host')),
  hostTick: () => host.tick(now('host')),
  // A club's tables (club-engine.js).
  ...clubs.ops,
};

self.onmessage = async e => {
  const {id, op, args = []} = e.data;
  await ready;
  try {
    postMessage({id, result: await ops[op](...args)});
  } catch (err) {
    postMessage({id, error: String(err && err.message || err)});
  }
};
