// A club's own rules (#455): ducy-play's club_rules (clubRules, from
// ducy-wasm) runs them: members and their names, the invite, help requests,
// the lobby, the club info, tables and reserved seats, and services.
//
// The club stays a plain object here, saved and sent as before. Each call
// hands the rules' part of it to the model with an op ({op, …}) and puts
// what comes back into the same objects, so a member or table someone
// holds stays the one in the club. A refusal throws an Error with the
// model's message, and nothing changes.
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';

// The club's fields the rules read, and those they change.
const READS = ['v', 'code', 'name', 'hostId', 'ownerId', 'invite', 'createdAt', 'codeJoin', 'members', 'help', 'lobby', 'info', 'tables', 'sitOutMins', 'stayHands', 'ratholeHours', 'waitlist', 'services', 'serviceRefused'];
const WRITES = ['invite', 'members', 'help', 'lobby', 'info', 'tables', 'waitlist', 'services', 'serviceRefused'];

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

function apply(club, out) {
  for (const k of WRITES) {
    if (!(k in out)) continue;
    if (k === 'members') merge(club.members ??= {}, out.members);
    else if (k === 'tables') {
      const had = new Map((club.tables || []).map(t => [t.id, t]));
      club.tables = out.tables.map(t => (had.has(t.id) ? merge(had.get(t.id), t) : t));
    } else club[k] = out[k];
  }
}

// Runs `op` on `club`; returns its value. Throws why, if the rules refuse it.
export function rules(club, op, now = Date.now()) {
  const part = {};
  for (const k of READS) if (club[k] !== undefined) part[k] = club[k];
  const r = ducy.clubRules(JSON.stringify(part), op, now);
  if (!r.ok) throw new Error(r.message);
  if (r.club) apply(club, r.club);
  return r.value;
}

// A new club's rules part: {v, code, name, hostId, invite, createdAt, …}.
// Throws if the name won't do.
export function newRules(name, code, hostId, now = Date.now()) {
  const r = ducy.clubRules('{}', {op: 'new', name: String(name ?? ''), code, hostId}, now);
  if (!r.ok) throw new Error(r.message);
  return r.club;
}

// What a name reads as (#450): names with the same key are the same name.
export const nameKey = name => ducy.nameKey(String(name ?? ''));

// The club info as given, checked against the info it replaces.
export const cleanClubInfo = (input, prev = null, now = Date.now()) => ducy.cleanClubInfo(JSON.stringify(input ?? {}), JSON.stringify(prev ?? null), now);
