// Runs the bot table (ducy-wasm's BotTable) off the main thread, so the page
// stays responsive while a bot thinks; Omaha decisions can take a second or
// two. Protocol: each request {id, op, args} gets {id, result} or {id, error}.
//   ops: personalities | create(bots, buyIn, sb, bb, seed, game) | newHand |
//        advance | act(kind, amount) | loadGto(manifestUrl)
// Every table op returns {state, botToAct}.
import init, { BotTable, botPersonalities, loadGto } from '../wasm/ducy_wasm.js';

const ready = init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)});
let table = null;

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
  newHand: () => snapshot(table.newHand()),
  advance: () => snapshot(table.advance()),
  act: (kind, amount) => snapshot(table.act(kind, BigInt(amount))),
  loadGto: manifestUrl => loadGtoModel(manifestUrl),
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
