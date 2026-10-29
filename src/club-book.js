// A club's book (#456): ducy-play's club_book (clubBook, from ducy-wasm)
// runs what needs the club's rules and its money together: chips the club
// or an agent gives and takes back, chip requests, credit limits, agents,
// and the activity log.
//
// As club-rules.js: each call hands the book's part of the club to the
// model with an op and puts what comes back into the same objects (members
// keep their identity). A refusal throws an Error with the model's message,
// and nothing changes.
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';
import { startMoney } from './club-money.js';

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// Runs `op` on the club's book; returns its value. Throws why, if refused.
export function book(club, op, now = Date.now()) {
  // A club not on links yet moves onto them first (club-money.js).
  if (!club.money) startMoney(club, now);
  const part = {
    code: club.code, hostId: club.hostId, ownerId: club.ownerId, members: club.members, money: club.money,
    chips: club.chips, requestLog: club.requestLog || [], log: club.log || [],
  };
  const r = ducy.clubBook(JSON.stringify(part), op, now);
  if (!r.ok) throw new Error(r.message);
  if (r.club) {
    merge(club.members, r.club.members);
    club.money = r.club.money;
    Object.assign(club.chips ??= {}, r.club.chips);
    club.requestLog = r.club.requestLog;
    club.log = r.club.log;
  }
  return r.value;
}
