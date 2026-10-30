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
//   {type: 'join', club, invite, name}   ask to join (or update a pending request);
//                                        no invite: by the club's code, when the
//                                        club allows it (codeJoin, #393)
//   {type: 'hello', club, name, since, ledger}   a member or applicant checking in;
//                                        `since` is the last ledger entry they have,
//                                        `ledger: 'links'` when their copy is the
//                                        money model's (#454)
//   {type: 'chip_request', club, amount, note, table?}   ask the host for chips (#67),
//                                        from a table when nothing's available (#404)
//   {type: 'cancel_request', club}
//   {type: 'table', club, table, cmd}    a command for a club table (#68): join, act,
//                                        sit_in, leave, request_chips; a tournament's
//                                        tables are table 'tourney:<id>' (#81)
//   {type: 'tourney', club, tourney, op} op: 'register' | 'unregister' (#77), or
//                                        'enter' (late registration or re-entry, #80)
//   {type: 'help_ask', club, text, table}   ask the host for help (#192)
//   {type: 'lobby_say', club, text}      a line in the lobby chat (club-lobby.js)
// Host → player bodies:
//   {type: 'status', club, name, status} status: 'pending' | 'member' | 'declined'
//                                        | 'removed' | 'bad_invite' | 'unknown'
//                                        | 'invite_only' (asked by code, #393);
//                                        nameTaken: the name asked for, when
//                                        someone in the club has it (#450)
//   {type: 'account', club, balance, request, entries, credit, available, ledger}
//                                        see club-chips.js (credit: #404)
//   {type: 'tables', club, tables}       the open tables (club-tables.js)
//   {type: 'tourneys', club, tourneys}   the tournaments (club-tourneys.js)
//   {type: 'tourney_error', club, tourney, reason}   why a tournament op was refused
//   {type: 'admin_result', club, error}  how an agent's command went
//   {type: 'host_key', club, key}        the host's session key for table updates
//   {type: 'help', club, staff, mine}    who's around to help, and your latest
//                                        help requests (club-help.js, #192)
//   {type: 'lobby', club, online, chat}  who's online, and the lobby chat
//                                        (club-lobby.js)
//   {type: 'info', club, info}           the club info (club-info.js, #398)
//   {type: 'group', club, group, kind, name, until?, table?, reason?}
//                                        grouped tables (#501): kind 'ask' (a new
//                                        table, Join?), 'open' or 'closed'
// Join and hello carry the player's session key ({key}). Table updates go
// to players encrypted, {type: 'table', table, enc: {iv, ct}} (e2e.js), so
// the relay never sees hole cards and can't forge an update.

import * as ducy from '../wasm/ducy_wasm.js';
import { checkSignature } from './identity.js';
import { normCode } from './play-net.js';
import { accountBody, backerTake, cancelRequest, ensureChips, reclaim, requestChips } from './club-chips.js';
import { backerOf, CLUB } from './club-money.js';
import { nameKey, newRules, rules } from './club-rules.js';

export const MAX_CLUB_NAME = 50;
export const MAX_PLAYER_NAME = 20;
const TOKEN_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// A club's name, tidied; throws if it's empty or too long.
export const clubName = s => newRules(s, '', '').name;

// Names in a club are unique (#450): ducy-play's nameKey says what a name
// reads as, whatever its case, spacing, punctuation, accents and look-alike
// letters.
export { nameKey };

// An agent's invite token (club-agents.js).
export function newInvite() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => TOKEN_CHARS[b % TOKEN_CHARS.length]).join('');
}

export function newClub(name, code, hostId, now = Date.now()) {
  return ensureChips(newRules(name, code, hostId, now));
}

// A new invite token; the old link stops working for people who haven't
// asked to join yet. Pending requests and members aren't affected.
export function revokeInvite(club) {
  rules(club, {op: 'revokeInvite'});
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

// The host handles one envelope from the relay. Returns {replies: [{to, body}],
// changed, reason}: replies to sign and send, whether the club changed (save
// it), and why a message was refused. ducy-play's club rules decide joins,
// names and who may send what; what they pass on is the caller's (club-server.js):
//   owner    an always-on club's owner's check-in or command (#93)
//   admin    an agent's answer or command (#74–#76, club-agents.js)
//   table    a command for a club table (#68, club-host.js), signed, so a
//            player can prove what they did
//   tourney  registering for a tournament, and the like (club-tourneys.js)
//   help     a help request (club-help.js, #192)
//   lobby    a line in the lobby chat (club-lobby.js)
// Chip requests (#67, from a table when nothing's left to add there, #404)
// and a member's account on hello are handled here (club-chips.js).
export async function hostReceive(club, verifier, env, now = Date.now()) {
  const v = await verifier.verify(env);
  if (!v.ok) return {replies: [], changed: false, reason: v.reason};
  const id = v.from, body = v.body || {};
  ensureChips(club);
  const {account: since, chips, ...r} = rules(club, {op: 'receive', from: id, body}, now);
  // A new request gets the chip fields.
  if (r.changed) ensureChips(club);
  if (since !== undefined) r.replies.push(account(club, id, since));
  if (!chips) return r;
  try {
    if (chips.type === 'chip_request') requestChips(club, id, chips.amount, chips.note, now, {table: chips.table});
    else cancelRequest(club, id);
  } catch (e) {
    return {replies: [account(club, id, Infinity)], changed: false, reason: e.message};
  }
  return {replies: [account(club, id, Infinity)], changed: true};
}

// A member's account as a reply. `since` is the last entry they have, so
// only newer entries are sent (Infinity: none, just the balance and request).
export function account(club, id, since = 0) {
  const s = Number.isFinite(since) ? Math.max(0, Math.floor(since)) : Number.MAX_SAFE_INTEGER;
  return {to: id, body: accountBody(club, id, s)};
}

// The host's decisions. Each returns the reply to send, or null if it didn't apply.
export const approve = (club, id, now = Date.now()) => rules(club, {op: 'approve', id}, now);
export const decline = (club, id, now = Date.now()) => rules(club, {op: 'decline', id}, now);
// Removing a member: their backer (the club, or their agent) takes back
// their whole balance first (#66, #454), and any open chip request goes.
// Returns the replies to send (status, and the account showing the
// reclaim), or null. A member seated at a table is cashed out by the table
// first (#68).
export function removeMember(club, id, now = Date.now()) {
  ensureChips(club);
  if (!rules(club, {op: 'removable', id})) return null;
  const m = club.members[id];
  const hadChips = m.balance > 0;
  if (hadChips) {
    const backer = backerOf(club, m);
    if (backer === CLUB) reclaim(club, id, m.balance, now, 'Removed from the club');
    else backerTake(club, backer, id, m.balance, now, 'Removed from the club');
  }
  m.request = null;
  const status = rules(club, {op: 'remove', id}, now);
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
// ignored. ducy-play's club_member (#456) says whether it's worth checking
// (from the host, newer, from the key the first message pinned) and takes
// it in, checked and cut to size; the signature is checked here.
export async function playerReceive(mem, env) {
  if (!env || typeof env !== 'object') return false;
  const pin = {hostId: mem.hostId, hostSeq: mem.hostSeq, hostPub: mem.hostPub ?? null};
  if (!ducy.memberFromHost(JSON.stringify(pin), JSON.stringify(env))) return false;
  if (await checkSignature(env)) return false;
  const r = ducy.memberTake(JSON.stringify(mem), JSON.stringify(env));
  for (const k of Object.keys(mem)) if (!(k in r.mem)) delete mem[k];
  Object.assign(mem, r.mem);
  return r.changed;
}

// The last ledger entry this player has, for 'hello' (0: an older copy, or none).
export const lastEntry = mem => (mem.ledger === 'links' && mem.entries?.length ? mem.entries[mem.entries.length - 1].n : 0);
