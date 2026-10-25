// Standings for a one-off private game (#403): what each player was given
// (a cash game's chips, a tournament's buy-in), what they have now or won,
// and who owes whom at the end. One game's own: nothing carries over to
// another. Pure functions; play.js keeps a cash game's ledger, and
// private-tourney.js makes a tournament's rows.
//
// A cash game's ledger: {players: {[id]: {id, name, given, out, at}}}, in
// chips (hundredths, chip-format.js). `given`: every amount the host gave
// them (their first chips, rebuys, top-ups), less any handed back; `out`:
// what they left the table with; `at`: what they have at the table now.

export const newLedger = () => ({players: {}});

function player(ledger, id, name) {
  const p = (ledger.players[id] ||= {id, name: name || '?', given: 0, out: 0, at: 0});
  if (name) p.name = name;
  return p;
}

// The host gave player `id` `amount` chips. They're theirs at once, though a
// player in a hand gets them at the next deal.
export function give(ledger, id, name, amount) {
  if (!(amount > 0)) return;
  const p = player(ledger, id, name);
  p.given += amount;
  p.at += amount;
}

// Chips approved that didn't fit under the table's maximum: handed back, so
// never given.
export function handBack(ledger, id, amount) {
  const p = ledger.players[id];
  if (!p || !(amount > 0)) return;
  p.given -= amount;
  p.at = Math.max(0, p.at - amount);
}

// Player `id` left the table with `chips`.
export function cashOut(ledger, id, chips) {
  const p = ledger.players[id];
  if (!p) return;
  p.out += Math.max(0, chips || 0);
  p.at = 0;
}

// Everyone's chips at the table now (between hands, so none are in a pot):
// [{id, name, chips}]. Anyone not listed has none there.
export function atTable(ledger, seated) {
  const now = new Map(seated.map(s => [s.id, s]));
  for (const p of Object.values(ledger.players)) p.at = now.get(p.id)?.chips ?? 0;
  for (const s of seated) if (!ledger.players[s.id] && s.chips > 0) player(ledger, s.id, s.name).at = s.chips;
  for (const s of seated) if (s.name && ledger.players[s.id]) ledger.players[s.id].name = s.name;
}

// The cash game's standings, the biggest winner first: [{id, name, given,
// now, net}] (now: at the table plus cashed out).
export function cashStandings(ledger) {
  return Object.values(ledger.players)
    .map(p => ({id: p.id, name: p.name, given: p.given, now: p.at + p.out, net: p.at + p.out - p.given}))
    .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
}

// Who owes whom, from each player's net ([{id, name, net}]): the biggest
// loser pays the biggest winner first, so there are as few payments as this
// simple way makes. [{from, fromName, to, toName, amount}]. Nets that don't
// add up to 0 (a pot in play) leave the difference unpaid.
export function settleUp(rows) {
  const owe = rows.filter(r => r.net < 0).map(r => ({...r, left: -r.net})).sort((a, b) => b.left - a.left);
  const get = rows.filter(r => r.net > 0).map(r => ({...r, left: r.net})).sort((a, b) => b.left - a.left);
  const out = [];
  let i = 0, j = 0;
  while (i < owe.length && j < get.length) {
    const amount = Math.min(owe[i].left, get[j].left);
    out.push({from: owe[i].id, fromName: owe[i].name, to: get[j].id, toName: get[j].name, amount});
    owe[i].left -= amount;
    get[j].left -= amount;
    if (!owe[i].left) i++;
    if (!get[j].left) j++;
  }
  return out;
}

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
