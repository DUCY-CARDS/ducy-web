// Tournament payouts by the number of entries (#424): a payout table's row
// in force at each boundary, what makes a table invalid, the club's payout
// tables (added, edited, renamed, deleted; a tournament paying by one, which
// follows its edits until it finishes and then keeps what it paid), an older
// tournament's own payout as a one-row table, what members see, the editor's
// draft, a one-off tournament's own table, and the club server's ops for
// managers and not members.
// Needs the wasm build in wasm/. Run with: node --test test/payout-tables.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { createClub, openClub } from '../relay/src/club-room.js';
import { approve, newClub } from '../src/club.js';
import { issue, totals } from '../src/club-chips.js';
import {
  MAX_ENTRIES, MAX_PAYOUT_ROWS, addPayoutTable, checkPayoutRows, defaultPayout, deletePayoutTable, editPayoutTable, finishTourney, knockedOut, newTourney, payoutRow,
  payoutRows, payoutShares, prizes, register, lateEntry, setPayout, setPayoutTable, startTourney, tourneysBody,
} from '../src/club-tourneys.js';
import { entriesOpen, hostTourneysHtml, memberTourneysHtml, payoutTablesHtml } from '../src/club-tourneys-ui.js';
import { addPlace, addRow, cleanRows, draftOf, readRows, removeRow, rowsEditorHtml, starterRows } from '../src/payout-table-ui.js';
import { HOST_ID, joinPrivate, lobbyBody, newPrivateTourney, paidPlaces, privateClub, prizeTotals, setPrizes } from '../src/private-tourney.js';
import { setupHtml } from '../src/private-tourney-ui.js';
import { structureEditor } from '../src/tourney-structure-ui.js';

const LEVELS = [{sb: 10, bb: 20, ante: 0, minutes: 10}, {sb: 20, bb: 40, ante: 0, minutes: 10}, {sb: 50, bb: 100, ante: 10, minutes: 10}];
const ROWS = starterRows(); // 2: 100 · 6: 65/35 · 10: 50/30/20 · 20: 40/25/20/15 · 30 … 1000: the Default's

function clubWith(n, balance = 10000) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  const ids = Array.from({length: n}, (_, i) => `p${i}`);
  for (const id of ids) {
    club.members[id] = {id, name: id.toUpperCase(), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, balance, 0);
  }
  return {club, ids};
}
const tourney = (club, s = {}) => newTourney(club, {buyIn: 100, stack: 1500, structure: LEVELS, opensAt: 0, startsAt: 1000, maxPlayers: 100, ...s});

test('the row in force: the last that starts at or below the entries, the first below it', () => {
  const rows = checkPayoutRows(ROWS);
  const at = n => payoutRow(rows, n).from;
  for (const [n, from] of [[0, 2], [1, 2], [2, 2], [5, 2], [6, 6], [9, 6], [10, 10], [19, 10], [20, 20], [29, 20], [30, 30], [999, 750], [1000, 1000]]) assert.equal(at(n), from, `${n} entries`);
  assert.deepEqual(payoutRow(rows, 10).places, [5000, 3000, 2000]);
});

test('the table to start from goes up to the most entries a tournament takes, paying as the Default does from 30', () => {
  assert.equal(ROWS.at(-1).from, MAX_ENTRIES);
  assert.ok(ROWS.length <= MAX_PAYOUT_ROWS);
  for (const r of ROWS.filter(x => x.from >= 30)) assert.deepEqual(r.places, defaultPayout(r.from), `from ${r.from}`);
  assert.equal(ROWS.at(-1).places.length, 150, '1000 entries: the top 15% paid');
});

test('a payout table: each row exactly 100%, no place above the one before, rows starting at more entries', () => {
  assert.throws(() => checkPayoutRows([]), /at least one row/);
  assert.throws(() => checkPayoutRows([{from: 0, places: [10000]}]), /Row 1: entries/);
  assert.throws(() => checkPayoutRows([{from: 1.5, places: [10000]}]), /Row 1/);
  assert.throws(() => checkPayoutRows([{from: 5, places: [10000]}, {from: 5, places: [6000, 4000]}]), /more entries than the one above/);
  assert.throws(() => checkPayoutRows([{from: 2, places: [10000]}, {from: 6, places: [6000, 3000]}]), /From 6 entries: The payouts add up to 90\.00%/);
  assert.throws(() => checkPayoutRows([{from: 2, places: [10000]}, {from: 6, places: [4000, 6000]}]), /From 6 entries: .*more than the one above/);
  assert.throws(() => checkPayoutRows([{from: 1, places: []}]), /above 0/);
  assert.throws(() => checkPayoutRows(Array.from({length: 51}, (_, i) => ({from: i + 1, places: [10000]}))), /At most 50/);
  const ok = checkPayoutRows([{from: 1, places: [10000], extra: 1}]);
  assert.deepEqual(ok, [{from: 1, places: [10000]}], 'a clean copy');
});

test('club payout tables: a tournament pays by one, following the entries and its edits, and keeps what it paid', () => {
  const {club, ids} = clubWith(25);
  const p = addPayoutTable(club, {name: ' Standard ', rows: ROWS});
  assert.equal(p.name, 'Standard');
  assert.throws(() => addPayoutTable(club, {name: 'standard', rows: ROWS}), /called standard already/);
  assert.throws(() => addPayoutTable(club, {name: 'Default', rows: ROWS}), /another name/);
  assert.throws(() => addPayoutTable(club, {name: '', rows: ROWS}), /Name/);
  assert.throws(() => addPayoutTable(club, {name: 'Bad', rows: [{from: 1, places: [9000]}]}), /90\.00%/);
  assert.throws(() => tourney(club, {payoutTable: 'nope'}), /No such payout table/);

  const t = tourney(club, {payoutTable: p.id, lateLevel: 2});
  const other = tourney(club);
  assert.equal(other.payoutTable, undefined, 'Default');
  // The entries so far pick the row.
  const shares = () => payoutShares(t, club);
  for (const id of ids.slice(0, 5)) register(club, t.id, id, 10);
  assert.deepEqual(shares(), [10000]);
  register(club, t.id, ids[5], 10);
  assert.deepEqual(shares(), [6500, 3500]);
  assert.deepEqual(prizes(t, club), [390, 210]);
  for (const id of ids.slice(6, 10)) register(club, t.id, id, 10);
  assert.deepEqual(shares(), [5000, 3000, 2000]);
  // Editing the table changes it (still to finish); renaming keeps it.
  editPayoutTable(club, p.id, {name: 'Main', rows: [{from: 1, places: [7000, 3000]}]});
  assert.equal(p.name, 'Main');
  assert.deepEqual(shares(), [7000, 3000]);
  editPayoutTable(club, p.id, {rows: ROWS});
  // Late entries move it on to the next row.
  startTourney(club, t.id, 1000);
  for (const id of ids.slice(10, 20)) lateEntry(club, t.id, id, 1, 1100);
  assert.deepEqual(shares(), [4000, 2500, 2000, 1500]);
  // Deleting a table in use is refused.
  assert.throws(() => deletePayoutTable(club, p.id), /Sunday|Tournament 1/);
  assert.throws(() => deletePayoutTable(club, p.id), /pick another payout/);
  // The finish: 20 entries, 2000 in the pool.
  ids.slice(1, 20).reverse().forEach((id, k) => knockedOut(club, t.id, id, 20 - k));
  const paid = finishTourney(club, t.id, ids[0], 2000);
  assert.deepEqual(paid.map(x => x.amount), [800, 500, 400, 300]);
  assert.deepEqual(t.paidShares, [4000, 2500, 2000, 1500]);
  assert.ok(totals(club).conserved);
  // Later edits don't rewrite it; nor does deleting the table, now allowed.
  editPayoutTable(club, p.id, {rows: [{from: 1, places: [10000]}]});
  assert.deepEqual(prizes(t, club), [800, 500, 400, 300]);
  assert.throws(() => setPayoutTable(club, t.id, null), /over already/);
  deletePayoutTable(club, p.id);
  assert.equal(club.payoutTables.length, 0);
  assert.deepEqual(tourneysBody(club, {}, 3000).tourneys.find(x => x.id === t.id).prizes, [800, 500, 400, 300]);
});

test('picking: a club table, back to Default, or the tournament’s own', () => {
  const {club} = clubWith(2);
  const p = addPayoutTable(club, {name: 'Top heavy', rows: [{from: 1, places: [10000]}]});
  const t = tourney(club);
  setPayoutTable(club, t.id, p.id);
  assert.equal(t.payoutTable, p.id);
  assert.deepEqual(payoutRows(t, club), p.rows);
  assert.throws(() => setPayoutTable(club, t.id, 'zzz'), /No such payout table/);
  setPayoutTable(club, t.id, null);
  assert.equal(t.payoutTable, undefined);
  assert.equal(payoutRows(t, club), null, 'Default');
  setPayoutTable(club, t.id, p.id);
  setPayout(club, t.id, {rows: [{from: 1, places: [6000, 4000]}]});
  assert.equal(t.payoutTable, undefined, 'its own instead');
  assert.deepEqual(payoutShares(t, club), [6000, 4000]);
});

test('an older tournament’s own payout pays the same: one row from 1 entry', () => {
  const {club, ids} = clubWith(10);
  const t = tourney(club);
  t.payout = {places: [5000, 3000, 2000]}; // as saved before #424
  for (const id of ids) register(club, t.id, id, 10);
  assert.deepEqual(payoutRows(t, club), [{from: 1, places: [5000, 3000, 2000]}]);
  assert.deepEqual(payoutShares(t, club), [5000, 3000, 2000]);
  assert.deepEqual(prizes(t, club), [500, 300, 200]);
  assert.deepEqual(prizes(t), [500, 300, 200], 'without the club too');
  // The manager's page shows it as its own, besides Default and the club's tables.
  addPayoutTable(club, {name: 'Standard', rows: ROWS});
  const h = hostTourneysHtml(club, {}, {form: false}, 500);
  assert.match(h, /<option value="">Default<\/option><option value="[a-z0-9]+">Standard<\/option><option value="own" selected>Its own<\/option>/);
  assert.match(h, /50%<\/td><td>5<\/td>/);
  assert.match(h, /<h2>Payout tables<\/h2>/);
  assert.match(h, /data-cl="paytable-edit"/);
  assert.match(payoutTablesHtml(club, {id: 'new', name: 'X', draft: draftOf()}), /form class="cl-paytable" data-paytable="new"/);
});

test('members see the row in force, for the entries so far until registration closes', () => {
  const {club, ids} = clubWith(7);
  const p = addPayoutTable(club, {name: 'Standard', rows: ROWS});
  const t = tourney(club, {payoutTable: p.id, lateLevel: 1});
  for (const id of ids.slice(0, 6)) register(club, t.id, id, 10);
  const body = () => tourneysBody(club, {}, 500).tourneys[0];
  assert.deepEqual(body().shares, [6500, 3500]);
  const mem = t2 => ({code: club.code, status: 'member', tourneys: [t2]});
  let h = memberTourneysHtml(mem(body()), 'p0', {hostHere: true}, 500);
  assert.match(h, /Payouts \(for the entries so far\)/);
  assert.match(h, /65%/);
  assert.match(h, /35%/);
  startTourney(club, t.id, 1000);
  const running = {...body(), live: {level: 0, playersLeft: 6, tables: [{}], standings: []}};
  assert.ok(entriesOpen(running), 'late registration still open');
  const closed = {...body(), live: {level: 1, playersLeft: 6, tables: [{}], standings: []}};
  assert.ok(!entriesOpen(closed));
  h = memberTourneysHtml(mem(closed), 'p0', {hostHere: true}, 1500);
  assert.match(h, /<span class="pl-label">Payouts<\/span>/, 'settled');
});

test('the editor’s draft: rows and places added and taken away, read back, gaps refused', () => {
  const d = draftOf(ROWS.slice(0, 4));
  assert.notEqual(d.rows[0].places, ROWS[0].places, 'a copy');
  assert.equal(draftOf().rows.length, ROWS.length, 'a new table starts from them all');
  addRow(d);
  assert.deepEqual(d.rows.at(-1), {from: 30, places: [4000, 2500, 2000, 1500]});
  removeRow(d, 0);
  assert.equal(d.rows[0].from, 6);
  addPlace(d);
  const h = rowsEditorHtml(d, 'data-cl');
  assert.match(h, /5th %/);
  assert.match(h, /name="p0_4"/);
  assert.match(h, /data-cl="prow-remove" data-i="3"/);
  // What's typed.
  const typed = {f0: '3', p0_0: '60', p0_1: '40', p0_2: '', f1: '8', p1_0: '50', p1_1: '', p1_2: '50'};
  const el = {querySelector: sel => ({value: typed[sel.match(/name="(.+)"/)[1]] ?? ''})};
  const back = readRows(el, {rows: [{from: 1, places: []}, {from: 2, places: []}], cols: 3});
  assert.deepEqual(back.rows[0], {from: 3, places: [6000, 4000, null]});
  assert.throws(() => cleanRows(back), /From 8 entries: fill the places in order/);
  back.rows[1].places = [10000, null, null];
  assert.deepEqual(cleanRows(back), [{from: 3, places: [6000, 4000]}, {from: 8, places: [10000]}]);
  assert.equal(removeRow({rows: [{from: 1, places: [1]}]}, 0).rows.length, 1, 'the last row stays');
});

test('a one-off tournament: its own table by entries, in points, prizes beyond the entries still allowed', () => {
  const club = privateClub('ABCD-EFGH', 'Ann', 0);
  assert.throws(() => newPrivateTourney(club, {game: 'nlhe', stack: 1500, tableSize: 9, structure: LEVELS, payout: 'table', buyIn: 100, rows: [{from: 1, places: [9000]}]}, 0), /90\.00%/);
  assert.equal(club.tourneys.length, 0, 'nothing made');
  const t = newPrivateTourney(club, {game: 'nlhe', stack: 1500, tableSize: 9, structure: LEVELS, payout: 'table', buyIn: 100, rows: ROWS}, 0);
  assert.deepEqual(t.payout.rows, ROWS);
  for (let i = 0; i < 5; i++) joinPrivate(club, `g${i}`, `G${i}`, 0);
  assert.deepEqual(paidPlaces(t).map(p => p.share), [10000]);
  joinPrivate(club, HOST_ID, 'Ann', 0);
  assert.deepEqual(paidPlaces(t).map(p => p.share), [6500, 3500]);
  assert.deepEqual(lobbyBody(club).prizes, [390, 210]);
  // The host pays more than came in (#403).
  setPrizes(club, [500, 300]);
  assert.deepEqual(prizeTotals(t), {prizes: 800, entries: 600, added: 200});
  // The form shows the editor for By entries.
  const ed = structureEditor({stack: 1500, tableSize: 9});
  const h = setupHtml({name: '', game: 'nlhe', stack: 1500, tableSize: 9, payout: 'table', buyIn: 100, table: draftOf()}, ed);
  assert.match(h, /data-tzrows/);
  assert.match(h, /data-tz="prow-add"/);
  assert.doesNotMatch(setupHtml({name: '', game: 'nlhe', stack: 1500, tableSize: 9, payout: 'wta', buyIn: 100, table: draftOf()}, ed), /data-tzrows/);
});

// ---- the club server ----

function memoryStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
  };
}
const wait = () => new Promise(r => setTimeout(r, 150));

test('the club server: the owner adds, edits, renames and deletes payout tables and picks one; members can’t; each is logged', async () => {
  const storage = memoryStorage();
  const owner = await createIdentity(), ben = await createIdentity(), cy = await createIdentity();
  const code = 'PAYT-ABLE';
  const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Payouts'}), code);
  const sent = [];
  const server = await openClub({storage, send: (to, data) => sent.push({to, data}), online: [], timers: {set: () => 0, clear() {}}});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  for (const p of [owner, ben, cy]) await server.message({from: p.id, event: 'open'});
  await say(owner, {type: 'owner_hello'});
  let n = 1;
  const cmd = async (who, op, args = {}) => {
    const id = n++;
    await say(who, {type: 'owner_cmd', op, args, id});
    await wait();
    return sent.filter(s => s.to === who.id && s.data.body?.type === 'owner_result' && s.data.body.id === id).at(-1)?.data.body;
  };
  for (const [p, name] of [[ben, 'Ben'], [cy, 'Cy']]) {
    await say(p, {type: 'join', invite, name});
    assert.equal((await cmd(owner, 'approve', {id: p.id})).error, '');
  }

  // A member isn't answered, even one who was a manager before (#454).
  server.club.members[ben.id].role = 'assistant';
  assert.equal(await cmd(cy, 'add_payout_table', {table: {name: 'Mine', rows: ROWS}}), undefined);
  assert.equal(await cmd(ben, 'add_payout_table', {table: {name: 'Mine', rows: ROWS}}), undefined);
  assert.equal(server.club.payoutTables, undefined);
  // The owner adds one, renames and edits it.
  const add = await cmd(owner, 'add_payout_table', {table: {name: 'Standard', rows: ROWS}});
  assert.equal(add.error, '');
  const pid = add.value;
  assert.equal(server.club.payoutTables[0].name, 'Standard');
  assert.match((await cmd(owner, 'add_payout_table', {table: {name: 'Bad', rows: [{from: 1, places: [5000]}]}})).error, /50\.00%/);
  assert.equal((await cmd(owner, 'edit_payout_table', {id: pid, table: {name: 'Main'}})).error, '');
  assert.equal((await cmd(owner, 'edit_payout_table', {id: pid, table: {rows: [{from: 1, places: [10000]}, {from: 6, places: [6000, 4000]}]}})).error, '');
  assert.deepEqual(server.club.payoutTables[0].rows[1], {from: 6, places: [6000, 4000]});
  // A tournament made with it, then switched to Default and back.
  const tid = (await cmd(owner, 'new_tourney', {tourney: {name: 'Sunday', buyIn: 0, stack: 1500, structure: LEVELS, opensAt: Date.now(), startsAt: Date.now() + 3600e3, payoutTable: pid}})).value;
  assert.ok(tid);
  const t = server.club.tourneys.find(x => x.id === tid);
  assert.equal(t.payoutTable, pid);
  assert.match((await cmd(owner, 'delete_payout_table', {id: pid})).error, /Sunday pays by Main/);
  assert.equal((await cmd(owner, 'set_payout_table', {id: tid, table: null})).error, '');
  assert.equal(t.payoutTable, undefined);
  assert.equal((await cmd(owner, 'set_payout_table', {id: tid, table: pid})).error, '');
  assert.equal(t.payoutTable, pid);
  assert.equal((await cmd(owner, 'set_payout_table', {id: tid, table: null})).error, '');
  assert.equal((await cmd(owner, 'delete_payout_table', {id: pid})).error, '');
  assert.equal(server.club.payoutTables.length, 0);
  // Members get the tournaments with the row in force.
  const lobby = sent.filter(s => s.to === cy.id && s.data.body?.type === 'tourneys').at(-1)?.data.body;
  assert.deepEqual(lobby.tourneys[0].shares, [10000]);
  // Each in the log.
  const mine = server.club.log.filter(l => l.by === owner.id).map(l => l.text);
  for (const line of ['Added the payout table Standard', 'Renamed the payout table Standard to Main', 'Changed the payout table Main', 'Sunday pays by Main', 'Sunday pays by Default', 'Deleted the payout table Main']) {
    assert.ok(mine.includes(line), line);
  }
});
