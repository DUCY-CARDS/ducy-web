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
//   remove_player | keep_player  stand a player up from a table, or Undo (#414)
//   move_player              move a player to a seat held at another table (#425)
//   new_promo | edit_promo | promo_status | approve_award | void_award
//                            High Hand promotions (#274): set up and run
//                            them, pay a prize held over budget, void one
// Assistants can't create chips (beyond promotion prizes the host's
// promotions pay), change club settings, or appoint anyone.
// Every assistant action goes in the club's activity log, which the host sees.

import { approve, decline, removeMember, account } from './club.js';
import { chipText } from './chip-format.js';
import { answerRequest, checkGrant, declineRequest, ensureChips, transfer } from './club-chips.js';
import { newTable, tableById } from './club-tables.js';
import { approveAward, editPromo, newPromo, promosAdmin, setPromoStatus, voidAward } from './club-promos.js';

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

// ---- managers (#417) ----
// Game assistants are now the club's managers: in an always-on club they
// run it from the owner's page (owner_view, owner_cmd, club-server.js), with
// the owner's actions except these, which stay the owner's: adding and
// removing managers, settings and services, agents, backup, deleting it.
// (The `role` field keeps its name, 'assistant'.)
export const OWNER_ONLY = new Set([
  'offer_assistant', 'revoke_role', 'settings', 'service_add', 'service_update', 'service_revoke',
  'offer_agent', 'credit_limit', 'revoke_agent', 'assign_agent', 'settle', 'delete_club', 'backup_proved',
]);

// Throws if manager `by` may not run `op` on its target: only the owner
// removes a manager, and no one removes the owner.
export function checkManagerOp(club, by, op, args = {}) {
  if (OWNER_ONLY.has(op)) throw new Error('Only the club’s owner can do that.');
  const t = club.members[args.id];
  if (op === 'remove' && t && (t.id === club.ownerId || t.role === 'assistant')) throw new Error('Only the club’s owner can remove a manager.');
}

// What manager `by` did with `op`, for the activity log; '' for what changes
// nothing (looking at hands, watching).
export function managerLogText(club, by, op, args = {}) {
  const who = club.members[by]?.name || 'A manager';
  const name = club.members[args.id]?.name || 'someone';
  const amt = Number.isSafeInteger(args.amount) ? chipText(args.amount) : '';
  const table = tableById(club, args.table)?.name || 'a table';
  const text = {
    approve: `let ${name} in`, decline: `declined ${name}`, remove: `removed ${name} from the club`,
    give: `gave ${name} ${amt}`, take: `took back ${amt} from ${name}`, grant: `granted ${name}’s chip request${amt ? ` (${amt})` : ''}`,
    deny: `declined ${name}’s chip request`, revoke_invite: 'made a new invite link',
    new_table: `opened table ${args.table?.name || ''}`.trim(), close_table: `closed ${table}`,
    new_tourney: `scheduled the tournament ${args.tourney?.name || ''}`.trim(), cancel_tourney: 'cancelled a tournament', set_payout: 'changed a tournament’s payouts',
    new_promo: `started the promotion ${args.promo?.name || ''}`.trim(), edit_promo: 'changed a promotion', promo_status: `set a promotion to ${args.status}`,
    approve_award: 'paid a promotion prize', void_award: 'voided a promotion prize',
    help_answer: 'answered a help request',
  }[op];
  return text ? `${who} ${text}` : '';
}

const roleBody = (club, id) => ({type: 'role', club: club.code, role: club.members[id]?.role || null});

// The host offers member `id` the assistant role. Returns the reply.
export function offerAssistant(club, id) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Only members can be managers.');
  if (m.role === 'assistant') throw new Error(`${m.name} is already a manager.`);
  m.role = 'offered';
  return {to: id, body: roleBody(club, id)};
}

export function revokeRole(club, id, now = Date.now()) {
  const m = club.members[id];
  if (!m?.role) return null;
  const was = m.role;
  delete m.role;
  if (was === 'assistant') logAction(club, club.hostId, `${m.name} is no longer a manager`, now);
  return {to: id, body: roleBody(club, id)};
}

// The member's answer to an offer.
export function answerRole(club, id, accept, now = Date.now()) {
  const m = club.members[id];
  if (m?.role !== 'offered') return null;
  if (accept) {
    m.role = 'assistant';
    logAction(club, id, `${m.name} became a manager`, now);
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
      // Who's at it, for Remove from table (#414).
      players: ms.filter(m => m.seat?.table === t.id).map(m => ({id: m.id, name: m.name, stack: m.seat.stack, ...(m.seat.removing ? {removing: true, ...(m.seat.removing.now ? {now: true} : {})} : {}), ...(m.seat.moving ? {moving: m.seat.moving.to} : {})})),
    })),
    // The promotions, as the host sees them (#274).
    promos: club.promos?.list?.length || club.promos?.awards?.length ? promosAdmin(club) : null,
  };
}

// Carries out an assistant's command. Returns {replies, table} where table
// is {start: t} or {close: id} for the host's table runtime, or throws why not.
export function runAdmin(club, by, cmd, now = Date.now(), limits = null) {
  if (!isAssistant(club, by)) throw new Error('You’re not a manager in this club.');
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
      checkGrant(club, cmd.id);
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
    // High Hand promotions (#274). `promos` tells the host to send the
    // promotions out and set their timer; `paid`, prizes it should announce.
    case 'new_promo': {
      const p = newPromo(club, cmd.promo || {}, now);
      logAction(club, by, `${a.name} started the promotion ${p.name}`, now);
      return {replies: [], promos: true};
    }
    case 'edit_promo': {
      const p = editPromo(club, String(cmd.id), cmd.promo || {}, now);
      logAction(club, by, `${a.name} changed the promotion ${p.name}`, now);
      return {replies: [], promos: true};
    }
    case 'promo_status': {
      const p = setPromoStatus(club, String(cmd.id), String(cmd.status));
      const did = {running: 'resumed', paused: 'paused', ended: 'ended'}[p.status];
      logAction(club, by, `${a.name} ${did} the promotion ${p.name}`, now);
      return {replies: [], promos: true};
    }
    case 'approve_award': {
      const w = approveAward(club, String(cmd.id), now);
      logAction(club, by, `${a.name} paid ${w.name} ${chipText(w.amount)} for ${w.promoName}`, now, w.amount);
      return {replies: [], promos: true, paid: [w]};
    }
    case 'void_award': {
      const {award: w} = voidAward(club, String(cmd.id), now, cmd.why || '');
      logAction(club, by, `${a.name} voided ${w.name}’s ${chipText(w.amount)} from ${w.promoName}`, now, w.amount);
      return {replies: [account(club, w.member, club.chips.ledger.at(-1).n - 1)], promos: true};
    }
    // Removing a player from a table (#414): `seat` tells the host's table
    // runtime, which logs it when they stand up. keep_player is Undo.
    // move_player (#425): to a seat held at table `to`, after the hand.
    case 'remove_player':
    case 'keep_player':
    case 'move_player': {
      const t = tableById(club, cmd.table);
      if (!t || target?.seat?.table !== t.id) throw new Error(`${who || 'That player'} isn’t at that table.`);
      if (cmd.op === 'move_player') {
        const to = tableById(club, cmd.to);
        if (!to || to.status !== 'open' || to.id === t.id) throw new Error('Pick another open table.');
        return {replies: [], seat: {table: t.id, id: cmd.id, to: to.id}};
      }
      return {replies: [], seat: {table: t.id, id: cmd.id, now: !!cmd.now, ...(cmd.op === 'keep_player' ? {keep: true} : {})}};
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
