// The owner's fair play page (#582): the relay's collusion check
// (relay/src/collusion.js) in plain words. Its report comes with the
// owner's view of the club (club-server.js, `checks`): players, and pairs
// of players, whose play stands out, with counts and hand numbers, never
// cards. A flag means "look into it", not proof.

import { chipText } from './chip-format.js';

const n = x => Number(x || 0).toLocaleString();

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
    case 'contest': return `${a} and ${b} rarely play a pot together: ${n(w.k)} in ${n(w.n)} hands, about ${n(f.expected)} expected`;
    // Seat and location flags (#581) bring their own words.
    default: return f.text || f.kind;
  }
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
