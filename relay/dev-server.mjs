// The relay for local development and tests: same protocol and close codes
// as src/worker.js, in one Node process.
//   npm install && node dev-server.mjs [port]     (default 8787)
// Then open the page with ?relay=ws://localhost:8787
import { WebSocketServer } from 'ws';
import { pingReply } from './src/worker.js';

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

// code → {host, guests: Map(id → {ws, queue}), queued: [{n, from, data, at}], next}
const rooms = new Map();

const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

function roomFor(code) {
  let room = rooms.get(code);
  if (!room) rooms.set(code, (room = {host: null, guests: new Map(), queued: [], next: 1}));
  room.queued = room.queued.filter(q => Date.now() - q.at < QUEUE_DAYS * 864e5);
  return room;
}

function dropIfEmpty(code, room) {
  if (!room.host && !room.guests.size && !room.queued.length) rooms.delete(code);
}

function enqueue(room, from, raw) {
  if (raw.length > MAX_QUEUED_MESSAGE || room.queued.length >= MAX_QUEUED) return false;
  if (room.queued.filter(q => q.from === from).length >= MAX_QUEUED_PER_GUEST) return false;
  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  room.queued.push({n: room.next++, from, data, at: Date.now()});
  return true;
}

const wss = new WebSocketServer({port, maxPayload: MAX_MESSAGE});
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
    if (!existing?.host && !queue) return ws.close(4004, 'no such table');
    const room = roomFor(code);
    room.guests.get(id)?.ws.close(4009, 'replaced');
    room.guests.delete(id);
    if (room.guests.size >= MAX_GUESTS) return ws.close(4029, 'the room is full');
    room.guests.set(id, {ws, queue});
    if (room.host) send(room.host, {from: id, event: 'open'});
    else send(ws, {type: 'host_away'});
    ws.on('message', data => {
      if (!allow(ws, RATE, BURST)) return ws.close(4008, 'too many messages');
      const pong = pingReply(String(data));
      if (pong) return ws.send(pong);
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
      if (room.host) send(room.host, {from: id, event: 'close'});
      dropIfEmpty(code, room);
    });
  } else {
    ws.close(4000, 'bad role');
  }
});
console.log(`ducy relay on ws://localhost:${port}`);
