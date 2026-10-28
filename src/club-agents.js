// Agents (#63: #74, #75, #76): members the host trusts to bring in and back
// players. Pure functions over the club object; clubs.js carries messages.
//
// On links (#454, club-money.js): each player's balance is their link with
// the agent, and the agent's is their link with the club, which carries
// their players' play too (a player's buy-in moves both). The agent gives
// chips to their players and takes them back; giving costs them nothing
// until the chips go on a table. Credit: the agent's link may go below
// zero, down to −their credit limit (the member's one credit, #404, #445),
// and no player's buy-in takes it further. Credit used is how far it is
// below zero; players' winnings raise it again. Paying up (outside the app;
// chips are play money) is the host giving or taking back chips, with a note.
//
// Member fields: agent: 'offered' | 'yes' (is an agent), agentInvite (their
// own invite token); a player under an agent: agentOf.
// Agents recruit with their own invite link and approve their own players;
// the host can still decline or remove anyone and assign or reassign members.

import { approve, decline, account, newInvite } from './club.js';
import { chipText } from './chip-format.js';
import { answerRequest, available, backerGive, backerTake, checkGrant, creditOf, declineRequest, ensureChips } from './club-chips.js';
import { CLUB, linkOf, move } from './club-money.js';
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
// credit (they've settled up), and they've settled with their players and
// none is seated; their players then play through the club.
export function revokeAgent(club, id, now = Date.now()) {
  const m = club.members[id];
  if (!m?.agent) return null;
  if (m.agent === 'yes') {
    if (accountOf(club, id).creditUsed > 0) throw new Error(`${m.name}'s account is in credit: settle up first.`);
    const open = playersOf(club, id).find(p => p.seat || (club.money && linkOf(club, p.id, id)?.balance));
    if (open) throw new Error(`${m.name} and ${open.name} settle up first${open.seat ? ', after they leave their table' : ''}.`);
  }
  for (const p of Object.values(club.members)) {
    if (p.agentOf !== id) continue;
    delete p.agentOf;
    if (m.agent === 'yes' && p.status === 'member') playThrough(club, p.id, CLUB, now);
  }
  const was = m.agent;
  delete m.agent;
  delete m.agentInvite;
  if (was === 'yes') logAction(club, club.hostId, `${m.name} is no longer an agent`, now);
  return {to: id, body: agentBodyRole(club, id)};
}

// Member `id` plays through `backer` from now on: their link with them,
// made if it's new (#454).
function playThrough(club, id, backer, now) {
  if (!linkOf(club, id, backer)) move(club, {op: 'addLink', member: id, backer}, now);
  move(club, {op: 'setThrough', member: id, backer}, now);
}

// The host puts a member under an agent (or none). A member has at most
// one, and moves only with nothing on their link and not seated: their
// chips stay where they are (#454).
export function assignToAgent(club, playerId, agentId, now = Date.now()) {
  const p = club.members[playerId];
  if (!p || p.status !== 'member') throw new Error('No such member.');
  if (p.agent) throw new Error('Agents can’t play under another agent.');
  if (agentId && !isAgent(club, agentId)) throw new Error('Not an agent.');
  if ((agentId || null) !== (p.agentOf || null)) {
    if (p.seat) throw new Error(`${p.name} is at a table; they need to leave it first.`);
    if (p.balance) throw new Error(`${p.name} has ${chipText(p.balance)} on their account: settle it first.`);
    playThrough(club, playerId, agentId || CLUB, now);
  }
  if (agentId) p.agentOf = agentId; else delete p.agentOf;
  logAction(club, club.hostId, agentId ? `${p.name} now plays under ${club.members[agentId].name}` : `${p.name} no longer plays under an agent`, now);
}

// The account: the agent's link with the club (`total`), their players'
// shares, what's their own, and how much credit it uses (#76, #454).
export function accountOf(club, id) {
  ensureChips(club);
  const a = club.members[id];
  const players = playersOf(club, id);
  const shares = players.reduce((s, p) => s + p.balance, 0);
  const total = a.balance;
  return {own: total - shares, shares, total, limit: creditOf(a), creditUsed: Math.max(0, -total), room: available(a), players};
}

// A member's result at the tables (#190): what they won or lost over the
// table sessions they've finished (buy-ins and top-ups out, cash-outs in;
// a session still running isn't counted).
export function tableResult(club, id) {
  let total = 0, session = 0;
  for (const e of club.chips.ledger) {
    // An agent's entries for their players' moves aren't their own play.
    if (e.member !== id || e.player) continue;
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

// What an agent sees: their account, recruits waiting, and their players
// (with their results at the tables, #190, and where they're playing, #428).
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
      // On their link with the agent: it costs the agent nothing until the
      // chips go on a table (#454).
      const e = backerGive(club, by, cmd.id, amt, now, cmd.op === 'grant' ? p.request.note : cmd.note);
      if (cmd.op === 'grant') answerRequest(club, cmd.id, 'granted', {given: amt, by, now});
      logAction(club, by, `${a.name} ${cmd.op === 'grant' ? 'granted' : 'gave'} ${p.name} ${chipText(amt)}`, now, amt);
      return {replies: [account(club, cmd.id, e.n - 1)]};
    }
    case 'take': {
      const p = mine(club, by, cmd.id);
      const e = backerTake(club, by, cmd.id, Number(cmd.amount), now, cmd.note);
      logAction(club, by, `${a.name} took back ${chipText(e.amount)} from ${p.name}`, now, e.amount);
      return {replies: [account(club, cmd.id, e.n - 1)]};
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
