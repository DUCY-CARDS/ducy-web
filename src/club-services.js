// Services: outside servers an always-on club's owner lets give members
// chips, within limits (e.g. a rewards server paying for a league).
// ducy-play's club rules keep them and check their requests (club-rules.js,
// #455); here, the signature check, finding the member, and the chips
// through the money model. club-server.js runs them, and the relay's
// Worker carries the requests (POST /club/<code>/service, relay/src/worker.js).
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

import * as ducy from '../wasm/ducy_wasm.js';
import { checkSignature, fromB64url, isPlayerId, parseShownId, playerIdFor, showId } from './identity.js';
import { ensureChips } from './club-chips.js';
import { startMoney } from './club-money.js';
import { rules } from './club-rules.js';

export const SKEW_MS = 5 * 60_000;
const ALGS = ['ed25519', 'p256'];

// An error with the HTTP status the relay answers with.
export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The service line a service's tool prints, as {alg, pub, id}; throws if it isn't one.
export async function parseServiceLine(line) {
  const m = String(line || '').trim().match(/^ducy-service:1:(ed25519|p256):([A-Za-z0-9_-]{40,200})$/);
  if (!m) throw new Error('That isn’t a service line: it starts with ducy-service:1:');
  let raw;
  try { raw = fromB64url(m[2]); } catch { throw new Error('That service line is damaged.'); }
  return {alg: m[1], pub: m[2], id: await playerIdFor(raw)};
}

export const serviceLine = ident => `ducy-service:1:${ident.alg}:${ident.pub}`;

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// Runs one of ducy-play's service ops (club_service: 'add', 'update',
// 'revoke', 'request'), all or nothing. Throws a ServiceError (the HTTP
// status to answer with) if refused, and nothing changes.
function service(club, op, args, now) {
  ensureChips(club);
  if (!club.money) startMoney(club, now);
  const r = ducy.clubService(JSON.stringify(club), op, JSON.stringify(args), now);
  if (!r.ok) throw new ServiceError(r.status, r.message);
  merge(club.members, r.club.members);
  club.money = r.club.money;
  Object.assign(club.chips, r.club.chips);
  club.log = r.club.log;
  club.services = merge(club.services || {}, r.club.services || {});
  return r.value;
}

// The owner adds a service: {line, name, perms, budget, perGive, perDay, expires}.
export async function addService(club, o, now = Date.now()) {
  const {alg, pub, id} = await parseServiceLine(o.line);
  const {line, ...limits} = o;
  service(club, 'add', {id, alg, key: pub, o: limits}, now);
  return club.services[id];
}

// The owner changes a service's limits; `addBudget` tops its budget up.
export function updateService(club, id, o, now = Date.now()) {
  service(club, 'update', {id, o: o || {}}, now);
  return club.services[id];
}

// Revoking: the key is forgotten at once. The record stays, for the history.
export function revokeService(club, id, now = Date.now()) {
  service(club, 'revoke', {id}, now);
}

// What the owner's page shows of each service.
export const servicesView = (club, now = Date.now()) => rules(club, {op: 'servicesView'}, now);

const refusal = r => new ServiceError(r.status, r.reason);

// Checks a request's envelope: its signature, that it's from an active
// service of this club, for this club, fresh, and not seen before. Returns
// the service. Throws a ServiceError; a refusal is counted in the club, so
// the caller saves it.
export async function checkRequest(club, env, now = Date.now()) {
  if (!env || typeof env !== 'object' || !isPlayerId(env.from) || !ALGS.includes(env.alg)) throw new ServiceError(400, 'Not a signed request.');
  const op = sig => ({op: 'checkService', from: env.from, alg: env.alg, key: String(env.pub ?? ''), seq: Math.max(0, Math.floor(Number(env.seq) || 0)), body: env.body ?? null, sig});
  let r = rules(club, op(null), now);
  // The key is the service's: the signature is checked, then the rest.
  if (r === false) r = rules(club, op((await checkSignature(env)) || ''), now);
  if (r?.refused) throw refusal(r.refused);
  return club.services[env.from];
}

// A member by their stored ID or the shown one ("ABCDE-FGHJ").
const memberId = (club, id) => (club.members[String(id)] ? String(id) : parseShownId(String(id ?? '')) || null);

// Runs a checked request from service `s` in one step (ducy-play's
// club_service): its status, the members, or chips given or taken back,
// logged, against its budget and once-only key. Returns {value, member}:
// the answer, and the member whose balance changed (if any), to tell them.
// Throws a ServiceError.
export function runRequest(club, s, body, now = Date.now()) {
  const r = service(club, 'request', {id: s.id, body: body ?? null, member: memberId(club, body?.args?.member)}, now);
  // The members, with the IDs people see.
  if (r.members) return {value: r.members.map(m => ({id: m.id, shownId: showId(m.id), name: m.name, balance: m.balance}))};
  return r.member ? {value: r.value, member: r.member} : {value: r.value};
}
