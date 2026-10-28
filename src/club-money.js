// A club's money on links (#454): ducy-play's money model (ClubMoney, from
// ducy-wasm) runs every chip move. Each member plays through a backer, the
// club or their agent; the pair is a link with one balance and one credit
// limit, and a buy-in or cash-out moves every link on the path up to the
// club. See the club money model doc (#454).
//
// The model lives in the club object as `club.money` (plain data, so it's
// saved, backed up and sent to the owner's page with the club), and the host
// keeps a ClubMoney for it here. After every move:
//   m.balance  their link with whoever they play through (an agent's: their
//              own chips and their players', as the club sees it)
//   m.credit   that link's credit limit
//   m.room     what they can bring to a table: the least room on their path
// and each move's entries on those links are added to club.chips.ledger in
// its older form ({n, kind, member, amount, balance, …}; `player` when the
// move was a player's, on their agent's link), so pages and members' copies
// carry on until they read links themselves.
//
// The first time, a club is moved onto links: a player under an agent gets
// a link with the agent at their balance, an agent one with the club at
// their own chips plus their players', everyone else one with the club, and
// anyone seated a session on their path.
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).
// Pages only read the mirrors and club.money.

import * as ducy from '../wasm/ducy_wasm.js';

export const CLUB = 'club';

const cache = new WeakMap(); // club → {cm, data}: data is the club.money it last wrote

const isAgent = (club, id) => club.members[id]?.status === 'member' && club.members[id]?.agent === 'yes';
// Whom a member plays through, by today's fields: their agent, or the club.
export const backerOf = (club, m) => (m?.agentOf && isAgent(club, m.agentOf) ? m.agentOf : CLUB);

// A refused move, with the model's reason ({code, …}) as `money`.
function refused(r) {
  const e = new Error(r.message);
  e.money = r.error;
  return e;
}

function run(cm, op, now) {
  const r = cm.run(op, now);
  if (!r.ok) throw refused(r);
  return r.entries;
}

// Links for members who have none yet (new, or approved since).
function ensureLinks(club, cm, now) {
  const linked = id => !!cm.account(id)?.through;
  const link = (m, depth = 0) => {
    if (linked(m.id) || depth > 8) return;
    const b = backerOf(club, m);
    if (b !== CLUB) link(club.members[b], depth + 1);
    run(cm, {op: 'addLink', member: m.id, backer: b}, now);
    if (m.credit) run(cm, {op: 'setCredit', member: m.id, backer: b, credit: m.credit}, now);
  };
  for (const m of Object.values(club.members)) if (m.status === 'member') link(m);
}

// Moving today's club onto links: balances and seats carried over.
function migrate(club, cm, now) {
  ensureLinks(club, cm, now);
  const members = Object.values(club.members).filter(m => m.status === 'member');
  for (const m of members) {
    const backer = cm.account(m.id)?.through;
    if (!backer) continue;
    // An agent's link is their account as the club saw it: their own chips
    // and their players' shares.
    const shares = isAgent(club, m.id) ? members.filter(p => backerOf(club, p) === m.id).reduce((s, p) => s + (p.balance || 0), 0) : 0;
    const balance = (m.balance || 0) + shares;
    if (balance) run(cm, {op: 'openBalance', member: m.id, backer, balance}, now);
    // Their own ledger copy still adds up: the shares come in as one line.
    if (shares) club.chips.ledger.push({n: club.chips.next++, at: now, kind: 'links', member: m.id, amount: Math.abs(shares), change: shares, balance});
  }
  for (const m of members) {
    if (m.seat) run(cm, {op: 'openSession', member: m.id, table: m.seat.table, stack: m.seat.stack || 0, put: m.seat.put ?? m.seat.stack ?? 0}, now);
  }
}

function load(club, now) {
  let c = cache.get(club);
  if (!c || c.data !== club.money) {
    const cm = club.money ? ducy.ClubMoney.fromData(club.money) : new ducy.ClubMoney(0);
    c = {cm, data: null};
    cache.set(club, c);
    if (!club.money) migrate(club, cm, now);
  }
  ensureLinks(club, c.cm, now);
  return c.cm;
}

// What member `id` can bring to a table, from club.money: the least room
// (balance + credit, at least 0) on their path.
function roomIn(data, links, id) {
  let room = Infinity, at = id;
  for (let i = 0; i < 64; i++) {
    const b = data.accounts[at]?.through;
    if (!b) return 0;
    const l = links.get(`${at}|${b}`);
    room = Math.min(room, Math.max(0, (l?.balance || 0) + (l?.credit || 0)));
    if (b === CLUB) return room;
    at = b;
  }
  return 0;
}

function sync(club, cm) {
  const data = cm.data();
  club.money = data;
  cache.get(club).data = data;
  const links = new Map(data.links.map(l => [`${l.member}|${l.backer}`, l]));
  for (const m of Object.values(club.members)) {
    const b = data.accounts[m.id]?.through;
    const l = b && links.get(`${m.id}|${b}`);
    if (!l) continue;
    m.balance = l.balance;
    if (l.credit) m.credit = l.credit; else delete m.credit;
    m.room = roomIn(data, links, m.id);
  }
}

// Moves the club onto links if it isn't yet, and links new members. The
// host runs it as the club starts.
export function startMoney(club, now = Date.now()) {
  sync(club, load(club, now));
}

// Makes one move (a ClubMoney op, {op, …}) and returns its entries in the
// ledger's older form, on each link someone plays through: `kind` names
// them (or `kinds`, by the model's kind), and `extra` is added to each.
// Throws an Error with `money` ({code, …}) if the model refuses it; nothing
// changes then.
export function move(club, op, now = Date.now(), {kind = null, kinds = {}, extra = {}} = {}) {
  const cm = load(club, now);
  let entries;
  try {
    entries = run(cm, op, now);
  } finally {
    sync(club, cm);
  }
  const through = id => club.money.accounts[id]?.through;
  const out = [];
  for (const e of entries) {
    if (through(e.member) !== e.backer) continue;
    const old = {n: club.chips.next++, at: e.at, kind: kinds[e.kind] || kind || e.kind, member: e.member, amount: Math.abs(e.amount), balance: e.balance, ...extra};
    if (e.note) old.note = e.note;
    if (op.member && e.member !== op.member) old.player = op.member;
    club.chips.ledger.push(old);
    out.push(old);
  }
  return out;
}

// A link of member `id`'s (with whoever they play through, by default), from club.money.
export function linkOf(club, id, backer = club.money?.accounts?.[id]?.through) {
  return club.money?.links?.find(l => l.member === id && l.backer === backer) || null;
}

// Whom member `id` plays through now: the club, their agent, or null.
export const throughOf = (club, id) => club.money?.accounts?.[id]?.through ?? null;

// What `backer` settles with the people below them (the Settle page): each
// of their links with a balance, largest first, as {member, balance};
// below zero, the member owes the backer. An agent's link carries their
// players' play too, so it's their whole tree's result.
export function settleRows(club, backer = CLUB) {
  return (club.money?.links || []).filter(l => l.backer === backer && l.balance)
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.member.localeCompare(b.member))
    .map(l => ({member: l.member, balance: l.balance}));
}
