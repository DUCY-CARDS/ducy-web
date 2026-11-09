// The owner's fair play page (#582): the relay's collusion check
// (relay/src/collusion.js) and its check for play too close to ducy's GTO
// model (#591, relay/src/assist.js) in plain words. Its report comes with the
// owner's view of the club (club-server.js, `checks`): players, and pairs
// of players, whose play stands out, with counts and hand numbers, never
// cards. A flag means "look into it", not proof.

import { chipText } from './chip-format.js';

const n = x => Number(x || 0).toLocaleString();
// A share as a whole percent: pct(0.91) or pct(91, 100), "91%".
const pct = (k, of = 1) => `${of ? Math.round((100 * Number(k || 0)) / of) : 0}%`;
// "the club's average is 58%", or, with no one else to compare, the
// solver's own rate on the same decisions.
const clubAvg = f => (f.club == null ? 'no club average yet' : `the club’s average is ${pct(f.club)}`);
const clubOr = (f, solver) => (f.club != null ? clubAvg(f) : `${solver}: ${pct(f.solver)}`);

// A flag in a line: "Ava rarely bets or raises against Bo: 2 of 40 hands
// heads-up, against 31 of 90 with others". `names`: {id: name}.
export function flagText(f, names = {}) {
  const a = names[f.who] || 'Someone', b = names[f.other] || 'someone';
  const w = f.with || {}, e = f.elsewhere || {};
  switch (f.kind) {
    case 'raises': return `${a} rarely bets or raises against ${b}: ${n(w.k)} of ${n(w.n)} hands heads-up, against ${n(e.k)} of ${n(e.n)} with others`;
    case 'enters': return `${a} rarely plays a pot ${b} opened: ${n(w.k)} of ${n(w.n)}, against ${n(e.k)} of ${n(e.n)} opened by others`;
    case 'folds': return `${a} folds to ${b}’s bets: ${n(w.k)} of ${n(w.n)}, against ${n(e.k)} of ${n(e.n)} to others`;
    case 'checks': return `${a} checks strong hands against ${b}: ${n(w.k)} of ${n(w.n)} heads-up, against ${n(e.k)} of ${n(e.n)} with others`;
    case 'dumps': return `${a} lost big pots to ${b} with weak hands: ${n(w.k)} of ${n(w.n)}, against ${n(e.k)} of ${n(e.n)} to others`;
    case 'chips': return `${a} lost ${chipText(f.chips)} to ${b} (${n(f.bb)} big blinds)`;
    case 'partner': return `${a} played as if they knew ${b}’s cards: ${n(w.k)} of ${n(w.n)} spots where it mattered, others ${n(e.k)} of ${n(e.n)}`;
    case 'contest': return `${a} and ${b} rarely play a pot together: ${n(w.k)} in ${n(w.n)} hands, about ${n(f.expected)} expected`;
    // Seat and location flags (#581, relay/src/proximity.js).
    case 'near': return `${a} and ${b} were within 100 m of each other: ${n(w.k)} of ${n(w.n)} hands together`;
    case 'network': return `${a} and ${b} played on the same network: ${n(w.k)} of ${n(w.n)} hands together`;
    case 'vpn': return `${a} played through a VPN or hosting network: ${n(w.k)} of ${n(w.n)} hands`;
    case 'fake': return `${a}’s location may be faked${f.why?.length ? ` (${f.why.map(x => FAKE_WHY[x] || x).join(', ')})` : ''}: ${n(w.k)} of ${n(w.n)} hands`;
    // Play too close to ducy's GTO model (#591, relay/src/assist.js).
    case 'gto-top': return `${a} matched the solver’s top play in ${pct(w.k, w.n)} of ${n(w.n)} preflop decisions; ${clubOr(f, 'the solver itself')}`;
    case 'gto-off': return `${a} made ${n(w.k)} plays the solver never makes in ${n(w.n)} preflop decisions (${pct(w.k, w.n)}); ${clubAvg(f)}`;
    case 'gto-mix': return `${a} took the less common play in close spots ${pct(w.k, w.n)} of ${n(w.n)} times, as the solver would (${pct(f.solver)}); ${clubAvg(f)}`;
    case 'gto-sizes': return `${a} raised the solver’s exact size ${pct(w.k, w.n)} of ${n(w.n)} times; ${clubAvg(f)}`;
    case 'gto-pace': return `${a} took as long on clear decisions as harder ones: ${f.clear} s and ${f.hard} s${f.club ? `; the club: ${f.club.clear} s and ${f.club.hard} s` : ''}`;
    case 'gto-even': return `${a} took ${f.median} s give or take ${f.spread} s over ${n(f.n)} decisions`;
    case 'gto-away': return `${a}’s tab was hidden while deciding ${pct(w.k, w.n)} of ${n(w.n)} times; ${clubAvg(f)}`;
    case 'gto-jump': return `${a}’s top-play rate jumped from ${pct(f.before.top, f.before.n)} (${n(f.before.n)} decisions) to ${pct(f.after.top, f.after.n)} (${n(f.after.n)}); plays the solver never makes: ${n(f.before.off)}, then ${n(f.after.off)}`;
    // After the flop, against ducy's heads-up models (#615, relay/src/postflop.js).
    case 'gto-post-top': return `${a} matched the solver’s top play in ${pct(w.k, w.n)} of ${n(w.n)} decisions after the flop; ${clubOr(f, 'the solver itself')}`;
    case 'gto-post-off': return `${a} made ${n(w.k)} plays the solver rarely makes in ${n(w.n)} decisions after the flop (${pct(w.k, w.n)}); ${clubAvg(f)}`;
    case 'gto-post-loss': return `${a} gave up ${f.bb} big blinds per 100 decisions after the flop by the solver’s values, over ${n(f.n)}; ${f.club == null ? 'no club average yet' : `the club’s average is ${f.club}`}`;
    default: return f.text || f.kind;
  }
}

// Why a location may be faked (proximity.js takeReading).
const FAKE_WHY = {far: 'far from their network', timezone: 'time zone doesn’t match', accuracy: 'unnatural accuracy', jump: 'impossible jump'};

// The seat flags' words (#581), as the table and the hand records show them.
export const SEAT_FLAGS = {near: 'within 100 m', network: 'same network', vpn: 'VPN', relay: 'private relay', fake: 'location may be faked', hidden: 'location not shared'};

// A seat_flags update from the relay, checked: {seats: {seat: [kind]},
// groups: [{letter, seats: [seat], links: [{kind, seats: [a, b]}]}]}.
export function readSeatFlags(m) {
  const seats = {};
  for (const [k, v] of Object.entries(m?.seats && typeof m.seats === 'object' ? m.seats : {})) {
    if (Array.isArray(v)) seats[Number(k)] = v.filter(x => SEAT_FLAGS[x]);
  }
  const pair = l => Array.isArray(l?.seats) && l.seats.length === 2 && ['near', 'network'].includes(l.kind);
  const groups = (Array.isArray(m?.groups) ? m.groups : []).filter(g => Array.isArray(g?.seats)).slice(0, 26).map(g => ({
    letter: String(g.letter || '?').slice(0, 1), seats: g.seats.map(Number), links: (g.links || []).filter(pair).map(l => ({kind: l.kind, seats: l.seats.map(Number)})),
  }));
  return {seats, groups};
}

// What table seat `at` shows (#581): its group's badge ({letter, index},
// the colour by index) or null, its flag ('red' for location not shared,
// a VPN or a location that may be faked; 'grey' for a private relay; or
// null), and the words for both: "Within 100 m of Bo", "Same network as
// Ava", "Location not shared"... `nameAt(seat)`: who sits there.
export function seatMarks(flags, at, nameAt = () => 'someone') {
  const lines = [];
  const index = (flags?.groups || []).findIndex(g => g.seats.includes(at));
  const g = index >= 0 ? flags.groups[index] : null;
  for (const l of g?.links || []) {
    if (!l.seats.includes(at)) continue;
    const other = nameAt(l.seats.find(x => x !== at));
    lines.push(l.kind === 'near' ? `Within 100 m of ${other}` : `Same network as ${other}`);
  }
  const kinds = flags?.seats?.[at] || [];
  const red = ['hidden', 'vpn', 'fake'].filter(k => kinds.includes(k));
  for (const k of red) lines.push({hidden: 'Location not shared', vpn: 'VPN', fake: 'Location may be faked'}[k]);
  if (kinds.includes('relay')) lines.push('Private relay');
  // The colour goes by the letter, so everyone sees a group alike.
  return {group: g ? {letter: g.letter, index: Math.max(0, g.letter.charCodeAt(0) - 65)} : null, flag: red.length ? 'red' : kinds.includes('relay') ? 'grey' : null, lines};
}
const ORDER = Object.keys(SEAT_FLAGS);

// A seat's flags in a line: "within 100 m · VPN". `kinds`: the relay's.
export function seatFlagsText(kinds) {
  if (!Array.isArray(kinds)) return '';
  return [...new Set(kinds)].filter(k => SEAT_FLAGS[k]).sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)).map(k => SEAT_FLAGS[k]).join(' · ');
}

// A kept hand's seat flags (`rec.flags`, [{kind, ids}]) by name, for the
// owner's records: "Ava and Bo: within 100 m; Cy: VPN"; '' for none.
export function handFlagsText(rec) {
  const names = Object.fromEntries((rec?.seats || []).filter(s => s.id).map(s => [s.id, s.name || 'Someone']));
  const by = new Map();
  for (const f of rec?.flags || []) {
    if (!SEAT_FLAGS[f?.kind] || !Array.isArray(f.ids)) continue;
    const who = f.ids.map(id => names[id] || 'Someone').join(' and ');
    if (!by.has(who)) by.set(who, []);
    by.get(who).push(f.kind);
  }
  return [...by].map(([who, kinds]) => `${who}: ${seatFlagsText(kinds)}`).join('; ');
}

// Who an entry is about: "Ava and Bo" for a pair, "Ava" for one player.
// `names` (the club's) first, then the names they played under.
const nameOf = (e, id, names) => names[id] || e.names?.[id] || 'Someone';
export const entryTitle = (e, names = {}) => e.ids.map(id => nameOf(e, id, names)).join(' and ');

// A pair's net chips, plainly: "Bo lost 3,200 to Ava"; '' for one player,
// or nothing moved.
export function flowText(e, names = {}) {
  if (e.ids.length !== 2 || !e.flow) return '';
  const [a, b] = e.flow > 0 ? e.ids : [...e.ids].reverse();
  return `${nameOf(e, a, names)} lost ${chipText(Math.abs(e.flow))} to ${nameOf(e, b, names)}`;
}

// A flag's hands, by table and number: "Main #212, #215 · Back room #9".
export function handsText(hands = []) {
  const by = new Map();
  for (const h of hands) {
    if (!by.has(h.table)) by.set(h.table, []);
    by.get(h.table).push(`#${h.hand}`);
  }
  return [...by].map(([t, list]) => `${t ? `${t} ` : ''}${list.join(', ')}`).join(' · ');
}

// The flagged players and pairs as notices for Needs you (#398): one each,
// clearable, keyed by who and what for, so a new kind of flag shows again.
export function fairPlayNotices(report, {cleared = new Set(), names = {}} = {}) {
  return (report?.flagged || []).map(e => ({
    kind: 'fair_play', key: `fair:${e.ids.join('|')}|${[...new Set(e.flags.map(f => f.kind))].sort().join(',')}`,
    name: entryTitle(e, names), flags: e.flags.length, at: report.at,
  })).filter(x => !cleared.has(x.key));
}
