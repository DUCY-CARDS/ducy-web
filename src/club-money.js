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


export const CLUB = 'club';

// Moves the club onto links if it isn't yet, and links new members
// (ducy-play's club book, club-book.js). The host runs it as the club starts.
export { startMoney } from './club-book.js';

// The club's ledger, oldest first.
export const ledgerOf = club => club.money?.ledger || [];

const PATH_MOVES = new Set(['buy_in', 'top_up', 'refund', 'cash_out', 'tourney_buy_in', 'prize', 'void']);

// An entry as pages and members' copies have it: `player` when it's on
// someone else's link for a player's move along their path (an agent's, for
// their player's buy-in), and for a promotion prize or its void, the award's
// `hand` and a note naming it.
export function entryView(club, e) {
  const out = {...e};
  if (!e.note) delete out.note;
  if (!e.about) delete out.about;
  const ledger = ledgerOf(club);
  if (PATH_MOVES.has(e.kind) && ledger[e.n - 1]?.n === e.n) {
    let i = e.n - 1;
    while (i > 0 && ledger[i - 1].tx === e.tx) i--;
    if (ledger[i].member !== e.member) out.player = ledger[i].member;
  }
  if (e.kind === 'prize' || e.kind === 'void') {
    const a = (club.promos?.awards || []).find(x => x.entry === e.n || x.voidEntry === e.n);
    if (a?.hand) out.hand = a.hand;
    if (a) out.note = e.kind === 'void' ? `Voided: ${a.promoName}${a.voidWhy ? `, ${a.voidWhy}` : ''}` : `${a.promoName}: ${a.handName}`;
  }
  return out;
}

// The club's ledger without the entries on other links for a player's
// move: each move's first entry, on the player's own link.
export function ownEntries(club) {
  const out = [];
  let tx = null;
  for (const e of ledgerOf(club)) {
    if (e.tx !== tx) out.push(e);
    tx = e.tx;
  }
  return out;
}

// Member `id`'s own entries (on their links up) after entry `since`.
export const entriesOf = (club, id, since = 0) => ledgerOf(club).filter(e => e.member === id && e.n > since).map(e => entryView(club, e));

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
export function settleRows(club, backer = CLUB) {
  return (club.money?.links || []).filter(l => l.backer === backer && l.balance)
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.member.localeCompare(b.member))
    .map(l => ({member: l.member, balance: l.balance}));
}
