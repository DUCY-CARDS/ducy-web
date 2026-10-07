// Hand history for clubs (#71, #72): what's stored about a finished hand,
// rebuilding it action by action for the replayer, and win/loss per table
// session from the chip ledger. Pure functions; hand-store.js keeps the
// records and clubs.js draws them.
//
// A record is built from a finished hand's TableView as its viewer saw it:
// the host's view at a club table shows no cards that weren't shown down,
// and a player's shows their own. So a record never holds anyone's unshown
// cards. Seat numbers are the viewer's (they're seat 0).

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

const num = v => Number(v);

// The record for a finished hand. `who` is 'host' or the viewer's player id.
export function handRecord({club, table, tableName, game, view, who}, now = Date.now()) {
  const seats = view.seats.map((s, i) => ({
    i, name: s.name, cards: s.cards || null, stackEnd: num(s.stack), net: num(s.net), won: num(s.won),
    folded: !!s.folded, inHand: !s.empty && !s.sitting_out,
  }));
  return {
    id: `${club}:${table}:${num(view.hand_number)}:${now}`,
    club, table, tableName, game, who, at: now,
    hand: num(view.hand_number), sb: num(view.small_blind), bb: num(view.big_blind), button: num(view.button),
    holeCards: num(view.hole_cards), board: view.board || [], showdown: !!view.showdown,
    pot: (view.pots || []).reduce((s, p) => s + num(p.amount), 0) || seats.reduce((s, x) => s + x.won, 0),
    seats, events: view.events || [],
  };
}

// Who won what, for a list row: "Ann +12".
export function summary(rec) {
  const winners = rec.seats.filter(s => s.inHand && s.net > 0).map(s => `${s.name} +${s.net}`);
  return winners.join(', ') || 'split';
}

function eventText(rec, e) {
  const who = rec.seats[e.seat]?.name || `Seat ${e.seat}`;
  switch (e.type) {
    case 'ante': return `${who} antes ${num(e.amount)}`;
    case 'small_blind': return `${who} posts the small blind ${num(e.amount)}`;
    case 'big_blind': return `${who} posts the big blind ${num(e.amount)}`;
    case 'fold': return `${who} folds`;
    case 'check': return `${who} checks`;
    case 'call': return `${who} calls ${num(e.amount)}${e.all_in ? ' (all-in)' : ''}`;
    case 'bet': return `${who} bets ${num(e.to)}${e.all_in ? ' (all-in)' : ''}`;
    case 'raise': return `${who} raises to ${num(e.to)}${e.all_in ? ' (all-in)' : ''}`;
    case 'board': return `${String(e.street)[0].toUpperCase()}${String(e.street).slice(1)}: ${e.cards.join(' ')}`;
    case 'award': return `${who} wins ${num(e.amount)}${e.pot > 0 ? ' (side pot)' : ''}`;
    default: return '';
  }
}

// The hand as a list of frames, one before any action and one after each
// event: {street, board, pot, seats: [{name, stack, bet, folded, allIn,
// cards}], text, event}. Stacks start at each seat's final stack minus its
// net result.
export function replayFrames(rec) {
  const seats = rec.seats.map(s => ({
    name: s.name, inHand: s.inHand, stack: s.inHand ? s.stackEnd - s.net : s.stackEnd, bet: 0, folded: false, allIn: false,
    cards: s.cards,
  }));
  let pot = 0, street = 'preflop', board = [], awarding = false;
  const collect = () => { for (const s of seats) { pot += s.bet; s.bet = 0; } };
  const frame = (text, event) => ({
    street, board: [...board], pot, text, event,
    seats: seats.map(s => ({...s})),
  });
  const frames = [frame('Cards are dealt', null)];
  for (const e of rec.events) {
    const s = seats[e.seat];
    switch (e.type) {
      case 'ante': s.stack -= num(e.amount); pot += num(e.amount); break;
      case 'small_blind': case 'big_blind': case 'call':
        s.stack -= num(e.amount); s.bet += num(e.amount); if (e.all_in || s.stack === 0) s.allIn = s.stack === 0; break;
      case 'bet': case 'raise': {
        const add = num(e.to) - s.bet;
        s.stack -= add; s.bet = num(e.to); s.allIn = !!e.all_in || s.stack === 0; break;
      }
      case 'fold': s.folded = true; break;
      case 'board': collect(); street = String(e.street); board = [...board, ...e.cards]; break;
      case 'award':
        if (!awarding) { collect(); awarding = true; }
        s.stack += num(e.amount); pot -= num(e.amount); break;
      default: break;
    }
    frames.push(frame(eventText(rec, e), e));
  }
  return frames;
}

// The frame index where each street starts (for jumping), from frames.
export function streetStarts(frames) {
  const out = {};
  frames.forEach((f, i) => { if (!(f.street in out)) out[f.street] = i; });
  return out;
}

// Win/loss per table session from ledger entries (a member's own copy, or
// the club's whole ledger): a session runs from a buy-in to the cash-out.
// Returns [{member, table, start, end, put, took, net, open}], newest first.
export function tableSessions(entries) {
  const open = new Map(); // member → session
  const out = [];
  for (const e of [...entries].sort((a, b) => a.n - b.n)) {
    if (!['buy_in', 'top_up', 'cash_out'].includes(e.kind)) continue;
    let s = open.get(e.member);
    if (e.kind === 'buy_in' || !s) {
      s = {member: e.member, table: e.table, start: e.at, end: null, put: 0, took: 0, net: 0, open: true};
      open.set(e.member, s);
      out.push(s);
    }
    if (e.kind === 'cash_out') {
      s.took = e.amount; s.end = e.at; s.open = false; open.delete(e.member);
    } else s.put += e.amount;
    s.net = s.took - s.put;
  }
  return out.reverse();
}

// Total net per member over closed sessions: {member: net}.
export function totalsByMember(sessions) {
  const t = {};
  for (const s of sessions) if (!s.open) t[s.member] = (t[s.member] || 0) + s.net;
  return t;
}
