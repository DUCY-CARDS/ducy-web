// Services: outside servers an always-on club's owner lets give members
// chips, within limits (e.g. a rewards server paying for a league).
// Pure functions over the club object, plus the check of a service's signed
// request; club-server.js runs them, and the relay's Worker carries the
// requests (POST /club/<code>/service, relay/src/worker.js).
//
// A service has its own signing key, made on its server (tools/ducy-service.mjs);
// the private key never leaves it. The owner adds the service by its public
// key (its "service line", ducy-service:1:<alg>:<pub>), with:
//   perms     {give, take, read}: give chips, take them back, list members
//   budget    chips it may still give; it never creates more than this
//   perGive   most chips in one give (0: no cap besides the budget)
//   perDay    most chips given in any 24 hours (0: no cap)
//   expires   when it stops working (ms), or null
// Revoking forgets the key at once: the next request is refused.
//
// A request is a signed envelope (identity.js) whose body is
//   {type: 'service', club, op, args}
// op 'give' / 'take' {member, amount, note, key}, 'members', or 'status'.
// Amounts to and from services are in chips (up to two decimals); the club
// stores hundredths, as everywhere (chip-format.js), and so do the limits
// set from the owner's page.
// Its seq is the time it was signed (signMessage does that): requests more
// than SKEW_MS away from the room's clock are refused, and each seq is
// accepted once, so a copied request can't be sent again. `key` (any string
// up to 64 characters) makes a give or take idempotent: sent again, with a
// fresh signature, it returns the first result instead of paying twice.
//
// Club fields: club.services {id: service}, club.serviceRefused {count, at}
// (requests from no service the club knows).

import { checkSignature, fromB64url, isPlayerId, parseShownId, playerIdFor, showId } from './identity.js';
import { issue, reclaim, ensureChips } from './club-chips.js';
import { logAction } from './club-log.js';
import { CHIP_SCALE, chipText } from './chip-format.js';

export const SKEW_MS = 5 * 60_000;
const DAY = 864e5;
const MAX_SERVICES = 10;
const MAX_DONE = 500;
const MAX_NAME = 40;
const MAX_NOTE = 100;
const ALGS = ['ed25519', 'p256'];

// An error with the HTTP status the relay answers with.
export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const whole = n => Number.isSafeInteger(n) && n >= 0;

// The service line a service's tool prints, as {alg, pub, id}; throws if it isn't one.
export async function parseServiceLine(line) {
  const m = String(line || '').trim().match(/^ducy-service:1:(ed25519|p256):([A-Za-z0-9_-]{40,200})$/);
  if (!m) throw new Error('That isn’t a service line: it starts with ducy-service:1:');
  let raw;
  try { raw = fromB64url(m[2]); } catch { throw new Error('That service line is damaged.'); }
  return {alg: m[1], pub: m[2], id: await playerIdFor(raw)};
}

export const serviceLine = ident => `ducy-service:1:${ident.alg}:${ident.pub}`;

// The limits from the owner's form, checked.
function limitsFrom(o, old = {}) {
  const perms = o.perms ?? old.perms ?? {give: true, take: false, read: true};
  const out = {
    perms: {give: !!perms.give, take: !!perms.take, read: !!perms.read},
    budget: Number(o.budget ?? old.budget ?? 0),
    perGive: Number(o.perGive ?? old.perGive ?? 0),
    perDay: Number(o.perDay ?? old.perDay ?? 0),
    expires: o.expires === undefined ? (old.expires ?? null) : (o.expires == null || o.expires === '' ? null : Number(o.expires)),
  };
  for (const k of ['budget', 'perGive', 'perDay']) if (!whole(out[k])) throw new Error('Budgets and caps are whole numbers of chips (0 for no cap).');
  if (out.expires != null && !Number.isSafeInteger(out.expires)) throw new Error('Not a valid expiry.');
  return out;
}

// The owner adds a service: {line, name, perms, budget, perGive, perDay, expires}.
export async function addService(club, o, now = Date.now()) {
  if (!club.ownerId) throw new Error('Only an always-on club can have services.');
  club.services ??= {};
  const {alg, pub, id} = await parseServiceLine(o.line);
  if (club.services[id]?.status === 'active') throw new Error('That service is already added.');
  if (Object.values(club.services).filter(s => s.status === 'active').length >= MAX_SERVICES) throw new Error(`A club can have at most ${MAX_SERVICES} services.`);
  if (club.members[id]) throw new Error('That key is a member’s, not a service’s.');
  const name = String(o.name || '').trim().slice(0, MAX_NAME);
  if (!name) throw new Error('Give the service a name.');
  const s = {id, name, alg, pub, status: 'active', addedAt: now, ...limitsFrom(o), gives: [], seen: {}, done: {}, failures: 0, lastFailure: null, lastUsed: null};
  club.services[id] = s;
  logAction(club, club.ownerId, `Added the service ${name}`, now);
  return s;
}

// The owner changes a service's limits; `addBudget` tops its budget up.
export function updateService(club, id, o, now = Date.now()) {
  const s = club.services?.[id];
  if (!s || s.status !== 'active') throw new Error('No such service.');
  const add = Number(o.addBudget || 0);
  if (!whole(add)) throw new Error('Add a whole number of chips.');
  Object.assign(s, limitsFrom(o, s));
  if (o.name != null && String(o.name).trim()) s.name = String(o.name).trim().slice(0, MAX_NAME);
  s.budget += add;
  logAction(club, club.ownerId, add ? `Added ${chipText(add)} to ${s.name}’s budget` : `Changed ${s.name}’s limits`, now);
  return s;
}

// Revoking: the key is forgotten at once. The record stays, for the history.
export function revokeService(club, id, now = Date.now()) {
  const s = club.services?.[id];
  if (!s || s.status !== 'active') throw new Error('No such service.');
  s.status = 'revoked';
  s.revokedAt = now;
  delete s.pub;
  s.seen = {};
  s.done = {};
  logAction(club, club.ownerId, `Revoked the service ${s.name}`, now);
}

// Chips given in the last 24 hours.
const givenToday = (s, now) => s.gives.filter(g => now - g.at < DAY).reduce((t, g) => t + g.amount, 0);

// What the owner's page shows of each service.
export function servicesView(club, now = Date.now()) {
  return Object.values(club.services || {}).map(s => ({
    id: s.id, name: s.name, status: s.status, perms: s.perms, budget: s.budget, perGive: s.perGive, perDay: s.perDay,
    expires: s.expires, givenToday: givenToday(s, now), failures: s.failures, lastFailure: s.lastFailure, lastUsed: s.lastUsed, addedAt: s.addedAt,
  }));
}

function refuse(club, s, status, reason, now) {
  if (s) { s.failures = (s.failures || 0) + 1; s.lastFailure = {at: now, reason}; } else {
    club.serviceRefused = {count: (club.serviceRefused?.count || 0) + 1, at: now};
  }
  return new ServiceError(status, reason);
}

// Checks a request's envelope: its signature, that it's from an active
// service of this club, for this club, fresh, and not seen before. Returns
// the service. Throws a ServiceError; `changed` says whether the club was
// changed (a failure counted), so the caller saves it.
export async function checkRequest(club, env, now = Date.now()) {
  if (!env || typeof env !== 'object' || !isPlayerId(env.from) || !ALGS.includes(env.alg)) throw new ServiceError(400, 'Not a signed request.');
  const s = club.services?.[env.from];
  if (!s) throw refuse(club, null, 401, 'This club has no such service.', now);
  if (s.status !== 'active') throw refuse(club, s, 401, 'This service was revoked.', now);
  if (env.pub !== s.pub || env.alg !== s.alg) throw refuse(club, s, 401, 'Not this service’s key.', now);
  const bad = await checkSignature(env);
  if (bad) throw refuse(club, s, 401, `The signature doesn’t check out (${bad}).`, now);
  if (env.body?.type !== 'service' || env.body.club !== club.code) throw refuse(club, s, 400, 'Not a request for this club.', now);
  if (Math.abs(now - env.seq) > SKEW_MS) throw refuse(club, s, 401, 'The request is too old or from the future: check the server’s clock.', now);
  if (s.expires != null && now >= s.expires) throw refuse(club, s, 401, 'This service has expired.', now);
  // Each seq once, while it's within the window.
  for (const [k, at] of Object.entries(s.seen)) if (now - at > 2 * SKEW_MS) delete s.seen[k];
  if (s.seen[env.seq]) throw refuse(club, s, 401, 'This request was already received.', now);
  s.seen[env.seq] = now;
  return s;
}

// A member by their stored ID or the shown one ("ABCDE-FGHJ").
function memberOf(club, id) {
  const m = club.members[String(id)] || club.members[parseShownId(String(id)) || ''];
  if (!m || m.status !== 'member') throw new ServiceError(404, 'No such member.');
  return m;
}

// Services count in chips, as people do ("500", "0.25"); the club keeps
// hundredths (chip-format.js).
function chipAmount(n) {
  const a = Math.round(Number(n) * CHIP_SCALE);
  if (!Number.isSafeInteger(a) || a <= 0 || Math.abs(a - Number(n) * CHIP_SCALE) > 1e-6) throw new ServiceError(400, 'The amount is a number of chips above 0, with at most two decimals.');
  return a;
}
const inChips = n => n / CHIP_SCALE;

// Runs a checked request from service `s`. Returns {value, member}: the
// answer, and the member whose balance changed (if any), to tell them.
export function runRequest(club, s, body, now = Date.now()) {
  ensureChips(club);
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  const op = String(body.op || '');
  s.lastUsed = now;
  if (op === 'status') {
    return {value: {name: s.name, perms: s.perms, budget: inChips(s.budget), perGive: inChips(s.perGive), perDay: inChips(s.perDay), givenToday: inChips(givenToday(s, now)), expires: s.expires}};
  }
  if (op === 'members') {
    if (!s.perms.read) throw new ServiceError(403, 'This service may not list members.');
    return {value: Object.values(club.members).filter(m => m.status === 'member').map(m => ({id: m.id, shownId: showId(m.id), name: m.name, balance: inChips(m.balance)}))};
  }
  if (op !== 'give' && op !== 'take') throw new ServiceError(400, `No service action ${op}.`);
  if (!s.perms[op]) throw new ServiceError(403, `This service may not ${op} chips.`);
  const key = args.key == null ? null : String(args.key).slice(0, 64);
  if (key && s.done[key]) return {value: {...s.done[key].value, repeat: true}};
  const m = memberOf(club, args.member);
  const amount = chipAmount(args.amount);
  const note = String(args.note || '').slice(0, MAX_NOTE);
  let entry;
  if (op === 'give') {
    if (s.perGive && amount > s.perGive) throw new ServiceError(403, `At most ${chipText(s.perGive)} in one give.`);
    if (s.perDay && givenToday(s, now) + amount > s.perDay) throw new ServiceError(403, `That would be over the ${chipText(s.perDay)} a day this service may give.`);
    if (amount > s.budget) throw new ServiceError(403, `The service’s budget has ${chipText(s.budget)} left.`);
    entry = issue(club, m.id, amount, now, note ? `${s.name}: ${note}` : s.name);
    s.budget -= amount;
    s.gives.push({at: now, amount});
    s.gives = s.gives.filter(g => now - g.at < DAY);
    logAction(club, s.id, `${s.name} (service) gave ${m.name} ${chipText(amount)}${note ? `: ${note}` : ''}`, now, amount);
  } else {
    try {
      entry = reclaim(club, m.id, amount, now, note ? `${s.name}: ${note}` : s.name);
    } catch (e) {
      throw new ServiceError(409, e.message);
    }
    logAction(club, s.id, `${s.name} (service) took back ${chipText(amount)} from ${m.name}${note ? `: ${note}` : ''}`, now, amount);
  }
  const value = {op, member: m.id, amount: inChips(amount), balance: inChips(m.balance), entry: entry.n, budget: inChips(s.budget)};
  if (key) {
    s.done[key] = {at: now, value};
    const keys = Object.keys(s.done);
    for (const k of keys) if (now - s.done[k].at > DAY) delete s.done[k];
    for (const k of Object.keys(s.done).slice(0, Math.max(0, Object.keys(s.done).length - MAX_DONE))) delete s.done[k];
  }
  return {value, member: m.id};
}
