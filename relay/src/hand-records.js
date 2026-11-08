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
// seats: [{seat, id, name, cards, folded, net, won, stackEnd}] (the seats
// dealt in, by seat), actions (the hand's events, by seat), board, board2,
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
export function fullRecord({view, players, cards, deal, club, table, tableName, game}, now = Date.now()) {
  const rec = handRecord({club, table, tableName, game, view, who: 'ducy'}, now);
  const idAt = seat => players.find(p => p.seat === seat)?.client_id || null;
  const cardsAt = seat => cards?.seats?.find(s => s.seat === seat)?.cards || null;
  return {
    id: rec.id, at: rec.at, club, table, tableName, game, hand: rec.hand,
    sb: rec.sb, bb: rec.bb, button: rec.button,
    seats: rec.seats.filter(s => s.inHand).map(s => ({
      seat: s.i, id: idAt(s.i), name: s.name, cards: cardsAt(s.i), folded: s.folded, net: s.net, won: s.won, stackEnd: s.stackEnd,
    })),
    actions: rec.events, board: rec.board, board2: rec.board2 || [], pot: rec.pot, showdown: rec.showdown, pots: view.pots || [],
    deal: deal ? {seed: deal.seed, list: deal.list, reveals: deal.reveals, order: deal.order} : null,
  };
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
