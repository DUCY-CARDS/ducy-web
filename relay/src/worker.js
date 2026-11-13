// Relays messages for ducy's clubs. Each code is a room (one Durable
// Object); each always-on club runs in its room, and its members' tabs hold a
// WebSocket to it as guests. Nothing else is hosted here: a tab can't host a
// table or a tournament (#643), and `role=host` is refused (4000).
//
// Queue mode (guest connects with queue=1, used by clubs): the guest may
// connect before the room is a club ({type: 'host_away'}). Its messages
// meanwhile are stored (a few per guest, for up to 7 days); moving a club
// here (import_club) is gone (#636), so nothing takes them.
//
// Heartbeat: {type: "ping", t} from anyone is answered with {type: "pong", t}.
//
// Always-on clubs (#93, club-room.js): a guest alone in an empty room may
// send a signed {type: 'create_club', club: code, name, grant}, `grant` the
// token from their one-time link (#636, registry.js); the room then is that
// club's host, for good. It answers {type: 'club_created', hostId,
// invite} (or {type: 'club_error', reason}), and runs the club itself with
// members connecting as guests.
//
// Close codes: 4000 bad request, 4003 the club is paused or its trial ended
// (#265; the reason says which), 4004 no such club, 4008 sending too fast,
// 4009 replaced by a newer connection with the same id, 4029 the room is full.
//
// The super admin's API (#265, #401): POST /admin/…, each request signed by
// a key listed in admins.json (bundled at build time). admin.js has the
// routes and the checks. Pages on ALLOWED_ORIGINS or ADMIN_ORIGINS (the
// admin site, #601) may call it.
//
// Usage counts (#601, stats.js): rooms tell the registry when a club gets a
// player or finishes a hand. The registry keeps totals per day; the admin
// site reads them with /admin/stats.
//
// What a code is (#393), for Play's Enter a code, public:
//   GET /code/<code>   {kind: 'club', ask, name, hostId} for an always-on
//                      club (name and hostId only when it lets people ask
//                      to join with the code: club-room.js codeInfo), else
//                      {kind: 'none'}
//
// Services (src/club-services.js, service-http.js): an always-on club's
// outside servers send
//   POST /club/<code>/service   a signed envelope (identity.js), as JSON
// and get {ok, value} or {ok: false, error}, with 400 (malformed), 401 (not
// a service of the club, revoked, expired, stale or replayed), 403 (not
// allowed, over a limit, or the club is paused), 404 (no such club or
// member), 409 (refused, e.g. not enough chips) or 429 (too fast).

import { adminView, codeInfo, createClub, openClub } from './club-room.js';
import { adminApi, adminsFrom } from './admin.js';
import adminList from '../../admins.json';
import { limitsFrom, registry } from './registry.js';
import { fairPlayStore } from './fair-play-admin.js';
import { MAX_REPORT_BYTES } from './error-log.js';
import { BACKUP_EVERY_MS, backupConfig, dropBackups, pullBackup, pushBackup } from './backup.js';
import { pingReply } from './ping.js';
import { serviceHttp, serviceInRoom } from './service-http.js';
import { clubCodes, resetRefusal } from './reset.js';
import { passkeys } from './passkeys.js';
import { mustProve, newChallenge, proves } from './prove.js';
import { CLUB_SITE_REPLY, check as unlockCheck, siteOk, unlockedNow } from './unlock.js';
import { stats } from './stats.js';
import { cfAnalytics } from './cf-analytics.js';
import { judgeVia } from './postflop.js';
import { initSync } from '../../wasm/ducy_wasm.js';
import wasmModule from '../../wasm/ducy_wasm_bg.wasm';

// The engine, for always-on clubs and every signature check (ducy-identity,
// #460): set up once per Worker instance.
let engineReady = false;
function loadEngine() {
  if (!engineReady) { initSync({module: wasmModule}); engineReady = true; }
}

// Table codes use capitals and digits with no I, L, O, 0 or 1 (play-net.js).
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const ID = /^[\w-]{1,64}$/;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 64 * 1024;
// Each connection may send RATE messages a second, in bursts of up to BURST;
// one that sends faster is closed (4008), so a single client can't use up
// the account's quota for everyone (#103).
const RATE = 20, BURST = 50;

// A token bucket kept on the socket itself, so it survives hibernation.
function allow(ws, rate, burst, now = Date.now()) {
  // The socket also keeps its proof (#577) and unlock (#575).
  const b = ws.deserializeAttachment() || {};
  if (b.tokens == null) { b.tokens = burst; b.at = now; }
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  ws.serializeAttachment(b);
  return true;
}

// A member's connection to an always-on club (#582): its IP and user agent
// (club-room.js hashes them with the club's salt at once and never keeps
// them as they are) and Cloudflare's network and place for it. The place's
// rough coordinates are only for the location checks while connected
// (#581, proximity.js), never kept. `trust` (#583): how far its client can
// be believed; every connection is from the website for now. When the app
// comes, the relay decides its level from what it can check (an attested
// device), never from what the client says.
function connOf(req) {
  const cf = req.cf || {};
  return {
    ip: req.headers.get('CF-Connecting-IP') || '', ua: req.headers.get('User-Agent') || '',
    asn: cf.asn ?? null, asOrg: cf.asOrganization ?? null, country: cf.country ?? null, region: cf.region ?? null,
    city: cf.city ?? null, timezone: cf.timezone ?? null, latitude: cf.latitude ?? null, longitude: cf.longitude ?? null,
    trust: 'website',
  };
}

const MAX_QUEUED = 100, MAX_QUEUED_PER_GUEST = 10, MAX_QUEUED_MESSAGE = 8 * 1024;
const QUEUE_MS = 7 * 864e5;

// The relay's one registry of always-on clubs (registry.js).
const registryOf = env => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
const roomOf = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

// The admins (#401): admins.json at the repo root, bundled when the relay is built.
const ADMINS = adminsFrom(adminList);
// Their player IDs, left out of the usage counts (#601).
const ADMIN_IDS = new Set(ADMINS.keys());
const originsOf = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
// The relay's environment as the admin site names it (#636): 'live' for
// production (no ENVIRONMENT), else 'staging' or 'sandbox'.
const environmentOf = env => (!env.ENVIRONMENT || env.ENVIRONMENT === 'production' ? 'live' : String(env.ENVIRONMENT));

// What's live now (#601): each club's players and running tables (its
// room's /admin/now).
async function liveNow(env, reg) {
  const list = await reg('/list');
  const clubs = await Promise.all(list.clubs.map(c => roomOf(env, c.code).fetch(`https://room/admin/now/${encodeURIComponent(c.code)}`).then(r => r.json()).catch(() => ({online: 0, tables: 0}))));
  const busy = clubs.filter(c => c.online > 0);
  return {
    rooms: busy.length,
    players: busy.reduce((s, c) => s + c.online, 0),
    clubTables: clubs.reduce((s, c) => s + (c.tables || 0), 0),
  };
}

// The super admin's API (#265, #401): admin.js says what it answers.
async function admin(req, env, url, cors) {
  const json = (v, status = 200) => Response.json(v, {status, headers: cors});
  if (req.method !== 'POST') return json({error: 'Admin requests are signed POSTs.'}, 405);
  const signed = await req.json().catch(() => null);
  // The registry's answer, or throws its error.
  const reg = async (path, body) => {
    const out = await registryOf(env).fetch(`https://registry${path}`, {method: 'POST', body: JSON.stringify(body || {})}).then(r => r.json());
    if (out?.error) throw new Error(out.error);
    return out;
  };
  const room = async (code, what, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const out = await roomOf(env, code).fetch(`https://room/admin/${what}/${encodeURIComponent(code)}?${q}`).then(r => r.json());
    if (out?.error) throw new Error(out.error);
    return out;
  };
  const out = await adminApi(url.pathname, signed, ADMINS, {
    seen: (id, seq) => reg('/admin-seen', {id, seq}),
    log: entry => reg('/admin-log', {entry}),
    logList: () => reg('/admin-log-list').then(r => r.log),
    errors: () => reg('/errors').then(r => r.errors),
    stats: async () => {
      const [{days}, now] = await Promise.all([reg('/stats', {days: 30}), liveNow(env, reg)]);
      return {days, now};
    },
    cloudflare: () => cfAnalytics(env),
    fairPlay: () => reg('/fair-play-list').then(r => r.clubs),
    fairPlayHistory: id => reg('/fair-play-history', {id}).then(r => r.weeks),
    list: () => reg('/list'),
    grant: (id, body) => reg('/grant', {...body, id}),
    revoke: id => reg('/revoke', {id}),
    // Wipe all clubs (#636): each room's data, then the registry's records,
    // grants and fair play rows.
    environment: environmentOf(env),
    clubCodes: () => reg('/club-codes').then(r => r.codes),
    wipe: async codes => {
      for (const code of codes) await roomOf(env, code).fetch(`https://room/admin/wipe/${encodeURIComponent(code)}`);
      await reg('/wipe', {codes});
      return {clubs: codes.length};
    },
    setClub: (code, change) => reg('/set-club', {code, change}),
    status: code => reg('/status', {code}),
    room,
    // The room picks up the change at once: new limits, or members let go.
    refresh: code => roomOf(env, code).fetch(`https://room/admin/refresh/${encodeURIComponent(code)}`).catch(e => console.warn(e)),
  });
  return json(out.body, out.status);
}

// Every answer but a WebSocket's says its content type is to be believed
// (#436). CORS stays as each route sets it.
function nosniff(res) {
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.set('x-content-type-options', 'nosniff');
  return out;
}

export default {
  async fetch(req, env) {
    return nosniff(await route(req, env));
  },
};

async function route(req, env) {
  // The admin API checks signatures here, before any room has started.
  loadEngine();
  const url = new URL(req.url);
  const allowed = originsOf(env.ALLOWED_ORIGINS);
  if (url.pathname.startsWith('/admin/')) {
    const origin = req.headers.get('Origin');
    // The admin site (ADMIN_ORIGINS, #601) or a page on the site, or a
    // script (no Origin), signing as an admin.
    const cors = origin && (!allowed.length || allowed.includes(origin) || originsOf(env.ADMIN_ORIGINS).includes(origin))
      ? {'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST', vary: 'Origin'}
      : {};
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    return admin(req, env, url, cors);
  }
  // A page's error report (#552): from the site only, small, and answered with nothing.
  if (url.pathname === '/report') {
    const origin = req.headers.get('Origin');
    if (req.method !== 'POST' || !origin || (allowed.length && !allowed.includes(origin))) return new Response(null, {status: 403});
    const raw = await req.text();
    if (raw.length <= MAX_REPORT_BYTES) await registryOf(env).fetch('https://registry/report', {method: 'POST', body: raw}).catch(e => console.warn(e));
    return new Response(null, {status: 204, headers: {'access-control-allow-origin': origin, vary: 'Origin'}});
  }
  // Which relay this is (DEPLOY.md): its environment and commit, set at deploy.
  if (url.pathname === '/version' && req.method === 'GET') {
    return Response.json({environment: env.ENVIRONMENT || 'production', commit: env.COMMIT || ''}, {headers: {'access-control-allow-origin': '*'}});
  }
  // Wiping a test relay (reset.js): the sandbox only.
  if (url.pathname === '/reset') {
    const no = resetRefusal(env, req.headers.get('authorization'), req.method);
    if (no) return Response.json({error: no.error}, {status: no.status});
    const {codes} = await registryOf(env).fetch('https://registry/reset-list', {method: 'POST'}).then(r => r.json());
    for (const code of codes) await roomOf(env, code).fetch(`https://room/reset/${encodeURIComponent(code)}`);
    await registryOf(env).fetch('https://registry/reset', {method: 'POST'});
    return Response.json({ok: true, clubs: codes.length});
  }
  // How much always-on clubs use against the free plan (#98): numbers only.
  if (url.pathname === '/usage' && req.method === 'GET') {
    const res = await registryOf(env).fetch('https://registry/usage');
    const origin = req.headers.get('Origin');
    const cors = !allowed.length ? '*' : allowed.includes(origin) ? origin : '';
    return new Response(res.body, {headers: {'content-type': 'application/json', ...(cors ? {'access-control-allow-origin': cors} : {})}});
  }
  // What a code is (#393): a club (the registry knows it, its room says
  // what it may tell), or nothing.
  const look = url.pathname.match(/^\/code\/([^/]+)$/);
  if (look && req.method === 'GET') {
    const origin = req.headers.get('Origin');
    const cors = !allowed.length ? '*' : allowed.includes(origin) ? origin : '';
    const headers = {'content-type': 'application/json', vary: 'Origin', ...(cors ? {'access-control-allow-origin': cors} : {})};
    const code = decodeURIComponent(look[1]);
    if (!CODE.test(code)) return new Response(JSON.stringify({error: 'bad code'}), {status: 400, headers});
    const {has} = await registryOf(env).fetch('https://registry/has', {method: 'POST', body: JSON.stringify({code})}).then(r => r.json());
    if (!has) return new Response(JSON.stringify({kind: 'none'}), {headers});
    const invite = (url.searchParams.get('invite') || '').slice(0, 64);
    const res = await roomOf(env, code).fetch(`https://room/lookup/${encodeURIComponent(code)}?invite=${encodeURIComponent(invite)}`);
    return new Response(res.body, {headers});
  }
  // Passkeys (#575, passkeys.js): from the site's pages, to the registry.
  const pko = url.pathname.match(/^\/passkey\/([a-z]+)$/);
  if (pko) {
    const origin = req.headers.get('Origin');
    const ok = !allowed.length || allowed.includes(origin);
    const cors = ok && origin ? {'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST', vary: 'Origin'} : {};
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (req.method !== 'POST' || !ok) return Response.json({error: 'forbidden'}, {status: 403, headers: cors});
    const raw = await req.text();
    if (raw.length > 32 * 1024) return Response.json({error: 'too big'}, {status: 413, headers: cors});
    // The page's origin goes along (allowed above): a session keeps it (#637).
    const res = await registryOf(env).fetch(`https://registry/passkey/${pko[1]}`, {method: 'POST', body: raw, headers: {'x-ducy-origin': origin || ''}});
    return new Response(res.body, {status: res.status, headers: {'content-type': 'application/json', ...cors}});
  }
  const svc = url.pathname.match(/^\/club\/([^/]+)\/service$/);
  if (svc) {
    const code = decodeURIComponent(svc[1]);
    return serviceHttp(req, code, env2 => roomOf(env, code).fetch(`https://room/service/${encodeURIComponent(code)}`, {method: 'POST', body: JSON.stringify(env2)}));
  }
  const m = url.pathname.match(/^\/room\/([^/]+)$/);
  if (!m) return new Response('ducy relay', {status: 404});
  if (allowed.length && !allowed.includes(req.headers.get('Origin'))) return new Response('forbidden', {status: 403});
  const code = decodeURIComponent(m[1]);
  if (!CODE.test(code)) return new Response('bad table code', {status: 400});
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', {status: 426});
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
}

// The registry of always-on clubs (registry.js), one for the relay: limits
// on creating them, and their usage. Only rooms reach it, except /usage
// and the /has behind /code (#393). No club is deleted for going unused
// (#654).
export class Registry {
  constructor(state, env) {
    const s = state.storage;
    this.state = state;
    this.env = env;
    this.reg = registry({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)}, limitsFrom(env));
    // Passkeys (#575): pages on ALLOWED_ORIGINS only.
    // Club sites (#637): sessions keep where they were made, and no vouching there.
    this.pk = passkeys({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)}, {origins: originsOf(env.ALLOWED_ORIGINS), clubOrigins: originsOf(env.CLUB_ORIGINS)});
    // Usage counts (#601).
    this.stats = stats({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)}, {admins: ADMIN_IDS});
    // Each club's fair play summaries (#612).
    this.fp = fairPlayStore({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)});
  }

  async fetch(req) {
    // ducy's engine first: the registry's rules (registry.js clubRegistry),
    // admin checks and passkeys all call it, and this object may start in
    // a fresh isolate where nothing else has loaded it.
    loadEngine();
    const path = new URL(req.url).pathname;
    // Wiping a test relay (reset.js), from the Worker's /reset only.
    if (this.env.RESETTABLE === 'on' && path === '/reset-list') {
      return Response.json({codes: clubCodes(await this.state.storage.get('clubs'))});
    }
    if (this.env.RESETTABLE === 'on' && path === '/reset') {
      await this.state.storage.deleteAll();
      const s = this.state.storage;
      this.reg = registry({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)}, limitsFrom(this.env));
      this.stats = stats({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)}, {admins: ADMIN_IDS});
      this.fp = fairPlayStore({get: k => s.get(k), put: (k, v) => s.put(k, v), delete: k => s.delete(k)});
      return Response.json({ok: true});
    }
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    // Passkeys (#575): a page's request, through the Worker; a room's check
    // of a connection's session.
    const pko = path.match(/^\/passkey\/([a-z]+)$/);
    if (pko) {
      const out = await this.pk.http(pko[1], body, req.headers.get('x-ducy-origin') || '');
      return Response.json(out.body, {status: out.status});
    }
    if (path === '/passkey-session') return Response.json({session: await this.pk.session(String(body.token || ''), body.club || null)});
    if (path === '/passkey-owner') { await this.reg.moveOwner(String(body.code), String(body.from), String(body.to)); return Response.json({ok: true}); }
    try {
      if (path === '/claim') return Response.json(await this.reg.claim(String(body.owner), String(body.code), Date.now(), String(body.name || ''), {grant: String(body.grant || '')}));
      else if (path === '/has') return Response.json({has: await this.reg.has(String(body.code))});
      else if (path === '/status') return Response.json(await this.reg.status(String(body.code)));
      else if (path === '/release') { await this.reg.release(String(body.code)); await this.fp.drop(String(body.code)); }
      // On the day it was played (`at`, #421): within the last day or so.
      else if (path === '/used') {
        const now = Date.now(), at = Number(body.at);
        await this.reg.used(Number(body.minutes), Number.isFinite(at) && at <= now && now - at < 2 * 864e5 ? at : now, body.code ? String(body.code) : null);
      }
      else if (path === '/usage') return Response.json(await this.reg.usage());
      // The super admin's (only reached through admin() in the Worker).
      else if (path === '/list') return Response.json(await this.reg.list());
      else if (path === '/grant') return Response.json(await this.reg.grant(String(body.id), body));
      else if (path === '/revoke') await this.reg.revoke(String(body.id));
      // Wipe all clubs (#636): the codes first, then (each room emptied) the rest.
      else if (path === '/club-codes') return Response.json({codes: await this.reg.clubCodes()});
      else if (path === '/wipe') {
        await this.reg.wipe();
        await this.fp.wipe(Array.isArray(body.codes) ? body.codes.map(String) : []);
      }
      else if (path === '/set-club') return Response.json(await this.reg.setClub(String(body.code), body.change || {}));
      else if (path === '/admin-seen') await this.reg.adminSeen(String(body.id), Number(body.seq));
      else if (path === '/admin-log') await this.reg.adminLog(body.entry || {});
      else if (path === '/admin-log-list') return Response.json({log: await this.reg.adminLogList()});
      else if (path === '/report') await this.reg.report(body);
      else if (path === '/errors') return Response.json({errors: await this.reg.errors()});
      // Usage counts (#601), from rooms; read by the admin API.
      else if (path === '/stat') await this.stats.note(body);
      // Fair play summaries (#612): from rooms after each run; read by the admin API.
      else if (path === '/fair-play') await this.fp.note(String(body.code), body.summary);
      else if (path === '/fair-play-list') return Response.json({clubs: await this.fp.list()});
      else if (path === '/fair-play-history') return Response.json({weeks: await this.fp.history(String(body.id || ''))});
      else if (path === '/stats') return Response.json({days: await this.stats.days(Math.min(90, Math.max(1, Number(body.days) || 30)))});
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
    const proven = this.state.getWebSockets('guest').filter(g => !this.unproven(g));
    const online = [...new Set(proven.map(g => this.guestId(g)))];
    // Their connections, for the seat and location signals (#581).
    const openConns = Object.fromEntries(proven.map(g => [this.guestId(g), g.deserializeAttachment()?.conn]).filter(([, c]) => c));
    loadEngine();
    this.clubP = this.status(code)
      .then(({record}) => openClub({
        storage: this.storage(), send: (to, data) => this.toGuest(to, data), online, openConns, record,
        // The postflop fair play check's scoring (#615), in ducy's judge Worker.
        judge: judgeVia(this.env.JUDGE),
        onUsage: (minutes, at) => this.clubCode().then(c => this.registry('/used', {minutes, at, code: c})),
        onHand: ids => this.clubCode().then(c => this.registry('/stat', {kind: 'clubHand', code: c, ids})),
        // Each fair play run's summary, for the admin site (#612).
        onFairPlay: summary => this.clubCode().then(c => this.registry('/fair-play', {code: c, summary})),
        onDeleted: () => this.deleted(),
        onSaved: () => this.scheduleBackup(),
        timers: this.tableTimers(),
        onOwnerMoved: async (from, to) => {
          await this.registry('/passkey-owner', {code: await this.clubCode(), from, to});
          await this.status(null, true);
        },
      }))
      .catch(e => { this.clubP = null; throw e; });
    return this.clubP;
  }

  // The always-on club's code here, from its storage.
  async clubCode() {
    return (await this.state.storage.get('club'))?.code || null;
  }

  // The club's record in the registry and whether it may run (#265),
  // remembered for a minute (`fresh`: ask again).
  async status(code = null, fresh = false) {
    const c = code || await this.clubCode();
    if (!c) return {record: null, blocked: ''};
    if (!fresh && this.statusAt && Date.now() - this.statusAt < 60_000 && this.statusCode === c) return this.statusV;
    try {
      this.statusV = await this.registry('/status', {code: c});
    } catch (e) {
      // The registry can't be reached: let the club run as it was.
      console.warn('club: no status:', e);
      return this.statusV || {record: null, blocked: ''};
    }
    this.statusAt = Date.now();
    this.statusCode = c;
    return this.statusV;
  }

  // The super admin changed the club, or looks inside it (#265).
  async adminRequest(path, code) {
    // Who's here and the tables running, for the admin site's Now (#601):
    // the admins left out. A club no one is in isn't opened to ask.
    if (path === 'now') {
      const ids = new Set(this.state.getWebSockets('guest').filter(g => !this.unproven(g)).map(g => this.guestId(g)).filter(id => id && !ADMIN_IDS.has(id)));
      let tables = 0;
      if (ids.size || this.clubP) {
        const club = await this.club(code).catch(() => null);
        if (club) tables = (await club.adminInfo()).tables.filter(t => t.running).length;
      }
      return Response.json({online: ids.size, tables});
    }
    if (path === 'refresh') {
      const st = await this.status(code, true);
      const club = this.clubP ? await this.clubP.catch(() => null) : null;
      club?.setRecord(st.record);
      // Paused: everyone but the owner is let go.
      if (st.blocked) {
        for (const g of this.state.getWebSockets('guest')) {
          if (this.guestId(g) === st.record?.owner) continue;
          try { g.close(4003, st.blocked.slice(0, 120)); } catch {}
        }
      }
      return Response.json({ok: true});
    }
    const club = await this.club(code).catch(() => null);
    return Response.json({
      online: new Set(this.state.getWebSockets('guest').map(g => this.guestId(g))).size,
      queued: (await this.queued()).length,
      club: club ? await club.adminInfo() : null,
    });
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
    for (const g of this.guests(to)) { try { g.send(out); } catch {} }
  }

  // A guest alone in an empty room asks to make it an always-on club.
  async create(ws, id, env) {
    const code = this.state.getTags(ws).find(t => t.startsWith('c:'))?.slice(2);
    const others = this.state.getWebSockets('guest').some(g => this.guestId(g) !== id);
    try {
      if (!code || others || (await this.queued()).length) throw new Error('That club code is in use.');
      if (env?.from !== id) throw new Error('The request must come from you.');
      // The grant's token (#636), in the signed request: the registry takes
      // it from this player only, once.
      const made = await createClub(this.storage(), env, code, (owner, c, name) => this.registry('/claim', {owner, code: c, name, grant: String(env.body?.grant || '')}));
      ws.send(JSON.stringify({type: 'club_created', ...made}));
      await this.club();
    } catch (e) {
      ws.send(JSON.stringify({type: 'club_error', reason: e.message}));
    }
  }

  async fetch(req) {
    // Making or reading a club runs its rules (ducy-play's).
    loadEngine();
    const url = new URL(req.url);
    const code = decodeURIComponent(url.pathname.split('/').pop() || '');
    // Wiping a test relay (reset.js), from the Worker's /reset only: everyone
    // is let go and the room's storage deleted.
    if (this.env.RESETTABLE === 'on' && url.pathname.startsWith('/reset/')) {
      for (const ws of this.state.getWebSockets()) { try { ws.close(4004, 'the sandbox was reset'); } catch {} }
      this.clubP = null;
      this.timerMap?.clear();
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return Response.json({ok: true});
    }
    // From the Worker's admin API only: the outside world reaches rooms by
    // /room/<code> WebSockets alone.
    // Wipe all clubs (#636): everyone is let go, its backups dropped, and
    // the room's storage deleted.
    if (url.pathname.startsWith('/admin/wipe/')) {
      for (const ws of this.state.getWebSockets()) { try { ws.close(4004, 'the club was closed'); } catch {} }
      this.clubP = null;
      this.timerMap?.clear();
      const cfg = backupConfig(this.env);
      if (cfg && code) await dropBackups(cfg, code).catch(e => console.warn(e));
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return Response.json({ok: true});
    }
    const adm =url.pathname.match(/^\/admin\/(refresh|info|now)\//);
    if (adm) return this.adminRequest(adm[1], code);
    // The club as the admin page shows it, from storage (#401).
    const view = url.pathname.match(/^\/admin\/(full|people|person)\//);
    if (view) {
      const out = await adminView(this.storage(), view[1], {reveal: url.searchParams.get('reveal') === 'true', id: url.searchParams.get('id') || ''});
      return Response.json(out || {});
    }
    // What anyone may learn from the club's code (#393), from the Worker.
    if (url.pathname.startsWith('/lookup/')) return Response.json(codeInfo(await this.state.storage.get('club'), url.searchParams.get('invite') || ''));
    // A service's request, from the Worker (serviceHttp checked its shape).
    if (url.pathname.startsWith('/service/')) {
      const club = await this.club(code).catch(() => null);
      const st = club ? await this.status(code) : null;
      if (st?.blocked) return Response.json({ok: false, error: st.blocked}, {status: 403});
      const env = await req.json().catch(() => null);
      const out = await serviceInRoom(this, club, env);
      return Response.json(out.body, {status: out.status});
    }
    const role = url.searchParams.get('role');
    const id = url.searchParams.get('id') || '';
    const queue = url.searchParams.get('queue') === '1';
    const [client, server] = Object.values(new WebSocketPair());
    const refuse = (code, reason) => {
      server.accept();
      server.close(code, reason);
      return new Response(null, {status: 101, webSocket: client});
    };
    // Only guests: no tab hosts a table or a tournament here (#643).
    if (role !== 'guest') return refuse(4000, 'bad role');
    if (!ID.test(id)) return refuse(4000, 'bad id');
    const club = await this.club(code);
    if (!queue && !club) return refuse(4004, 'no such club');
    // A paused club, or a trial that's ended (#265): only its owner gets in.
    if (club) {
      const st = await this.status(code);
      if (st.blocked && id !== st.record?.owner) return refuse(4003, st.blocked.slice(0, 120));
      this.noteActive(code);
    }
    // A club connection proves it holds the player's key first (#577,
    // prove.js): until then it replaces no one, and only an older
    // unproven one of the same ID goes.
    const proving = mustProve({queue, club});
    for (const old of this.state.getWebSockets('g:' + id)) {
      if (!proving || this.unproven(old)) old.close(4009, 'replaced');
    }
    if (this.state.getWebSockets('guest').length >= MAX_GUESTS) return refuse(4029, 'the room is full');
    const tags = ['guest', 'g:' + id, 'c:' + code];
    this.state.acceptWebSocket(server, queue ? [...tags, 'queue'] : tags);
    if (proving) {
      const challenge = newChallenge();
      // The club keeps a hashed snapshot of the connection for ducy's
      // checks (#582): kept on the socket until it's proven.
      // And its page's origin: only a club site runs a club (#637).
      server.serializeAttachment({proof: challenge, conn: connOf(req), origin: req.headers.get('Origin') || ''});
      server.send(JSON.stringify({type: 'prove', challenge}));
    } else await this.arrived(server, id, connOf(req));
    return new Response(null, {status: 101, webSocket: client});
  }

  // A club connection that hasn't proved its player ID yet (#577).
  unproven(ws) {
    return !!ws.deserializeAttachment()?.proof;
  }

  // The guest connections of player `id` that count: proven, or not asked.
  guests(id) {
    return this.state.getWebSockets('g:' + id).filter(g => !this.unproven(g));
  }

  // Guest `ws` (player `id`) counts from now: the club hears they're here,
  // or, with no club here yet, they hear so.
  async arrived(ws, id, conn = ws.deserializeAttachment()?.conn) {
    const code = this.state.getTags(ws).find(t => t.startsWith('c:'))?.slice(2);
    const club = await this.club(code);
    if (club) {
      this.notePlayer(id, code);
      await club.message({from: id, event: 'open', conn});
    } else ws.send(JSON.stringify({type: 'host_away'}));
  }

  // ---- usage counts (#601, stats.js) ----

  stat(ev) {
    this.registry('/stat', ev).catch(e => console.warn('stats:', e));
  }

  // A player in the club: counted once a day per room (the registry
  // counts each player once a day in all).
  notePlayer(id, code) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.notedDay !== day) { this.notedDay = day; this.noted = new Set(); }
    if (this.noted.has(id)) return;
    this.noted.add(id);
    this.stat({kind: 'player', id, code});
  }

  // A proof from unproven connection `ws` (#577): it counts, replacing any
  // other connection of the same player. Anything else is dropped.
  async proving(ws, id, msg) {
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    const code = this.state.getTags(ws).find(t => t.startsWith('c:'))?.slice(2);
    if (!(await proves(m, {id, code, challenge: a.proof}))) {
      if (m?.type === 'prove') ws.close(4000, 'not proven');
      return;
    }
    ws.serializeAttachment({...(ws.deserializeAttachment() || {}), proof: null});
    for (const old of this.state.getWebSockets('g:' + id)) if (old !== ws) old.close(4009, 'replaced');
    ws.send(JSON.stringify({type: 'proven'}));
    await this.arrived(ws, id);
  }

  // Someone connected to the club: its last-active time in the registry,
  // at most once an hour.
  noteActive(code) {
    if (this.activeAt && Date.now() - this.activeAt < 3600e3) return;
    this.activeAt = Date.now();
    this.registry('/used', {minutes: 0, code}).catch(e => console.warn(e));
  }

  guestId(ws) {
    const tag = this.state.getTags(ws).find(t => t.startsWith('g:'));
    return tag ? tag.slice(2) : null;
  }

  // Stored messages for a club moving here, oldest first, dropping expired ones.
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
    if (!allow(ws, RATE, BURST)) { ws.close(4008, 'too many messages'); return; }
    if (typeof msg !== 'string' || msg.length > MAX_MESSAGE) return;
    // A heartbeat: answered here, never passed on or queued.
    const pong = pingReply(msg);
    if (pong) { ws.send(pong); return; }
    const id = this.guestId(ws);
    // Checking a proof checks a signature, with the engine (after
    // hibernation the Worker may have started again without it).
    if (id && this.unproven(ws)) { loadEngine(); await this.proving(ws, id, msg); return; }
    if (id) {
      // An always-on club runs here: it gets the message. Or someone asks
      // to make this room one, or to move their club here.
      const club = await this.club(this.state.getTags(ws).find(t => t.startsWith('c:'))?.slice(2));
      // A location reading (#581): from an unlocked connection only, and it
      // doesn't count as activity (unlock.js unlockedNow).
      if (club && msg.startsWith('{"type":"location"')) {
        let m;
        try { m = JSON.parse(msg); } catch { return; }
        if (unlockedNow(ws.deserializeAttachment()?.unlock)) await club.message({from: id, data: m});
        return;
      }
      if (club || msg.includes('"create_club"') || msg.startsWith('{"type":"unlock"')) {
        let m;
        try { m = JSON.parse(msg); } catch { return; }
        // Only a connection unlocked with the player's passkey acts (#575).
        // The unlock is kept on the socket, so it lasts through hibernation.
        const a = ws.deserializeAttachment() || {};
        const c = await this.state.storage.get('club');
        const about = c ? {code: c.code, hostId: c.hostId, name: c.name, owner: c.ownerId === id} : null;
        const g = await unlockCheck(m, a.unlock || null, id, token => this.registry('/passkey-session', {token, club: about}).then(r => r.session));
        ws.serializeAttachment({...(ws.deserializeAttachment() || {}), unlock: g.u});
        // The relay vouched for this player as someone who lost their ID:
        // moved over before they hear they're unlocked.
        if (g.movedFrom && club) await club.vouchedMove(g.movedFrom, id);
        if (g.reply) ws.send(JSON.stringify(g.reply));
        if (!g.pass) return;
        // Running a club only from a club site, with a session made there (#637).
        if (!siteOk(m, g.u, a.origin, originsOf(this.env.CLUB_ORIGINS))) { ws.send(JSON.stringify(CLUB_SITE_REPLY)); return; }
        // Counted as active (#601), as well as on connecting: the player
        // who just made the club connected before it was one.
        if (club) this.notePlayer(id, c.code);
        if (club) await club.message({from: id, data: m});
        else if (m?.body?.type === 'create_club') await this.create(ws, id, m);
        return;
      }
      if (this.state.getTags(ws).includes('queue') && !(await this.enqueue(id, msg))) {
        ws.send(JSON.stringify({type: 'queue_full'}));
      }
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
      // One that never proved its ID (#577) was never there.
      if (this.unproven(ws)) return;
      // A newer connection with the same id took over: not a disconnect.
      if (this.guests(id).some(g => g !== ws)) return;
      this.clubP?.then(c => c.message({from: id, event: 'close'})).catch(e => console.warn(e));
    }
  }
}
