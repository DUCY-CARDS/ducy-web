// A club's money on links (#454): ducy-play's money model runs every chip
// move, through the club's book (club-book.js). Each member plays through a
// backer, the club or their agent; the pair is a link with one balance and
// one credit limit, and a buy-in or cash-out moves every link on the path
// up to the club. See the club money model doc (#454).
//
// The model lives in the club object as `club.money` (plain data, so it's
// saved, backed up and sent to the owner's page with the club). After every
// move:
//   m.balance  their link with whoever they play through (an agent's: their
//              own chips and their players', as the club sees it)
//   m.credit   that link's credit limit
//   m.room     what they can bring to a table: the least room on their path
//
// The ledger is club.money.ledger: one entry per link per move, {n, at, tx,
// member, backer, kind, amount, balance, note, about}, where `amount` is the
// change to the link's balance (below zero: toward the backer) and `about`
// the table, tournament or promotion. Kinds: give, take_back, buy_in,
// top_up, refund, cash_out, tourney_buy_in, prize, rake_share, void,
// opening. The entries of one move along a path share a `tx`, the player's
// own link first; `entryView` adds whose move it was (`player`) to the
// others, and a prize's hand.
//
// The first time, a club is moved onto links: a player under an agent gets
// a link with the agent at their balance, an agent one with the club at
// their own chips plus their players', everyone else one with the club, and
// anyone seated a session on their path. Each link's balance is its first
// entry ('opening').
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).
// Pages only read the mirrors and club.money.


import * as ducy from '../wasm/ducy_wasm.js';

export const CLUB = 'club';

// Moves the club onto links if it isn't yet, and links new members
// (ducy-play's club book, club-book.js). The host runs it as the club starts.
export { startMoney } from './club-book.js';

// The club's ledger, oldest first.
export const ledgerOf = club => club.money?.ledger || [];

// Runs one of ducy-play's club views (club_views, #459) over the club:
// 'entriesOf', 'ledger', 'entryViews', 'settleRows', 'accountOf',
// 'tableResult', 'agentBody'. Throws why not.
export function view(club, op, args = {}) {
  const r = ducy.clubView(JSON.stringify(club), op, JSON.stringify(args));
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

// Entries as pages and members' copies have them: `player` when it's on
// someone else's link for a player's move along their path (an agent's, for
// their player's buy-in), and for a promotion prize or its void, the award's
// `hand` and a note naming it.
const entryViews = (club, entries) => (entries.length ? view(club, 'entryViews', {ns: entries.map(e => e.n)}) : []);
export const entryView = (club, e) => entryViews(club, [e])[0] || {...e};

// Member `id`'s own entries (on their links up) after entry `since`.
export const entriesOf = (club, id, since = 0) => view(club, 'entriesOf', {id, since});

// The club's whole ledger as pages show it.
export const ledgerView = club => view(club, 'ledger');

// What an entry drew on credit (a buy-in, top-up or tournament buy-in that
// took the link below zero), or paid back (a cash-out that brought it up
// toward zero), from the balances before and after.
const owing = b => Math.max(0, -b);
export const drawnOn = e => Math.max(0, owing(e.balance) - owing(e.balance - e.amount));
export const repaidBy = e => Math.max(0, owing(e.balance - e.amount) - owing(e.balance));

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
export const settleRows = (club, backer = CLUB) => view(club, 'settleRows', {backer});
