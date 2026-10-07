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
//   {type: 'hello', club, name}          a member or applicant checking in
// Host → player bodies:
//   {type: 'status', club, name, status} status: 'pending' | 'member' | 'declined'
//                                        | 'removed' | 'bad_invite' | 'unknown'

import { checkSignature } from './identity.js';

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
  return {v: 1, code, name: clubName(name), hostId, invite: newInvite(), createdAt: now, members: {}};
}

// A new invite token; the old link stops working for people who haven't
// asked to join yet. Pending requests and members aren't affected.
export function revokeInvite(club) {
  club.invite = newInvite();
}

// The invite link for `club` on a page at `base` (location.href), carrying
// `relay` when it isn't the default.
export function inviteLink(club, base, relay = '') {
  const u = new URL(base);
  u.search = '';
  u.searchParams.set('club', club.code);
  u.searchParams.set('invite', club.invite);
  u.searchParams.set('host', club.hostId);
  if (relay) u.searchParams.set('relay', relay);
  u.hash = 'clubs';
  return u.toString();
}

// The invite in a page address, or null.
export function parseInvite(href) {
  const p = new URL(href).searchParams;
  const code = (p.get('club') || '').toUpperCase();
  const invite = p.get('invite') || '';
  const host = p.get('host') || '';
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) || !invite || !host) return null;
  return {code, invite, hostId: host};
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
  const m = club.members[id];
  if (body.type === 'join') {
    const name = playerName(body.name);
    if (m?.status === 'member' || m?.status === 'pending') {
      const changed = m.name !== name;
      m.name = name;
      return {replies: [reply(club, id)], changed};
    }
    if (body.invite !== club.invite) return {replies: [{to: id, body: {...statusBody(club, id), status: 'bad_invite'}}], changed: false, reason: 'bad invite'};
    // New, or asking again after being declined or removed.
    club.members[id] = {...m, id, name, status: 'pending', requestedAt: now};
    return {replies: [reply(club, id)], changed: true};
  }
  if (body.type === 'hello') {
    let changed = false;
    if (m && body.name) { const name = playerName(body.name); changed = m.name !== name; m.name = name; }
    return {replies: [reply(club, id)], changed};
  }
  return {replies: [], changed: false, reason: 'unknown message'};
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
// Removing a member. Their chips go back to the host once the ledger exists (#67).
export const removeMember = (club, id, now = Date.now()) => setStatus(club, id, 'removed', now, ['member', 'pending']);

export function membersByStatus(club, status) {
  return Object.values(club.members).filter(m => m.status === status)
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
}

// ---- the player's side ----

// A club the player has asked to join: {code, name, hostId, invite, status, hostSeq}.
export function newMembership(inv) {
  return {code: inv.code, hostId: inv.hostId, invite: inv.invite, name: '', status: 'new', hostSeq: 0};
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
  if (b.type !== 'status' || b.club !== mem.code) return false;
  mem.hostSeq = env.seq;
  if (b.name) mem.name = String(b.name).slice(0, MAX_CLUB_NAME);
  if (b.status !== 'unknown') mem.status = b.status;
  return true;
}
