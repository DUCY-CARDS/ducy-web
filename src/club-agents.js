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
// ducy-play's club book (club-book.js, #456) runs the role and the
// commands; what an agent sees is drawn here.

import { account } from './club.js';
import { ensureChips } from './club-chips.js';
import { view } from './club-money.js';
import { book } from './club-book.js';

export const isAgent = (club, id) => club.members[id]?.status === 'member' && club.members[id]?.agent === 'yes';
export const playersOf = (club, id) => Object.values(club.members).filter(m => m.agentOf === id && m.status === 'member');

// The host offers member `id` the agent role. Their credit limit is the one
// they have as a member (#445). Returns the reply to send them.
export const offerAgent = (club, id) => book(club, {op: 'offerAgent', id});

// Member `id` answers the offer; the reply to send them, or null.
export const answerAgent = (club, id, accept, now = Date.now()) => book(club, {op: 'answerAgent', id, accept: !!accept}, now);

// The host ends the agent role. Only once the agent's account isn't in
// credit (they've settled up), and they've settled with their players and
// none is seated; their players then play through the club.
export const revokeAgent = (club, id, now = Date.now()) => book(club, {op: 'revokeAgent', id}, now);

// The host puts a member under an agent (or none). A member has at most
// one, and moves only with nothing on their link and not seated: their
// chips stay where they are (#454).
export function assignToAgent(club, playerId, agentId, now = Date.now()) {
  book(club, {op: 'assignAgent', id: playerId, agent: agentId || null}, now);
}

// The account: the agent's link with the club (`total`), their players'
// shares, what's their own, and how much credit it uses (#76, #454).
export function accountOf(club, id) {
  ensureChips(club);
  const a = view(club, 'accountOf', {id});
  return {...a, players: a.players.map(p => club.members[p])};
}

// A member's result at the tables (#190): what they won or lost over the
// table sessions they've finished (buy-ins and top-ups out, cash-outs in;
// a session still running isn't counted).
export const tableResult = (club, id) => view(club, 'tableResult', {id});

// What an agent sees: their account, what they'd owe the club if their
// players stood up now (#428), recruits waiting, and their players (with
// their results at the tables, #190, and where they're playing, #428).
export function agentBody(club, id) {
  ensureChips(club);
  return view(club, 'agentBody', {id});
}

// An agent's command (sent signed through the host): approving or
// declining their recruits, giving, granting, taking back, or denying a
// request. Returns {replies, approved} or throws. A give goes on the
// player's link with the agent: it costs the agent nothing until the chips
// go on a table (#454).
export function runAgent(club, by, cmd, now = Date.now()) {
  const done = book(club, {op: 'runAgent', by, cmd: cmd ?? {}}, now);
  const accounts = done.accounts.map(a => account(club, a.id, a.since ?? Infinity));
  return {replies: [...done.replies, ...accounts], approved: done.approved};
}
