// Standings for a one-off private game (#403): what each player was given
// (a cash game's chips, a tournament's buy-in), what they have now or won,
// and who owes whom at the end. One game's own: nothing carries over to
// another. ducy-play's club_oneoff works them out (oneOff, #457); play.js
// keeps a cash game's ledger, and private-tourney.js makes a tournament's rows.
//
// A cash game's ledger: {players: {[id]: {id, name, given, out, at}}}, in
// chips (hundredths, chip-format.js). `given`: every amount the host gave
// them (their first chips, rebuys, top-ups), less any handed back; `out`:
// what they left the table with; `at`: what they have at the table now.
//
// Needs ducy's wasm loaded (the page, tests: ./wasm.mjs).

import { oneOff } from '../wasm/ducy_wasm.js';

// Runs one of ducy's one-off ops; throws why, if refused.
export function ask(op) {
  const r = oneOff(op);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

export const newLedger = () => ({players: {}});

// The ledger, as ducy has it after `op`: the same object, kept by play.js.
const update = (ledger, op) => { ledger.players = ask({...op, ledger}).players; };

// The host gave player `id` `amount` chips. They're theirs at once, though a
// player in a hand gets them at the next deal.
export const give = (ledger, id, name, amount) => update(ledger, {op: 'give', id, name: name || '', amount: Number(amount) || 0});

// Chips approved that didn't fit under the table's maximum: handed back, so
// never given.
export const handBack = (ledger, id, amount) => update(ledger, {op: 'handBack', id, amount: Number(amount) || 0});

// Player `id` left the table with `chips`.
export const cashOut = (ledger, id, chips) => update(ledger, {op: 'cashOut', id, chips: Number(chips) || 0});

// Everyone's chips at the table now (between hands, so none are in a pot):
// [{id, name, chips}]. Anyone not listed has none there.
export const atTable = (ledger, seated) => update(ledger, {op: 'atTable', seated: seated.map(s => ({id: s.id, name: s.name || '', chips: s.chips || 0}))});

// The cash game's standings, the biggest winner first: [{id, name, given,
// now, net}] (now: at the table plus cashed out).
export const cashStandings = ledger => ask({op: 'cashStandings', ledger});

// Who owes whom, from each player's net ([{id, name, net}]): the biggest
// loser pays the biggest winner first, so there are as few payments as this
// simple way makes. [{from, fromName, to, toName, amount}]. Nets that don't
// add up to 0 (a pot in play) leave the difference unpaid.
export const settleUp = rows => ask({op: 'settleUp', rows});

// The standings and the settle-up list as CSV, for the download. `cols`:
// [[heading, row => value]]; `fmt` writes an amount.
export function standingsCsv(rows, transfers, cols, fmt) {
  const cell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.map(c => c[0]).map(cell).join(',')];
  for (const r of rows) lines.push(cols.map(c => cell(c[1](r))).join(','));
  if (transfers.length) {
    lines.push('', 'Pays,To,Amount');
    for (const t of transfers) lines.push([t.fromName, t.toName, fmt(t.amount)].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}
