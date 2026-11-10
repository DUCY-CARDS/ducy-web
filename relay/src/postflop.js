// ducy's postflop check for real-time assistance (#615): players whose play
// after the flop is too close to ducy's heads-up GTO models, in Hold'em and
// Omaha. Preflop is assist.js's (#591); getting preflop right is learnable
// from charts, so play after the flop is the stronger signal.
//
// The relay has no GTO engine (its wasm is the clubs-only build, #463), so
// the scoring runs in a Worker of its own, the judge (relay/judge/), with
// ducy's models: the club room sends it the hands to score over a Durable
// Object binding, within Cloudflare, and gets back numbers by seat, never a
// card. Each hand is scored once, as the fair play run (fair-play.js) finds
// it, and its scores are kept here, under keys of their own:
//
//   pfCursor        {at, ids}: the newest full record looked at (hand-records.js)
//   pfDays          {days: {<day>: count}}: scored hands kept per day
//   pf:<day>:<k>    a scored hand: {at, ref: {table, hand}, game, ds: [{id,
//                   name, street (1 flop … 3 river), f (how often the model
//                   makes their play, with their hand), top (how often it
//                   makes its most frequent play), loss (big blinds their play
//                   gives up against the model's best, Hold'em only, else
//                   null), lost (what the hand review charges)}]}
//
// No cards in any of them: they may go wherever the report goes.
//
// Which hands: pots two players took to the flop, at any table size, in
// No-limit Hold'em or pot-limit Omaha (4, 5 or 6 cards), with stacks near
// the depth the models were trained for (100 big blinds). Multiway pots
// after the flop are skipped: ducy has no multiway postflop model.
//
// Per player, over their scored decisions in the last WINDOW_DAYS:
//   top    how often they took the model's most frequent play, against how
//          often the model would on the same decisions
//   off    plays the model rarely makes (under OFF_P with their hand)
//   loss   big blinds given up per 100 valued decisions (Hold'em)
// A player is flagged when, over MIN_DECISIONS or more, they are as close
// as the model itself: hardly any plays it rarely makes (OFF_RATE), its top
// play at least as often as it would take it (TOP_SLACK), and, with
// MIN_VALUED Hold'em decisions or more, hardly any loss (LOSS_RATE). The
// thresholds were set by simulation (scripts/postflop-calibrate.mjs):
// ducy's bot personalities, weak to very strong, as honest players, and
// players using the model, or a solver of their own, as cheaters. A flag
// means "look into it", never proof; nothing is done to anyone.

// ---- the thresholds, all here ----
export const LIMITS = {
  // Days of scored hands the report covers (at most the club's Keep hands).
  WINDOW_DAYS: 30,
  // Decisions scored before a player is judged.
  MIN_DECISIONS: 300,
  // A player counts toward the club's averages from this many.
  MIN_BASELINE: 100,
  // A play the model rarely makes: under this share with their hand (the
  // hand review's own line for "one of its choices").
  OFF_P: 0.05,
  // As close as the model: at this share of such plays or fewer ...
  OFF_RATE: 0.07,
  // ... the model's top play at least as often as it would take it, less
  // this ...
  TOP_SLACK: 0.06,
  // ... and, over MIN_VALUED Hold'em decisions or more, at most this many
  // big blinds given up per decision. Loose: the review charges the model
  // itself up to about 0.18 (its mixes and the sampled flop values), and
  // the plays above tell players apart far better.
  MIN_VALUED: 150,
  LOSS_RATE: 0.25,
  // Hands sent to the judge at once, and at most per run (the rest wait for
  // the next run): each call is one Durable Object request, with its own
  // CPU limit (30 s).
  BATCH: 4,
  MAX_PER_RUN: 400,
  // Hands listed per line, the newest.
  MAX_HANDS_LISTED: 10,
};

const GAMES = new Set(['nlhe', 'plo4', 'plo5', 'plo6']);
const ACTS = new Set(['fold', 'check', 'call', 'bet', 'raise']);
const DAY_MS = 864e5;
const dayOf = at => Math.floor(at / DAY_MS);

// The judge as scoreNew wants it, through the relay's Durable Object
// binding `ns` (env.JUDGE, judge/judge.js); null without one (the local
// relay, tests), and the check is off.
export function judgeVia(ns) {
  if (!ns?.idFromName) return null;
  return async hands => {
    const stub = ns.get(ns.idFromName('judge'));
    const r = await stub.fetch('https://judge/score', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({hands})});
    if (!r.ok) throw new Error(`judge: ${r.status}`);
    return (await r.json()).results;
  };
}

// Whether record `rec` (hand-records.js) can be scored: a game the models
// play, a flop dealt, and exactly two players left when it was.
export function eligible(rec) {
  if (!GAMES.has(rec?.game || 'nlhe') || !Array.isArray(rec.actions)) return false;
  const seats = new Set((rec.seats || []).map(s => s.seat));
  const folded = new Set();
  for (const e of rec.actions) {
    if (e?.type === 'board') return seats.size - folded.size === 2;
    if (e?.type === 'fold') folded.add(e.seat);
  }
  return false;
}

// What the judge needs of `rec`, and nothing more: the seats' cards and
// stacks, the actions and the board.
export function judgeInput(rec) {
  return {
    game: rec.game || 'nlhe', sb: rec.sb, bb: rec.bb, button: rec.button,
    seats: (rec.seats || []).map(s => ({seat: s.seat, cards: s.cards || null, stackEnd: s.stackEnd, net: s.net})),
    actions: (rec.actions || []).filter(e => e && (ACTS.has(e.type) || ['ante', 'small_blind', 'big_blind', 'post', 'board', 'second_board', 'runs'].includes(e.type))),
    board: rec.board || [],
  };
}

// A record's scores ({seat, street, frequency, top, evLoss, bbLost} from
// the judge) by player: the stored form's `ds`.
function byPlayer(rec, scored) {
  const at = new Map((rec.seats || []).map(s => [s.seat, s]));
  const num = x => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
  return (scored || []).filter(d => at.get(d.seat)?.id).map(d => ({
    id: at.get(d.seat).id, name: at.get(d.seat).name || '', street: d.street,
    f: num(d.frequency), top: num(d.top), loss: num(d.evLoss), lost: num(d.bbLost) || 0,
  })).filter(d => d.f != null && d.top != null);
}

// Scores the records in `recs` (fullHands, oldest first) not scored yet,
// with `judge(inputs)` (resolves to one list of scores per input), and keeps
// the scores. At most MAX_PER_RUN hands that can be scored, BATCH at a time;
// a batch that fails is tried a hand at a time, and a hand that fails alone
// is skipped; when no hand of a batch can be scored (the judge is down), the
// run stops and they wait for the next. Drops scores older than `days`.
// {scored, skipped, left}.
export async function scoreNew(storage, recs, judge, {now = Date.now(), days = LIMITS.WINDOW_DAYS} = {}) {
  const out = {scored: 0, skipped: 0, left: 0};
  await prune(storage, now, days);
  if (typeof judge !== 'function') return out;
  let cursor = (await storage.get('pfCursor')) || {at: 0, ids: []};
  const fresh = recs.filter(r => r.at > cursor.at || (r.at === cursor.at && !cursor.ids.includes(r.id))).sort((a, b) => a.at - b.at);
  const index = (await storage.get('pfDays')) || {days: {}};
  const advance = r => { cursor = r.at === cursor.at ? {at: r.at, ids: [...cursor.ids, r.id]} : {at: r.at, ids: [r.id]}; };
  const keep = async (rec, scored) => {
    const ds = byPlayer(rec, scored);
    if (!ds.length) return;
    const day = dayOf(rec.at || now), k = index.days[day] || 0;
    await storage.put(`pf:${day}:${k}`, {at: rec.at, ref: {table: rec.tableName || '', hand: rec.hand}, game: rec.game || 'nlhe', ds});
    index.days[day] = k + 1;
    out.scored++;
  };
  const tryJudge = async batch => {
    try {
      const res = await judge(batch.map(judgeInput));
      if (Array.isArray(res) && res.length === batch.length) return res;
    } catch (e) {
      console.warn('postflop: judge failed:', e?.message || e);
    }
    return null;
  };
  // Scores the batch: false, keeping nothing, when not one hand of it could
  // be scored (the judge is down, or has no models): those hands wait for
  // the next run.
  let batch = [], sent = 0;
  const flush = async () => {
    if (!batch.length) return true;
    let res = await tryJudge(batch);
    if (!res && batch.length > 1) {
      res = [];
      for (const r of batch) res.push(((await tryJudge([r])) || [null])[0]);
    }
    if (!res || !res.some(Boolean)) return false;
    for (let k = 0; k < batch.length; k++) {
      if (res[k]) await keep(batch[k], res[k]);
      else out.skipped++;
    }
    batch = [];
    return true;
  };
  let i = 0, done = cursor, down = false;
  const save = async () => {
    await storage.put('pfDays', index);
    await storage.put('pfCursor', cursor);
    done = cursor;
  };
  for (; i < fresh.length; i++) {
    const r = fresh[i];
    if (eligible(r)) {
      if (sent >= LIMITS.MAX_PER_RUN) break;
      batch.push(r);
      sent++;
    }
    advance(r);
    if (batch.length >= LIMITS.BATCH) {
      if (!(await flush())) { down = true; break; }
      await save();
    }
  }
  // The hands in the last batch, scored before the cursor moves past them.
  if (!down && !(await flush())) down = true;
  if (down) {
    cursor = done;
    out.left = fresh.filter(r => r.at > done.at || (r.at === done.at && !done.ids.includes(r.id))).filter(eligible).length;
  } else {
    await save();
    out.left = fresh.slice(i).filter(eligible).length;
  }
  return out;
}

// Drops scored hands from before the club's `days`.
async function prune(storage, now, days) {
  const index = (await storage.get('pfDays')) || {days: {}};
  const oldest = dayOf(now - Math.max(1, Number(days) || 1) * DAY_MS);
  let changed = false;
  for (const d of Object.keys(index.days)) {
    if (Number(d) >= oldest) continue;
    for (let k = 0; k < index.days[d]; k++) await storage.delete(`pf:${d}:${k}`);
    delete index.days[d];
    changed = true;
  }
  if (changed) await storage.put('pfDays', index);
}

// Every scored hand from `since` on, oldest first.
export async function scoredHands(storage, {since = 0} = {}) {
  const index = (await storage.get('pfDays')) || {days: {}};
  const out = [];
  for (const d of Object.keys(index.days).map(Number).sort((a, b) => a - b)) {
    if ((d + 1) * DAY_MS <= since) continue;
    for (let k = 0; k < index.days[d]; k++) {
      const h = await storage.get(`pf:${d}:${k}`);
      if (h && h.at >= since) out.push(h);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Every scored hand goes (the club was deleted).
export async function dropScores(storage) {
  const index = (await storage.get('pfDays')) || {days: {}};
  for (const d of Object.keys(index.days)) for (let k = 0; k < index.days[d]; k++) await storage.delete(`pf:${d}:${k}`);
  await storage.delete('pfDays');
  await storage.delete('pfCursor');
}

// The postflop part of a fair play run (fair-play.js): scores what's new in
// `recs` (the run's full records) with `judge` (judgeVia), then reports over
// the last WINDOW_DAYS (at most `days`, the club's Keep hands) of scored
// hands. {flagged, stats, counts: {decisions, players, scored, left,
// skipped}}. Without a judge, the hands scored before still report.
export async function postflopRun(storage, recs, {now = Date.now(), days = LIMITS.WINDOW_DAYS, judge = null} = {}) {
  let run = {scored: 0, skipped: 0, left: 0};
  try {
    run = await scoreNew(storage, recs, judge, {now, days});
  } catch (e) {
    console.warn('postflop: not scored:', e?.message || e);
  }
  const since = now - Math.min(LIMITS.WINDOW_DAYS, Math.max(1, Number(days) || 1)) * DAY_MS;
  const r = postflopReport(await scoredHands(storage, {since}));
  return {flagged: r.flagged, stats: r.stats, counts: {decisions: r.decisions, players: r.players, ...run}};
}

// ---- adding up ----

// A player's numbers over decisions `ds` ({f, top, loss, lost}).
export function statsOf(ds) {
  const st = {n: ds.length, top: 0, expTop: 0, off: 0, valued: 0, lost: 0, loss: 0};
  for (const d of ds) {
    st.expTop += d.top;
    if (d.f >= d.top - 1e-6) st.top++;
    if (d.f < LIMITS.OFF_P) st.off++;
    if (d.loss != null) { st.valued++; st.loss += d.loss; st.lost += d.lost || 0; }
  }
  return st;
}

// As close to the model as the model itself.
export function tooClose(st, L = LIMITS) {
  return st.n >= L.MIN_DECISIONS && st.off <= L.OFF_RATE * st.n && st.top >= st.expTop - L.TOP_SLACK * st.n
    && (st.valued < L.MIN_VALUED || st.lost <= L.LOSS_RATE * st.valued);
}

const rate = (k, n) => (n ? k / n : null);
function clubRate(all, id, k, n) {
  let a = 0, b = 0;
  for (const [other, st] of all) {
    if (other === id || st.n < LIMITS.MIN_BASELINE) continue;
    a += k(st); b += n(st);
  }
  return rate(a, b);
}

// The report over scored hands `hands` (scoredHands): {decisions, players,
// flagged: [{ids: [id], names, decisions, flags}], stats: {players: [{id,
// name, n, top, exp, off, valued, lost}]}}. Flags: 'gto-post-top' {with:
// {k, n}, solver, club}, 'gto-post-off' {with, club}, 'gto-post-loss' {bb
// (per 100 valued decisions), n, club}, with hand numbers. No cards.
export function postflopReport(hands) {
  const by = new Map(), names = new Map(), refs = new Map();
  let total = 0;
  for (const h of hands) {
    for (const d of h.ds || []) {
      total++;
      if (!by.has(d.id)) { by.set(d.id, []); refs.set(d.id, []); }
      by.get(d.id).push(d);
      names.set(d.id, d.name);
      const r = refs.get(d.id);
      if (r[r.length - 1] !== h.ref) r.push(h.ref);
    }
  }
  const all = new Map([...by].map(([id, ds]) => [id, statsOf(ds)]));
  const flagged = [];
  for (const [id, st] of all) {
    if (!tooClose(st)) continue;
    const hands = refs.get(id).slice(-LIMITS.MAX_HANDS_LISTED).map(r => ({...r}));
    const flags = [
      {kind: 'gto-post-top', who: id, with: {k: st.top, n: st.n}, solver: rate(st.expTop, st.n), club: clubRate(all, id, s => s.top, s => s.n), hands},
      {kind: 'gto-post-off', who: id, with: {k: st.off, n: st.n}, club: clubRate(all, id, s => s.off, s => s.n)},
    ];
    if (st.valued) {
      const club = clubRate(all, id, s => s.lost, s => s.valued);
      flags.push({kind: 'gto-post-loss', who: id, bb: Math.round(1000 * st.lost / st.valued) / 10, n: st.valued, club: club == null ? null : Math.round(1000 * club) / 10});
    }
    flagged.push({ids: [id], names: {[id]: names.get(id)}, decisions: st.n, flags});
  }
  const r1 = v => Math.round(v * 10) / 10;
  const players = [...all].map(([id, st]) => ({id, name: names.get(id) || '', n: st.n, top: st.top, exp: r1(st.expTop), off: st.off, valued: st.valued, lost: r1(st.lost)})).sort((a, b) => b.n - a.n);
  return {decisions: total, players: players.filter(p => p.n >= LIMITS.MIN_DECISIONS).length, flagged, stats: {players}};
}
