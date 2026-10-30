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

import { checkSignature, isPlayerId } from './identity.js';
import { normCode } from './play-net.js';
import { accountBody, cancelRequest, checkOwnLedger, ensureChips, requestChips } from './club-chips.js';
import { command } from './club-commands.js';
import { nameKey, newRules, rules } from './club-rules.js';
import { readLobby } from './club-lobby.js';
import { readInfo } from './club-info.js';

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
// ducy-play's club host does it (its 'remove' command).
export function removeMember(club, id, now = Date.now()) {
  ensureChips(club);
  const out = command(club, 'remove', {id}, now);
  if (!out.replies.length) return null;
  return [...out.replies, ...out.accounts.map(a => account(club, a.id, a.since ?? Infinity))];
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
    // The name you asked for is someone else's here (#450).
    if (b.nameTaken) mem.nameTaken = String(b.nameTaken).slice(0, MAX_PLAYER_NAME);
    else delete mem.nameTaken;
    return true;
  }
  if (b.type === 'tables') {
    mem.hostSeq = env.seq;
    mem.tables = Array.isArray(b.tables) ? b.tables : [];
    mem.rathole = Number(b.rathole) || 0;
    // No backup of the club proved yet (#395).
    mem.temporary = b.temporary === true;
    return true;
  }
  if (b.type === 'help') {
    mem.hostSeq = env.seq;
    mem.staff = Array.isArray(b.staff) ? b.staff : [];
    mem.help = Array.isArray(b.mine) ? b.mine : [];
    return true;
  }
  if (b.type === 'lobby') {
    mem.hostSeq = env.seq;
    mem.lobby = readLobby(b);
    return true;
  }
  if (b.type === 'tourneys') {
    mem.hostSeq = env.seq;
    mem.tourneys = Array.isArray(b.tourneys) ? b.tourneys : [];
    return true;
  }
  // High Hand promotions (#267, club-promos.js): what's running, and a
  // moment worth telling the member about (a prize, a new leader).
  if (b.type === 'promos') {
    mem.hostSeq = env.seq;
    mem.promos = {promos: Array.isArray(b.promos) ? b.promos : [], recent: Array.isArray(b.recent) ? b.recent : []};
    return true;
  }
  // The owner's view of the whole club, and how their action went (#93).
  if (b.type === 'owner_view') {
    mem.hostSeq = env.seq;
    if (!b.data || typeof b.data !== 'object') return false;
    mem.mgr = {data: b.data, seated: b.seated || {}, running: b.running || [], online: b.online || [], tourneys: b.tourneys || {}, plan: b.plan || null, owner: b.owner === true, seen: b.seen || {}};
    return true;
  }
  if (b.type === 'owner_result') {
    mem.hostSeq = env.seq;
    mem.mgrResult = {id: b.id, error: String(b.error || ''), value: b.value ?? null};
    return true;
  }
  // Club info (#398, club-info.js).
  if (b.type === 'info') {
    mem.hostSeq = env.seq;
    mem.info = readInfo(b.info);
    return true;
  }
  if (b.type === 'promo_event') {
    mem.hostSeq = env.seq;
    mem.promoEvent = {kind: b.kind === 'award' ? 'award' : 'lead', text: String(b.text || '').slice(0, 200), at: env.seq};
    return true;
  }
  // Grouped tables (#501): "We're starting a new table. Join?" (ask), the
  // table it opened for you (open), or the question closed (closed, with
  // why, when you'd said yes).
  if (b.type === 'group') {
    mem.hostSeq = env.seq;
    const kind = ['ask', 'open', 'closed'].includes(b.kind) ? b.kind : 'closed';
    mem.groupAsk = kind === 'ask' ? {group: String(b.group || ''), name: String(b.name || '').slice(0, 60), until: Number(b.until) || 0} : null;
    mem.groupEvent = {kind, group: String(b.group || ''), table: String(b.table || ''), name: String(b.name || '').slice(0, 60), reason: String(b.reason || '').slice(0, 200)};
    return true;
  }
  if (b.type === 'tourney_error') {
    mem.hostSeq = env.seq;
    mem.tourneyError = {tourney: b.tourney, reason: String(b.reason || '')};
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
    if (mem.agent !== 'yes') mem.agentView = null;
    return true;
  }
  if (b.type === 'agent') {
    mem.hostSeq = env.seq;
    mem.agentView = {own: b.own, shares: b.shares, total: b.total, limit: b.limit, creditUsed: b.creditUsed, room: b.room, owed: b.owed ?? b.creditUsed, invite: b.invite, recruits: b.recruits || [], players: b.players || []};
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
    // A credit player's limit and what they may sit with (#404). From an
    // older host without them: the balance.
    mem.credit = Number(b.credit) || 0;
    mem.available = b.available == null ? Math.max(0, mem.balance) : Number(b.available) || 0;
    mem.request = b.request || null;
    // A cancel sent while the host was away has reached them (#188).
    delete mem.cancelQueued;
    // How their last request was answered (#188).
    if (b.answer !== undefined) mem.answer = b.answer || null;
    // The club's moved to the money model's ledger (#454): the copy starts
    // again from its entries, and the older one is kept with its receipts.
    if (b.ledger === 'links' && mem.ledger !== 'links') {
      if (mem.entries?.length) mem.before = {entries: mem.entries, receipts: mem.receipts || []};
      mem.entries = [];
      mem.receipts = [];
      mem.ledger = 'links';
    }
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

// The last ledger entry this player has, for 'hello' (0: an older copy, or none).
export const lastEntry = mem => (mem.ledger === 'links' && mem.entries?.length ? mem.entries[mem.entries.length - 1].n : 0);
