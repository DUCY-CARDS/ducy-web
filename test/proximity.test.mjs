// Seat and location flags (#581): the relay's signals (relay/src/proximity.js),
// the page's location watcher (src/table-location.js), the words for them
// (src/club-fair-play.js), the fair play check's use of them
// (relay/src/collusion.js), and a club on the relay (club-room.js) sending
// them to the seats and keeping them in the hand records, never a location.
// Needs the wasm build in wasm/.
// Run with: node --test test/proximity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import {
  hostingNetwork, ipNetwork, LIMITS, liveOf, metres, readingOf, tableSignals, takeReading, trustOf,
} from '../relay/src/proximity.js';
import { unlockedNow } from '../relay/src/unlock.js';
import { IDLE_MS } from '../relay/src/passkeys.js';
import { collusionReport, proximityFlags } from '../relay/src/collusion.js';
import { connSnapshot, createClub, openClub } from '../relay/src/club-room.js';
import { fullHands } from '../relay/src/hand-records.js';
import { EVERY_MS, MIN_MS, watchLocation } from '../src/table-location.js';
import { flagText, handFlagsText, seatFlagsText } from '../src/club-fair-play.js';
import { createIdentity, signMessage } from '../src/identity.js';
import { newKeyPair, open as openBox, sharedKey } from '../src/e2e.js';

const AUSTIN = {lat: 30.2672, lon: -97.7431};
const CST = -360; // the browser's UTC offset there in November, minutes
const at = (p, dLatM = 0, dLonM = 0) => ({lat: p.lat + dLatM / 111_320, lon: p.lon + dLonM / (111_320 * Math.cos((p.lat * Math.PI) / 180))});
const reading = (p, acc = 20, off = CST) => readingOf({type: 'location', lat: p.lat, lon: p.lon, acc, off});

test('networks: hosting and VPN ones by ASN or name; IPv6 homes share their first 64 bits', () => {
  assert.equal(hostingNetwork(14061, 'DIGITALOCEAN-ASN'), true);
  assert.equal(hostingNetwork(null, 'NordVPN S.A.'), true);
  assert.equal(hostingNetwork(9009, ''), true, 'M247, many VPNs');
  assert.equal(hostingNetwork(7922, 'Comcast Cable Communications, LLC'), false);
  assert.equal(hostingNetwork(21928, 'T-Mobile USA, Inc.'), false);
  assert.equal(ipNetwork('203.0.113.7'), '203.0.113.7');
  assert.equal(ipNetwork('2001:db8:85a3:0:1:2:3:4'), '2001:db8:85a3:0');
  assert.equal(ipNetwork('2001:DB8::1'), '2001:db8:0:0');
  assert.equal(ipNetwork('2001:0db8:0000:0042::9'), ipNetwork('2001:db8:0:42:aaaa::1'));
  assert.equal(ipNetwork(''), '');
  assert.deepEqual(TRUSTS(), ['website', 'website', 'app', 'attested app']);
});
const TRUSTS = () => [trustOf(undefined), trustOf('root'), trustOf('app'), trustOf('attested app')];

test('a reading: checked, or refused', () => {
  assert.deepEqual(readingOf({type: 'location', shared: false}), {shared: false});
  assert.deepEqual(readingOf({type: 'location', lat: 1, lon: 2, acc: 3, off: 60}), {shared: true, lat: 1, lon: 2, acc: 3, off: 60});
  assert.equal(readingOf({type: 'location', lat: 91, lon: 2, acc: 3}), null);
  assert.equal(readingOf({type: 'location', lat: 1, lon: 2, acc: -1}), null);
  assert.equal(readingOf({type: 'location', lat: 'x', lon: 2, acc: 3}), null);
  assert.equal(readingOf({type: 'table'}), null);
  assert.equal(readingOf({type: 'location', lat: 1, lon: 2, acc: 3, off: 5000}).off, null);
});

test('honest readings raise no sign of a fake: walking about, a phone’s GPS, a laptop’s Wi-Fi', () => {
  const net = {latitude: 30.27, longitude: -97.74};
  const L = liveOf(null, net);
  let t = 0;
  for (let i = 0; i < 12; i++) takeReading(L, reading(at(AUSTIN, i * 15, i * 5), 8 + (i % 4) * 2.7), (t += 30_000));
  assert.deepEqual(L.fake, []);
  // A laptop: the same place, the same round accuracy, over and over.
  const desk = liveOf(null, net);
  for (let i = 0; i < 10; i++) takeReading(desk, reading(AUSTIN, 30), i * 60_000);
  assert.deepEqual(desk.fake, []);
  // On a hosting network the network's place says nothing (VPN says it).
  const vpn = liveOf({asn: 14061}, {latitude: 52.37, longitude: 4.9});
  takeReading(vpn, reading(AUSTIN), 0);
  assert.equal(vpn.hosting, true);
  assert.deepEqual(vpn.fake, []);
});

test('signs of a faked location: far from the network, the wrong time zone, unnatural accuracy, an impossible jump', () => {
  // GPS in Paris, the network in Austin.
  const far = liveOf(null, {latitude: 30.27, longitude: -97.74});
  takeReading(far, reading({lat: 48.8566, lon: 2.3522}, 20, 60), 0);
  assert.deepEqual(far.fake, ['far']);
  // GPS in Tokyo, the browser's clock in Austin.
  const tz = liveOf();
  takeReading(tz, reading({lat: 35.68, lon: 139.69}, 20, CST), 0);
  assert.deepEqual(tz.fake, ['timezone']);
  // Accuracy exactly 0.
  const zero = liveOf();
  takeReading(zero, reading(AUSTIN, 0), 0);
  assert.deepEqual(zero.fake, ['accuracy']);
  // The same round accuracy while moving, reading after reading.
  const fixed = liveOf();
  for (let i = 0; i < LIMITS.SAME_ACC_RUN; i++) takeReading(fixed, reading(at(AUSTIN, i * 40), 10), i * 30_000);
  assert.deepEqual(fixed.fake, ['accuracy']);
  // Austin to Dallas (about 300 km) in a minute.
  const jump = liveOf();
  takeReading(jump, reading(AUSTIN), 0);
  takeReading(jump, reading({lat: 32.7767, lon: -96.797}), 60_000);
  assert.deepEqual(jump.fake, ['jump']);
  assert.ok(metres(AUSTIN, {lat: 32.7767, lon: -96.797}) > 250_000);
  // Signs stay while connected; a refusal drops the reading.
  takeReading(jump, {shared: false}, 120_000);
  assert.deepEqual([jump.shared, jump.loc, jump.fake], [false, null, ['jump']]);
});

test('the table’s signals: within 100 m, the same network, VPN, location not shared; never where', () => {
  const live = (snap, r) => { const L = liveOf(snap); if (r) takeReading(L, r, 0); return L; };
  const players = [
    {id: 'ann', live: live({ip: 'h1', ipNet: 'n1'}, reading(AUSTIN))},
    {id: 'bob', live: live({ip: 'h2', ipNet: 'n1'}, reading(at(AUSTIN, 40, 30)))},
    {id: 'cy', live: live({ip: 'h3', ipNet: 'n3', asn: 9009}, {shared: false})},
    // Same city, 5 km away: nothing.
    {id: 'dee', live: live({ip: 'h4', ipNet: 'n4'}, reading(at(AUSTIN, 5000)))},
    // A browser that only knows the city (kilometres of accuracy), at its middle: nothing.
    {id: 'eve', live: live({ip: 'h5', ipNet: 'n5'}, reading(at(AUSTIN, 20), 5000))},
    // Not connected: nothing at all.
    {id: 'flo', live: null},
  ];
  const s = tableSignals(players);
  assert.deepEqual(s.seats, {ann: ['near', 'network'], bob: ['near', 'network'], cy: ['vpn', 'hidden']});
  assert.deepEqual(s.flags.map(f => [f.kind, f.ids.join('+')]).sort(), [['hidden', 'cy'], ['near', 'ann+bob'], ['network', 'ann+bob'], ['vpn', 'cy']]);
  assert.doesNotMatch(JSON.stringify(s), /30\.2|97\.7|lat|lon/);
  assert.equal(seatFlagsText(s.seats.cy), 'VPN · location not shared');
  assert.equal(seatFlagsText(['fake', 'near']), 'within 100 m · location may be faked');
  assert.equal(seatFlagsText(undefined), '');
});

test('a reading the page sends on its own needs an unlocked connection, and doesn’t keep it unlocked', () => {
  const now = 1e9;
  assert.equal(unlockedNow(null, now), false);
  assert.equal(unlockedNow({seen: now - 1000, checked: now - 1000}, now), true);
  assert.equal(unlockedNow({seen: now - IDLE_MS - 1, checked: now - 1000}, now), false, 'idle');
  assert.equal(unlockedNow({seen: now - 1000, checked: now - 3600e3}, now), false, 'due a session check');
});

test('the page’s watcher: a reading with its accuracy, refusals, at most every 15 s, again every minute', () => {
  let clock = 0, tick = null, cleared = false;
  const timers = {setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { cleared = true; }};
  let onPos = null, onErr = null;
  const geo = {watchPosition: (ok, err) => { onPos = ok; onErr = err; return 7; }, clearWatch: id => assert.equal(id, 7)};
  const sent = [];
  const w = watchLocation(m => sent.push(m), {geo, now: () => clock, timers});
  const pos = (lat, lon, accuracy) => onPos({coords: {latitude: lat, longitude: lon, accuracy}});
  pos(30.2672123, -97.7431456, 12.34);
  assert.equal(sent.length, 1);
  assert.deepEqual({...sent[0], off: 0}, {type: 'location', lat: 30.26721, lon: -97.74315, acc: 12.3, off: 0});
  clock = MIN_MS - 1;
  pos(30.2673, -97.7431, 10);
  assert.equal(sent.length, 1, 'not more often than MIN_MS');
  clock = MIN_MS;
  pos(30.2674, -97.7431, 10);
  assert.equal(sent.length, 2);
  tick();
  assert.equal(sent.length, 3, `the latest again every ${EVERY_MS / 1000} s`);
  w.again();
  assert.equal(sent.at(-1).lat, 30.2674);
  // Said no.
  onErr({code: 1});
  assert.deepEqual(sent.at(-1), {type: 'location', shared: false});
  w.stop();
  assert.ok(cleared);
  tick();
  assert.equal(sent.at(-1).shared, false);
  const n = sent.length;
  w.again();
  assert.equal(sent.length, n, 'nothing after stop');
  // No geolocation in this browser: not shared.
  const none = [];
  watchLocation(m => none.push(m), {geo: null, timers}).stop();
  assert.deepEqual(none, [{type: 'location', shared: false}]);
});

// Hands at a table, as full records, with the seat and location flags on them.
function hands(n, prox, seats = ['ann', 'bob', 'cy']) {
  return Array.from({length: n}, (_, h) => ({
    id: `T:${h}`, at: 1e6 + h, table: 't1', tableName: 'Main', hand: h + 1, bb: 2, button: 0,
    seats: seats.map((id, i) => ({seat: i, id, name: id[0].toUpperCase() + id.slice(1), cards: null, net: 0})),
    actions: [], board: [], prox: prox(h),
  }));
}

test('the fair play check: pairs within 100 m or on one network, one player’s VPN or faked location', () => {
  const recs = hands(30, h => [
    ...(h < 12 ? [{kind: 'near', ids: ['ann', 'bob']}] : []),
    {kind: 'network', ids: ['ann', 'bob']},
    ...(h % 3 === 0 ? [{kind: 'vpn', ids: ['cy']}] : []),
    ...(h === 5 ? [{kind: 'fake', ids: ['cy'], why: ['timezone']}] : []),
    {kind: 'hidden', ids: ['cy']},
  ]);
  const r = collusionReport(recs);
  const pair = r.flagged.find(e => e.ids.length === 2);
  assert.deepEqual(pair.ids, ['ann', 'bob']);
  assert.deepEqual(pair.flags.map(f => [f.kind, f.with.k, f.with.n]), [['near', 12, 30], ['network', 30, 30]]);
  assert.deepEqual(pair.flags[0].hands.at(-1), {table: 'Main', hand: 12});
  const cy = r.flagged.find(e => e.ids.length === 1);
  assert.deepEqual(cy.ids, ['cy']);
  assert.deepEqual(cy.flags.map(f => [f.kind, f.with.k, f.with.n, f.why || null]), [['vpn', 10, 30, null], ['fake', 1, 30, ['timezone']]]);
  assert.ok(!r.flagged.some(e => e.flags.some(f => f.kind === 'hidden')), 'location not shared isn’t a fair play flag');
  const names = {ann: 'Ann', bob: 'Bo', cy: 'Cy'};
  assert.equal(flagText(pair.flags[0], names), 'Ann and Bo were within 100 m of each other: 12 of 30 hands together');
  assert.equal(flagText(pair.flags[1], names), 'Ann and Bo played on the same network: 30 of 30 hands together');
  assert.equal(flagText(cy.flags[0], names), 'Cy played through a VPN or hosting network: 10 of 30 hands');
  assert.equal(flagText(cy.flags[1], names), 'Cy’s location may be faked (time zone doesn’t match): 1 of 30 hands');
  // Flags about someone not in the hand are ignored; no records, no flags.
  assert.deepEqual(collusionReport(hands(5, () => [{kind: 'near', ids: ['ann', 'zed']}])).flagged, []);
  assert.deepEqual(proximityFlags('a', 'b'), []);
});

test('the owner’s records: each hand’s flags by name', () => {
  const rec = {seats: [{id: 'a', name: 'Ann'}, {id: 'b', name: 'Bo'}, {id: 'c', name: 'Cy'}], flags: [
    {kind: 'near', ids: ['a', 'b']}, {kind: 'network', ids: ['a', 'b']}, {kind: 'vpn', ids: ['c']}, {kind: 'hidden', ids: ['c']}, {kind: 'odd', ids: ['c']},
  ]};
  assert.equal(handFlagsText(rec), 'Ann and Bo: within 100 m · same network; Cy: VPN · location not shared');
  assert.equal(handFlagsText({seats: []}), '');
});

test('a connection’s snapshot keeps its trust level and its network, hashed', async () => {
  const a = await connSnapshot({ip: '2001:db8:1:2::10', ua: 'x', trust: 'website'}, 'salt', 0);
  const b = await connSnapshot({ip: '2001:db8:1:2::99', ua: 'x'}, 'salt', 0);
  assert.equal(a.trust, 'website');
  assert.equal(b.trust, 'website', 'website unless the relay says otherwise');
  assert.notEqual(a.ip, b.ip);
  assert.equal(a.ipNet, b.ipNet, 'one home');
  assert.match(a.ipNet, /^[0-9a-f]{32}$/);
});

// ---- at a club on the relay ----

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const timers = {set: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clear: h => clearTimeout(h)};

test('at a club on the relay: the seats get their flags, the records keep them, and no location is kept', async () => {
  const store = new Map();
  const storage = {get: async k => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async k => { store.delete(k); }};
  const code = 'NEAR-BY01';
  const owner = await createIdentity();
  const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Near'}), code);
  const people = {};
  let server = null;
  const send = (to, data) => {
    const p = people[to];
    if (!p) return;
    const env = JSON.parse(JSON.stringify(data));
    p.wire.push(env);
    p.inbox = p.inbox.then(() => p.receive(env)).catch(e => console.warn(e));
  };
  const person = async name => {
    const ident = await createIdentity(), keys = await newKeyPair();
    const p = {ident, keys, name, wire: [], got: [], inbox: Promise.resolve(), out: Promise.resolve(), aes: null, table: null};
    p.say = body => (p.out = p.out.then(async () => server.message({from: ident.id, data: await signMessage(ident, {club: code, ...body})})));
    p.cmd = cmd => p.say({type: 'table', table: p.table, cmd});
    p.receive = async env => {
      if (env.body?.type === 'host_key') {
        p.aes = await sharedKey(keys, env.body.key, {context: `club:${code}`, hostId, playerId: ident.id, hostPub: env.body.key, playerPub: keys.pub});
        return;
      }
      if (env.type !== 'table' || !env.enc || !p.aes) return;
      const u = await openBox(p.aes, env.enc);
      p.got.push(u);
      if (u.type === 'state' && u.view.legal && !u.view.complete) p.cmd({type: 'act', seq: u.seq, kind: u.view.legal.can_check ? 'check' : 'call', amount: 0});
    };
    people[ident.id] = p;
    return p;
  };
  const ann = await person('Ann'), bob = await person('Bob'), cy = await person('Cy');
  const players = [ann, bob, cy];
  server = await openClub({storage, send, online: [], timers});
  let n = 0;
  const ownerSays = async (op, args) => server.message({from: owner.id, data: await signMessage(owner, {club: code, type: 'owner_cmd', op, args, id: ++n})});
  await server.message({from: owner.id, event: 'open'});
  await ownerSays('new_table', {table: {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 3, turnSecs: 30}});
  const tid = server.club.tables.find(t => t.name === 'Main').id;
  // Ann and Bob at one home; Cy over a VPN.
  const home = {ip: '198.51.100.20', ua: 'Mozilla/5.0 (Macintosh)', asn: 7922, asOrg: 'Comcast Cable', country: 'US', city: 'Austin', timezone: 'America/Chicago', latitude: 30.27, longitude: -97.74, trust: 'website'};
  const conns = {[ann.ident.id]: home, [bob.ident.id]: home, [cy.ident.id]: {...home, ip: '192.0.2.50', asn: 14061, asOrg: 'DIGITALOCEAN-ASN'}};
  for (const p of players) {
    await server.message({from: p.ident.id, event: 'open', conn: conns[p.ident.id]});
    await p.say({type: 'join', invite, name: p.name, key: p.keys.pub});
    await ownerSays('approve', {id: p.ident.id});
    await ownerSays('give', {id: p.ident.id, amount: 1000});
    await p.say({type: 'hello', key: p.keys.pub});
  }
  await until('the host key', () => players.every(p => p.aes));
  for (const p of players) {
    p.table = tid;
    await p.cmd({type: 'join'});
    await p.cmd({type: 'request_chips', amount: 150});
  }
  // Their pages send their locations as they sit: Ann and Bob 40 m apart, Cy says no.
  const loc = (p, m) => server.message({from: p.ident.id, data: {type: 'location', ...m}});
  await until('everyone seated', () => server.seatsAt(tid).length === 3);
  await loc(ann, {lat: AUSTIN.lat, lon: AUSTIN.lon, acc: 15, off: CST});
  const b = at(AUSTIN, 30, 25);
  await loc(bob, {lat: b.lat, lon: b.lon, acc: 18.5, off: CST});
  await loc(cy, {shared: false});
  await until('two hands', () => new Set(bob.got.filter(u => u.type === 'state' && u.view.complete && Number(u.view.hand_number)).map(u => u.view.hand_number)).size >= 2, 120_000);
  await sleep(100);

  // Each page's latest flags, by the table's seats; a view's seat i is the
  // table's (view.seat + i) mod seats.
  const seatOf = Object.fromEntries(server.seatsAt(tid).map(s => [s.id, s.seat]));
  for (const p of players) {
    const flags = p.got.filter(u => u.type === 'seat_flags').at(-1)?.seats;
    assert.ok(flags, `${p.name} got the seats' flags`);
    assert.deepEqual(flags[seatOf[ann.ident.id]], ['near', 'network']);
    assert.deepEqual(flags[seatOf[bob.ident.id]], ['near', 'network']);
    assert.deepEqual(flags[seatOf[cy.ident.id]], ['vpn', 'hidden']);
    const view = p.got.filter(u => u.type === 'state').at(-1).view;
    assert.equal(view.seats[0].name, p.name);
    assert.equal(Number(view.seat), seatOf[p.ident.id], 'the view says which seat is theirs');
    const shown = Object.fromEntries(view.seats.map((s, i) => [s.name, seatFlagsText(flags[(Number(view.seat) + i) % view.seats.length])]));
    assert.deepEqual(shown, {Ann: 'within 100 m · same network', Bob: 'within 100 m · same network', Cy: 'VPN · location not shared'});
  }

  // The records: the owner's history and the full records carry the flags.
  await server.flush();
  const history = await server.run('hands', {limit: 100});
  assert.ok(history.length >= 2);
  const last = history[0];
  assert.match(handFlagsText(last), /Ann and Bob: within 100 m · same network|Bob and Ann: within 100 m · same network/);
  // Cy's flag is in it if Cy was dealt into it (Cy sat down last).
  if ((last.seats || []).some(s => s.id === cy.ident.id && s.inHand !== false)) assert.match(handFlagsText(last), /Cy: VPN · location not shared/);
  const full = await fullHands(storage);
  assert.ok(full.at(-1).prox.some(f => f.kind === 'near'));
  assert.equal(full.at(-1).seats.find(s => s.id === ann.ident.id).conn.trust, 'website');
  const report = await server.checkFairPlay();
  const pair = report.flagged.find(e => e.ids.length === 2 && e.ids.includes(ann.ident.id) && e.ids.includes(bob.ident.id));
  assert.deepEqual(pair.flags.map(f => f.kind).sort(), ['near', 'network']);
  // Cy's VPN counts in the hands Cy was dealt into (Cy sat down last, so
  // maybe none yet).
  const cyHands = full.filter(r => r.seats.some(s => s.id === cy.ident.id)).length;
  const cyEntry = report.flagged.find(e => e.ids.length === 1 && e.ids[0] === cy.ident.id);
  if (cyHands) assert.deepEqual(cyEntry.flags.map(f => [f.kind, f.with.k]), [['vpn', cyHands]]);
  else assert.equal(cyEntry, undefined);

  // No location anywhere it's kept, or sent to anyone.
  await server.flush();
  const kept = JSON.stringify([...store.values()]);
  for (const x of [String(AUSTIN.lat), String(AUSTIN.lon), b.lat.toFixed(4), '30.27', '-97.74']) assert.ok(!kept.includes(x), `stored ${x}`);
  for (const p of players) assert.doesNotMatch(JSON.stringify(p.got.filter(u => u.type === 'seat_flags')), /30\.2|97\.7/);

  // Bob leaves the relay: his reading goes with him, and the table hears.
  const before = ann.got.filter(u => u.type === 'seat_flags').length;
  await server.message({from: bob.ident.id, event: 'close'});
  await until('new flags', () => ann.got.filter(u => u.type === 'seat_flags').length > before);
  const now = ann.got.filter(u => u.type === 'seat_flags').at(-1).seats;
  assert.equal(now[seatOf[bob.ident.id]], undefined);
  assert.equal(now[seatOf[ann.ident.id]], undefined, 'no one near her now');
  await ownerSays('close_table', {table: tid});
  await server.flush();
});
