// Full hand records at an always-on club (#580): every finished hand at the
// club's tables with every seat's player ID and hole cards, folded ones
// too, its actions, board and result, and its fair deal. They're for ducy's
// automated checks for cheating on the relay (the collusion report, #582),
// and for nothing else: nobody at the club, its owner included, sees cards
// they didn't see at the table.
//
// So they're kept apart from everything else the room stores, under keys of
// their own, and only this file reads them: no owner command, admin view,
// backup or export does (test/hand-records.test.mjs checks that). Code that
// needs them calls fullHands() on the relay.
//
// storage: {get(key), put(key, value), delete(key)}, the club room's.
//   fullHands          {days: {<day>: count}}: how many hands each day holds
//   full:<day>:<n>     hand n of that day (day = days since 1970, UTC)
//
// A record: {id, at, club, table, tableName, game, hand, sb, bb, button,
// startedAt (ms, when the relay first saw the hand; null if not known),
// seats: [{seat, id, name, cards, folded, net, won, stackEnd, connected,
// conn}] (the seats dealt in, by seat; `connected`: when the hand began,
// null if not known; `conn`: their connection then, club-room.js
// connSnapshot: a hashed IP, network, place, client, never the raw IP),
// actions (the hand's events, by seat), and by action: times (ms since the
// hand began, null where not known; #591's decision times), amounts (the
// chips it put in, amountsOf), how ('player' their own command, 'clock' a
// timeout or anything else, null), away (their page said it was hidden or
// out of focus while they decided: true, false or null), board, board2,
// pot, showdown, pots (who won what), deal: {seed, list, reveals, order}
// or null}. `order` is the player IDs in the order the deal gave out cards.

import { handRecord } from '../../src/hand-replay.js';
import { fairCheck } from '../../wasm/ducy_wasm.js';

const INDEX = 'fullHands';
const DAY_MS = 864e5;
// Hands kept for one day at most (each record is a few KB).
export const MAX_FULL_PER_DAY = 5000;

const dayOf = at => Math.floor(at / DAY_MS);

// The full record of a hand from the club's table (club-host.js onFullHand,
// with {club, table, tableName, game}), at `now`.
export function fullRecord({view, players, cards, deal, timing, conns, club, table, tableName, game}, now = Date.now()) {
  const rec = handRecord({club, table, tableName, game, view, who: 'ducy'}, now);
  const idAt = seat => players.find(p => p.seat === seat)?.client_id || null;
  const cardsAt = seat => cards?.seats?.find(s => s.seat === seat)?.cards || null;
  const at = (list, i) => (list?.[i] === undefined ? null : list[i]);
  const online = Array.isArray(timing?.online) ? new Set(timing.online) : null;
  return {
    id: rec.id, at: rec.at, club, table, tableName, game, hand: rec.hand,
    sb: rec.sb, bb: rec.bb, button: rec.button,
    startedAt: Number.isFinite(timing?.start) ? timing.start : null,
    seats: rec.seats.filter(s => s.inHand).map(s => {
      const id = idAt(s.i);
      return {
        seat: s.i, id, name: s.name, cards: cardsAt(s.i), folded: s.folded, net: s.net, won: s.won, stackEnd: s.stackEnd,
        connected: online && id ? online.has(id) : null, conn: (id && conns?.[id]) || null,
      };
    }),
    actions: rec.events,
    times: rec.events.map((_, i) => (Number.isFinite(timing?.at?.[i]) ? timing.at[i] : null)),
    amounts: amountsOf(rec.events),
    how: rec.events.map((_, i) => at(timing?.how, i)),
    away: rec.events.map((_, i) => at(timing?.away, i)),
    board: rec.board, board2: rec.board2 || [], pot: rec.pot, showdown: rec.showdown, pots: view.pots || [],
    deal: deal ? {seed: deal.seed, list: deal.list, reveals: deal.reveals, order: deal.order} : null,
  };
}

// The chips each event put in, by event (null for one that isn't a seat's:
// the board, an award): a blind or call its amount, a bet or raise what it
// added to the seat's bet for the street, a check or fold 0.
export function amountsOf(events) {
  const bet = new Map();
  const add = (seat, n) => bet.set(seat, (bet.get(seat) || 0) + n);
  return (events || []).map(e => {
    switch (e.type) {
      case 'ante': return Number(e.amount) || 0;
      case 'small_blind': case 'big_blind': case 'call': add(e.seat, Number(e.amount) || 0); return Number(e.amount) || 0;
      case 'post': add(e.seat, Number(e.live) || 0); return (Number(e.dead) || 0) + (Number(e.live) || 0);
      case 'bet': case 'raise': {
        const put = (Number(e.to) || 0) - (bet.get(e.seat) || 0);
        bet.set(e.seat, Number(e.to) || 0);
        return put;
      }
      case 'check': case 'fold': return 0;
      case 'board': bet.clear(); return null;
      default: return null;
    }
  });
}

// Keeps `rec` (fullRecord) for the club's `days`, and drops what's older.
// One at a time: the caller runs these in order (club-room.js saves).
export async function keepFullHand(storage, rec, {days}, now = Date.now()) {
  const index = (await storage.get(INDEX)) || {days: {}};
  const day = dayOf(rec.at || now);
  const n = index.days[day] || 0;
  if (n >= MAX_FULL_PER_DAY) return false;
  await storage.put(`full:${day}:${n}`, rec);
  index.days[day] = n + 1;
  const oldest = dayOf(now - Math.max(1, Number(days) || 1) * DAY_MS);
  for (const d of Object.keys(index.days)) {
    if (Number(d) >= oldest) continue;
    for (let i = 0; i < index.days[d]; i++) await storage.delete(`full:${d}:${i}`);
    delete index.days[d];
  }
  await storage.put(INDEX, index);
  return true;
}

// The full records kept, oldest first, from time `since` on. For ducy's
// checks on the relay only (#582): never to send to anyone.
export async function fullHands(storage, {since = 0} = {}) {
  const index = (await storage.get(INDEX)) || {days: {}};
  const out = [];
  for (const d of Object.keys(index.days).map(Number).sort((a, b) => a - b)) {
    if ((d + 1) * DAY_MS <= since) continue;
    for (let i = 0; i < index.days[d]; i++) {
      const rec = await storage.get(`full:${d}:${i}`);
      if (rec && rec.at >= since) out.push(rec);
    }
  }
  return out;
}

// Every full record goes (the club was deleted).
export async function dropFullHands(storage) {
  const index = (await storage.get(INDEX)) || {days: {}};
  for (const [d, n] of Object.entries(index.days)) for (let i = 0; i < n; i++) await storage.delete(`full:${d}:${i}`);
  await storage.delete(INDEX);
}

// ducy's check of a hand's deal from its full record: every revealed value
// opens its commitment, the seed is made from them, and each seat's cards
// and the board are what the seed deals, with cards going to the seats in
// seat order. {ok, why, missing}: `missing`, the players dealt in whose own
// value wasn't used (they didn't answer in time, or the host left them out).
export function checkDeal(rec) {
  const d = rec?.deal;
  if (!d) return {ok: false, why: 'no fair deal', missing: []};
  const seats = [...rec.seats].filter(s => s.cards?.length).sort((a, b) => a.seat - b.seat);
  // The order the deal gave out cards is seat order.
  for (let i = 0; i < seats.length; i++) {
    if (d.order?.[i] != null && d.order[i] !== seats[i].id) return {ok: false, why: `seat ${seats[i].seat} wasn’t dealt in seat order`, missing: []};
  }
  const m = {game: rec.game, dealt: seats.length, seed: d.seed, list: d.list, reveals: d.reveals};
  for (let i = 0; i < seats.length; i++) {
    const c = fairCheck(JSON.stringify({...m, index: i}), JSON.stringify({cards: seats[i].cards, board: rec.board}), 'null');
    if (!c.ok) return {ok: false, why: `seat ${seats[i].seat}: ${c.why}`, missing: []};
  }
  const used = new Set((d.reveals || []).map(r => r.id));
  return {ok: true, why: '', missing: seats.filter(s => !used.has(s.id)).map(s => s.id)};
}
