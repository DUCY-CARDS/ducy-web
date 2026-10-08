// The relay for local development and tests: same protocol and close codes
// as src/worker.js, in one Node process.
//   npm install && node dev-server.mjs [port]     (default 8787)
// Then open the page with ?relay=ws://localhost:8787
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { pingReply } from './src/ping.js';
import { createClub, importClub, openClub } from './src/club-room.js';

// The engine for always-on clubs (#93), loaded on first use from the site's
// wasm build (../wasm, as the Worker bundles it).
let engineP = null;
const engine = () => (engineP ||= import('../wasm/ducy_wasm.js').then(m => {
  m.initSync({module: readFileSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url))});
  return m.MultiTable;
}));

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

// The always-on club running in the room, opening it if needed; null if none.
async function clubOf(room) {
  if (!room.store.has('club')) return null;
  room.club ||= engine().then(MultiTable => openClub({
    storage: storageOf(room),
    send: (to, data) => { const g = room.guests.get(to); if (g) send(g.ws, data); },
    online: [...room.guests.keys()],
    MultiTable,
  }));
  return room.club;
}

function enqueue(room, from, raw) {
  if (raw.length > MAX_QUEUED_MESSAGE || room.queued.length >= MAX_QUEUED) return false;
  if (room.queued.filter(q => q.from === from).length >= MAX_QUEUED_PER_GUEST) return false;
  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  room.queued.push({n: room.next++, from, data, at: Date.now()});
  return true;
}

// Up to 1 MB: a whole club moving here (#98); other messages stay under MAX_MESSAGE.
const wss = new WebSocketServer({port, maxPayload: 1024 * 1024});
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
    room.guests.get(id)?.ws.close(4009, 'replaced');
    room.guests.delete(id);
    if (room.guests.size >= MAX_GUESTS) return ws.close(4029, 'the room is full');
    room.guests.set(id, {ws, queue});
    if (isClub) inRoom(room, async () => (await clubOf(room)).message({from: id, event: 'open'}));
    else if (room.host) send(room.host, {from: id, event: 'open'});
    else send(ws, {type: 'host_away'});
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
          const club = await clubOf(room);
          if (club) return club.message({from: id, data: msg});
          const type = msg?.body?.type;
          if (type !== 'create_club' && type !== 'import_club') return;
          try {
            if (msg.from !== id) throw new Error('The request must come from you.');
            if (type === 'create_club') {
              if (room.host || room.guests.size > 1 || room.queued.length) throw new Error('That club code is in use.');
              send(ws, {type: 'club_created', ...(await createClub(storageOf(room), msg, code))});
              await clubOf(room);
            } else {
              if (room.host) throw new Error('The club is still open in a tab as its host. Close it there first.');
              send(ws, {type: 'club_imported', ...(await importClub(storageOf(room), msg, code))});
              const c = await clubOf(room);
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
  } else {
    ws.close(4000, 'bad role');
  }
});
console.log(`ducy relay on ws://localhost:${port}`);
