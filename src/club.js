// Clubs (#61, #66): a host's club, its members, and the messages between the
// host and players. No DOM or network here, so the tests run it in Node;
// clubs.js draws the page and carries the messages over the relay.
//
// The club lives in the host's browser. Its code is the relay room. Players
// join through an invite link (?club=CODE&invite=TOKEN&host=HOSTID#clubs):
// the token proves they were invited, and the host's player ID lets them check
// that replies really come from the host. Every message is a signed envelope
// from identity.js; the host checks players' with a Verifier, and players
// check the host's against the ID in the link.
//
// Player → host bodies:
//   {type: 'join', club, invite, name}   ask to join (or update a pending request)
//   {type: 'hello', club, name, since}   a member or applicant checking in; `since`
//                                        is the last ledger entry they have
//   {type: 'chip_request', club, amount, note}   ask the host for chips (#67)
//   {type: 'cancel_request', club}
//   {type: 'table', club, table, cmd}    a command for a club table (#68): join, act,
//                                        sit_in, leave, request_chips; a tournament's
//                                        tables are table 'tourney:<id>' (#81)
//   {type: 'tourney', club, tourney, op} op: 'register' | 'unregister' (#77), or
//                                        'enter' (late registration or re-entry, #80)
//   {type: 'role_reply', club, accept}   answer to an assistant offer (#62)
//   {type: 'admin_cmd', club, cmd}       an assistant's command (club-roles.js)
// Host → player bodies:
//   {type: 'status', club, name, status} status: 'pending' | 'member' | 'declined'
//                                        | 'removed' | 'bad_invite' | 'unknown'
//   {type: 'account', club, balance, request, entries}   see club-chips.js
//   {type: 'tables', club, tables}       the open tables (club-tables.js)
//   {type: 'tourneys', club, tourneys}   the tournaments (club-tourneys.js)
//   {type: 'tourney_error', club, tourney, reason}   why a tournament op was refused
//   {type: 'role', club, role}           'offered' | 'assistant' | null (#62)
//   {type: 'admin', club, pending, members, tables}   an assistant's view
//   {type: 'admin_result', club, error}  how an assistant's command went
//   {type: 'host_key', club, key}        the host's session key for table updates
// Join and hello carry the player's session key ({key}). Table updates go
// to players encrypted, {type: 'table', table, enc: {iv, ct}} (e2e.js), so
// the relay never sees hole cards and can't forge an update.

import { checkSignature, isPlayerId } from './identity.js';
import { normCode } from './play-net.js';
import { accountBody, cancelRequest, checkOwnLedger, ensureChips, reclaim, requestChips } from './club-chips.js';

export const MAX_CLUB_NAME = 50;
export const MAX_PLAYER_NAME = 20;
const TOKEN_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function clubName(s) {
  const name = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Give the club a name.');
  if (name.length > MAX_CLUB_NAME) throw new Error(`Club names can be at most ${MAX_CLUB_NAME} characters.`);
  return name;
}

const playerName = s => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_PLAYER_NAME) || 'Player';

export function newInvite() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => TOKEN_CHARS[b % TOKEN_CHARS.length]).join('');
}

export function newClub(name, code, hostId, now = Date.now()) {
  return ensureChips({v: 1, code, name: clubName(name), hostId, invite: newInvite(), createdAt: now, members: {}});
}

// A new invite token; the old link stops working for people who haven't
// asked to join yet. Pending requests and members aren't affected.
export function revokeInvite(club) {
  club.invite = newInvite();
}

// The invite link for `club` on a page at `base` (location.href), carrying
// `relay` when it isn't the default.
// The link also names the club and, given `by`, who sent it (#185), so the
// page it opens can say what you're joining. They're only for showing: the
// club's real name comes from its host once you've asked.
export function inviteLink(club, base, relay = '', by = '') {
  const u = new URL(base);
  u.search = '';
  u.searchParams.set('club', club.code);
  u.searchParams.set('invite', club.invite);
  u.searchParams.set('host', club.hostId);
  if (club.name) u.searchParams.set('name', club.name);
  if (by) u.searchParams.set('by', by);
  if (relay) u.searchParams.set('relay', relay);
  u.hash = 'join';
  return u.toString();
}

// The invite in a page address, or null: {code, invite, hostId}, with the
// club's `name` and who it's `by` when the link has them.
export function parseInvite(href) {
  const p = new URL(href).searchParams;
  const code = normCode(p.get('club') || '');
  const invite = p.get('invite') || '';
  const host = p.get('host') || '';
  if (!code || !invite || !host) return null;
  const inv = {code, invite, hostId: host};
  const name = (p.get('name') || '').trim().slice(0, MAX_CLUB_NAME);
  const by = (p.get('by') || '').trim().slice(0, MAX_PLAYER_NAME);
  if (name) inv.name = name;
  if (by) inv.by = by;
  return inv;
}

export const statusBody = (club, id) => ({type: 'status', club: club.code, name: club.name, status: club.members[id]?.status || 'unknown'});

const reply = (club, id) => ({to: id, body: statusBody(club, id)});

// The host handles one envelope from the relay. Returns {replies: [{to, body}],
// changed, reason}: replies to sign and send, whether the club changed (save
// it), and why a message was refused.
export async function hostReceive(club, verifier, env, now = Date.now()) {
  const v = await verifier.verify(env);
  if (!v.ok) return {replies: [], changed: false, reason: v.reason};
  const id = v.from, body = v.body || {};
  if (body.club !== club.code) return {replies: [], changed: false, reason: 'wrong club'};
  ensureChips(club);
  const m = club.members[id];
  // An always-on club's owner (#93), who runs it from their page: their
  // check-ins and commands. The caller handles them (club-server.js).
  if (body.type === 'owner_hello' || body.type === 'owner_cmd') {
    if (!club.ownerId || id !== club.ownerId) return {replies: [], changed: false, reason: 'not the owner'};
    return {replies: [], changed: false, owner: {type: body.type, from: id, body}};
  }
  if (body.type === 'join') {
    const name = playerName(body.name);
    if (m?.status === 'member' || m?.status === 'pending') {
      const changed = m.name !== name;
      m.name = name;
      return {replies: [reply(club, id)], changed};
    }
    // The club's link, or an agent's (#74): their recruits wait for the agent.
    const agent = body.invite && Object.values(club.members).find(a => a.agent === 'yes' && a.status === 'member' && a.agentInvite === body.invite);
    if (body.invite !== club.invite && !agent) return {replies: [{to: id, body: {...statusBody(club, id), status: 'bad_invite'}}], changed: false, reason: 'bad invite'};
    // New, or asking again after being declined or removed.
    club.members[id] = {...m, id, name, status: 'pending', requestedAt: now};
    if (agent) club.members[id].agentOf = agent.id;
    ensureChips(club);
    return {replies: [reply(club, id)], changed: true};
  }
  if (body.type === 'hello') {
    let changed = false;
    if (m && body.name) { const name = playerName(body.name); changed = m.name !== name; m.name = name; }
    const replies = [reply(club, id)];
    if (m?.status === 'member') replies.push(account(club, id, body.since));
    return {replies, changed};
  }
  // Game assistants (#62) and agents (#74–#76): an answer to a role offer,
  // or a command. The caller handles them (club-roles.js, club-agents.js).
  if (['role_reply', 'admin_cmd', 'agent_reply', 'agent_cmd'].includes(body.type)) {
    if (m?.status !== 'member') return {replies: [reply(club, id)], changed: false, reason: 'not a member'};
    return {replies: [], changed: false, admin: {type: body.type, from: id, body}};
  }
  // A command for one of the club's tables (#68): signed, so a player can
  // prove what they did. The caller runs it (club-host.js).
  if (body.type === 'table') {
    if (m?.status !== 'member') return {replies: [reply(club, id)], changed: false, reason: 'not a member'};
    if (typeof body.table !== 'string' || !body.cmd || typeof body.cmd !== 'object') return {replies: [], changed: false, reason: 'bad table command'};
    return {replies: [], changed: false, table: {id: body.table, cmd: body.cmd, from: id}};
  }
  // Registering for a tournament, and the like (club-tourneys.js): the
  // caller runs it (club-server.js).
  if (body.type === 'tourney') {
    if (m?.status !== 'member') return {replies: [reply(club, id)], changed: false, reason: 'not a member'};
    if (typeof body.tourney !== 'string' || !['register', 'unregister', 'enter'].includes(body.op)) return {replies: [], changed: false, reason: 'bad tournament command'};
    return {replies: [], changed: false, tourney: {id: body.tourney, op: body.op, from: id}};
  }
  if (body.type === 'chip_request' || body.type === 'cancel_request') {
    if (m?.status !== 'member') return {replies: [reply(club, id)], changed: false, reason: 'not a member'};
    try {
      if (body.type === 'chip_request') requestChips(club, id, body.amount, body.note, now);
      else cancelRequest(club, id);
    } catch (e) {
      return {replies: [account(club, id, Infinity)], changed: false, reason: e.message};
    }
    return {replies: [account(club, id, Infinity)], changed: true};
  }
  return {replies: [], changed: false, reason: 'unknown message'};
}

// A member's account as a reply. `since` is the last entry they have, so
// only newer entries are sent (Infinity: none, just the balance and request).
export function account(club, id, since = 0) {
  const s = Number.isFinite(since) ? Math.max(0, Math.floor(since)) : Number.MAX_SAFE_INTEGER;
  return {to: id, body: accountBody(club, id, s)};
}

function setStatus(club, id, status, now, from) {
  const m = club.members[id];
  if (!m || !from.includes(m.status)) return null;
  m.status = status;
  if (status === 'member') m.joinedAt = now;
  m.changedAt = now;
  return reply(club, id);
}

// The host's decisions. Each returns the reply to send, or null if it didn't apply.
export const approve = (club, id, now = Date.now()) => setStatus(club, id, 'member', now, ['pending']);
export const decline = (club, id, now = Date.now()) => setStatus(club, id, 'declined', now, ['pending']);
// Removing a member: the host takes back their whole club balance first
// (#66), and any open chip request goes. Returns the replies to send (status,
// and the account showing the reclaim), or null. A member seated at a table
// is cashed out by the table first (#68).
export function removeMember(club, id, now = Date.now()) {
  ensureChips(club);
  const m = club.members[id];
  if (!m || !['member', 'pending'].includes(m.status) || m.seat) return null;
  const hadChips = m.balance > 0;
  if (hadChips) reclaim(club, id, m.balance, now, 'Removed from the club');
  m.request = null;
  const status = setStatus(club, id, 'removed', now, ['member', 'pending']);
  return hadChips ? [status, account(club, id, 0)] : [status];
}

export function membersByStatus(club, status) {
  return Object.values(club.members).filter(m => m.status === status)
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
}

// ---- the player's side ----

// A club the player has asked to join: {code, name, hostId, invite, status, hostSeq}.
export function newMembership(inv) {
  // The link's name until the host's own arrives.
  return {code: inv.code, hostId: inv.hostId, invite: inv.invite, name: inv.name || '', status: 'new', hostSeq: 0};
}

// The player handles one envelope from the host. Returns true if it updated
// the membership. Anything not signed by the club's host, or replayed, is
// ignored.
export async function playerReceive(mem, env) {
  if (!env || env.from !== mem.hostId || !(env.seq > mem.hostSeq)) return false;
  // The first valid message pins the host's full key, so later ones can't
  // come from another key that happens to share the 8-character ID.
  if (mem.hostPub && env.pub !== mem.hostPub) return false;
  if (await checkSignature(env)) return false;
  mem.hostPub = env.pub;
  const b = env.body || {};
  if (b.club !== mem.code) return false;
  // The club moved to an always-on room on the relay (#98), signed by the
  // host it had: from now on it signs as `hostId`.
  if (b.type === 'host_moved') {
    if (!isPlayerId(b.hostId) || b.hostId === mem.hostId) return false;
    mem.hostId = b.hostId;
    mem.hostPub = null;
    mem.hostSeq = 0;
    mem.hostKey = null;
    return true;
  }
  if (b.type === 'status') {
    mem.hostSeq = env.seq;
    if (b.name) mem.name = String(b.name).slice(0, MAX_CLUB_NAME);
    if (b.status !== 'unknown') mem.status = b.status;
    return true;
  }
  if (b.type === 'tables') {
    mem.hostSeq = env.seq;
    mem.tables = Array.isArray(b.tables) ? b.tables : [];
    mem.rathole = Number(b.rathole) || 0;
    return true;
  }
  if (b.type === 'tourneys') {
    mem.hostSeq = env.seq;
    mem.tourneys = Array.isArray(b.tourneys) ? b.tourneys : [];
    return true;
  }
  if (b.type === 'tourney_error') {
    mem.hostSeq = env.seq;
    mem.tourneyError = {tourney: b.tourney, reason: String(b.reason || '')};
    return true;
  }
  if (b.type === 'role') {
    mem.hostSeq = env.seq;
    mem.role = b.role || null;
    if (mem.role !== 'assistant') mem.admin = null;
    return true;
  }
  if (b.type === 'admin') {
    mem.hostSeq = env.seq;
    mem.admin = {pending: b.pending || [], members: b.members || [], tables: b.tables || []};
    return true;
  }
  // The host's key for this session's encrypted table updates (e2e.js),
  // signed by the host like every other message here.
  if (b.type === 'host_key') {
    mem.hostSeq = env.seq;
    mem.hostKey = typeof b.key === 'string' ? b.key : null;
    return true;
  }
  // The host couldn't seat this player at a table (e.g. no encryption key).
  if (b.type === 'table_error') {
    mem.hostSeq = env.seq;
    mem.tableError = {table: b.table, reason: String(b.reason || '')};
    return true;
  }
  if (b.type === 'agent_role') {
    mem.hostSeq = env.seq;
    mem.agent = b.agent || null;
    mem.creditLimit = Number(b.creditLimit) || 0;
    if (mem.agent !== 'yes') mem.agentView = null;
    return true;
  }
  if (b.type === 'agent') {
    mem.hostSeq = env.seq;
    mem.agentView = {own: b.own, shares: b.shares, total: b.total, limit: b.limit, creditUsed: b.creditUsed, room: b.room, invite: b.invite, recruits: b.recruits || [], players: b.players || []};
    return true;
  }
  if (b.type === 'admin_result') {
    mem.hostSeq = env.seq;
    mem.adminNote = b.error ? String(b.error) : '';
    return true;
  }
  if (b.type === 'account') {
    mem.hostSeq = env.seq;
    mem.balance = Number(b.balance) || 0;
    mem.request = b.request || null;
    const have = new Set((mem.entries || []).map(e => e.n));
    const fresh = (Array.isArray(b.entries) ? b.entries : []).filter(e => Number.isSafeInteger(e?.n) && !have.has(e.n));
    mem.entries = [...(mem.entries || []), ...fresh].sort((x, y) => x.n - y.n);
    // Keep the signed messages that brought entries: they prove the balance.
    if (fresh.length) mem.receipts = [...(mem.receipts || []), env];
    mem.ledgerOk = checkOwnLedger(mem.entries, mem.balance);
    return true;
  }
  return false;
}

// The last ledger entry this player has, for 'hello'.
export const lastEntry = mem => (mem.entries?.length ? mem.entries[mem.entries.length - 1].n : 0);
