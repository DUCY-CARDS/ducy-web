// Relays multiplayer messages for ducy's #play and #clubs pages. Each code is
// a room (one Durable Object); the host's tab and each player's tab hold a
// WebSocket to it. The relay knows nothing about poker: it forwards
//   host  → {to, data}  as data to that guest
//   guest → data        as {from, data} to the host
// and tells the host when a guest connects or drops ({from, event}). When
// the host drops, guests get {type: 'host_gone'} and are disconnected, so
// they reconnect once the host is back.
//
// Queue mode (guest connects with queue=1, used by clubs): the guest may
// connect while the host is away ({type: 'host_away'}) and stays connected
// when the host leaves. Its messages while the host is away are stored (a few
// per guest, for up to 7 days) and delivered when the host connects as
// {from, data, queued: n}; the host sends {ack: n} to delete each one. Queued
// guests get {type: 'host_back'} when the host arrives.
//
// Close codes: 4000 bad request, 4001 the room already has a host, 4002 the
// host left, 4004 no such table, 4009 replaced by a newer connection with the
// same id, 4029 the room is full.

const CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const ID = /^[\w-]{1,64}$/;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 64 * 1024;
const MAX_QUEUED = 100, MAX_QUEUED_PER_GUEST = 10, MAX_QUEUED_MESSAGE = 8 * 1024;
const QUEUE_MS = 7 * 864e5;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('ducy relay', {status: 404});
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(req.headers.get('Origin'))) return new Response('forbidden', {status: 403});
    const code = decodeURIComponent(m[1]);
    if (!CODE.test(code)) return new Response('bad table code', {status: 400});
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', {status: 426});
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const role = url.searchParams.get('role');
    const id = url.searchParams.get('id') || '';
    const queue = url.searchParams.get('queue') === '1';
    const [client, server] = Object.values(new WebSocketPair());
    const refuse = (code, reason) => {
      server.accept();
      server.close(code, reason);
      return new Response(null, {status: 101, webSocket: client});
    };
    const host = this.host();
    if (role === 'host') {
      if (host) return refuse(4001, 'the table already has a host');
      this.state.acceptWebSocket(server, ['host']);
      for (const g of this.state.getWebSockets('guest')) {
        server.send(JSON.stringify({from: this.guestId(g), event: 'open'}));
        g.send(JSON.stringify({type: 'host_back'}));
      }
      for (const q of await this.queued()) server.send(JSON.stringify({from: q.from, data: q.data, queued: q.n}));
    } else if (role === 'guest') {
      if (!ID.test(id)) return refuse(4000, 'bad id');
      if (!host && !queue) return refuse(4004, 'no such table');
      for (const old of this.state.getWebSockets('g:' + id)) old.close(4009, 'replaced');
      if (this.state.getWebSockets('guest').length >= MAX_GUESTS) return refuse(4029, 'the room is full');
      this.state.acceptWebSocket(server, queue ? ['guest', 'g:' + id, 'queue'] : ['guest', 'g:' + id]);
      if (host) host.send(JSON.stringify({from: id, event: 'open'}));
      else server.send(JSON.stringify({type: 'host_away'}));
    } else {
      return refuse(4000, 'bad role');
    }
    return new Response(null, {status: 101, webSocket: client});
  }

  host(except = null) {
    return this.state.getWebSockets('host').find(ws => ws !== except) || null;
  }

  guestId(ws) {
    const tag = this.state.getTags(ws).find(t => t.startsWith('g:'));
    return tag ? tag.slice(2) : null;
  }

  // Stored messages for the host, oldest first, dropping expired ones.
  async queued() {
    const all = [...(await this.state.storage.list({prefix: 'q:'})).values()];
    const old = all.filter(q => Date.now() - q.at >= QUEUE_MS);
    if (old.length) await this.state.storage.delete(old.map(q => 'q:' + String(q.n).padStart(12, '0')));
    return all.filter(q => Date.now() - q.at < QUEUE_MS);
  }

  async enqueue(from, raw) {
    if (raw.length > MAX_QUEUED_MESSAGE) return false;
    const all = await this.queued();
    if (all.length >= MAX_QUEUED || all.filter(q => q.from === from).length >= MAX_QUEUED_PER_GUEST) return false;
    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    const n = ((await this.state.storage.get('next')) || 1);
    await this.state.storage.put({next: n + 1, ['q:' + String(n).padStart(12, '0')]: {n, from, data, at: Date.now()}});
    return true;
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MESSAGE) return;
    const id = this.guestId(ws);
    if (id) {
      const host = this.host();
      if (host) {
        let m;
        try { m = JSON.parse(msg); } catch { return; }
        host.send(JSON.stringify({from: id, data: m}));
      } else if (this.state.getTags(ws).includes('queue') && !(await this.enqueue(id, msg))) {
        ws.send(JSON.stringify({type: 'queue_full'}));
      }
      return;
    }
    if (!this.state.getTags(ws).includes('host')) return;
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    if (m && typeof m.to === 'string') {
      const out = JSON.stringify(m.data);
      for (const g of this.state.getWebSockets('g:' + m.to)) g.send(out);
    } else if (m && Number.isSafeInteger(m.ack)) {
      await this.state.storage.delete('q:' + String(m.ack).padStart(12, '0'));
    }
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    this.gone(ws);
  }

  webSocketError(ws) {
    this.gone(ws);
  }

  gone(ws) {
    const id = this.guestId(ws);
    if (id) {
      // A newer connection with the same id took over: not a disconnect.
      if (this.state.getWebSockets('g:' + id).some(g => g !== ws)) return;
      this.host()?.send(JSON.stringify({from: id, event: 'close'}));
    } else if (this.state.getTags(ws).includes('host') && !this.host(ws)) {
      for (const g of this.state.getWebSockets('guest')) {
        try {
          g.send(JSON.stringify({type: 'host_gone'}));
          if (!this.state.getTags(g).includes('queue')) g.close(4002, 'the host left');
        } catch {}
      }
    }
  }
}
