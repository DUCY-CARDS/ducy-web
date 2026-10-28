// Agents (#63: #74, #75, #76): members the host trusts to bring in and back
// players. Pure functions over the club object; clubs.js carries messages.
//
// To the club, an agent and their players are one account. Each player's
// club balance is their share, and the agent's own balance is what they
// haven't handed out. The agent gives chips to their players and takes them
// back (transfers inside the account). Credit: the agent's own balance may
// go below zero, down to −their credit limit (the member's one credit,
// #404, #445), so they can back players beyond the chips the host gave
// them. Credit used is how far the whole account (own +
// players' shares) is below zero; players' winnings raise it again. The host
// records settlements (paid outside the app; chips are play money), which
// raise the agent's balance.
//
// Member fields: agent: 'offered' | 'yes' (is an agent), agentInvite (their
// own invite token); a player under an agent: agentOf.
// Agents recruit with their own invite link and approve their own players;
// the host can still decline or remove anyone and assign or reassign members.

import { approve, decline, account, newInvite } from './club.js';
import { chipText } from './chip-format.js';
import { answerRequest, checkGrant, creditOf, declineRequest, ensureChips, issue, transfer } from './club-chips.js';
import { logAction } from './club-log.js';

export const isAgent = (club, id) => club.members[id]?.status === 'member' && club.members[id]?.agent === 'yes';
export const playersOf = (club, id) => Object.values(club.members).filter(m => m.agentOf === id && m.status === 'member');
export const recruitsOf = (club, id) => Object.values(club.members).filter(m => m.agentOf === id && m.status === 'pending');

const agentBodyRole = (club, id) => ({type: 'agent_role', club: club.code, agent: club.members[id]?.agent || null});

// The host offers member `id` the agent role. Their credit limit is the one
// they have as a member (#445).
export function offerAgent(club, id) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Only members can be agents.');
  if (m.agent === 'yes') throw new Error(`${m.name} is already an agent.`);
  if (m.agentOf) throw new Error(`${m.name} plays under an agent; unassign them first.`);
  m.agent = 'offered';
  return {to: id, body: agentBodyRole(club, id)};
}

export function answerAgent(club, id, accept, now = Date.now()) {
  const m = club.members[id];
  if (m?.agent !== 'offered') return null;
  if (accept) {
    m.agent = 'yes';
    m.agentInvite = newInvite();
    logAction(club, id, `${m.name} became an agent (credit limit ${chipText(creditOf(m))})`, now);
  } else {
    delete m.agent;
  }
  return {to: id, body: agentBodyRole(club, id)};
}

// The host ends the agent role. Only once the agent's account isn't in
// credit (they've settled up); their players become regular members.
export function revokeAgent(club, id, now = Date.now()) {
  const m = club.members[id];
  if (!m?.agent) return null;
  if (m.agent === 'yes' && accountOf(club, id).creditUsed > 0) throw new Error(`${m.name}'s account is in credit: settle up first.`);
  for (const p of Object.values(club.members)) if (p.agentOf === id) delete p.agentOf;
  const was = m.agent;
  delete m.agent;
  delete m.agentInvite;
  if (was === 'yes') logAction(club, club.hostId, `${m.name} is no longer an agent`, now);
  return {to: id, body: agentBodyRole(club, id)};
}

// The host puts a member under an agent (or none). A member has at most one.
export function assignToAgent(club, playerId, agentId, now = Date.now()) {
  const p = club.members[playerId];
  if (!p || p.status !== 'member') throw new Error('No such member.');
  if (p.agent) throw new Error('Agents can’t play under another agent.');
  if (agentId && !isAgent(club, agentId)) throw new Error('Not an agent.');
  if (agentId) p.agentOf = agentId; else delete p.agentOf;
  logAction(club, club.hostId, agentId ? `${p.name} now plays under ${club.members[agentId].name}` : `${p.name} no longer plays under an agent`, now);
}

// The account: the agent's own balance, the players' shares, the total, and
// how much credit it uses (#76).
export function accountOf(club, id) {
  ensureChips(club);
  const a = club.members[id];
  const players = playersOf(club, id);
  const shares = players.reduce((s, p) => s + p.balance, 0);
  const total = a.balance + shares;
  return {own: a.balance, shares, total, limit: creditOf(a), creditUsed: Math.max(0, -total), room: creditOf(a) + a.balance, players};
}

// The host records a settlement from the agent (paid outside the app).
export function settle(club, id, amount, now = Date.now(), why = '') {
  if (!isAgent(club, id)) throw new Error('Not an agent.');
  const e = issue(club, id, amount, now, why || 'Settlement', 'settle');
  logAction(club, club.hostId, `Recorded a settlement of ${chipText(amount)} from ${club.members[id].name}`, now, Number(amount));
  return e;
}

// A member's result at the tables (#190): what they won or lost over the
// table sessions they've finished (buy-ins and top-ups out, cash-outs in;
// a session still running isn't counted).
export function tableResult(club, id) {
  let total = 0, session = 0;
  for (const e of club.chips.ledger) {
    if (e.member !== id) continue;
    if (e.kind === 'buy_in' || e.kind === 'top_up') session -= e.amount;
    else if (e.kind === 'top_up_refund') session += e.amount;
    else if (e.kind === 'cash_out') { total += session + e.amount; session = 0; }
  }
  return total;
}

// Where a seated member is: their table's name (#428).
function tableName(club, seat) {
  if (seat.table.startsWith('tourney:')) return (club.tourneys || []).find(t => `tourney:${t.id}` === seat.table)?.name || 'A tournament';
  return (club.tables || []).find(t => t.id === seat.table)?.name || 'A table';
}

// What an agent sees: their account, recruits waiting, their players (with
// their results at the tables, #190, and where they're playing, #428), and
// the settlements recorded.
export function agentBody(club, id) {
  const a = accountOf(club, id);
  return {
    type: 'agent', club: club.code,
    own: a.own, shares: a.shares, total: a.total, limit: a.limit, creditUsed: a.creditUsed, room: a.room,
    // What the agent would owe the club if their players stood up now
    // (#428): credit used, less their players' chips at the tables.
    owed: Math.max(0, -(a.total + a.players.reduce((s, m) => s + (m.seat?.stack || 0), 0))),
    invite: club.members[id].agentInvite,
    recruits: recruitsOf(club, id).map(m => ({id: m.id, name: m.name, at: m.requestedAt})),
    players: a.players.map(m => ({
      id: m.id, name: m.name, balance: m.balance, request: m.request || null, seated: !!m.seat, result: tableResult(club, m.id),
      ...(m.seat ? {table: tableName(club, m.seat), stack: m.seat.stack || 0} : {}),
    })),
    settlements: club.chips.ledger.filter(e => e.member === id && e.kind === 'settle').slice(-10).map(e => ({at: e.at, amount: e.amount, note: e.note || ''})),
  };
}

function mine(club, agentId, playerId) {
  const p = club.members[playerId];
  if (!p || p.agentOf !== agentId) throw new Error('Not one of your players.');
  return p;
}

// An agent's command (sent signed through the host). Returns {replies} or throws.
export function runAgent(club, by, cmd, now = Date.now()) {
  if (!isAgent(club, by)) throw new Error('You’re not an agent in this club.');
  const a = club.members[by];
  switch (cmd?.op) {
    case 'approve': case 'decline': {
      const p = club.members[cmd.id];
      if (!p || p.agentOf !== by || p.status !== 'pending') throw new Error('No such request.');
      const r = (cmd.op === 'approve' ? approve : decline)(club, cmd.id, now);
      logAction(club, by, `${a.name} ${cmd.op === 'approve' ? 'approved' : 'declined'} ${p.name}`, now);
      return {replies: [r], approved: cmd.op === 'approve' ? cmd.id : null};
    }
    case 'give': case 'grant': {
      const p = mine(club, by, cmd.id);
      const amt = Number(cmd.op === 'grant' ? (cmd.amount ?? p.request?.amount) : cmd.amount);
      if (cmd.op === 'grant' && !p.request) throw new Error('There’s no request to grant.');
      if (cmd.op === 'grant') checkGrant(club, cmd.id);
      if (!Number.isSafeInteger(amt) || amt <= 0) throw new Error('Enter a whole number of chips above 0.');
      // Inside the account: the agent's own balance may go negative, down to −limit.
      const [out] = transfer(club, by, cmd.id, amt, now, cmd.op === 'grant' ? p.request.note : cmd.note, {floor: -creditOf(a)});
      if (cmd.op === 'grant') answerRequest(club, cmd.id, 'granted', {given: amt, by, now});
      logAction(club, by, `${a.name} ${cmd.op === 'grant' ? 'granted' : 'gave'} ${p.name} ${chipText(amt)}`, now, amt);
      return {replies: [account(club, by, out.n - 1), account(club, cmd.id, out.n)]};
    }
    case 'take': {
      const p = mine(club, by, cmd.id);
      const [out] = transfer(club, cmd.id, by, Number(cmd.amount), now, cmd.note);
      logAction(club, by, `${a.name} took back ${chipText(out.amount)} from ${p.name}`, now, out.amount);
      return {replies: [account(club, cmd.id, out.n - 1), account(club, by, out.n)]};
    }
    case 'deny': {
      const p = mine(club, by, cmd.id);
      if (!declineRequest(club, cmd.id, cmd.note, now, by)) throw new Error('There’s no request to decline.');
      logAction(club, by, `${a.name} declined ${p.name}’s chip request`, now);
      return {replies: [account(club, cmd.id, Infinity)]};
    }
    default:
      throw new Error('Unknown command.');
  }
}
