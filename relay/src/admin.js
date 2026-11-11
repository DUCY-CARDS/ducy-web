// The super admin's API (#265, #401), shared by the Worker (worker.js) and
// the local relay (dev-server.mjs).
//
// Who is an admin: admins.json at the repo root, [{id, pub, name}], each
// admin's player ID and public key (identity.js), bundled into the relay
// when it's built. Every request is POST /admin/<what> with a signed
// envelope (identity.js signMessage) as its JSON body, whose body is
//   {type: 'admin', path: '/admin/<what>', data}
// It's refused (401) when the signature is bad, the path differs, it was
// signed more than WINDOW_MS from the relay's clock, or its seq was seen
// before (a replay); and (403) when the key isn't on the list.
//
//   /admin/clubs                  every club, who has permission, trials, limits
//   /admin/club/<code>   {reveal} a club in full, read-only; reveal: with the
//                                 lobby chat and finished hands' cards (logged)
//   /admin/club/<code>/set {suspended, limits, plan, expires}
//   /admin/grant  {id, note, limits}   lets a player create one club (#636):
//                                 answers {...grant, token}, the token for
//                                 their one-time link (never kept or logged)
//   /admin/revoke {id}            takes it away; an unused link stops working
//   /admin/wipe   {confirm}       Wipe all clubs (#636): every club's data,
//                                 record, backups and fair play rows, and every
//                                 grant; `confirm` must be the relay's
//                                 environment name ('live', 'staging',
//                                 'sandbox', 'local'). Logged before it starts.
//   /admin/people                 every player ID the server knows
//   /admin/person {id}            their activity in every club
//   /admin/log                    the admin log: every admin action
//   /admin/errors                 what pages reported going wrong (#552)
//   /admin/stats                  usage (#601): {days (the last 30, stats.js),
//                                 now: {rooms, players, clubTables}}
//   /admin/cloudflare             Cloudflare's numbers for this relay, if its
//                                 token is set (cf-analytics.js)
//   /admin/fair-play              every club's latest fair play summary
//                                 (fair-play-admin.js, #612): open flags,
//                                 each player's and pair's numbers, the
//                                 club's averages; never a card
//   /admin/fair-play/history {id} that player's weekly summaries, every club
//
// Changes, and each reveal, go in the admin log (registry.js), with who and
// when. Owners aren't told.

import { checkSignature, isPlayerId } from '../../src/identity.js';
import { THRESHOLDS as FAIR_PLAY_LIMITS } from './fair-play-admin.js';

// How far a request's seq (the time it was signed) may be from the relay's clock.
export const WINDOW_MS = 5 * 60_000;
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

export class AdminError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// The listed admins, by player ID: well-formed entries only, so a
// placeholder in admins.json lets no one in.
export function adminsFrom(list) {
  const out = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (a && isPlayerId(a.id) && typeof a.pub === 'string' && a.pub.length >= 32) out.set(a.id, {id: a.id, pub: a.pub, name: String(a.name || '')});
  }
  return out;
}

// Checks a signed request for `path`. Returns {admin, data, seq}, or throws
// an AdminError. Replays are checked by the caller's store (seen()).
export async function checkAdmin(env, path, admins, now = Date.now()) {
  if (!env || typeof env !== 'object') throw new AdminError(400, 'Not a signed request.');
  const bad = await checkSignature(env);
  if (bad) throw new AdminError(401, `The request isn’t signed properly (${bad}).`);
  const body = env.body || {};
  if (body.type !== 'admin' || body.path !== path) throw new AdminError(401, 'The request was signed for something else.');
  if (Math.abs(now - env.seq) > WINDOW_MS) throw new AdminError(401, 'The request is too old, or this device’s clock is off.');
  const admin = admins.get(env.from);
  if (!admin || admin.pub !== env.pub) throw new AdminError(403, 'Your key isn’t on the admin list (admins.json).', {id: env.from, pub: env.pub});
  return {admin, data: body.data && typeof body.data === 'object' ? body.data : {}, seq: env.seq};
}

// What an admin action changed, for the log.
function changeText(change) {
  const out = [];
  if (typeof change.suspended === 'boolean') out.push(change.suspended ? 'pause' : 'resume');
  if (change.limits) out.push('limits');
  if (change.plan) out.push('plan');
  if (Number.isSafeInteger(change.expires)) out.push('expires');
  return out;
}

// Every player ID the server knows, from the registry's list and each
// club's people (club-room.js adminPeople): [{id, names, clubs: [{code,
// club, role, status, balance, agent}], lastSeen, grant, trial}].
export function mergePeople(list, perClub) {
  const people = new Map();
  const get = id => {
    if (!people.has(id)) people.set(id, {id, names: [], clubs: [], lastSeen: null, grant: list.grants?.[id] || null, trial: list.trials?.[id] || null});
    return people.get(id);
  };
  const byCode = Object.fromEntries((list.clubs || []).map(c => [c.code, c]));
  for (const c of list.clubs || []) get(c.owner).clubs.push({code: c.code, club: c.name, role: 'owner'});
  for (const id of Object.keys(list.grants || {})) get(id);
  for (const id of Object.keys(list.trials || {})) get(id);
  for (const [code, view] of Object.entries(perClub)) {
    if (!view || view.error) continue;
    for (const m of view.people || []) {
      const p = get(m.id);
      if (m.name && !p.names.includes(m.name)) p.names.push(m.name);
      if (m.lastSeen && m.lastSeen > (p.lastSeen || 0)) p.lastSeen = m.lastSeen;
      const own = p.clubs.find(x => x.code === code && x.role === 'owner');
      const row = {code, club: byCode[code]?.name || view.name || '', role: m.role || null, status: m.status || null, balance: m.balance ?? null, agent: m.agent || null};
      if (own && !m.status) continue;
      if (own) Object.assign(own, {status: row.status, balance: row.balance});
      else p.clubs.push(row);
    }
  }
  return [...people.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || a.id.localeCompare(b.id));
}

// Answers one admin request. `ops`, the relay's side:
//   seen(id, seq)            throws if this admin's seq was seen (a replay)
//   log(entry)               adds to the admin log
//   logList()                the admin log
//   errors()                 the pages' error reports
//   stats()                  {days, now} (#601)
//   cloudflare()             cf-analytics.js's answer
//   fairPlay()               fair-play-admin.js list(): each club's summary
//   fairPlayHistory(id)      fair-play-admin.js history(id)
//   list() grant(id, body) revoke(id) setClub(code, change) status(code)
//                            the registry (registry.js)
//   environment              the relay's environment name, for /admin/wipe
//   clubCodes()              every club's code (registry.js)
//   wipe(codes)              deletes every club (#636): {clubs}
//   room(code, what, params) a club room's view: 'info', 'full' {reveal},
//                            'people', 'person' {id}
//   refresh(code)            the room picks up a change to its record
// Resolves to {status, body}.
export async function adminApi(path, env, admins, ops, now = Date.now()) {
  try {
    const {admin, data, seq} = await checkAdmin(env, path, admins, now);
    try { await ops.seen(admin.id, seq); } catch (e) { throw new AdminError(401, e.message); }
    const log = (action, target, detail = '') => ops.log({at: now, by: admin.id, name: admin.name, action, target, detail: String(detail).slice(0, 200)});
    if (path === '/admin/clubs') return ok(await ops.list());
    if (path === '/admin/log') return ok({log: await ops.logList()});
    if (path === '/admin/errors') return ok({errors: await ops.errors()});
    if (path === '/admin/stats') return ok(await ops.stats());
    if (path === '/admin/cloudflare') return ok(ops.cloudflare ? await ops.cloudflare() : {enabled: false});
    if (path === '/admin/fair-play') {
      // Club names from the registry's list; a summary's club may be gone.
      const [clubs, list] = await Promise.all([ops.fairPlay(), ops.list()]);
      const names = Object.fromEntries((list.clubs || []).map(c => [c.code, c.name]));
      return ok({clubs: clubs.filter(c => c.code in names).map(c => ({...c, name: names[c.code] || ''})), limits: FAIR_PLAY_LIMITS});
    }
    if (path === '/admin/fair-play/history') {
      const id = String(data.id || '');
      if (!/^[\w-]{1,64}$/.test(id)) throw new AdminError(400, 'That isn’t a player ID.');
      const [weeks, list] = await Promise.all([ops.fairPlayHistory(id), ops.list()]);
      const names = Object.fromEntries((list.clubs || []).map(c => [c.code, c.name]));
      return ok({id, weeks: weeks.map(w => ({...w, club: names[w.code] || ''}))});
    }
    if (path === '/admin/grant') {
      const out = await ops.grant(String(data.id), {note: String(data.note || ''), limits: data.limits && typeof data.limits === 'object' ? data.limits : null});
      await log('grant', String(data.id), [out.note, out.limits ? `${out.limits.tables} tables, ${out.limits.tourneysPerDay}/day` : ''].filter(Boolean).join(' · '));
      return ok(out);
    }
    if (path === '/admin/wipe') {
      const name = String(ops.environment || '');
      if (!name || data.confirm !== name) throw new AdminError(400, `Type ${name} to wipe this relay’s clubs.`);
      const codes = await ops.clubCodes();
      // Logged before anything is deleted: the log is the record (#401).
      await log('wipe', name, `${codes.length} ${codes.length === 1 ? 'club' : 'clubs'}`);
      return ok(await ops.wipe(codes));
    }
    if (path === '/admin/revoke') {
      await ops.revoke(String(data.id));
      await log('revoke', String(data.id));
      return ok({ok: true});
    }
    if (path === '/admin/people') {
      const list = await ops.list();
      const views = await Promise.all(list.clubs.map(c => ops.room(c.code, 'people').catch(e => ({error: e.message}))));
      return ok({people: mergePeople(list, Object.fromEntries(list.clubs.map((c, i) => [c.code, views[i]])))});
    }
    if (path === '/admin/person') {
      const id = String(data.id || '');
      if (!/^[\w-]{1,64}$/.test(id)) throw new AdminError(400, 'That isn’t a player ID.');
      const list = await ops.list();
      const clubs = [];
      for (const c of list.clubs) {
        const v = await ops.room(c.code, 'person', {id}).catch(e => ({error: e.message}));
        if (c.owner === id || v?.member || v?.error) clubs.push({code: c.code, name: c.name, owner: c.owner === id, ...v});
      }
      return ok({id, grant: list.grants[id] || null, trial: list.trials[id] || null, clubs});
    }
    const m = path.match(/^\/admin\/club\/([^/]+)(\/set)?$/);
    const code = m && decodeURIComponent(m[1]);
    if (!code || !CODE.test(code)) throw new AdminError(404, 'not found');
    if (m[2]) {
      const rec = await ops.setClub(code, data);
      await ops.refresh(code);
      for (const a of changeText(data)) {
        const detail = a === 'limits' ? `${rec.limits.tables} tables, ${rec.limits.tourneysPerDay}/day` : a === 'plan' ? rec.plan : a === 'expires' && rec.expires ? new Date(rec.expires).toISOString().slice(0, 10) : '';
        await log(a, code, detail);
      }
      return ok(rec);
    }
    const reveal = data.reveal === true;
    // Logged before anything is shown: the log is the record (#401).
    if (reveal) await log('reveal', code);
    const status = await ops.status(code);
    const [inside, full] = await Promise.all([
      ops.room(code, 'info').catch(e => ({error: e.message})),
      ops.room(code, 'full', {reveal}).catch(e => ({error: e.message})),
    ]);
    return ok({...status, inside, full});
  } catch (e) {
    if (e instanceof AdminError) return {status: e.status, body: {error: e.message, ...e.extra}};
    return {status: 409, body: {error: e.message}};
  }
}

const ok = body => ({status: 200, body});
