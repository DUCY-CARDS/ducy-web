// The club manager's notifications (#398): what needs the manager, newest
// first, each with what's needed for its quick actions (clubs.js draws
// them and their buttons). Pure: built from the club object.
//
//   join        asks to join                    Let in · No
//   chips       asks for chips                  Give (the amount) · Other · No
//   at_limit    a credit player at their limit  Raise limit (new amount) · No (#404)
//   help        a help request                  Reply · Watch
//   prize       a promotion prize held          Pay · Replay hand
//   stopped     a table stopped dealing         Close table
//   left_owing  left a table owing the club     (a notice) (#404)
// Each has a `key`, unique and stable while it stands, so the notices that
// need no answer (stopped, left_owing) can be cleared.

import { openHelp } from './club-help.js';
import { creditNotices } from './club-credit.js';
import { openTables } from './club-tables.js';
import { isDealing } from './club-overview.js';

// Notices only shown (no answer needed), which Clear puts away.
export const CLEARABLE = new Set(['stopped', 'left_owing']);

export function managerNotices(club, {cleared = new Set(), seated = {}} = {}) {
  const out = [];
  const ms = Object.values(club.members || {});
  for (const m of ms) {
    if (m.status === 'pending') out.push({key: `join:${m.id}:${m.requestedAt || 0}`, kind: 'join', member: m.id, name: m.name, via: m.agentOf ? club.members[m.agentOf]?.name || '' : '', at: m.requestedAt || 0});
    // An agent's player asks their agent (#75); one at their credit limit
    // is an at_limit notice below.
    const q = m.status === 'member' && !m.agentOf && m.request;
    if (q && !q.atLimit) out.push({key: `chips:${m.id}:${q.at}`, kind: 'chips', member: m.id, name: m.name, amount: q.amount, note: q.note || '', table: q.table || '', at: q.at || 0});
  }
  for (const c of creditNotices(club)) {
    if (c.kind === 'at_limit') out.push({...c, key: `at_limit:${c.member}:${c.at}`});
    // Settled since: nothing to say.
    else if (c.owesNow > 0) out.push({...c, key: `left_owing:${c.n}`});
  }
  for (const x of openHelp(club)) {
    const m = club.members[x.from];
    out.push({key: `help:${x.id}`, kind: 'help', id: x.id, member: x.from, name: x.name, text: x.text, table: x.table || '', watch: m?.seat?.table || '', at: x.at});
  }
  for (const a of club.promos?.awards || []) {
    if (a.status === 'held') out.push({key: `prize:${a.id}`, kind: 'prize', id: a.id, member: a.member, name: a.name, amount: a.amount, promo: a.promoName, hand: a.hand || '', handName: a.handName || '', at: a.at});
  }
  // A table that dealt and has stopped (fewer than two in hands), still open.
  for (const t of openTables(club)) {
    if (t.status !== 'open' || isDealing(t.dealing) || !t.dealing?.stoppedAt) continue;
    out.push({key: `stopped:${t.id}:${t.dealing.stoppedAt}`, kind: 'stopped', table: t.id, name: t.name, seated: seated[t.id] || 0, at: t.dealing.stoppedAt});
  }
  return out.filter(n => !cleared.has(n.key)).sort((a, b) => b.at - a.at);
}

// The keys of the clearable notices in `list`, to put away with Clear.
export const clearableKeys = list => list.filter(n => CLEARABLE.has(n.kind)).map(n => n.key);

// A new credit limit to offer a player at their limit: enough for what
// they asked, on top of what they have available.
export const raiseTo = n => n.credit + Math.max(0, n.asked - n.available);
