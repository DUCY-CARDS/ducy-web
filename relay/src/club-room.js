// An always-on club (#93): its room on the relay is its host. The room runs
// the same host code as a host's tab (src/club-server.js, with the engine
// from src/club-engine.js) and keeps everything in the room's storage, so
// the club goes on with no browser open, and picks up where it was after
// the room restarts (e.g. after hibernating while no one plays).
//
// Shared by the Cloudflare Worker (worker.js, Durable Object storage) and
// the local relay (dev-server.mjs, in memory). What to make of requests,
// what the super admin sees and the play clock are ducy-play's club_room
// (clubRoom, #463); this keeps the storage and runs the club.
//
// storage: {get(key), put(key, value), delete(key)}, async, JSON-like values:
//   club, verifier       the club (club.js) and its Verifier's senders
//   identity             the club's signing identity (identity.js export):
//                        players check every message against its ID
//   hostKey              its key pair for encrypted table updates (e2e.js)
//   memberPubs           members' public keys for those, {id: pub}
//   table:<id>           a table saved mid-hand (club-host.js)
//   hands, hand:<…>      finished hands, as the host saw them (#125)
//   fullHands, full:<…>  finished hands with every seat's cards, for ducy's
//                        own checks (#580): only hand-records.js reads them,
//                        for collusion.js and assist.js (fair-play.js)
//   seen                 when each player was last heard from, {id: ms} (#401)
//   fairPlay             the latest fair play check's report (#582, #591): counts
//                        and hand numbers, no cards; the owner sees it
//   fairPlayDue          when the first hand not yet checked was played
//   conns, connSalt      each player's last few connections, hashed with
//                        the club's salt (#582): only for the full records
// Players' locations (#581) are never stored: the latest reading of each
// connected player is held in memory only (proximity.js), and only the
// flags from it are kept, in the hand records.

import { checkSignature, createIdentity, exportIdentity, importIdentity, signMessage, Verifier } from '../../src/identity.js';
import { newClub } from '../../src/club.js';
import { ensureTables } from '../../src/club-tables.js';
import { createClubServer } from '../../src/club-server.js';
import { clubEngine } from '../../src/club-engine.js';
import { command } from '../../src/club-commands.js';
import { keyPairFromJSON, keyPairToJSON, newKeyPair } from '../../src/e2e.js';
import { clubRoom } from '../../wasm/ducy_wasm.js';
import { dropFullHands, fullRecord, keepFullHand } from './hand-records.js';
import { SCHEDULE } from './collusion.js';
import { fairPlayRun } from './fair-play.js';
import { ipNetwork, liveOf, readingOf, seatPayloads, tableSignals, takeReading, trustOf } from './proximity.js';
import { HOST_KEEP_DAYS } from '../../src/hand-store.js';

// Hands kept for the owner's history (#125); about 1–2 KB each.
const MAX_HANDS = 500;
// How often a player's last-seen time is saved (#401).
const SEEN_EVERY_MS = 60_000;
// Finished hands the admin page shows (#401).
const ADMIN_HANDS = 100;
// Usage (#421): the longest pause in play that still counts.
export const PLAY_GAP_MS = 60_000;

// ---- connections, for the full hand records (#582) ----
// Kept so ducy's checks can tell players who share a place or a device;
// never sent to anyone, the owner included, and never the raw IP.

// How many connections are kept per player.
const CONNS_KEPT = 5;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hashed(salt, text) {
  if (!text) return null;
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${text}`))).slice(0, 32);
}

// A user agent's family: {browser, os, mobile}.
export function clientKind(ua) {
  const u = String(ua || '');
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : u ? 'Other' : null;
  const os = /Android/.test(u) ? 'Android' : /iPhone|iPad|iPod/.test(u) ? 'iOS' : /Windows/.test(u) ? 'Windows'
    : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : u ? 'Other' : null;
  return {browser, os, mobile: u ? /Mobi|iPhone|Android/.test(u) : null};
}

// What's kept of a connection the relay saw (`conn`: {ip, ua, asn, asOrg,
// country, region, city, timezone, trust}, worker.js connOf), at `now`: the
// IP, its network (ipNetwork: a home's devices share it on IPv6) and the
// user agent hashed with the club's own salt (the same player or device
// shows as the same value at this club only), Cloudflare's network and
// place for it, the client's kind, and its trust level (#581, #583:
// 'website' for now).
export async function connSnapshot(conn, salt, now = Date.now()) {
  const c = conn || {};
  const str = v => (v == null || v === '' ? null : String(v).slice(0, 80));
  return {
    since: now, until: null,
    ip: await hashed(salt, str(c.ip)), ipNet: await hashed(salt, str(ipNetwork(c.ip))), ua: await hashed(salt, str(c.ua)),
    trust: trustOf(c.trust),
    asn: Number.isFinite(Number(c.asn)) && c.asn !== '' && c.asn != null ? Number(c.asn) : null, asOrg: str(c.asOrg),
    country: str(c.country), region: str(c.region), city: str(c.city), timezone: str(c.timezone),
    client: clientKind(c.ua),
  };
}

// Player `id`'s connection when a hand began at `at`, from their kept ones
// (newest last): the one open then, else the last one before it.
export function connAt(list, at) {
  if (!list?.length) return null;
  if (!Number.isFinite(at)) return list[list.length - 1];
  const before = list.filter(c => c.since <= at);
  const open = before.filter(c => c.until == null || c.until >= at);
  const pick = open[open.length - 1] || before[before.length - 1] || null;
  if (!pick) return null;
  const {since: _s, until: _u, ...rest} = pick;
  return rest;
}

// Runs room op `op` (ducy-play's club_room): its value, or throws why not.
function room(op, now = Date.now()) {
  const r = clubRoom(op, now);
  if (!r.ok) throw new Error(r.message);
  return r;
}

// A signed request to create an always-on club in room `code`:
// {type: 'create_club', club: code, name}. Returns {hostId, invite}, or
// throws why not. The room must be empty: the caller checks there's no host
// and no one else in it. `claim(owner, code)` asks the relay's registry
// (registry.js) whether this owner may have another club, and throws if not.
export async function createClub(storage, env, code, claim = async () => {}) {
  if (await storage.get('club')) throw new Error('That club code is in use.');
  if (await checkSignature(env)) throw new Error('The request isn’t signed properly.');
  const name = room({op: 'checkCreate', env, code}).value;
  await claim(env.from, code, name);
  const identity = await createIdentity();
  const club = newClub(env.body.name, code, identity.id);
  club.ownerId = env.from;
  club.alwaysOn = true;
  ensureTables(club);
  // Its owner's float (#589), filled from their vault, in the ledger.
  command(club, 'vault_settle');
  const hostKey = await newKeyPair({keep: true});
  await storage.put('identity', await exportIdentity(identity));
  await storage.put('hostKey', await keyPairToJSON(hostKey));
  await storage.put('verifier', {});
  await storage.put('memberPubs', {});
  await storage.put('club', club);
  return {hostId: identity.id, invite: club.invite};
}

// A browser-run club moving here (#98): {type: 'import_club', club: code,
// data, senders}, signed by the club's host (data.hostId), with its club
// (club.js) and its Verifier's senders. No one may be at a table. The club
// gets its own signing identity here, the host becomes its owner, and the
// members' keys and message counters carry over. Returns {hostId}: the host
// then signs a host_moved for it (see openClub), so members follow.
// `claim` as for createClub.
export async function importClub(storage, env, code, claim = async () => {}) {
  if (await storage.get('club')) throw new Error('That club is already on the server.');
  if (await checkSignature(env)) throw new Error('The request isn’t signed properly.');
  const name = room({op: 'checkImport', env, code}).value;
  await claim(env.from, code, name);
  const body = env.body;
  const identity = await createIdentity();
  const club = {...body.data, hostId: identity.id, ownerId: env.from, alwaysOn: true};
  ensureTables(club);
  // Its daily chip cap becomes the owner's float (#589).
  command(club, 'vault_settle');
  const hostKey = await newKeyPair({keep: true});
  await storage.put('identity', await exportIdentity(identity));
  await storage.put('hostKey', await keyPairToJSON(hostKey));
  await storage.put('verifier', body.senders && typeof body.senders === 'object' ? body.senders : {});
  await storage.put('memberPubs', {});
  await storage.put('club', club);
  return {hostId: identity.id};
}

// What anyone may learn from a club's code (GET /code/<code>, #393): that
// it's a club; and, only when it lets people ask to join with the code,
// its name and host ID, so they can. Nothing about its members or tables.
// With an `invite` token that's the club's (or an agent's): its About the
// club too (#398), for the invite screen.
export const codeInfo = (club, invite = '') => room({op: 'codeInfo', club: club || {}, invite: String(invite || '')}).value;

// What the super admin sees of the club in `storage` (#401), read from
// storage, so the club needn't be opened:
//   'full'    everything it stores, read-only; the lobby chat and the
//             cards in finished hands only with `reveal`
//   'people'  each player it knows: [{id, name, status, role, agent,
//             balance, lastSeen}], the owner too
//   'person'  player `id`'s part in it: their member record, ledger
//             entries, chip requests, help requests and log lines
// null when the room holds no club.
export async function adminView(storage, what, {reveal = false, id = ''} = {}) {
  const club = await storage.get('club');
  if (!club) return null;
  const seen = (await storage.get('seen')) || {};
  if (what === 'people') return room({op: 'adminPeople', club, seen}).value;
  if (what === 'person') return room({op: 'adminPerson', club, seen, id: String(id)}).value;
  const index = (await storage.get('hands')) || [];
  const hands = [];
  for (const h of index.slice(-ADMIN_HANDS).reverse()) {
    const rec = await storage.get(h.key);
    if (rec) hands.push(rec);
  }
  return room({op: 'adminFull', club, seen, reveal: !!reveal, hands}).value;
}

// The club server's plan and limits from its registry record (#265). An
// older club with no record keeps the free limits. `temporary` (#395):
// no backup of it proved yet.
const planOf = record => room({op: 'planOf', record: record || null}).value;

// Is `env` the old host's signed handoff to this club's identity (#98)?
async function isHandoff(club, env) {
  const b = env?.body;
  return b?.type === 'host_moved' && b.club === club.code && b.hostId === club.hostId
    && env.from === club.ownerId && !(await checkSignature(env));
}

// A club's play time (#421, club_room's PlayClock): playing() each time a
// hand is in play; gaps up to PLAY_GAP_MS count, longer ones end a stretch.
// onUsage(minutes, at) gets it as it goes: at most every five minutes of
// play, at the end of each stretch (found by `timers`, if given, else at the
// next one), and at a new day. report() sends what's counted so far.
export function playClock(onUsage, timers = null, now = () => Date.now()) {
  let clock = {played: 0, lastPlay: 0}, reportT = null;
  const tell = u => { if (u) Promise.resolve(onUsage(u.minutes, u.at)).catch(e => console.warn('club: usage not reported:', e)); };
  const step = (op, t = now()) => {
    const r = room({op, clock}, t);
    clock = r.clock;
    tell(r.value);
    return r.value;
  };
  function check() {
    reportT = null;
    if (!step('check') && clock.played) reportT = timers.set(check, PLAY_GAP_MS);
  }
  function playing() {
    step('playing');
    if (timers && !reportT) reportT = timers.set(check, PLAY_GAP_MS + 1000);
  }
  return {playing, report: () => step('report')};
}

// Opens the club in this room, if there is one: a running club server
// (club-server.js), with `online` (the member IDs connected now) told it's
// open, on ducy's engine (the wasm must be loaded). `send(to, data)`
// delivers to a member's connections. Returns null when the room isn't a club.
// `ClubTable`: ducy's unless given (club-engine.js).
// `onUsage(minutes, at)`: the club's tables were in play that long, by time
// `at` (registry.js counts it against the free plan on that day). `onDeleted()`: the owner deleted the
// club and its storage is gone; the caller drops the server and its
// connections. `onSaved()`: the club was saved (the caller may back it up,
// backup.js).
// `timers`: {set(fn, ms), clear(handle)} for the tables' clocks (#135); the
// Worker backs it with the room's alarm, the local relay uses plain timers.
// `onHand(ids)`: a hand finished, with these players in it (counted for the
// admin site, #601).
// `record`: the club's record in the registry (registry.js, #265), for its
// plan and limits; server.setRecord(record) when the super admin changes it.
// `onProved(owner)`: the owner proved a backup works (#395, the
// backup_proved action); the caller records it in the registry and
// resolves to the club's new record.
// `onOwnerMoved(from, to)`: the relay vouched the owner onto a new player
// ID (vouchedMove); the caller updates the registry's record.
// `openConns`: {id: conn} for those in `online`, their connections as the
// relay saw them (worker.js connOf), for the seat and location signals.
// `onFairPlay(summary)`: a fair play run finished; its summary for ducy's
// admin (fair-play-admin.js adminSummary, #612), which the caller sends to
// the registry. No cards in it.
export async function openClub({storage, send, online = [], openConns = {}, ClubTable, onUsage = () => {}, onHand = () => {}, onDeleted = () => {}, onSaved = () => {}, onProved = null, onOwnerMoved = async () => {}, onFairPlay = () => {}, timers = null, record = null}) {
  const club = await storage.get('club');
  if (!club) return null;
  const identity = await importIdentity(await storage.get('identity'));
  const verifier = new Verifier((await storage.get('verifier')) || {});
  const hostKeyPair = await keyPairFromJSON(await storage.get('hostKey'));
  const memberPubs = (await storage.get('memberPubs')) || {};
  const engine = clubEngine(ClubTable);
  // Saves go out in order, one at a time.
  let saving = Promise.resolve();
  // Once the club is deleted nothing more is saved, so it can't come back.
  let deleted = false;
  const later = fn => { saving = saving.then(() => (deleted ? null : fn())).catch(e => console.warn('club: not saved:', e)); return saving; };
  // Usage (#98, #421): the time hands are in play at any of the club's
  // tables (playClock; the tables call onPlay every few seconds while one
  // is), not merely someone seated: a seat held two weeks once counted as
  // two weeks. Seated time was kept as playingSince before; that's dropped.
  if (await storage.get('playingSince') != null) later(() => storage.delete('playingSince'));
  const {playing, report} = playClock(onUsage, timers);
  // The owner deletes the club: members are told, and its storage goes.
  async function deleteClub() {
    if (Object.values(club.members).some(m => m.seat)) throw new Error('People are still at tables. Close the tables first.');
    for (const [id, m] of Object.entries(club.members)) {
      if (m.status === 'member' || m.status === 'pending') send(id, await signMessage(identity, {type: 'status', club: club.code, name: club.name, status: 'closed'}));
    }
    report();
    deleted = true;
    await saving;
    const hands = ((await storage.get('hands')) || []).map(h => h.key);
    timers?.clear(checkT);
    const keys = ['club', 'identity', 'hostKey', 'verifier', 'memberPubs', 'handoff', 'playingSince', 'hands', 'seen', 'fairPlay', 'fairPlayDue', 'conns', 'connSalt', ...hands, ...(club.tables || []).map(t => `table:${t.id}`)];
    for (const k of keys) await storage.delete(k);
    await dropFullHands(storage);
    await onDeleted();
  }
  // The host's hand history (#71, #125): each finished hand as the host sees
  // it (no hidden cards), under its own key, with an index of {key, at}.
  // Kept for the club's days, and at most MAX_HANDS.
  async function storeHand(rec, {days}) {
    // Counted for the admin site (#601): who sat in, for leaving out hands
    // only the admins played.
    Promise.resolve().then(() => onHand((rec.seats || []).filter(s => s.inHand !== false).map(s => s.id).filter(Boolean))).catch(e => console.warn('club: hand not counted:', e));
    // The seat and location flags at its table as it finished (#581), for
    // the owner: who and which flag, never where.
    const flags = signalsAmong((rec.seats || []).filter(s => s.inHand !== false).map(s => s.id).filter(Boolean)).flags;
    if (flags.length) rec = {...rec, flags};
    const key = `hand:${String(rec.at || Date.now()).padStart(15, '0')}:${Math.random().toString(36).slice(2, 8)}`;
    const index = (await storage.get('hands')) || [];
    index.push({key, at: rec.at || Date.now()});
    const keep = index.filter(h => Date.now() - h.at < days * 864e5).slice(-MAX_HANDS);
    const drop = index.filter(h => !keep.includes(h));
    await later(async () => {
      await storage.put(key, {...rec, id: key});
      await storage.put('hands', keep);
      for (const h of drop) await storage.delete(h.key);
    });
  }
  // The newest `limit` hands, for the owner's page.
  async function hands({limit = 100} = {}) {
    const index = (await storage.get('hands')) || [];
    const out = [];
    for (const h of index.slice(-Math.min(Math.max(1, Number(limit) || 100), 200)).reverse()) {
      const rec = await storage.get(h.key);
      if (rec) out.push(rec);
    }
    return out;
  }
  // Only the owner's signed owner_cmd reaches this (club-server.js).
  async function backupProved() {
    if (!onProved) throw new Error('ducy’s server can’t record that right now.');
    server.setRecord(await onProved(club.ownerId));
  }
  // The fair play check (fair-play.js: collusion, #582, and real-time
  // assistance, #591): after a session (play quiet
  // for SCHEDULE.QUIET_MS) and every SCHEDULE.EVERY_MS while play goes on,
  // on the tables' timers (the room's alarm, in the Worker). `fairPlayDue`,
  // kept, is when the first hand not yet checked was played, so a room
  // evicted meanwhile checks once it's woken (openClub runs again).
  let fairPlay = (await storage.get('fairPlay')) || null;
  let due = (await storage.get('fairPlayDue')) || null;
  let checkT = null, checking = null, kept = 0;
  function checkFairPlay() {
    timers?.clear(checkT);
    checkT = null;
    checking ||= (async () => {
      const before = kept;
      const {report, summary} = await fairPlayRun(storage, {days: club.keepDays ?? HOST_KEEP_DAYS});
      if (deleted) return report;
      // To ducy's admin (#612), by way of the registry: a failure only
      // means the admin sees the run before this one until the next.
      Promise.resolve().then(() => onFairPlay(summary)).catch(e => console.warn('club: fair play summary not sent:', e));
      fairPlay = report;
      // Hands kept while it ran are due next time.
      if (kept === before) due = null;
      await later(async () => {
        await storage.put('fairPlay', report);
        if (due == null) await storage.delete('fairPlayDue');
      });
      server.ownerChanged();
      return report;
    })().finally(() => { checking = null; });
    return checking;
  }
  function scheduleCheck(at) {
    if (!timers || deleted) return;
    timers.clear(checkT);
    checkT = timers.set(() => checkFairPlay().catch(e => console.warn('club: fair play not checked:', e)), Math.max(0, at - Date.now()));
  }
  function handKept() {
    const now = Date.now();
    kept++;
    if (due == null) { due = now; later(() => storage.put('fairPlayDue', due)); }
    scheduleCheck(Math.min(now + SCHEDULE.QUIET_MS, due + SCHEDULE.EVERY_MS));
  }
  // Each player's last few connections (#582), for their seats' records:
  // {id: [connSnapshot, newest last]}, hashed with the club's own salt.
  // Only this file and the full hand records hold them.
  const conns = (await storage.get('conns')) || {};
  let salt = await storage.get('connSalt');
  if (!salt) {
    salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    later(() => storage.put('connSalt', salt));
  }
  const saveConns = () => later(() => storage.put('conns', structuredClone(conns)));
  // `resumed`: a connection already noted, open while the room slept: only
  // its live state (below) is made again.
  async function noteConn(id, conn, resumed = false) {
    if (typeof id !== 'string' || !conn || typeof conn !== 'object') return;
    const list = conns[id] || [];
    const now = Date.now();
    const snap = await connSnapshot(conn, salt, now);
    live.set(id, liveOf(snap, conn));
    if (resumed) return;
    for (const c of list) if (c.until == null) c.until = now;
    list.push(snap);
    conns[id] = list.slice(-CONNS_KEPT);
    saveConns();
  }
  function noteClosed(id) {
    const tid = tableOf(id);
    if (live.delete(id) && tid) refreshFlags(tid);
    const open = conns[id]?.filter(c => c.until == null);
    if (!open?.length) return;
    for (const c of open) c.until = Date.now();
    saveConns();
  }
  // Seat and location signals (#581, proximity.js): each connected
  // player's live state, their latest location reading among it, in memory
  // only and dropped when they leave. Nothing about a location is stored;
  // the flags from it go to the seats at their table, the hand records,
  // and from those the fair play check.
  const live = new Map();
  const flagsSent = new Map(); // `${table}|${player}` → the flags last sent them, as JSON
  const signalsAmong = ids => tableSignals(ids.map(id => ({id, live: live.get(id) || null})));
  // A reading from player `id` (their page sends one when they sit down,
  // then as it changes and every minute).
  function onLocation(id, m) {
    const r = readingOf(m);
    if (!r || typeof id !== 'string') return;
    if (!live.has(id)) live.set(id, liveOf());
    takeReading(live.get(id), r);
    const tid = tableOf(id);
    if (tid) refreshFlags(tid, id);
  }
  // The table player `id` sits at: a cash table's id, or a tournament's
  // `tourney:<id>`.
  const groupsOf = tid => server.seatGroups?.(tid) || [];
  const tableOf = id => {
    if (club.members[id]?.seat?.table) return club.members[id].seat.table;
    const tables = [...(club.tables || []).map(t => t.id), ...(club.tourneys || []).filter(t => t.status === 'running').map(t => `tourney:${t.id}`)];
    return tables.find(tid => groupsOf(tid).some(g => g.some(s => s.id === id))) || null;
  };
  // Table `tid`'s seat flags (proximity.js seatPayloads, by the engine's
  // seat numbers; a tournament's, each of its tables apart), to each
  // player seated there whose own flags changed, and to `also` in any case
  // (they've just sat down, or come back). Each gets their own: never a
  // group of players near each other that they're in.
  function refreshFlags(tid, also = null) {
    for (const seats of groupsOf(tid)) {
      const forViewer = seatPayloads(seats, signalsAmong(seats.map(s => s.id)));
      for (const s of seats) {
        const update = {type: 'seat_flags', ...forViewer(s.id)};
        const json = JSON.stringify(update), key = `${tid}|${s.id}`;
        const changed = flagsSent.get(key) !== json;
        flagsSent.set(key, json);
        if ((changed || s.id === also) && server.online.has(s.id)) server.sendTable(s.id, {table: tid, update});
      }
    }
  }
  // When each player was last heard from, for the admin page's People
  // (#401) and the owner's Members (#426): saved at most once a minute
  // per player.
  const seen = (await storage.get('seen')) || {};
  const server = createClubServer({
    lastSeen: () => seen,
    identity, club, verifier,
    // A tournament hand ended: its tables' seat flags again (#581).
    handDone: tid => refreshFlags(tid),
    onPlay: playing,
    extraOps: {delete_club: deleteClub, hands, backup_proved: backupProved},
    storeHand,
    // Every seat's cards, kept apart for ducy's checks (hand-records.js).
    fullHand: (hand, opts) => {
      const start = hand.timing?.start;
      const ids = (hand.players || []).map(p => p.client_id).filter(Boolean);
      const at = Object.fromEntries(ids.map(id => [id, connAt(conns[id], start)]).filter(([, c]) => c));
      // Seat and location flags (#581) as the hand finished; and the
      // table's seats get theirs again, in case someone sat or left.
      const prox = signalsAmong(ids).flags;
      if (hand.table) refreshFlags(hand.table);
      return later(() => keepFullHand(storage, fullRecord({...hand, conns: at, prox}), opts)).then(handKept);
    },
    checks: () => fairPlay,
    persist: () => later(() => Promise.all([storage.put('club', club), storage.put('verifier', verifier.toJSON())])).then(() => onSaved()),
    transport: {send, ack() {}},
    engine: {
      call: async (op, ...args) => engine.ops[op](...args),
      store: {
        get: async (code, tid) => (await storage.get(`table:${tid}`)) ?? null,
        put: (code, tid, rec) => later(() => storage.put(`table:${tid}`, rec)),
        drop: (code, tid) => later(() => storage.delete(`table:${tid}`)),
      },
      ...(timers ? {timers} : {}),
    },
    hostKeyPair, memberPubs,
    onMemberKey: (id, pub) => { memberPubs[id] = pub; later(() => storage.put('memberPubs', {...memberPubs})); },
    ...planOf(record),
  });
  server.setRecord = rec => { const p = planOf(rec); server.setLimits(p.limits, p.plan); };
  // What the super admin sees of the club (#265): its shape and activity,
  // no one's cards or chats.
  server.adminInfo = async () => {
    const members = Object.values(club.members);
    const count = s => members.filter(m => m.status === s).length;
    const index = (await storage.get('hands')) || [];
    const day = Date.now() - 864e5;
    return {
      name: club.name, ownerId: club.ownerId, createdAt: club.createdAt,
      members: {member: count('member'), pending: count('pending'), online: server.online.size, seated: members.filter(m => m.seat).length},
      tables: (club.tables || []).filter(t => t.status !== 'closed').map(t => ({name: t.name, game: t.game, sb: t.sb, bb: t.bb, seats: t.seats, status: t.status, running: server.running(t.id), seated: server.seatedCounts()[t.id] || 0})),
      tourneys: (club.tourneys || []).filter(t => ['scheduled', 'running'].includes(t.status) || Date.now() - (t.endedAt || 0) < 7 * 864e5)
        .map(t => ({name: t.name, game: t.game, status: t.status, startsAt: t.startsAt, entries: t.entries.length})),
      hands: {kept: index.length, lastDay: index.filter(h => h.at >= day).length, last: index.length ? index[index.length - 1].at : null},
      ledger: (club.money?.ledger || []).slice(-15).map(e => ({at: e.at, kind: e.kind, amount: e.amount, member: club.members[e.member]?.name || e.member})),
      limits: server.limits(),
    };
  };
  // A club that moved here from a browser (#98): its old host's handoff,
  // which members need before they'll accept this room's messages. It's
  // kept, and given to everyone as they connect.
  let handoff = (await storage.get('handoff')) || null;
  const noteSeen = id => {
    if (typeof id !== 'string' || Date.now() - (seen[id] || 0) < SEEN_EVERY_MS) return;
    seen[id] = Date.now();
    later(() => storage.put('seen', {...seen}));
  };
  const message = server.message;
  server.message = async msg => {
    noteSeen(msg?.from);
    if (msg && 'conn' in msg) {
      const {conn, resumed, ...rest} = msg;
      msg = rest;
      if (msg.event === 'open') await noteConn(msg.from, conn, !!resumed);
    }
    // A location reading (#581): for this file alone, never the club's.
    if (msg?.data?.type === 'location') { onLocation(msg.from, msg.data); return; }
    if (msg?.event === 'close') noteClosed(msg.from);
    if (msg?.event === 'open' && handoff) send(msg.from, handoff);
    if (msg?.data?.body?.type === 'host_moved') {
      if (!handoff && msg.from === club.ownerId && await isHandoff(club, msg.data)) {
        handoff = msg.data;
        await later(() => storage.put('handoff', handoff));
        for (const id of server.online) send(id, handoff);
      }
      return;
    }
    return message(msg);
  };
  await server.relayOpen();
  // `openConns`: those connections as the relay saw them, so their live
  // state (#581) comes back after the room slept.
  for (const id of online) await server.message({from: id, event: 'open', ...(openConns[id] ? {conn: openConns[id], resumed: true} : {})});
  server.flush = () => saving;
  // The collusion check now (tests; the room runs it on its own), and the
  // one left due when the room last stopped.
  server.checkFairPlay = checkFairPlay;
  if (due != null) scheduleCheck(Math.min(Date.now() + SCHEDULE.QUIET_MS, due + SCHEDULE.EVERY_MS));
  // The relay vouched (#575, passkeys.js): player `to` signed in with the
  // passkey of `from`, who lost their player ID, on a device without a
  // copy of it. Their place in the club moves to `to` (move_member), the
  // owner's too. Resolves to whether it moved.
  server.vouchedMove = async (from, to) => {
    const m = club.members[from];
    const owner = club.ownerId === from;
    if (!owner && !(m && (m.status === 'member' || m.status === 'pending'))) return false;
    try {
      await server.run('move_member', {id: from, to, vouched: true});
    } catch (e) {
      console.warn('club: not moved:', e.message);
      return false;
    }
    if (owner) await onOwnerMoved(from, to);
    return true;
  };
  return server;
}
