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
import { BACKUP_EVERY_MS, backupConfig, dropBackups, pullBackup, pushBackup } from './src/backup.js';
import { serviceHttp, serviceInRoom } from './src/service-http.js';
import { initSync } from '../wasm/ducy_wasm.js';

// The engine (#93), from the site's wasm build (../wasm, as the Worker
// bundles it): always-on clubs run on it, and making or reading one runs
// its rules.
initSync({module: readFileSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url))});

// Table codes use capitals and digits with no I, L, O, 0 or 1 (play-net.js).
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const ID = /^[\w-]{1,64}$/;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 64 * 1024;
// Messages kept for an absent host (guests that connect with queue=1).
const MAX_QUEUED = 100, MAX_QUEUED_PER_GUEST = 10, MAX_QUEUED_MESSAGE = 8 * 1024;
const QUEUE_DAYS = 7;
// Messages a second per connection, in bursts of up to BURST (as in the Worker).
const RATE = Number(process.env.RELAY_RATE || 20), BURST = Number(process.env.RELAY_BURST || 50);
const HOST_RATE = 200, HOST_BURST = 500;

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

// code → {host, guests: Map(id → {ws, queue}), queued: [{n, from, data, at}], next,
//   store (an always-on club's storage), club (its server, once open), chain}
const rooms = new Map();

const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

function roomFor(code) {
  let room = rooms.get(code);
  if (!room) rooms.set(code, (room = {host: null, guests: new Map(), queued: [], next: 1, store: new Map(), club: null, chain: Promise.resolve()}));
  room.queued = room.queued.filter(q => Date.now() - q.at < QUEUE_DAYS * 864e5);
  return room;
}

function dropIfEmpty(code, room) {
  if (!room.host && !room.guests.size && !room.queued.length && !room.store.has('club')) rooms.delete(code);
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
    onUsage: (minutes, at) => reg.used(minutes, at ?? Date.now(), code),
    onSaved: () => scheduleBackup(room, code),
    // A backup proved (#395): recorded in the registry, signed for by the owner.
    onProved: owner => reg.proved(code, owner),
    // Deleted by its owner: an ordinary room again; members are let go.
    onDeleted: async () => {
      room.club = null;
      await reg.release(code);
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
    const club = room ? await clubOf(room, code) : null;
    // Deleting tells its members, and releases it from the registry.
    if (club) await inRoom(room, () => club.run('delete_club'));
    else await reg.release(code);
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
    list: () => reg.list(),
    grant: (id, body) => reg.grant(id, body),
    revoke: id => reg.revoke(id),
    setClub: (code, change) => reg.setClub(code, change),
    status: code => reg.status(code),
    room: async (code, what, params) => {
      const room = rooms.get(code);
      if (what === 'info') {
        const club = room ? await clubOf(room, code) : null;
        return {online: room?.guests.size || 0, host: !!room?.host, queued: room?.queued.length || 0, club: club ? await club.adminInfo() : null};
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
  // What a code is (#393): a club, or else a game.
  const look = url.pathname.match(/^\/code\/([^/]+)$/);
  if (look && req.method === 'GET') {
    const code = decodeURIComponent(look[1]);
    const out = (v, status = 200) => { res.writeHead(status, {'content-type': 'application/json', 'access-control-allow-origin': '*'}); res.end(JSON.stringify(v)); };
    if (!CODE.test(code)) return out({error: 'bad code'}, 400);
    if (!(await reg.has(code))) return out({kind: 'game'});
    return out(codeInfo(rooms.get(code)?.store.get('club'), (url.searchParams.get('invite') || '').slice(0, 64)));
  }
  const svc = url.pathname.match(/^\/club\/([^/]+)\/service$/);
  if (svc) return service(req, res, decodeURIComponent(svc[1]));
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
  if (role === 'host') {
    const room = roomFor(code);
    if (room.host) return ws.close(4001, 'the table already has a host');
    if (room.store.has('club')) return ws.close(4001, 'this club runs on the relay');
    room.host = ws;
    // Guests waiting in queue mode, then whatever they left while the host was away.
    for (const [gid, g] of room.guests) { send(ws, {from: gid, event: 'open'}); send(g.ws, {type: 'host_back'}); }
    for (const q of room.queued) send(ws, {from: q.from, data: q.data, queued: q.n});
    ws.on('message', data => {
      if (!allow(ws, HOST_RATE, HOST_BURST)) return ws.close(4008, 'too many messages');
      const pong = pingReply(String(data));
      if (pong) return ws.send(pong);
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg && typeof msg.to === 'string') { const g = room.guests.get(msg.to); if (g) send(g.ws, msg.data); }
      else if (msg && Number.isSafeInteger(msg.ack)) room.queued = room.queued.filter(q => q.n !== msg.ack);
    });
    ws.on('close', () => {
      if (room.host !== ws) return;
      room.host = null;
      for (const [gid, g] of room.guests) {
        send(g.ws, {type: 'host_gone'});
        if (!g.queue) { g.ws.close(4002, 'the host left'); room.guests.delete(gid); }
      }
      dropIfEmpty(code, room);
    });
  } else if (role === 'guest') {
    if (!ID.test(id)) return ws.close(4000, 'bad id');
    const existing = rooms.get(code);
    const isClub = !!existing?.store.has('club');
    if (!existing?.host && !queue && !isClub) return ws.close(4004, 'no such table');
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
        guest(ws, room, code, id, queue, isClub, held);
      });
      return;
    }
    guest(ws, room, code, id, queue, isClub, []);
  } else {
    ws.close(4000, 'bad role');
  }
});

// A guest's connection, accepted: `held`, any messages it sent meanwhile.
function guest(ws, room, code, id, queue, isClub, held) {
  {
    room.guests.get(id)?.ws.close(4009, 'replaced');
    room.guests.delete(id);
    if (room.guests.size >= MAX_GUESTS) return ws.close(4029, 'the room is full');
    room.guests.set(id, {ws, queue});
    if (isClub) inRoom(room, async () => (await clubOf(room, code)).message({from: id, event: 'open'}));
    else if (room.host) send(room.host, {from: id, event: 'open'});
    else {
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
      // An always-on club runs here, or someone asks to make this room one,
      // or to move their club here.
      if (room.store.has('club') || String(data).includes('"create_club"') || String(data).includes('"import_club"')) {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        inRoom(room, async () => {
          const club = await clubOf(room, code);
          if (club) return club.message({from: id, data: msg});
          const type = msg?.body?.type;
          if (type !== 'create_club' && type !== 'import_club') return;
          try {
            if (msg.from !== id) throw new Error('The request must come from you.');
            if (type === 'create_club') {
              if (room.host || room.guests.size > 1 || room.queued.length) throw new Error('That club code is in use.');
              send(ws, {type: 'club_created', ...(await createClub(storageOf(room), msg, code, (owner, c, name) => reg.claim(owner, c, Date.now(), name)))});
              await clubOf(room, code);
            } else {
              if (room.host) throw new Error('The club is still open in a tab as its host. Close it there first.');
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
      if (room.host) {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        send(room.host, {from: id, data: msg});
      } else if (queue && !enqueue(room, id, String(data))) {
        send(ws, {type: 'queue_full'});
      }
    });
    ws.on('close', () => {
      if (room.guests.get(id)?.ws !== ws) return; // replaced
      room.guests.delete(id);
      if (room.club) inRoom(room, async () => (await room.club).message({from: id, event: 'close'}));
      else if (room.host) send(room.host, {from: id, event: 'close'});
      dropIfEmpty(code, room);
    });
  }
  for (const d of held) ws.emit('message', d);
}
console.log(`ducy relay on ws://localhost:${port}`);
