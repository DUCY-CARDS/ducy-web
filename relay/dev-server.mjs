// The relay for local development and tests: same protocol and close codes
// as src/worker.js, in one Node process.
//   npm install && node dev-server.mjs [port]     (default 8787)
// Then open the page with ?relay=ws://localhost:8787
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { pingReply } from './src/ping.js';
import { createServer } from 'node:http';
import { adminView, codeInfo, createClub, importClub, openClub } from './src/club-room.js';
import { adminApi, adminsFrom } from './src/admin.js';
import { limitsFrom, registry } from './src/registry.js';
import { fairPlayStore } from './src/fair-play-admin.js';
import { BACKUP_EVERY_MS, backupConfig, dropBackups, pullBackup, pushBackup } from './src/backup.js';
import { serviceHttp, serviceInRoom } from './src/service-http.js';
import { passkeys } from './src/passkeys.js';
import { CLUB_SITE_REPLY, check as unlockCheck, siteOk, unlockedNow } from './src/unlock.js';
import { mustProve, newChallenge, proves } from './src/prove.js';
import { stats } from './src/stats.js';
import { cfAnalytics } from './src/cf-analytics.js';
import { initSync } from '../wasm/ducy_wasm.js';

// The engine (#93), from the site's wasm build (../wasm, as the Worker
// bundles it): always-on clubs run on it, and making or reading one runs
// its rules.
initSync({module: readFileSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url))});

// RELAY_TEST_CLOCK=1, for browser tests only (#599): a clock POST
// /test/clock?ahead=<ms> moves on, and the clubs' timers run by it, so a
// scheduled game's check-in and start come within a test.
const TEST_CLOCK = process.env.RELAY_TEST_CLOCK === '1';
let testTimers = null;
if (TEST_CLOCK) {
  const realNow = Date.now.bind(Date);
  let ahead = 0;
  Date.now = () => realNow() + ahead;
  testTimers = {list: new Map(), n: 0, move: ms => { ahead += ms; }};
  setInterval(() => {
    for (const [h, t] of [...testTimers.list]) if (t.at <= Date.now()) { testTimers.list.delete(h); try { t.fn(); } catch (e) { console.warn(e); } }
  }, 50).unref();
}
const clubTimers = () => (testTimers ? {
  set: (fn, ms) => { const h = ++testTimers.n; testTimers.list.set(h, {fn, at: Date.now() + Math.max(0, Number(ms) || 0)}); return h; },
  clear: h => { testTimers.list.delete(h); },
} : null);

// Table codes use capitals and digits with no I, L, O, 0 or 1 (play-net.js).
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const ID = /^[\w-]{1,64}$/;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 64 * 1024;
// Messages kept for a club moving here (guests that connect with queue=1).
const MAX_QUEUED = 100, MAX_QUEUED_PER_GUEST = 10, MAX_QUEUED_MESSAGE = 8 * 1024;
const QUEUE_DAYS = 7;
// Messages a second per connection, in bursts of up to BURST (as in the Worker).
const RATE = Number(process.env.RELAY_RATE || 20), BURST = Number(process.env.RELAY_BURST || 50);

// A token bucket per socket: false when it's sending too fast.
function allow(ws, rate, burst, now = Date.now()) {
  const b = (ws.bucket ||= {tokens: burst, at: now});
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
const port = Number(process.argv[2] || process.env.PORT || 8787);

// code → {guests: Map(id → {ws, queue}), queued: [{n, from, data, at}], next,
//   store (an always-on club's storage), club (its server, once open), chain}
const rooms = new Map();

const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

function roomFor(code) {
  let room = rooms.get(code);
  if (!room) rooms.set(code, (room = {guests: new Map(), queued: [], next: 1, store: new Map(), club: null, chain: Promise.resolve()}));
  room.queued = room.queued.filter(q => Date.now() - q.at < QUEUE_DAYS * 864e5);
  return room;
}

function dropIfEmpty(code, room) {
  if (!room.guests.size && !room.queued.length && !room.store.has('club')) rooms.delete(code);
}

// An always-on club's storage, kept in memory while this relay runs.
function storageOf(room) {
  return {
    get: async k => (room.store.has(k) ? structuredClone(room.store.get(k)) : undefined),
    put: async (k, v) => { room.store.set(k, structuredClone(v)); },
    delete: async k => { room.store.delete(k); },
  };
}

// Runs fn for the room after whatever it's doing: one message at a time.
function inRoom(room, fn) {
  room.chain = room.chain.then(fn).catch(e => console.warn('club room:', e));
  return room.chain;
}

// The registry of always-on clubs (registry.js), in memory, with the limits
// from the environment as in wrangler.toml (MAX_CLUBS_PER_OWNER, MAX_CLUBS,
// CLUB_CREATORS).
const reg = registry(storageOf({store: new Map()}), limitsFrom(process.env));
// Each club's fair play summaries (#612), as the Worker's registry keeps them.
const fairPlay = fairPlayStore(storageOf({store: new Map()}));

// Passkeys (#575), in memory: pages on ALLOWED_ORIGINS, else local ones.
// CLUB_ORIGINS (#637): the club sites, as the Worker's; empty, anywhere.
const CLUB_ORIGINS = String(process.env.CLUB_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const pk = passkeys(storageOf({store: new Map()}), {origins: String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), clubOrigins: CLUB_ORIGINS});

// The club in `room` as passkeys.js remembers it for player `id`'s recovery.
const clubFor = (room, id) => {
  const c = room.store.get('club');
  return c ? {code: c.code, hostId: c.hostId, name: c.name, owner: c.ownerId === id} : null;
};

// Backups (#97), as in the Worker, when BACKUP_URL, BACKUP_SECRET and
// BACKUP_KEY are set in the environment.
const backups = backupConfig(process.env);

// The club changed: back it up now, or when 5 minutes have passed since the last.
function scheduleBackup(room, code) {
  if (!backups || room.backupTimer) return;
  const wait = Math.max(0, (room.backupAt || 0) + BACKUP_EVERY_MS - Date.now());
  room.backupTimer = setTimeout(() => {
    room.backupTimer = null;
    room.backupAt = Date.now();
    if (room.store.has('club')) pushBackup(backups, storageOf(room), code).catch(e => console.warn('club: not backed up:', e));
  }, wait);
}

// The always-on club running in the room, opening it if needed; null if
// none. A room the registry says holds a club, with no storage, is rebuilt
// from its backup (once).
async function clubOf(room, code) {
  if (!room.store.has('club')) {
    if (!backups || room.rebuildChecked || !(await reg.has(code))) return null;
    room.rebuildChecked = true;
    if (!(await pullBackup(backups, storageOf(room), code).catch(e => { console.warn('club: not rebuilt:', e); return false; }))) return null;
  }
  room.club ||= reg.status(code).then(({record}) => openClub({
    storage: storageOf(room),
    send: (to, data) => { const g = room.guests.get(to); if (g) send(g.ws, data); },
    online: [...room.guests.keys()],
    record,
    timers: clubTimers(),
    onUsage: (minutes, at) => reg.used(minutes, at ?? Date.now(), code),
    onHand: ids => usage.note({kind: 'clubHand', code, ids}),
    onFairPlay: summary => fairPlay.note(code, summary),
    onSaved: () => scheduleBackup(room, code),
    // A backup proved (#395): recorded in the registry, signed for by the owner.
    onProved: owner => reg.proved(code, owner),
    // The relay vouched the owner onto a new player ID (#575).
    onOwnerMoved: (from, to) => reg.moveOwner(code, from, to),
    // Deleted by its owner: an ordinary room again; members are let go.
    onDeleted: async () => {
      room.club = null;
      await reg.release(code);
      await fairPlay.drop(code);
      clearTimeout(room.backupTimer);
      room.backupTimer = null;
      if (backups) await dropBackups(backups, code).catch(e => console.warn(e));
      setTimeout(() => { for (const g of room.guests.values()) g.ws.close(4004, 'the club was closed'); }, 1000);
    },
  }));
  return room.club;
}

// Temporary clubs left unused for 7 days are deleted (#395), as the
// Worker's registry does on its alarm: hourly here (RELAY_CLEANUP_MS).
// RELAY_CLEANUP_AHEAD_MS, for tests: look as if that much later.
const CLEANUP_MS = Number(process.env.RELAY_CLEANUP_MS || 3600e3);
const CLEANUP_AHEAD_MS = Number(process.env.RELAY_CLEANUP_AHEAD_MS || 0);
async function expireClubs() {
  const now = Date.now() + CLEANUP_AHEAD_MS;
  for (const code of await reg.expired(now)) {
    const room = rooms.get(code);
    // Claimed but not stored yet (being created as we look): once, next time.
    if (room && !room.store.has('club') && !room.expireWaited) { room.expireWaited = true; continue; }
    const club = room ? await clubOf(room, code) : null;
    // Deleting tells its members, and releases it from the registry.
    if (club) await inRoom(room, () => club.run('delete_club'));
    else { await reg.release(code); await fairPlay.drop(code); }
  }
}
setInterval(() => expireClubs().catch(e => console.warn('club: not expired:', e)), CLEANUP_MS).unref();

function enqueue(room, from, raw) {
  if (raw.length > MAX_QUEUED_MESSAGE || room.queued.length >= MAX_QUEUED) return false;
  if (room.queued.filter(q => q.from === from).length >= MAX_QUEUED_PER_GUEST) return false;
  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  room.queued.push({n: room.next++, from, data, at: Date.now()});
  return true;
}

// The admins (#401): admins.json at the repo root, read once at start as
// the Worker bundles it; ADMINS_FILE (for tests) names another file.
const ADMINS = adminsFrom(JSON.parse(readFileSync(process.env.ADMINS_FILE || new URL('../admins.json', import.meta.url), 'utf8')));

// Usage counts (#601), as the Worker's registry keeps them (stats.js).
// RELAY_STATS_AHEAD_MS, for tests: count as if that much later.
const usage = stats(storageOf({store: new Map()}), {admins: new Set(ADMINS.keys())});
const STATS_AHEAD_MS = Number(process.env.RELAY_STATS_AHEAD_MS || 0);
const statNow = () => Date.now() + STATS_AHEAD_MS;

// A player in a club: counted once a day per room.
function notePlayer(room, id, code) {
  const day = new Date(statNow()).toISOString().slice(0, 10);
  if (room.notedDay !== day) { room.notedDay = day; room.noted = new Set(); }
  if (room.noted.has(id)) return;
  room.noted.add(id);
  usage.note({kind: 'player', id, code}, statNow());
}
// What's live now, for the admin site.
async function liveNow() {
  const out = {rooms: 0, players: 0, clubTables: 0};
  for (const [code, room] of rooms) {
    if (!room.store.has('club')) continue;
    const online = [...room.guests.keys()].filter(id => !ADMINS.has(id)).length;
    if (online) { out.rooms++; out.players += online; }
    if (room.club) out.clubTables += (await (await clubOf(room, code)).adminInfo()).tables.filter(t => t.running).length;
  }
  return out;
}

// The super admin's API (#265, #401), as in the Worker (admin.js).
async function admin(req, res, url) {
  const out = (v, status = 200) => {
    res.writeHead(status, {'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST'});
    res.end(status === 204 ? '' : JSON.stringify(v));
  };
  if (req.method === 'OPTIONS') return out({}, 204);
  if (req.method !== 'POST') return out({error: 'Admin requests are signed POSTs.'}, 405);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let signed = null;
  try { signed = JSON.parse(raw); } catch {}
  const answer = await adminApi(url.pathname, signed, ADMINS, {
    seen: (id, seq) => reg.adminSeen(id, seq),
    log: entry => reg.adminLog(entry),
    logList: () => reg.adminLogList(),
    errors: () => reg.errors(),
    stats: async () => ({days: await usage.days(30, statNow()), now: await liveNow()}),
    cloudflare: () => cfAnalytics(process.env),
    fairPlay: () => fairPlay.list(),
    fairPlayHistory: id => fairPlay.history(id),
    list: () => reg.list(),
    grant: (id, body) => reg.grant(id, body),
    revoke: id => reg.revoke(id),
    setClub: (code, change) => reg.setClub(code, change),
    status: code => reg.status(code),
    room: async (code, what, params) => {
      const room = rooms.get(code);
      if (what === 'info') {
        const club = room ? await clubOf(room, code) : null;
        return {online: room?.guests.size || 0, queued: room?.queued.length || 0, club: club ? await club.adminInfo() : null};
      }
      return (room && await adminView(storageOf(room), what, params)) || {};
    },
    // The room picks up the change at once: new limits, or members let go.
    refresh: async code => {
      const room = rooms.get(code);
      const st = await reg.status(code);
      if (room?.club) (await room.club).setRecord(st.record);
      if (st.blocked && room) for (const [gid, g] of room.guests) if (gid !== st.record?.owner) g.ws.close(4003, st.blocked.slice(0, 120));
    },
  });
  return out(answer.body, answer.status);
}

// A service's request (POST /club/<code>/service), as in the Worker.
async function service(req, res, code) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) break; }
  const request = new Request('http://localhost' + req.url, {method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw});
  const answer = await serviceHttp(request, code, async env => {
    const room = rooms.get(code);
    const club = room ? await clubOf(room, code) : null;
    const st = club ? await reg.status(code) : null;
    if (st?.blocked) return Response.json({ok: false, error: st.blocked}, {status: 403});
    // One at a time with the room's other messages.
    let out;
    await inRoom(room || {chain: Promise.resolve()}, async () => { out = await serviceInRoom(room || {}, club, env); });
    return Response.json(out.body, {status: out.status});
  });
  res.writeHead(answer.status, {'content-type': 'application/json'});
  res.end(await answer.text());
}

// Up to 1 MB: a whole club moving here (#98); other messages stay under MAX_MESSAGE.
// GET /usage, /code/… and /admin/…, as the Worker answers them; everything else is WebSockets.
const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/admin/')) return admin(req, res, url);
  if (TEST_CLOCK && url.pathname === '/test/clock' && req.method === 'POST') {
    testTimers.move(Math.max(0, Number(url.searchParams.get('ahead')) || 0));
    res.writeHead(200, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
    res.end(JSON.stringify({now: Date.now()}));
    return;
  }
  // A page's error report (#552), as in the Worker.
  if (url.pathname === '/report' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { await reg.report(JSON.parse(raw)); } catch {}
    res.writeHead(204, {'access-control-allow-origin': '*'});
    res.end();
    return;
  }
  // What a code is (#393): a club, or nothing.
  const look = url.pathname.match(/^\/code\/([^/]+)$/);
  if (look && req.method === 'GET') {
    const code = decodeURIComponent(look[1]);
    const out = (v, status = 200) => { res.writeHead(status, {'content-type': 'application/json', 'access-control-allow-origin': '*'}); res.end(JSON.stringify(v)); };
    if (!CODE.test(code)) return out({error: 'bad code'}, 400);
    if (!(await reg.has(code))) return out({kind: 'none'});
    return out(codeInfo(rooms.get(code)?.store.get('club'), (url.searchParams.get('invite') || '').slice(0, 64)));
  }
  const svc = url.pathname.match(/^\/club\/([^/]+)\/service$/);
  if (svc) return service(req, res, decodeURIComponent(svc[1]));
  // Passkeys (#575), as in the Worker.
  const pko = url.pathname.match(/^\/passkey\/([a-z]+)$/);
  if (pko) {
    const head = {'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST'};
    if (req.method === 'OPTIONS') { res.writeHead(204, head); res.end(); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 32 * 1024) break; }
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    const out = req.method === 'POST' ? await pk.http(pko[1], body, req.headers.origin || '') : {status: 405, body: {error: 'POST'}};
    res.writeHead(out.status, head);
    res.end(JSON.stringify(out.body));
    return;
  }
  if (req.url !== '/usage') { res.writeHead(404); res.end('ducy relay'); return; }
  res.writeHead(200, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
  res.end(JSON.stringify(await reg.usage()));
});
const wss = new WebSocketServer({server: http, maxPayload: 1024 * 1024});
http.listen(port);
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/room\/([^/]+)$/);
  const code = m ? decodeURIComponent(m[1]) : '';
  if (!CODE.test(code)) return ws.close(4000, 'bad table code');
  const role = url.searchParams.get('role');
  const id = url.searchParams.get('id') || '';
  const queue = url.searchParams.get('queue') === '1';
  // Its page's origin: only a club site runs a club (#637).
  ws.origin = req.headers.origin || '';
  // Only guests: no tab hosts a table or a tournament here (#643).
  if (role !== 'guest') return ws.close(4000, 'bad role');
  if (!ID.test(id)) return ws.close(4000, 'bad id');
  const existing = rooms.get(code);
  const isClub = !!existing?.store.has('club');
  if (!queue && !isClub) return ws.close(4004, 'no such club');
  const room = roomFor(code);
  // A paused club, or a trial that's ended (#265): only its owner gets in.
  // Checked before the connection counts, with its messages held meanwhile.
  if (isClub) {
    const held = [];
    const hold = d => held.push(d);
    ws.on('message', hold);
    reg.status(code).then(st => {
      ws.off('message', hold);
      if (st.blocked && id !== st.record?.owner) return ws.close(4003, st.blocked.slice(0, 120));
      proveFirst(ws, code, id, held, () => guest(ws, room, code, id, queue, isClub, []));
    });
    return;
  }
  if (mustProve({queue, club: isClub})) proveFirst(ws, code, id, [], () => guest(ws, room, code, id, queue, isClub, []));
  else guest(ws, room, code, id, queue, isClub, []);
});

// A club connection proves it holds its player's key before it counts
// (#577, prove.js): `then()` once it has. Meanwhile it replaces no one;
// only heartbeats are answered. `held`: messages it sent before this.
function proveFirst(ws, code, id, held, then) {
  const challenge = newChallenge();
  let done = false;
  const onMsg = async data => {
    if (done) return;
    const pong = pingReply(String(data));
    if (pong) return ws.send(pong);
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m?.type !== 'prove') return;
    if (!(await proves(m, {id, code, challenge}))) return ws.close(4000, 'not proven');
    done = true;
    ws.off('message', onMsg);
    send(ws, {type: 'proven'});
    then();
  };
  ws.on('message', onMsg);
  send(ws, {type: 'prove', challenge});
  for (const d of held) onMsg(d);
}

// A guest's connection, accepted: `held`, any messages it sent meanwhile.
function guest(ws, room, code, id, queue, isClub, held) {
  {
    room.guests.get(id)?.ws.close(4009, 'replaced');
    room.guests.delete(id);
    if (room.guests.size >= MAX_GUESTS) return ws.close(4029, 'the room is full');
    room.guests.set(id, {ws, queue});
    if (isClub) {
      notePlayer(room, id, code);
      inRoom(room, async () => (await clubOf(room, code)).message({from: id, event: 'open'}));
    } else {
      send(ws, {type: 'host_away'});
      // A club whose storage was lost comes back from its backup (#97), with
      // whatever was queued meanwhile.
      if (backups && !room.rebuildChecked) {
        inRoom(room, async () => {
          const c = await clubOf(room, code);
          if (!c) return;
          const waiting = room.queued;
          room.queued = [];
          for (const q of waiting) await c.message({from: q.from, data: q.data});
        });
      }
    }
    ws.on('message', data => {
      if (!allow(ws, RATE, BURST)) return ws.close(4008, 'too many messages');
      const pong = pingReply(String(data));
      if (pong) return ws.send(pong);
      // Only a club moving here (#98) may be bigger than MAX_MESSAGE.
      if (data.length > MAX_MESSAGE && !String(data).includes('"import_club"')) return;
      // A location reading (#581): from an unlocked connection only, not
      // counted as activity (unlock.js unlockedNow).
      if (room.store.has('club') && String(data).startsWith('{"type":"location"')) {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (unlockedNow(ws.unlock)) inRoom(room, async () => (await clubOf(room, code))?.message({from: id, data: msg}));
        return;
      }
      // An always-on club runs here, or someone asks to make this room one,
      // or to move their club here.
      if (room.store.has('club') || String(data).includes('"create_club"') || String(data).includes('"import_club"') || String(data).startsWith('{"type":"unlock"')) {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        inRoom(room, async () => {
          // Only a connection unlocked with the player's passkey acts (#575).
          const g = await unlockCheck(msg, ws.unlock, id, token => pk.session(token, clubFor(room, id)));
          ws.unlock = g.u;
          const club = await clubOf(room, code);
          // The relay vouched for this player as someone who lost their ID:
          // moved over before they hear they're unlocked.
          if (g.movedFrom && club) await club.vouchedMove(g.movedFrom, id);
          if (g.reply) send(ws, g.reply);
          if (!g.pass) return;
          // Running a club only from a club site, with a session made there (#637).
          if (!siteOk(msg, g.u, ws.origin, CLUB_ORIGINS)) return send(ws, CLUB_SITE_REPLY);
          // Counted as active (#601), as well as on connecting: the player
          // who just made the club connected before it was one.
          if (club) notePlayer(room, id, code);
          // With the passkey it was unlocked with (#589: refills).
          if (club) return club.message({from: id, data: msg, device: ws.unlock?.device || ''});
          const type = msg?.body?.type;
          if (type !== 'create_club' && type !== 'import_club') return;
          try {
            if (msg.from !== id) throw new Error('The request must come from you.');
            if (type === 'create_club') {
              if (room.guests.size > 1 || room.queued.length) throw new Error('That club code is in use.');
              send(ws, {type: 'club_created', ...(await createClub(storageOf(room), msg, code, (owner, c, name) => reg.claim(owner, c, Date.now(), name)))});
              await clubOf(room, code);
            } else {
              // A club that already existed isn't temporary (#395).
              send(ws, {type: 'club_imported', ...(await importClub(storageOf(room), msg, code, (owner, c, name) => reg.claim(owner, c, Date.now(), name, {temporary: false})))});
              const c = await clubOf(room, code);
              // What members left while the host was away goes to the club.
              const waiting = room.queued;
              room.queued = [];
              for (const q of waiting) await c.message({from: q.from, data: q.data});
            }
          } catch (e) {
            send(ws, {type: 'club_error', reason: e.message});
          }
        });
        return;
      }
      if (queue && !enqueue(room, id, String(data))) {
        send(ws, {type: 'queue_full'});
      }
    });
    ws.on('close', () => {
      if (room.guests.get(id)?.ws !== ws) return; // replaced
      room.guests.delete(id);
      if (room.club) inRoom(room, async () => (await room.club).message({from: id, event: 'close'}));
      dropIfEmpty(code, room);
    });
  }
  for (const d of held) ws.emit('message', d);
}
console.log(`ducy relay on ws://localhost:${port}`);
