// Hand history for clubs (#71, #72): what's stored about a finished hand,
// rebuilding it action by action for the replayer (ducy does the replay),
// and win/loss per table session from the chip ledger. hand-store.js keeps
// the records and clubs.js draws them.
//
// A record is built from a finished hand's TableView as its viewer saw it:
// the host's view at a club table shows no cards that weren't shown down,
// and a player's shows their own. So a record never holds anyone's unshown
// cards. Seat numbers are the viewer's (they're seat 0).

import { replayFrames as ducyReplayFrames } from '../wasm/ducy_wasm.js';
import { chipText } from './chip-format.js';

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
  const winners = rec.seats.filter(s => s.inHand && s.net > 0).map(s => `${s.name} +${chipText(s.net)}`);
  return winners.join(', ') || 'split';
}

// The hand as a list of frames, one before any action and one after each
// event: {street, board, pot, seats: [{name, stack, bet, folded, allIn,
// cards, inHand}], text, event}. ducy replays it (replayFrames, from
// ducy_play::replay); the record adds names, cards and who was in the hand.
// Stacks start at each seat's final stack minus its net result.
export function replayFrames(rec) {
  const start = rec.seats.map(s => BigInt(s.inHand ? s.stackEnd - s.net : s.stackEnd));
  const frames = ducyReplayFrames(rec.events, BigUint64Array.from(start), rec.seats.map(s => s.name));
  return frames.map(f => ({
    street: f.street, board: f.board, pot: num(f.pot),
    text: (f.event != null && amountText(rec.events[f.event], i => rec.seats[i]?.name || `Seat ${i}`)) || f.text,
    event: f.event == null ? null : rec.events[f.event],
    seats: f.seats.map((s, i) => ({
      name: rec.seats[i].name, inHand: rec.seats[i].inHand, cards: rec.seats[i].cards,
      stack: num(s.stack), bet: num(s.bet), folded: s.folded, allIn: s.all_in,
    })),
  }));
}

// The text for an event with an amount in it, the amount shown as chips
// (chip-format.js), as ducy words it; null for the rest, where ducy's text
// stands.
function amountText(e, name) {
  if (!e) return null;
  const c = chipText, who = name(e.seat), allIn = e.all_in ? ' (all-in)' : '';
  switch (e.type) {
    case 'ante': return `${who} antes ${c(e.amount)}`;
    case 'post': return `${who} posts missed blinds: ${[[e.dead, 'dead'], [e.live, 'live']].filter(([n]) => num(n) > 0).map(([n, w]) => `${c(n)} ${w}`).join(' + ')}`;
    case 'small_blind': return `${who} posts the small blind ${c(e.amount)}`;
    case 'big_blind': return `${who} posts the big blind ${c(e.amount)}`;
    case 'call': return `${who} calls ${c(e.amount)}${allIn}`;
    case 'bet': return `${who} bets ${c(e.to)}${allIn}`;
    case 'raise': return `${who} raises to ${c(e.to)}${allIn}`;
    case 'award': return `${who} wins ${c(e.amount)}${num(e.pot) > 0 ? ' (side pot)' : ''}`;
    default: return null;
  }
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
    if (!['buy_in', 'top_up', 'top_up_refund', 'cash_out'].includes(e.kind)) continue;
    let s = open.get(e.member);
    // A top-up handed back (ducy#118) wasn't put on the table after all.
    if (e.kind === 'top_up_refund') { if (s) { s.put -= e.amount; s.net = s.took - s.put; } continue; }
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
