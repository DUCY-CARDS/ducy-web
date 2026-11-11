// ducy's admin view of fair play across clubs (#612): each club's scheduled
// fair play run (fair-play.js, in the club's room) makes a compact summary
// (adminSummary) and the room sends it to the relay's registry, which keeps
// the latest per club and a small weekly summary per player for KEEP_DAYS
// (fairPlayStore). The admin API (admin.js /admin/fair-play) reads them
// there: one read, without waking every club's room.
//
// What's in it: the open flags (the owner's report's `flagged`), every
// player's numbers behind the assistance check and their seat and location
// flags, every pair's numbers behind the collusion and partner's-cards
// checks, and the club's averages. Counts, rates, seconds and hand numbers:
// never a card, a folded card, a seed or a location. Nothing here acts on
// anyone; the admin only looks.

import { LIMITS as C } from './collusion.js';
import { LIMITS as A } from './assist.js';
import { LIMITS as P } from './postflop.js';

// The thresholds the checks flag at, for the admin page to compare with.
export const THRESHOLDS = Object.freeze({
  windowDays: C.WINDOW_DAYS, minShared: C.MIN_SHARED, odds: C.ODDS_RATIO, partnerOdds: C.PARTNER_ODDS_RATIO, flowBB: C.FLOW_BB,
  minDecisions: A.MIN_DECISIONS, offRate: A.OFF_RATE, topSlack: A.TOP_SLACK, paceRatio: A.PACE_RATIO, evenSpread: A.EVEN_SPREAD, awayRate: A.AWAY_RATE,
  // After the flop (postflop.js, #615).
  pfMinDecisions: P.MIN_DECISIONS, pfOffRate: P.OFF_RATE, pfTopSlack: P.TOP_SLACK, pfLossRate: P.LOSS_RATE,
});

// How long the weekly summaries are kept.
export const KEEP_DAYS = 90;
// A summary's size, at most, in JSON characters (a Durable Object value
// may be 128 KiB).
export const MAX_CHARS = 100_000;
// Players in a summary, at most (the most hands first).
export const MAX_PLAYERS = 200;

const SOLO = ['vpn', 'relay', 'fake', 'hidden'];

// The Monday (UTC) of the week holding `ms`, as 'YYYY-MM-DD'.
export function weekOf(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 864e5).toISOString().slice(0, 10);
}

// Each player's hands in records `recs`, and in how many each one-player
// seat flag was on them as the hand finished: {id: {name, hands, vpn,
// relay, fake, hidden}}.
export function seatCounts(recs) {
  const out = {};
  const of = (id, name) => (out[id] ||= {name: '', hands: 0, vpn: 0, relay: 0, fake: 0, hidden: 0, ...(name ? {name} : {})});
  for (const rec of recs) {
    const ids = new Set();
    for (const s of rec.seats || []) {
      if (!s.id) continue;
      const p = of(s.id);
      if (s.name) p.name = String(s.name);
      p.hands++;
      ids.add(s.id);
    }
    const seen = new Set();
    for (const f of rec.prox || []) {
      if (!SOLO.includes(f?.kind) || !Array.isArray(f.ids) || f.ids.length !== 1 || !ids.has(f.ids[0])) continue;
      const k = `${f.ids[0]}|${f.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out[f.ids[0]][f.kind]++;
    }
  }
  return out;
}

// The summary from one run: `report` (the owner's), `pairStats`
// (collusion.js, stats: true), `assistStats` (assist.js playerStats), the
// records `recs` it read (for the seat flags), at `now`:
// {at, since, hands, decisions, flags, players: [{id, name, hands, flags
// (the kinds flagged about them, or a pair they're in), a (assist.js briefStats, or null), p
// ({vpn, relay, fake, hidden}: hands with each), pf (after the flop,
// postflop.js: {n, top, exp, off, valued, lost}, or null)}], pairs, club:
// {assist, pairs, p: {hands, vpn, relay, fake, hidden}}, postflop (the
// report's counts, #615)}. `postflopStats`: postflop.js postflopRun's.
export function adminSummary({report, pairStats = {pairs: [], club: {}}, assistStats = {players: [], club: null}, postflopStats = {players: []}, recs = [], now = Date.now()}) {
  const seats = seatCounts(recs);
  const assist = new Map((assistStats.players || []).map(({id, name, ...a}) => [id, {name, a}]));
  const pf = new Map((postflopStats?.players || []).map(({id, name, ...s}) => [id, {name, s}]));
  const flagsOf = new Map();
  for (const e of report.flagged || []) {
    for (const f of e.flags || []) {
      for (const id of e.ids || []) {
        if (!flagsOf.has(id)) flagsOf.set(id, new Set());
        flagsOf.get(id).add(f.kind);
      }
    }
  }
  const ids = new Set([...Object.keys(seats), ...assist.keys(), ...pf.keys()]);
  const players = [...ids].map(id => {
    const s = seats[id] || {hands: 0, vpn: 0, relay: 0, fake: 0, hidden: 0};
    return {
      id, name: s.name || assist.get(id)?.name || pf.get(id)?.name || '', hands: s.hands,
      flags: [...(flagsOf.get(id) || [])].sort(),
      a: assist.get(id)?.a || null,
      p: {vpn: s.vpn, relay: s.relay, fake: s.fake, hidden: s.hidden},
      pf: pf.get(id)?.s || null,
    };
  }).sort((x, y) => y.flags.length - x.flags.length || y.hands - x.hands).slice(0, MAX_PLAYERS);
  const club = {assist: assistStats.club || null, pairs: pairStats.club || {}, p: {hands: 0, vpn: 0, relay: 0, fake: 0, hidden: 0}};
  for (const s of Object.values(seats)) for (const k of Object.keys(club.p)) club.p[k] += s[k];
  return fitSummary({
    at: report.at ?? now, since: report.since ?? null, hands: report.hands ?? recs.length,
    decisions: report.assist?.decisions ?? 0,
    flags: report.flagged || [], players, pairs: pairStats.pairs || [], club,
    postflop: report.postflop || null,
  });
}

// `summary`, cut down until its JSON fits MAX_CHARS: pairs not flagged,
// then players with the fewest hands, then each flag's hand list.
export function fitSummary(summary, max = MAX_CHARS) {
  const s = {...summary, players: [...(summary.players || [])], pairs: [...(summary.pairs || [])], flags: [...(summary.flags || [])]};
  const size = () => JSON.stringify(s).length;
  for (let guard = 0; guard < 100 && size() > max; guard++) {
    if (s.pairs.length > 10) s.pairs = s.pairs.slice(0, Math.floor(s.pairs.length * 0.75));
    else if (s.players.length > 20) s.players = s.players.slice(0, Math.floor(s.players.length * 0.75));
    else if (s.flags.some(e => e.flags.some(f => f.hands?.length > 3))) s.flags = s.flags.map(e => ({...e, flags: e.flags.map(f => (f.hands ? {...f, hands: f.hands.slice(-3)} : f))}));
    else if (s.pairs.length) s.pairs = s.pairs.slice(0, -1);
    else if (s.players.length) s.players = s.players.slice(0, -1);
    else break;
  }
  return s;
}

// A player's line in the weekly summary.
const weekRow = p => ({name: p.name, hands: p.hands, flags: p.flags, a: p.a, p: p.p, pf: p.pf ?? null});

// The registry's side (`storage`: {get, put, delete}, the registry's):
//   fp:<code>          the club's latest summary, with `code`
//   fpw:<code>:<week>  {at, players: {id: weekRow}}: its latest summary in
//                      that week (weekOf), per player
//   fpIndex            {code: {latest: true|false, weeks: [week]}}
// Weeks older than KEEP_DAYS go as anything is noted, and as history is read.
export function fairPlayStore(storage) {
  const index = async () => (await storage.get('fpIndex')) || {};
  // Drops weeks older than KEEP_DAYS from `idx` (and storage); true if any.
  async function prune(idx, now) {
    const oldest = weekOf(now - KEEP_DAYS * 864e5);
    let changed = false;
    for (const [code, e] of Object.entries(idx)) {
      const keep = e.weeks.filter(w => w >= oldest);
      for (const w of e.weeks.filter(x => x < oldest)) await storage.delete(`fpw:${code}:${w}`);
      if (keep.length !== e.weeks.length) { e.weeks = keep; changed = true; }
      if (!e.latest && !e.weeks.length) { delete idx[code]; changed = true; }
    }
    return changed;
  }
  return {
    // Club `code`'s summary from a run (adminSummary's), at `now`.
    async note(code, summary, now = Date.now()) {
      if (!summary || typeof summary !== 'object') return;
      const s = fitSummary({...summary, code});
      const at = Number(s.at) || now;
      const week = weekOf(at);
      await storage.put(`fp:${code}`, s);
      await storage.put(`fpw:${code}:${week}`, {at, players: Object.fromEntries((s.players || []).map(p => [p.id, weekRow(p)]))});
      const idx = await index();
      const e = idx[code] ||= {latest: true, weeks: []};
      e.latest = true;
      if (!e.weeks.includes(week)) e.weeks = [...e.weeks, week].sort();
      await prune(idx, now);
      await storage.put('fpIndex', idx);
    },
    // Every club's latest summary, newest first.
    async list() {
      const idx = await index();
      const out = [];
      for (const [code, e] of Object.entries(idx)) {
        if (!e.latest) continue;
        const s = await storage.get(`fp:${code}`);
        if (s) out.push({...s, code});
      }
      return out.sort((a, b) => (b.at || 0) - (a.at || 0));
    },
    // Player `id`'s weeks in every club, newest first: [{week, code, at, ...weekRow}].
    async history(id, now = Date.now()) {
      const idx = await index();
      if (await prune(idx, now)) await storage.put('fpIndex', idx);
      const out = [];
      for (const [code, e] of Object.entries(idx)) {
        for (const week of e.weeks) {
          const w = await storage.get(`fpw:${code}:${week}`);
          const row = w?.players?.[id];
          if (row) out.push({week, code, at: w.at, ...row});
        }
      }
      return out.sort((a, b) => b.week.localeCompare(a.week) || a.code.localeCompare(b.code));
    },
    // The club is gone: its latest summary goes; its weeks age out.
    async drop(code) {
      const idx = await index();
      await storage.delete(`fp:${code}`);
      if (!idx[code]) return;
      idx[code].latest = false;
      if (!idx[code].weeks.length) delete idx[code];
      await storage.put('fpIndex', idx);
    },
    // Wipe all clubs (#636): every club's summaries and weeks go now. Codes
    // in `codes` that the index has forgotten go too. Returns how many clubs.
    async wipe(codes = []) {
      const idx = await index();
      const all = new Set([...Object.keys(idx), ...codes]);
      for (const code of all) {
        await storage.delete(`fp:${code}`);
        for (const w of idx[code]?.weeks || []) await storage.delete(`fpw:${code}:${w}`);
      }
      await storage.delete('fpIndex');
      return all.size;
    },
  };
}
