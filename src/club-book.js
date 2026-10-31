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

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// Runs `op` on the club's book; returns its value. Throws why, if refused:
// `short` set when it's for want of chips (a table then offers to ask the
// manager for more, #404).
export function book(club, op, now = Date.now()) {
  // A club not on links yet moves onto them first.
  if (!club.money) startMoney(club, now);
  return run(club, op, now);
}

// Starts the club's money (ducy-play's start_money): a club saved before
// links is moved onto them, balances and seats carried over; members
// without a link get one; each member's balance, credit and room follow.
// The host runs it as the club starts.
export function startMoney(club, now = Date.now()) {
  run(club, {op: 'startMoney'}, now);
}

function run(club, op, now) {
  const part = {
    code: club.code, hostId: club.hostId, ownerId: club.ownerId, ratholeHours: club.ratholeHours, members: club.members, money: club.money,
    chips: club.chips, requestLog: club.requestLog || [], log: club.log || [],
  };
  const r = ducy.clubBook(JSON.stringify(part), op, now);
  if (!r.ok) {
    const e = new Error(r.message);
    if (r.short) e.short = true;
    throw e;
  }
  if (r.club) {
    merge(club.members, r.club.members);
    club.money = r.club.money;
    Object.assign(club.chips ??= {}, r.club.chips);
    club.requestLog = r.club.requestLog;
    club.log = r.club.log;
  }
  return r.value;
}
