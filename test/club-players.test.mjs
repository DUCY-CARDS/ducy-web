// Players (#661, src/club-players.js): each player's cash hands, results,
// rake and tournaments by period, as the club counts them from its tables
// (club-host.js, ducy-club's players.rs), and the page: periods, sorting,
// the agent filter, per 100 hands and CSV. Needs the wasm build in wasm/.
// Run with: node --test test/club-players.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue, reclaim, tourneyBuyIn } = await import('../src/club-chips.js');
const { newTable } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');
const { agentBody, answerAgent, assignToAgent, contributions, offerAgent } = await import('../src/club-agents.js');
const { PERIODS, per100, picked, playersCsv, playersCsvFile, playersEvent, playersPageHtml, playersReport, shownRows } = await import('../src/club-players.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 20_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function clubWith(ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 100_000, 0);
  }
  return club;
}

test('each hand at a cash table counts for everyone dealt in: hands, results after the rake, and rake', {skip: !haveWasm && 'no wasm build'}, async tc => {
  const club = clubWith(['ann', 'bob', 'cy']);
  // 1/2, 10% capped at 3 BB: everyone all in, a 400 pot, 6 of it the club's.
  const t = newTable(club, {name: 'Main', sb: 100, bb: 200, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0, charge: {percent: 1000, capBB: 300}});
  const engine = clubEngine();
  const hands = [];
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = msg.update;
    if (u.type === 'state' && u.view.legal && !u.view.complete) host.handle(t.id, to, {type: 'act', seq: u.seq, ...(u.view.legal.call != null && u.view.legal.raise == null ? {kind: 'call', amount: 0} : {kind: 'allin', amount: 0})});
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {},
    onHand: (tid, view) => hands.push(view),
    call: async (op, ...args) => engine.ops[op](...args), nextHandMs: 50,
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  await host.start(t);
  tc.after(() => host.close(t.id));
  for (const id of ['ann', 'bob']) {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: 20_000});
    await until(`${id} seated`, () => club.members[id].seat?.stack === 20_000);
  }
  await until('a hand over', () => hands.length >= 1);
  for (const id of ['ann', 'bob']) await host.handle(t.id, id, {type: 'leave'});
  await until('both stood up', () => !club.members.ann.seat && !club.members.bob.seat);
  const n = hands.length;

  const r = playersReport(club);
  assert.deepEqual(r.players.map(p => p.id).sort(), ['ann', 'bob'], 'Cy never sat');
  for (const p of r.players) {
    assert.equal(p.all.hands, n);
    assert.deepEqual(p.today, p.all);
    assert.ok(p.last > 0);
  }
  // What they won and lost is the chips, less the rake each paid.
  const sum = k => r.players.reduce((s, p) => s + p.all[k], 0);
  assert.equal(sum('rake'), 600 * n);
  assert.equal(sum('net'), -600 * n);
  assert.equal(club.members.ann.balance + club.members.bob.balance, 200_000 - 600 * n);
  // The rake is the rake book's.
  assert.deepEqual(r.players.map(p => p.all.rake).sort(), contributions(club).players.map(p => p.all).sort());
  // Kept with the club, by day: totals only.
  assert.equal(Object.keys(club.playBook.days).length, 1);
  assert.deepEqual(Object.keys(club.playBook.total).sort(), ['ann', 'bob']);
  assert.ok(!JSON.stringify(club.playBook).includes('cards'));
});

test('an agent sees their own players’ play, and the owner sees every agent to filter by', {skip: !haveWasm && 'no wasm build'}, () => {
  const club = clubWith(['al', 'bo', 'cy']);
  offerAgent(club, 'al');
  answerAgent(club, 'al', true, 1);
  // Bo and Cy each played a tournament: in the ledger, so they're in the report.
  tourneyBuyIn(club, 'bo', 'T1', 1000, 5);
  tourneyBuyIn(club, 'cy', 'T1', 1000, 5);
  // Cy moves under Al with his chips taken back first (only an empty link moves).
  reclaim(club, 'cy', club.members.cy.balance, 6);
  assignToAgent(club, 'cy', 'al', 6);
  const owner = playersReport(club, null, 10);
  assert.deepEqual(owner.agents, [{id: 'al', name: 'Al'}]);
  const al = agentBody(club, 'al', 10);
  assert.deepEqual(al.report.players.map(p => p.id), ['cy']);
  assert.equal(al.report.players[0].all.tourney, -1000);
  assert.deepEqual(al.report.agents, []);
  // The agent's Play table: no agent column, no links.
  const html = playersPageHtml(al.report, {now: 10});
  assert.doesNotMatch(html, /data-pp-agent|>Agent</);
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /Cy/);
});

// A report by hand: Ann (the club's) plays a lot and wins, Bo (Al's) a
// little and loses, Cy (Al's) only tournaments, and Di only before today.
const P = (hands, net, rake, tourney = 0) => ({hands, net, rake, tourney});
const report = {
  agents: [{id: 'al', name: 'Al'}],
  players: [
    {id: 'ann', name: 'Ann', agent: null, last: 9_000, today: P(200, 5000, 600), week: P(400, 8000, 1200), month: P(400, 8000, 1200), all: P(400, 8000, 1200)},
    {id: 'bo', name: 'Bo', agent: 'al', last: 8_000, today: P(50, -2500, 150), week: P(50, -2500, 150), month: P(50, -2500, 150), all: P(50, -2500, 150)},
    {id: 'cy', name: 'Cy', agent: 'al', last: 7_000, today: P(0, 0, 0, 3000), week: P(0, 0, 0, 3000), month: P(0, 0, 0, 3000), all: P(0, 0, 0, 3000)},
    {id: 'di', name: 'Di', agent: null, last: 1_000, today: P(0, 0, 0), week: P(0, 0, 0), month: P(10, -100, 20), all: P(10, -100, 20)},
  ],
};

test('per 100 hands, and the rows for a period, sorted and filtered by agent', () => {
  assert.equal(per100(5000, 200), 2500);
  assert.equal(per100(-2500, 50), -5000);
  assert.equal(per100(7, 3), 233);
  assert.equal(per100(100, 0), null);
  assert.deepEqual(PERIODS.map(p => p[1]), ['Today', '7 days', '30 days', 'All']);
  const ids = at => shownRows(report, {period: 'today', sort: 'hands', dir: -1, agent: '', ...at}).map(r => r.id);
  // Today: Di played nothing, so isn't there.
  assert.deepEqual(ids(), ['ann', 'bo', 'cy']);
  assert.deepEqual(ids({period: 'month'}), ['ann', 'bo', 'di', 'cy']);
  assert.deepEqual(ids({dir: 1}), ['cy', 'bo', 'ann']);
  assert.deepEqual(ids({sort: 'net'}), ['ann', 'cy', 'bo']);
  // Per 100 without hands goes last, either way.
  assert.deepEqual(ids({sort: 'net100'}), ['ann', 'bo', 'cy']);
  assert.deepEqual(ids({sort: 'net100', dir: 1}), ['bo', 'ann', 'cy']);
  assert.deepEqual(ids({sort: 'rake100'}), ['ann', 'bo', 'cy']);
  assert.deepEqual(ids({sort: 'tourney'}), ['cy', 'ann', 'bo']);
  assert.deepEqual(ids({sort: 'name', dir: 1}), ['ann', 'bo', 'cy']);
  assert.deepEqual(ids({sort: 'agent', dir: 1, period: 'all'}), ['bo', 'cy', 'ann', 'di']);
  assert.deepEqual(ids({sort: 'last', period: 'all'}), ['ann', 'bo', 'cy', 'di']);
  assert.deepEqual(ids({agent: 'al'}), ['bo', 'cy']);
  assert.deepEqual(ids({agent: 'club', period: 'all'}), ['ann', 'di']);
});

test('the page: periods, the agent filter, sortable columns, per 100 and links', () => {
  Object.assign(picked, {period: 'today', sort: 'hands', dir: -1, agent: ''});
  const html = playersPageHtml(report, {link: id => `#clubs/member/${id}`, now: 10_000});
  for (const [k, t] of PERIODS) assert.match(html, new RegExp(`data-pp-period="${k}" aria-pressed="${k === 'today'}">${t}<`));
  assert.match(html, /<option value="" selected>All agents<\/option><option value="club">Club<\/option><option value="al">Al<\/option>/);
  assert.match(html, /data-pp-csv="1">Export CSV</);
  for (const h of ['Player', 'Agent', 'Hands ↓', 'Won', 'Won/100', 'Rake', 'Rake/100', 'Tournaments', 'Last played']) assert.match(html, new RegExp(`>${h}</button>`), h);
  assert.match(html, /aria-sort="descending"><button class="pp-sort on" data-pp-sort="hands">/);
  // Ann: 200 hands, +50 (+25 per 100), 6 rake (3 per 100).
  const ann = html.match(/<tr><th><a href="#clubs\/member\/ann">Ann<\/a><\/th>.*?<\/tr>/)[0];
  assert.match(ann, /<td class="pp-text">Club<\/td><td>200<\/td><td><span class="cl-up">\+50<\/span><\/td><td><span class="cl-up">\+25<\/span><\/td><td>6<\/td><td>3<\/td>/);
  // Cy: no hands, so nothing per 100.
  const cy = html.match(/<tr><th><a href="#clubs\/member\/cy">Cy<\/a><\/th>.*?<\/tr>/)[0];
  assert.match(cy, /<td>0<\/td><td><span class="">0<\/span><\/td><td>–<\/td><td>0<\/td><td>–<\/td><td><span class="cl-up">\+30<\/span><\/td>/);
  assert.doesNotMatch(html, />Di</);
  // No tournaments, no column; nobody under an agent, no filter or column.
  const plain = {agents: [], players: [report.players[0]]};
  const h2 = playersPageHtml(plain);
  assert.doesNotMatch(h2, /Tournaments|data-pp-agent|>Agent</);
  // Nothing yet; nothing in the period.
  assert.match(playersPageHtml({players: [], agents: []}), /No play yet\./);
  Object.assign(picked, {agent: 'nobody'});
  assert.match(playersPageHtml(report), /No one played\./);
  Object.assign(picked, {agent: ''});
});

test('clicks and changes pick the period, the order and the agent; Export CSV has the rows shown', () => {
  Object.assign(picked, {period: 'month', sort: 'hands', dir: -1, agent: ''});
  playersPageHtml(report);
  const btn = data => ({type: 'click', target: {closest: () => ({dataset: data})}});
  assert.equal(playersEvent(btn({ppPeriod: 'week'})), true);
  assert.equal(picked.period, 'week');
  // A number column starts high to low, a name A to Z; again turns it round.
  playersEvent(btn({ppSort: 'name'}));
  assert.deepEqual([picked.sort, picked.dir], ['name', 1]);
  playersEvent(btn({ppSort: 'name'}));
  assert.deepEqual([picked.sort, picked.dir], ['name', -1]);
  playersEvent(btn({ppSort: 'rake'}));
  assert.deepEqual([picked.sort, picked.dir], ['rake', -1]);
  assert.equal(playersEvent({type: 'change', target: {dataset: {ppAgent: '1'}, value: 'al'}}), true);
  assert.equal(picked.agent, 'al');
  assert.equal(playersEvent({type: 'change', target: {dataset: {}}}), false);
  assert.equal(playersEvent({type: 'click', target: {closest: () => null}}), false);
  assert.equal(playersEvent(btn({ppCsv: '1'})), 'csv');

  const f = playersCsvFile();
  assert.equal(f.name, 'ducy-players-7-days.csv');
  const lines = f.text.trim().split('\n');
  assert.equal(lines[0], 'player,agent,hands,won,won per 100,rake,rake per 100,tournaments,last played');
  // Al's players this week, by rake: Bo, then Cy (no hands: no per 100).
  assert.deepEqual(lines.slice(1), [
    `Bo,Al,50,-25,-50,1.5,3,0,${new Date(8_000).toISOString()}`,
    `Cy,Al,0,0,,0,,30,${new Date(7_000).toISOString()}`,
  ]);
  // Names with commas or quotes are quoted.
  const odd = {agents: [], players: [{...report.players[0], name: 'Ann "A", B'}]};
  assert.match(playersCsv(odd, {period: 'all', sort: 'hands', dir: -1, agent: ''}), /^"Ann ""A"", B",Club,400,/m);
  Object.assign(picked, {period: 'month', sort: 'hands', dir: -1, agent: ''});
});
