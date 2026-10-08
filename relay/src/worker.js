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
// Heartbeat: {type: "ping", t} from anyone is answered with {type: "pong", t}.
//
// Always-on clubs (#93, club-room.js): a guest alone in an empty room may
// send a signed {type: 'create_club', club: code, name}; the room then is
// that club's host, for good. It answers {type: 'club_created', hostId,
// invite} (or {type: 'club_error', reason}), runs the club itself with
// members connecting as guests, and refuses hosts (4001).
//
// Close codes: 4000 bad request, 4001 the room already has a host, 4002 the
// host left, 4004 no such table, 4008 sending too fast, 4009 replaced by a newer connection with the
// same id, 4029 the room is full.

import { createClub, importClub, openClub } from './club-room.js';
import { limitsFrom, registry } from './registry.js';
import { BACKUP_EVERY_MS, backupConfig, dropBackups, pullBackup, pushBackup } from './backup.js';
import { pingReply } from './ping.js';
import { initSync, MultiTable } from '../../wasm/ducy_wasm.js';
import wasmModule from '../../wasm/ducy_wasm_bg.wasm';

// The engine, for always-on clubs: set up once per Worker instance.
let engineReady = false;
function engine() {
  if (!engineReady) { initSync({module: wasmModule}); engineReady = true; }
  return MultiTable;
}

// Table codes use capitals and digits with no I, L, O, 0 or 1 (play-net.js).
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const ID = /^[\w-]{1,64}$/;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 64 * 1024;
// A whole club moving here (#98), with its ledger.
const MAX_IMPORT = 1024 * 1024;
// Each connection may send RATE messages a second, in bursts of up to BURST;
// one that sends faster is closed (4008), so a single client can't use up
// the account's quota for everyone (#103).
const RATE = 20, BURST = 50;
// A host sends one message per player per change, at every table it runs.
const HOST_RATE = 200, HOST_BURST = 500;

// A token bucket kept on the socket itself, so it survives hibernation.
function allow(ws, rate, burst, now = Date.now()) {
  const b = ws.deserializeAttachment() || {tokens: burst, at: now};
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  ws.serializeAttachment(b);
  return true;
}

const MAX_QUEUED = 100, MAX_QUEUED_PER_GUEST = 10, MAX_QUEUED_MESSAGE = 8 * 1024;
const QUEUE_MS = 7 * 864e5;

// The relay's one registry of always-on clubs (registry.js).
const registryOf = env => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    // How much always-on clubs use against the free plan (#98): numbers only.
    if (url.pathname === '/usage' && req.method === 'GET') {
      const res = await registryOf(env).fetch('https://registry/usage');
      const origin = req.headers.get('Origin');
      const cors = !allowed.length ? '*' : allowed.includes(origin) ? origin : '';
      return new Response(res.body, {headers: {'content-type': 'application/json', ...(cors ? {'access-control-allow-origin': cors} : {})}});
    }
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('ducy relay', {status: 404});
    if (allowed.length && !allowed.includes(req.headers.get('Origin'))) return new Response('forbidden', {status: 403});
    const code = decodeURIComponent(m[1]);
    if (!CODE.test(code)) return new Response('bad table code', {status: 400});
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', {status: 426});
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
  },
};

// The registry of always-on clubs (registry.js), one for the relay: limits
// on creating them, and their usage. Only rooms reach it, except /usage.
export class Registry {
  constructor(state, env) {
    const s = state.storage;
    this.reg = registry({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)}, limitsFrom(env));
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === 'POST' ? await req.json() : {};
    try {
      if (path === '/claim') await this.reg.claim(String(body.owner), String(body.code));
      else if (path === '/has') return Response.json({has: await this.reg.has(String(body.code))});
      else if (path === '/release') await this.reg.release(String(body.code));
      else if (path === '/used') await this.reg.used(Number(body.minutes));
      else if (path === '/usage') return Response.json(await this.reg.usage());
      else return new Response('not found', {status: 404});
      return Response.json({ok: true});
    } catch (e) {
      return Response.json({error: e.message}, {status: 409});
    }
  }
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clubP = null; // the always-on club running here, once opened
  }

  // The owner deleted the always-on club here (#98): the room is an
  // ordinary one again. Connections close a moment later, once the owner
  // has their answer and members their notice.
  async deleted() {
    const code = (await this.clubP)?.club.code;
    this.clubP = null;
    if (code) await this.registry('/release', {code}).catch(e => console.warn(e));
    // Its backups go too, so a deleted club is never rebuilt.
    const cfg = backupConfig(this.env);
    if (code && cfg) await dropBackups(cfg, code).catch(e => console.warn(e));
    await this.state.storage.delete('backupAt');
    await this.state.storage.delete('backupDue');
    this.timerMap?.clear();
    await this.state.storage.deleteAlarm();
    setTimeout(() => { for (const g of this.state.getWebSockets('guest')) { try { g.close(4004, 'the club was closed'); } catch {} } }, 1000);
  }

  // A request to the relay's registry; throws its error, if any.
  async registry(path, body) {
    const res = await registryOf(this.env).fetch(`https://registry${path}`, {method: 'POST', body: JSON.stringify(body)});
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    return out;
  }

  // The always-on club in this room (club-room.js), or null if the room isn't one.
  // `code`: the room's code, if known, so a club whose storage was lost can
  // be rebuilt from its backup.
  async club(code = null) {
    if (this.clubP) return this.clubP;
    if (!(await this.state.storage.get('club')) && !(code && await this.rebuild(code))) return null;
    const online = [...new Set(this.state.getWebSockets('guest').map(g => this.guestId(g)))];
    this.clubP = openClub({
      storage: this.storage(), send: (to, data) => this.toGuest(to, data), online, MultiTable: engine(),
      onUsage: minutes => this.registry('/used', {minutes}),
      onDeleted: () => this.deleted(),
      onSaved: () => this.scheduleBackup(),
      timers: this.tableTimers(),
    })
      .catch(e => { this.clubP = null; throw e; });
    return this.clubP;
  }

  // A room the registry says holds an always-on club, with its storage
  // empty (lost, or after moving providers): rebuilt from the latest backup
  // (#97). Looked into once per object. Resolves to whether it was.
  async rebuild(code) {
    const cfg = backupConfig(this.env);
    if (!cfg || this.rebuildChecked) return false;
    this.rebuildChecked = true;
    try {
      if (!(await this.registry('/has', {code})).has) return false;
      return await pullBackup(cfg, this.storage(), code);
    } catch (e) {
      console.warn('club: not rebuilt from backup:', e);
      return false;
    }
  }

  // The club changed: back it up now if the last backup is 5 minutes old,
  // else when that's up (on the alarm, which doesn't keep the room awake).
  async scheduleBackup() {
    if (!backupConfig(this.env)) return;
    const last = (await this.state.storage.get('backupAt')) || 0;
    if (Date.now() - last >= BACKUP_EVERY_MS) await this.backupNow();
    else if (!(await this.state.storage.get('backupDue'))) {
      await this.state.storage.put('backupDue', last + BACKUP_EVERY_MS);
      await this.armAlarm();
    }
  }

  // The tables' clocks (#135): turn time-outs, the next deal, the sit-out
  // sweep and the rest, on the room's one alarm (shared with backups), so
  // the room can sleep between them instead of being held awake by timers.
  // They're kept in memory; if the room is evicted meanwhile, the alarm
  // wakes it, the club opens again, and its tables (saved after every
  // change) restore and set their timers again, the ones already due firing
  // at once.
  tableTimers() {
    this.timerMap ||= new Map();
    this.timerN ||= 0;
    return {
      set: (fn, ms) => {
        const h = ++this.timerN;
        this.timerMap.set(h, {at: Date.now() + Math.max(0, Number(ms) || 0), fn});
        this.armAlarm().catch(e => console.warn('room: alarm not set:', e));
        return h;
      },
      clear: h => { if (h != null) this.timerMap?.delete(h); },
    };
  }

  // Sets the alarm for the soonest table timer or backup, if it's sooner
  // than the alarm already set.
  async armAlarm() {
    const times = [...(this.timerMap?.values() || [])].map(t => t.at);
    const backupDue = await this.state.storage.get('backupDue');
    if (backupDue) times.push(backupDue);
    if (!times.length) return;
    const next = Math.min(...times);
    const set = await this.state.storage.getAlarm();
    if (set == null || next < set) await this.state.storage.setAlarm(next);
  }

  async backupNow() {
    const cfg = backupConfig(this.env);
    const club = await this.state.storage.get('club');
    if (!cfg || !club) return;
    await this.state.storage.put('backupAt', Date.now());
    try { await pushBackup(cfg, this.storage(), club.code); } catch (e) { console.warn('club: not backed up:', e); }
  }

  async alarm() {
    // Woken after being evicted: open the club, so its tables restore and
    // set their timers again.
    if (!this.clubP && await this.state.storage.get('club')) {
      try { await this.club(); } catch (e) { console.warn('club: not reopened:', e); }
    }
    const now = Date.now();
    for (const [h, t] of [...(this.timerMap || [])]) {
      if (t.at > now) continue;
      this.timerMap.delete(h);
      try { t.fn(); } catch (e) { console.warn('room: timer:', e); }
    }
    const backupDue = await this.state.storage.get('backupDue');
    if (backupDue && backupDue <= now) {
      await this.state.storage.delete('backupDue');
      await this.backupNow();
    }
    await this.armAlarm();
  }

  storage() {
    const s = this.state.storage;
    return {get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)};
  }

  toGuest(to, data) {
    const out = JSON.stringify(data);
    for (const g of this.state.getWebSockets('g:' + to)) { try { g.send(out); } catch {} }
  }

  // A guest alone in an empty room asks to make it an always-on club.
  async create(ws, id, env) {
    const code = this.state.getTags(ws).find(t => t.startsWith('c:'))?.slice(2);
    const others = this.state.getWebSockets('guest').some(g => this.guestId(g) !== id);
    try {
      if (!code || this.host() || others || (await this.queued()).length) throw new Error('That club code is in use.');
      if (env?.from !== id) throw new Error('The request must come from you.');
      const made = await createClub(this.storage(), env, code, (owner, c) => this.registry('/claim', {owner, code: c}));
      ws.send(JSON.stringify({type: 'club_created', ...made}));
      await this.club();
    } catch (e) {
      ws.send(JSON.stringify({type: 'club_error', reason: e.message}));
    }
  }

  // A browser-run club's host moves it here (#98). Members may be connected
  // (waiting for the host); the host's own hosting connection must be gone.
  // What they left while the host was away goes to the club straight after.
  async importHere(ws, id, env) {
    const code = this.state.getTags(ws).find(t => t.startsWith('c:'))?.slice(2);
    try {
      if (!code) throw new Error('Not a club room.');
      if (this.host()) throw new Error('The club is still open in a tab as its host. Close it there first.');
      if (env?.from !== id) throw new Error('The request must come from you.');
      const made = await importClub(this.storage(), env, code, (owner, c) => this.registry('/claim', {owner, code: c}));
      ws.send(JSON.stringify({type: 'club_imported', ...made}));
      const club = await this.club();
      for (const q of await this.queued()) {
        await club.message({from: q.from, data: q.data});
        await this.state.storage.delete('q:' + String(q.n).padStart(12, '0'));
      }
    } catch (e) {
      ws.send(JSON.stringify({type: 'club_error', reason: e.message}));
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const code = decodeURIComponent(url.pathname.split('/').pop() || '');
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
    const club = await this.club(code);
    if (role === 'host') {
      if (host) return refuse(4001, 'the table already has a host');
      if (club) return refuse(4001, 'this club runs on the relay');
      this.state.acceptWebSocket(server, ['host']);
      for (const g of this.state.getWebSockets('guest')) {
        server.send(JSON.stringify({from: this.guestId(g), event: 'open'}));
        g.send(JSON.stringify({type: 'host_back'}));
      }
      for (const q of await this.queued()) server.send(JSON.stringify({from: q.from, data: q.data, queued: q.n}));
    } else if (role === 'guest') {
      if (!ID.test(id)) return refuse(4000, 'bad id');
      if (!host && !queue && !club) return refuse(4004, 'no such table');
      for (const old of this.state.getWebSockets('g:' + id)) old.close(4009, 'replaced');
      if (this.state.getWebSockets('guest').length >= MAX_GUESTS) return refuse(4029, 'the room is full');
      const tags = ['guest', 'g:' + id, 'c:' + code];
      this.state.acceptWebSocket(server, queue ? [...tags, 'queue'] : tags);
      if (club) await club.message({from: id, event: 'open'});
      else if (host) host.send(JSON.stringify({from: id, event: 'open'}));
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
    const host = this.state.getTags(ws).includes('host');
    if (!allow(ws, host ? HOST_RATE : RATE, host ? HOST_BURST : BURST)) { ws.close(4008, 'too many messages'); return; }
    if (typeof msg !== 'string' || msg.length > MAX_IMPORT) return;
    // Only a club moving here (#98) may be bigger than MAX_MESSAGE.
    if (msg.length > MAX_MESSAGE && !msg.includes('"import_club"')) return;
    // A heartbeat from either side: answered here, never forwarded or queued,
    // so a host can tell its link to the relay is alive.
    const pong = pingReply(msg);
    if (pong) { ws.send(pong); return; }
    const id = this.guestId(ws);
    if (id) {
      // An always-on club runs here: it gets the message. Or someone asks
      // to make this room one, or to move their club here.
      const club = await this.club(this.state.getTags(ws).find(t => t.startsWith('c:'))?.slice(2));
      if (club || msg.includes('"create_club"') || msg.includes('"import_club"')) {
        let m;
        try { m = JSON.parse(msg); } catch { return; }
        if (club) await club.message({from: id, data: m});
        else if (m?.body?.type === 'create_club') await this.create(ws, id, m);
        else if (m?.body?.type === 'import_club') await this.importHere(ws, id, m);
        return;
      }
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
      if (this.clubP) { this.clubP.then(c => c.message({from: id, event: 'close'})).catch(e => console.warn(e)); return; }
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
