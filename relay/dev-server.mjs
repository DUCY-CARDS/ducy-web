// The relay for local development and tests: same protocol and close codes
// as src/worker.js, in one Node process.
//   npm install && node dev-server.mjs [port]     (default 8787)
// Then open the page with ?relay=ws://localhost:8787
import { WebSocketServer } from 'ws';

const CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const ID = /^[\w-]{1,64}$/;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 64 * 1024;
const port = Number(process.argv[2] || process.env.PORT || 8787);

const rooms = new Map(); // code → {host, guests: Map(id → ws)}

const wss = new WebSocketServer({port, maxPayload: MAX_MESSAGE});
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/room\/([^/]+)$/);
  const code = m ? decodeURIComponent(m[1]) : '';
  if (!CODE.test(code)) return ws.close(4000, 'bad table code');
  const role = url.searchParams.get('role');
  const id = url.searchParams.get('id') || '';
  let room = rooms.get(code);
  if (role === 'host') {
    if (room?.host) return ws.close(4001, 'the table already has a host');
    if (!room) rooms.set(code, (room = {host: null, guests: new Map()}));
    room.host = ws;
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg && typeof msg.to === 'string') room.guests.get(msg.to)?.send(JSON.stringify(msg.data));
    });
    ws.on('close', () => {
      if (room.host !== ws) return;
      room.host = null;
      for (const g of room.guests.values()) { g.send(JSON.stringify({type: 'host_gone'})); g.close(4002, 'the host left'); }
      room.guests.clear();
      rooms.delete(code);
    });
  } else if (role === 'guest') {
    if (!ID.test(id)) return ws.close(4000, 'bad id');
    if (!room?.host) return ws.close(4004, 'no such table');
    room.guests.get(id)?.close(4009, 'replaced');
    if (room.guests.size >= MAX_GUESTS) return ws.close(4029, 'the room is full');
    room.guests.set(id, ws);
    room.host.send(JSON.stringify({from: id, event: 'open'}));
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      room.host?.send(JSON.stringify({from: id, data: msg}));
    });
    ws.on('close', () => {
      if (room.guests.get(id) !== ws) return; // replaced
      room.guests.delete(id);
      room.host?.send(JSON.stringify({from: id, event: 'close'}));
    });
  } else {
    ws.close(4000, 'bad role');
  }
});
console.log(`ducy relay on ws://localhost:${port}`);
