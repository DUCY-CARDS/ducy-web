// ducy's judge (#615): scores club players' decisions after the flop with
// ducy's heads-up GTO models (rust/ducy-judge), for the postflop fair play
// check (../src/postflop.js). A Worker of its own, so the relay stays the
// small clubs-only build (#463) and the models' memory and CPU stay out of
// club rooms.
//
// Only the relay reaches it: through its Durable Object binding (JUDGE in
// ../wrangler.toml), within Cloudflare. It has no route of its own: a
// request to its address gets 404. A club room POSTs {hands: [judgeInput],
// options} and gets {results: [scores or null]}: per hand, its decisions as
// numbers by seat ([{seat, street, frequency, top, evLoss, stderr, bbLost}]),
// or null when no model for its game could be loaded. It keeps nothing: the
// hands live only for the request, and no card is ever in what it returns.
//
// The models are the site's own, fetched once per instance from MODELS
// (the live site's gto/ folder): gto/current.json for Hold'em, and
// plo-current.json, plo5-current.json and plo6-current.json for Omaha, each
// {dir, cards, blueprint}. All four are trained 100 big blinds deep.

import { initSync, judgeHand, loadHoldem, loadPlo } from './wasm/ducy_judge.js';
import wasmModule from './wasm/ducy_judge_bg.wasm';

const MANIFESTS = {nlhe: 'current.json', plo4: 'plo-current.json', plo5: 'plo5-current.json', plo6: 'plo6-current.json'};
const DEPTH = 100;
// At most this many hands per request: each request has 30 s of CPU, and a
// Hold'em hand played to the river by both takes up to about 4.5 s
// (measured in Node, 16 flop runouts).
export const MAX_HANDS = 4;
// Turn and river cards sampled to value a flop decision: the hand review
// uses 32; 16 takes about two thirds of the time, with a larger standard
// error (a loss within two of it isn't charged).
const OPTIONS = {flopRunouts: 16};

let ready = false;
// game → a promise of whether its model loaded; a failure is tried again
// after RETRY_MS.
const models = new Map();
const RETRY_MS = 10 * 60 * 1000;

// Loads `game`'s model from `base` (a URL ending in /) with `fetcher`.
export async function loadModel(game, base, fetcher = fetch) {
  const get = async url => {
    const r = await fetcher(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r;
  };
  const m = await (await get(new URL(MANIFESTS[game], base))).json();
  const dir = new URL(`${m.dir}/`, base);
  const [cards, blueprint] = await Promise.all([m.cards, m.blueprint].map(async f => new Uint8Array(await (await get(new URL(f, dir))).arrayBuffer())));
  if (game === 'nlhe') loadHoldem(cards, blueprint);
  else loadPlo(cards, blueprint, BigInt(DEPTH));
}

function modelFor(game, base) {
  const at = models.get(game);
  if (at && (at.ok !== false || Date.now() - at.at < RETRY_MS)) return at.p;
  const entry = {at: Date.now(), ok: null};
  entry.p = loadModel(game, base).then(() => { entry.ok = true; return true; }, e => { entry.ok = false; console.warn('judge: no model:', game, e.message); return false; });
  models.set(game, entry);
  return entry.p;
}

// Scores `hands` (postflop.js judgeInput) with the models from `base`.
export async function judgeHands(hands, options = {}, base) {
  if (!ready) { initSync({module: wasmModule}); ready = true; }
  const games = [...new Set(hands.map(h => h?.game).filter(g => MANIFESTS[g]))];
  const loaded = new Map();
  for (const g of games) loaded.set(g, await modelFor(g, base));
  return hands.map(h => {
    if (!loaded.get(h?.game)) return null;
    try {
      return judgeHand(h, options);
    } catch (e) {
      console.warn('judge: hand not scored:', e.message);
      return [];
    }
  });
}

export class Judge {
  constructor(state, env) {
    this.env = env;
  }

  async fetch(req) {
    if (req.method !== 'POST') return new Response('Not found', {status: 404});
    const body = await req.json().catch(() => null);
    const hands = Array.isArray(body?.hands) ? body.hands.slice(0, MAX_HANDS) : [];
    const results = await judgeHands(hands, {...OPTIONS, ...(body?.options || {})}, this.env.MODELS || 'https://ducy.cards/gto/');
    return Response.json({results});
  }
}

export default {
  fetch() {
    return new Response('Not found', {status: 404});
  },
};
