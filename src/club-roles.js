// Game assistants (#62): members the host appoints to help run the club.
// Pure functions over the club object; clubs.js carries the messages.
//
// The host offers the role; the member accepts or declines; the host can
// revoke it. An assistant works through the host's tab (the club lives
// there): the host sends them a view of the club ('admin'), and they send
// signed commands ('admin_cmd') that the host checks and carries out:
//   approve | decline        a join request
//   remove                   a member (their balance goes back to the host)
//   give                     chips from the assistant's own balance
//   grant | deny             a member's chip request (granted from the assistant's balance)
//   new_table | close_table | hide_table
// Assistants can't create chips, change club settings, or appoint anyone.
// Every assistant action goes in the club's activity log, which the host sees.

import { approve, decline, removeMember, account } from './club.js';
import { chipText } from './chip-format.js';
import { answerRequest, declineRequest, ensureChips, transfer } from './club-chips.js';
import { newTable, tableById } from './club-tables.js';

export const MAX_LOG = 500;

export const isAssistant = (club, id) => club.members[id]?.status === 'member' && club.members[id]?.role === 'assistant';

// `amount`: the chips an action moved, so the host can spot big ones (#190).
export function logAction(club, by, text, now = Date.now(), amount = null) {
  club.log ??= [];
  club.log.push(amount == null ? {at: now, by, text} : {at: now, by, text, amount});
  if (club.log.length > MAX_LOG) club.log.splice(0, club.log.length - MAX_LOG);
}

// The size from which a chip move counts as big (#190): a full buy-in at
// the club's biggest open table (its maximum, in big blinds, times its big
// blind), or null when no table is open to measure by.
export function bigMove(club) {
  const buyIns = (club.tables || [])
    .filter(t => t.status !== 'closed' && t.bb > 0)
    .map(t => t.bb * (t.maxBB || 100));
  return buyIns.length ? Math.max(...buyIns) : null;
}

// Whether a log entry moved at least `threshold` chips.
export const isBigMove = (entry, threshold) => threshold != null && entry.amount != null && entry.amount >= threshold;

const roleBody = (club, id) => ({type: 'role', club: club.code, role: club.members[id]?.role || null});

// The host offers member `id` the assistant role. Returns the reply.
export function offerAssistant(club, id) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Only members can be assistants.');
  if (m.role === 'assistant') throw new Error(`${m.name} is already an assistant.`);
  m.role = 'offered';
  return {to: id, body: roleBody(club, id)};
}

export function revokeRole(club, id, now = Date.now()) {
  const m = club.members[id];
  if (!m?.role) return null;
  const was = m.role;
  delete m.role;
  if (was === 'assistant') logAction(club, club.hostId, `${m.name} is no longer an assistant`, now);
  return {to: id, body: roleBody(club, id)};
}

// The member's answer to an offer.
export function answerRole(club, id, accept, now = Date.now()) {
  const m = club.members[id];
  if (m?.role !== 'offered') return null;
  if (accept) {
    m.role = 'assistant';
    logAction(club, id, `${m.name} became an assistant`, now);
  } else delete m.role;
  return {to: id, body: roleBody(club, id)};
}

// What an assistant sees: requests, members (balances and requests) and tables.
export function adminBody(club, seatedCounts = {}) {
  ensureChips(club);
  const ms = Object.values(club.members);
  return {
    type: 'admin', club: club.code,
    pending: ms.filter(m => m.status === 'pending').map(m => ({id: m.id, name: m.name, at: m.requestedAt})),
    members: ms.filter(m => m.status === 'member').map(m => ({
      id: m.id, name: m.name, balance: m.balance, request: m.request || null, seated: !!m.seat, assistant: m.role === 'assistant',
    })),
    tables: (club.tables || []).filter(t => !t.hidden).map(t => ({
      id: t.id, name: t.name, game: t.game, sb: t.sb, bb: t.bb, minBB: t.minBB, maxBB: t.maxBB, seats: t.seats,
      status: t.status, taken: seatedCounts[t.id] || 0,
    })),
  };
}

// Carries out an assistant's command. Returns {replies, table} where table
// is {start: t} or {close: id} for the host's table runtime, or throws why not.
export function runAdmin(club, by, cmd, now = Date.now(), limits = null) {
  if (!isAssistant(club, by)) throw new Error('You’re not an assistant in this club.');
  const a = club.members[by];
  const target = cmd?.id ? club.members[cmd.id] : null;
  const who = target?.name || cmd?.id;
  switch (cmd?.op) {
    case 'approve': {
      const r = approve(club, cmd.id, now);
      if (!r) throw new Error('No such request.');
      logAction(club, by, `${a.name} approved ${who}`, now);
      return {replies: [r], approved: cmd.id};
    }
    case 'decline': {
      const r = decline(club, cmd.id, now);
      if (!r) throw new Error('No such request.');
      logAction(club, by, `${a.name} declined ${who}`, now);
      return {replies: [r]};
    }
    case 'remove': {
      if (cmd.id === by) throw new Error('You can’t remove yourself.');
      const r = removeMember(club, cmd.id, now);
      if (!r) throw new Error(target?.seat ? `${who} is at a table; they need to leave it first.` : 'No such member.');
      logAction(club, by, `${a.name} removed ${who}`, now);
      return {replies: r};
    }
    case 'give': {
      const [out] = transfer(club, by, cmd.id, Number(cmd.amount), now, cmd.note);
      logAction(club, by, `${a.name} gave ${who} ${chipText(out.amount)}`, now, out.amount);
      return {replies: [account(club, by, out.n - 1), account(club, cmd.id, out.n)]};
    }
    case 'grant': {
      if (!target?.request) throw new Error('There’s no request to grant.');
      const amt = Number(cmd.amount ?? target.request.amount);
      const [out] = transfer(club, by, cmd.id, amt, now, target.request.note);
      answerRequest(club, cmd.id, 'granted', {given: amt, by, now});
      logAction(club, by, `${a.name} granted ${who} ${chipText(amt)}`, now, amt);
      return {replies: [account(club, by, out.n - 1), account(club, cmd.id, out.n)]};
    }
    case 'deny': {
      if (!declineRequest(club, cmd.id, cmd.note, now, by)) throw new Error('There’s no request to decline.');
      logAction(club, by, `${a.name} declined ${who}’s chip request`, now);
      return {replies: [account(club, cmd.id, Infinity)]};
    }
    case 'new_table': {
      const t = newTable(club, cmd.table || {}, now, limits);
      logAction(club, by, `${a.name} opened table ${t.name}`, now);
      return {replies: [], table: {start: t}};
    }
    case 'close_table': {
      const t = tableById(club, cmd.table);
      if (!t || t.status !== 'open') throw new Error('That table isn’t open.');
      t.status = 'closing';
      logAction(club, by, `${a.name} closed table ${t.name}`, now);
      return {replies: [], table: {close: t.id}};
    }
    case 'hide_table': {
      const t = tableById(club, cmd.table);
      if (!t || t.status !== 'closed') throw new Error('Only closed tables can be removed.');
      t.hidden = true;
      logAction(club, by, `${a.name} removed table ${t.name} from the list`, now);
      return {replies: []};
    }
    default:
      throw new Error('Unknown command.');
  }
}
