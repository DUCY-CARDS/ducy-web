// The admin site's Fair play (#612): every club's latest fair play run
// (relay/src/fair-play-admin.js, from /admin/fair-play), as sortable tables:
// the open flags, each player's numbers behind the assistance and seat
// checks, each pair's behind the collusion and partner's-cards checks, the
// clubs' averages; and a player's weeks (/admin/fair-play/history).
// Counts, rates, seconds and hand numbers only: the relay sends no cards.
// Nothing here acts on anyone.

import { handsText } from './club-fair-play.js';
import { chipText } from './chip-format.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const rate = (k, n) => (n ? k / n : null);
const odds = (k, n) => (k + 0.5) / (n - k + 0.5);
const r2 = v => Math.round(v * 100) / 100;

// Each signal's short name.
export const SIGNALS = {
  raises: 'Bets against', enters: 'Enters after', folds: 'Folds to', checks: 'Checks strong', dumps: 'Dumps',
  chips: 'Chips', contest: 'Pots together', partner: 'Partner cards',
  near: 'Within 100 m', network: 'Same network', vpn: 'VPN', relay: 'Private relay', fake: 'Faked location',
  'gto-top': 'Top play', 'gto-off': 'Never-plays', 'gto-mix': 'Mixing', 'gto-sizes': 'Sizes',
  'gto-pace': 'Timing ratio', 'gto-even': 'Even timing', 'gto-away': 'Hidden tab', 'gto-jump': 'Jump',
  'gto-post-top': 'Top play after flop', 'gto-post-off': 'Rare plays after flop', 'gto-post-loss': 'Loss after flop',
};
const UPPER = new Set(['folds', 'checks', 'dumps', 'partner']);
const PROX = new Set(['near', 'network', 'vpn', 'relay', 'fake']);

// ---- formatting ----

export const pct = v => (v == null || !Number.isFinite(v) ? '—' : `${(100 * v).toFixed(1)}%`);
const times = v => (v == null || !Number.isFinite(v) ? '—' : `×${v.toFixed(2)}`);
const int = v => (v == null ? '—' : Number(v).toLocaleString('en'));
const secs = v => (v == null ? '—' : `${v} s`);
const kn = w => (w ? `${int(w.k)}/${int(w.n)}` : '—');

// A flag's strength: {value (for sorting), text}. Rate comparisons as how
// far the odds lean the suspicious way (×1: no difference; the checks flag
// at ×4, partner cards at ×2.5); chips in big blinds; seat flags and the
// assistance lines as their rate, ratio or change.
export function strength(f) {
  const w = f.with, e = f.elsewhere;
  if (f.kind === 'contest' && w) { const v = r2((f.expected + 0.5) / (w.k + 0.5)); return {value: v, text: times(v)}; }
  if (f.kind === 'chips') return {value: Math.abs(f.bb || 0), text: `${int(Math.abs(f.bb || 0))} bb`};
  if (w && e && SIGNALS[f.kind] && !f.kind.startsWith('gto-')) {
    const r = odds(w.k, w.n) / odds(e.k, e.n);
    const v = r2(UPPER.has(f.kind) ? r : 1 / r);
    return {value: v, text: times(v)};
  }
  if (f.kind === 'gto-pace') { const v = f.clear ? r2(f.hard / f.clear) : null; return {value: v, text: times(v)}; }
  if (f.kind === 'gto-even') { const v = f.median ? r2(f.spread / f.median) : null; return {value: v, text: times(v)}; }
  if (f.kind === 'gto-jump') {
    const v = rate(f.after.top, f.after.n) - rate(f.before.top, f.before.n);
    return {value: v, text: `+${(100 * v).toFixed(1)} pts`};
  }
  if (f.kind === 'gto-post-loss') return {value: f.bb ?? null, text: f.bb == null ? '—' : `${f.bb} bb/100`};
  const v = w ? rate(w.k, w.n) : null;
  return {value: v, text: pct(v)};
}

// A flag's numbers, briefly: "2/40 vs 31/90".
export function numbers(f) {
  const w = f.with, e = f.elsewhere;
  switch (f.kind) {
    case 'contest': return `${kn(w)}, ${int(f.expected)} expected`;
    case 'chips': return `${chipText(Math.abs(f.chips || 0))}`;
    case 'gto-top': case 'gto-post-top': return `${kn(w)} · model ${pct(f.solver)} · club ${pct(f.club)}`;
    case 'gto-post-off': return `${kn(w)} · club ${pct(f.club)}`;
    case 'gto-post-loss': return `${int(f.n)} valued · club ${f.club == null ? '—' : `${f.club} bb/100`}`;
    case 'gto-mix': return `${kn(w)} · model ${pct(f.solver)} · club ${pct(f.club)}`;
    case 'gto-off': case 'gto-sizes': case 'gto-away': return `${kn(w)} · club ${pct(f.club)}`;
    case 'gto-pace': return `${secs(f.hard)} / ${secs(f.clear)}${f.club ? ` · club ${secs(f.club.hard)} / ${secs(f.club.clear)}` : ''}`;
    case 'gto-even': return `${secs(f.median)} ± ${secs(f.spread)} · ${int(f.n)}`;
    case 'gto-jump': return `${kn({k: f.before.top, n: f.before.n})} → ${kn({k: f.after.top, n: f.after.n})}`;
    default:
      if (PROX.has(f.kind)) return `${kn(w)} hands${f.why?.length ? ` · ${f.why.join(', ')}` : ''}`;
      return e ? `${kn(w)} vs ${kn(e)}` : kn(w);
  }
}

// ---- rows ----

const nameIn = (names, id) => names?.[id] || id.slice(0, 8);
const inClub = (clubs, code) => (code ? clubs.filter(c => c.code === code) : clubs);

// One row per open flag.
export function flagRows(clubs, code = '') {
  const out = [];
  for (const c of inClub(clubs, code)) {
    for (const e of c.flags || []) {
      for (const f of e.flags || []) {
        // Who it's about first: "Ava → Bo".
        const ids = f.who && e.ids.length === 2 ? [f.who, e.ids.find(x => x !== f.who) || f.who] : e.ids;
        out.push({club: c.name || c.code, code: c.code, ids, names: e.names || {}, players: ids.map(id => nameIn(e.names, id)).join(' → '), kind: f.kind, signal: SIGNALS[f.kind] || f.kind, strength: strength(f), numbers: numbers(f), hands: f.hands || []});
      }
    }
  }
  return out;
}

// A player's numbers as the tables show them, from their summary line
// (`a`: assist.js briefStats; `p`: hands with each seat flag; `pf`: after
// the flop, postflop.js).
export function playerNumbers(p) {
  const a = p.a || {}, pf = p.pf || {};
  const paced = a.nClear >= 20 && a.nHard >= 20 && a.clear > 0;
  const evened = a.timed >= 40 && a.median > 0;
  return {
    hands: p.hands ?? null, decisions: a.n ?? null,
    top: rate(a.top, a.n), model: rate(a.exp, a.n), off: rate(a.off, a.n),
    pace: paced ? r2(a.hard / a.clear) : null, even: evened ? r2(a.spread / a.median) : null,
    away: rate(a.away, a.awayKnown),
    vpn: p.p?.vpn ?? null, relay: p.p?.relay ?? null, fake: p.p?.fake ?? null,
    pfN: pf.n ?? null, pfTop: rate(pf.top, pf.n), pfModel: rate(pf.exp, pf.n), pfOff: rate(pf.off, pf.n),
    pfLoss: pf.valued ? Math.round((1000 * pf.lost) / pf.valued) / 10 : null,
  };
}

export function playerRows(clubs, code = '') {
  return inClub(clubs, code).flatMap(c => (c.players || []).map(p => ({id: p.id, name: p.name || p.id.slice(0, 8), club: c.name || c.code, code: c.code, flags: p.flags || [], ...playerNumbers(p)})));
}

// The clubs' averages, a row each, in the player table's columns (seat
// flags as the share of hands).
export function averageRows(clubs, code = '') {
  return inClub(clubs, code).map(c => {
    const a = c.club?.assist || {}, s = c.club?.p || {};
    return {
      club: c.name || c.code, code: c.code, at: c.at, hands: c.hands, decisions: c.decisions, players: (c.players || []).length,
      top: rate(a.top, a.n), model: rate(a.exp, a.n), off: rate(a.off, a.n), pace: a.pace ?? null, even: a.even ?? null, away: rate(a.away, a.awayKnown),
      vpn: rate(s.vpn, s.hands), relay: rate(s.relay, s.hands), fake: rate(s.fake, s.hands),
      flags: (c.flags || []).reduce((n, e) => n + (e.flags || []).length, 0),
    };
  });
}

export const PAIR_KINDS = ['raises', 'enters', 'folds', 'checks', 'dumps', 'partner', 'contest'];

// One row per pair: hands together, chips between them, and for each
// comparison the strongest direction ({x, flagged, title}).
export function pairRows(clubs, code = '') {
  const out = [];
  for (const c of inClub(clubs, code)) {
    for (const p of c.pairs || []) {
      const [a, b] = p.ids;
      const row = {club: c.name || c.code, code: c.code, ids: p.ids, names: p.names || {}, players: `${nameIn(p.names, a)} · ${nameIn(p.names, b)}`, shared: p.shared, contested: p.contested, bb: Math.abs(p.bb || 0), flow: p.flow || 0, near: p.near || 0, network: p.network || 0, flagged: false};
      // Who lost the chips to whom.
      row.flowTitle = p.flow ? `${nameIn(p.names, p.flow > 0 ? a : b)} → ${nameIn(p.names, p.flow > 0 ? b : a)}: ${chipText(Math.abs(p.flow))}` : '';
      for (const kind of PAIR_KINDS) {
        const ts = (p.tests || []).filter(t => t.kind === kind && t.x != null);
        if (!ts.length) { row[kind] = null; continue; }
        const best = ts.reduce((x, y) => (y.x > x.x ? y : x));
        row[kind] = {
          x: best.x, flagged: ts.some(t => t.flagged),
          title: ts.map(t => (kind === 'contest' ? `${int(t.with.k)} in ${int(t.with.n)}, ${int(t.expected)} expected` : `${nameIn(p.names, t.who)}: ${kn(t.with)} vs ${kn(t.elsewhere)}`)).join('\n'),
        };
        if (row[kind].flagged) row.flagged = true;
      }
      if ((p.tests || []).some(t => t.flagged)) row.flagged = true;
      out.push(row);
    }
  }
  return out;
}

// Each club's rates over every pair, for the pairs' comparison.
export function pairRateRows(clubs, code = '') {
  return inClub(clubs, code).map(c => {
    const r = c.club?.pairs || {};
    return {club: c.name || c.code, ...Object.fromEntries(['raises', 'enters', 'folds', 'checks', 'dumps', 'partner'].map(k => [k, r[k] ? rate(r[k].k, r[k].n) : null]))};
  });
}

// A player's weeks (/admin/fair-play/history), as table rows.
export function historyRows(weeks) {
  return (weeks || []).map(w => ({week: w.week, club: w.club || w.code, code: w.code, flags: w.flags || [], ...playerNumbers(w)}));
}

// ---- sorting ----

// The sort value of `v`: a number, a string, or {value} / {x}.
const sortKey = v => (v && typeof v === 'object' && !Array.isArray(v) ? (v.value ?? v.x ?? null) : Array.isArray(v) ? v.length : v);

// `rows` by column `key`, 'asc' or 'desc'; missing values last either way.
export function sortRows(rows, key, dir = 'desc') {
  const s = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortKey(a[key]), y = sortKey(b[key]);
    const xm = x == null || (typeof x === 'number' && !Number.isFinite(x)), ym = y == null || (typeof y === 'number' && !Number.isFinite(y));
    if (xm || ym) return xm - ym;
    if (typeof x === 'number' && typeof y === 'number') return s * (x - y);
    return s * String(x).localeCompare(String(y));
  });
}

// ---- tables ----

// A sortable table: `id` names it in `sort` ({id: {key, dir}}); `cols`
// [{key, label, num, cell(row)}]; the default order `def` {key, dir}.
export function sortable(id, cols, rows, sort = {}, def = null, empty = 'None') {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  const st = sort[id] || def;
  const sorted = st ? sortRows(rows, st.key, st.dir) : rows;
  const head = cols.map(c => {
    const on = st?.key === c.key;
    const aria = on ? ` aria-sort="${st.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th${c.num ? ' class="n"' : ''}${aria}><button class="sort" data-sort="${esc(id)}" data-key="${esc(c.key)}">${esc(c.label)}${on ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
  }).join('');
  const body = sorted.map(r => `<tr${r.flagged ? ' class="flagged"' : ''}>${cols.map(c => `<td${c.num ? ' class="n"' : ''}>${c.cell(r)}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll tall"><table data-table="${esc(id)}"><tr>${head}</tr>${body}</table></div>`;
}

// The next sort for a click on column `key` of table `id`: the other way
// if it's already sorted by it, else largest first (names A to Z).
export function nextSort(sort, id, key, text = false) {
  const cur = sort[id];
  const dir = cur?.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : text ? 'asc' : 'desc';
  return {...sort, [id]: {key, dir}};
}

const warnIf = (on, text) => (on ? `<span class="warn">${text}</span>` : text);
const person = (id, name) => `<button class="link" data-fair="${esc(id)}">${esc(name)}</button>`;
const clubLink = r => `<button class="link" data-club="${esc(r.code)}">${esc(r.club)}</button>`;

// The player table's numbers, marked where they're past the line a flag
// needs (`t`: the relay's thresholds).
const playerCols = t => [
  {key: 'hands', label: 'Hands', num: true, cell: r => int(r.hands)},
  {key: 'decisions', label: 'Decisions', num: true, cell: r => int(r.decisions)},
  {key: 'top', label: 'Top play', num: true, cell: r => warnIf(r.top != null && r.model != null && r.top >= r.model - t.topSlack, pct(r.top))},
  {key: 'model', label: 'Model', num: true, cell: r => pct(r.model)},
  {key: 'off', label: 'Never-plays', num: true, cell: r => warnIf(r.off != null && r.off <= t.offRate, pct(r.off))},
  {key: 'pace', label: 'Timing ratio', num: true, cell: r => warnIf(r.pace != null && r.pace <= t.paceRatio, times(r.pace))},
  {key: 'even', label: 'Evenness', num: true, cell: r => warnIf(r.even != null && r.even <= t.evenSpread, times(r.even))},
  {key: 'away', label: 'Hidden tab', num: true, cell: r => warnIf(r.away != null && r.away >= t.awayRate, pct(r.away))},
  // After the flop (#615).
  {key: 'pfN', label: 'After flop', num: true, cell: r => int(r.pfN)},
  {key: 'pfTop', label: 'Top play', num: true, cell: r => warnIf(r.pfTop != null && r.pfModel != null && r.pfTop >= r.pfModel - t.pfTopSlack, pct(r.pfTop))},
  {key: 'pfModel', label: 'Model', num: true, cell: r => pct(r.pfModel)},
  {key: 'pfOff', label: 'Rare plays', num: true, cell: r => warnIf(r.pfOff != null && r.pfOff <= t.pfOffRate, pct(r.pfOff))},
  {key: 'pfLoss', label: 'Loss bb/100', num: true, cell: r => warnIf(r.pfLoss != null && r.pfLoss <= 100 * t.pfLossRate, r.pfLoss == null ? '—' : String(r.pfLoss))},
];

const DEFAULT_T = {minDecisions: 300, topSlack: 0.02, offRate: 0.01, paceRatio: 1.2, evenSpread: 0.25, awayRate: 0.2, odds: 4, partnerOdds: 2.5, pfTopSlack: 0.03, pfOffRate: 0.04, pfLossRate: 0.06};

// The Fair play page from /admin/fair-play's answer `x`; `state`: {club
// (a code, or '' for all), sort}.
export function fairHtml(x, state = {}) {
  const clubs = x.clubs || [];
  const t = {...DEFAULT_T, ...(x.limits || {})};
  const code = clubs.some(c => c.code === state.club) ? state.club : '';
  const sort = state.sort || {};
  const when = ms => (ms ? new Date(ms).toLocaleString(undefined, {dateStyle: 'short', timeStyle: 'short'}) : '—');
  let h = `<section><div class="row spread"><h2>Fair play</h2>`
    + `<select id="fp-club" aria-label="Club"><option value="">All clubs</option>${clubs.map(c => `<option value="${esc(c.code)}"${c.code === code ? ' selected' : ''}>${esc(c.name || c.code)}</option>`).join('')}</select></div>`;
  if (!clubs.length) return `${h}<p class="muted">No fair play runs yet</p></section>`;

  h += sortable('flags', [
    {key: 'club', label: 'Club', cell: clubLink},
    {key: 'players', label: 'Players', cell: r => r.ids.map(id => person(id, nameIn(r.names, id))).join(' → ')},
    {key: 'signal', label: 'Signal', cell: r => esc(r.signal)},
    {key: 'strength', label: 'Strength', num: true, cell: r => esc(r.strength.text)},
    {key: 'numbers', label: 'Numbers', cell: r => esc(r.numbers)},
    {key: 'hands', label: 'Hands', cell: r => esc(handsText(r.hands))},
  ], flagRows(clubs, code), sort, {key: 'strength', dir: 'desc'}, 'No open flags') + '</section>';

  const pc = playerCols(t);
  h += '<section><h2>Players</h2>' + sortable('players', [
    {key: 'name', label: 'Player', cell: r => person(r.id, r.name)},
    {key: 'club', label: 'Club', cell: clubLink},
    ...pc,
    {key: 'vpn', label: 'VPN', num: true, cell: r => warnIf(r.vpn > 0, int(r.vpn))},
    {key: 'relay', label: 'Relay', num: true, cell: r => int(r.relay)},
    {key: 'fake', label: 'Faked', num: true, cell: r => warnIf(r.fake > 0, int(r.fake))},
    {key: 'flags', label: 'Flags', cell: r => esc(r.flags.map(k => SIGNALS[k] || k).join(', '))},
  ], playerRows(clubs, code), sort, {key: 'decisions', dir: 'desc'});

  h += '<h3>Club averages</h3>' + sortable('averages', [
    {key: 'club', label: 'Club', cell: clubLink},
    {key: 'at', label: 'Run', cell: r => esc(when(r.at))},
    {key: 'players', label: 'Players', num: true, cell: r => int(r.players)},
    {key: 'hands', label: 'Hands', num: true, cell: r => int(r.hands)},
    {key: 'decisions', label: 'Decisions', num: true, cell: r => int(r.decisions)},
    ...['top', 'model', 'off'].map(k => ({key: k, label: pc.find(c => c.key === k).label, num: true, cell: r => pct(r[k])})),
    {key: 'pace', label: 'Timing ratio', num: true, cell: r => times(r.pace)},
    {key: 'even', label: 'Evenness', num: true, cell: r => times(r.even)},
    {key: 'away', label: 'Hidden tab', num: true, cell: r => pct(r.away)},
    {key: 'vpn', label: 'VPN', num: true, cell: r => pct(r.vpn)},
    {key: 'relay', label: 'Relay', num: true, cell: r => pct(r.relay)},
    {key: 'fake', label: 'Faked', num: true, cell: r => pct(r.fake)},
    {key: 'flags', label: 'Flags', num: true, cell: r => int(r.flags)},
  ], averageRows(clubs, code), sort) + '</section>';

  const pairCell = kind => r => {
    const v = r[kind];
    if (!v) return '—';
    const line = kind === 'partner' ? t.partnerOdds : t.odds;
    return `<span title="${esc(v.title)}"${v.flagged ? ' class="err"' : v.x >= line ? ' class="warn"' : ''}>${times(v.x)}</span>`;
  };
  h += '<section><h2>Pairs</h2>' + sortable('pairs', [
    {key: 'players', label: 'Players', cell: r => r.ids.map(id => person(id, nameIn(r.names, id))).join(' · ')},
    {key: 'club', label: 'Club', cell: clubLink},
    {key: 'shared', label: 'Hands', num: true, cell: r => int(r.shared)},
    {key: 'contested', label: 'Both played', num: true, cell: r => int(r.contested)},
    {key: 'bb', label: 'Chips (bb)', num: true, cell: r => `<span title="${esc(r.flowTitle)}">${int(Math.round(r.bb))}</span>`},
    ...PAIR_KINDS.map(k => ({key: k, label: SIGNALS[k], num: true, cell: pairCell(k)})),
    {key: 'near', label: 'Within 100 m', num: true, cell: r => warnIf(r.near > 0, int(r.near))},
    {key: 'network', label: 'Same network', num: true, cell: r => warnIf(r.network > 0, int(r.network))},
  ], pairRows(clubs, code), sort, {key: 'shared', dir: 'desc'});

  h += '<h3>Club rates</h3>' + sortable('rates', [
    {key: 'club', label: 'Club', cell: r => esc(r.club)},
    ...['raises', 'enters', 'folds', 'checks', 'dumps', 'partner'].map(k => ({key: k, label: SIGNALS[k], num: true, cell: r => pct(r[k])})),
  ], pairRateRows(clubs, code), sort) + '</section>';
  return h;
}

// A player's weeks, from /admin/fair-play/history's answer `x`.
export function historyHtml(x, state = {}, limits = {}) {
  const t = {...DEFAULT_T, ...limits};
  const name = x.weeks?.[0]?.name || '';
  let h = `<section><div class="row spread"><h2>${esc(name || 'Player')} <code>${esc(x.id)}</code></h2><button data-go="fair">Fair play</button></div>`;
  h += sortable('history', [
    {key: 'week', label: 'Week of', cell: r => esc(r.week)},
    {key: 'club', label: 'Club', cell: clubLink},
    ...playerCols(t),
    {key: 'vpn', label: 'VPN', num: true, cell: r => warnIf(r.vpn > 0, int(r.vpn))},
    {key: 'relay', label: 'Relay', num: true, cell: r => int(r.relay)},
    {key: 'fake', label: 'Faked', num: true, cell: r => warnIf(r.fake > 0, int(r.fake))},
    {key: 'flags', label: 'Flags', cell: r => esc(r.flags.map(k => SIGNALS[k] || k).join(', '))},
  ], historyRows(x.weeks), state.sort || {}, {key: 'week', dir: 'desc'}, 'No weeks kept') + '</section>';
  return h;
}
