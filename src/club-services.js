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

import { checkSignature, fromB64url, isPlayerId, parseShownId, playerIdFor, showId } from './identity.js';
import { issue, reclaim, ensureChips } from './club-chips.js';
import { logAction } from './club-log.js';
import { rules } from './club-rules.js';
import { CHIP_SCALE, chipText } from './chip-format.js';

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

// The owner adds a service: {line, name, perms, budget, perGive, perDay, expires}.
export async function addService(club, o, now = Date.now()) {
  const {alg, pub, id} = await parseServiceLine(o.line);
  const {line, ...limits} = o;
  const s = rules(club, {op: 'addService', id, alg, key: pub, o: limits}, now);
  logAction(club, club.ownerId, `Added the service ${s.name}`, now);
  return club.services[id];
}

// The owner changes a service's limits; `addBudget` tops its budget up.
export function updateService(club, id, o, now = Date.now()) {
  const s = rules(club, {op: 'updateService', id, o: o || {}}, now);
  const add = Number(o?.addBudget || 0);
  logAction(club, club.ownerId, add ? `Added ${chipText(add)} to ${s.name}’s budget` : `Changed ${s.name}’s limits`, now);
  return club.services[id];
}

// Revoking: the key is forgotten at once. The record stays, for the history.
export function revokeService(club, id, now = Date.now()) {
  const s = rules(club, {op: 'revokeService', id}, now);
  logAction(club, club.ownerId, `Revoked the service ${s.name}`, now);
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

const inChips = n => n / CHIP_SCALE;

// Runs a checked request from service `s`. Returns {value, member}: the
// answer, and the member whose balance changed (if any), to tell them.
export function runRequest(club, s, body, now = Date.now()) {
  ensureChips(club);
  const r = rules(club, {op: 'prepareService', id: s.id, body: body ?? null, member: memberId(club, body?.args?.member)}, now);
  if (r.refused) throw refusal(r.refused);
  if (r.value) return {value: r.value};
  if (r === 'members') {
    return {value: Object.values(club.members).filter(m => m.status === 'member').map(m => ({id: m.id, shownId: showId(m.id), name: m.name, balance: inChips(m.balance)}))};
  }
  const {op, member, amount, note, said, key} = r.move;
  const m = club.members[member], name = club.services[s.id].name;
  let entry;
  if (op === 'give') {
    entry = issue(club, member, amount, now, note);
    logAction(club, s.id, `${name} (service) gave ${m.name} ${chipText(amount)}${said ? `: ${said}` : ''}`, now, amount);
  } else {
    try {
      entry = reclaim(club, member, amount, now, note);
    } catch (e) {
      throw new ServiceError(409, e.message);
    }
    logAction(club, s.id, `${name} (service) took back ${chipText(amount)} from ${m.name}${said ? `: ${said}` : ''}`, now, amount);
  }
  const budget = op === 'give' ? club.services[s.id].budget - amount : club.services[s.id].budget;
  const value = {op, member, amount: inChips(amount), balance: inChips(m.balance), entry: entry.n, budget: inChips(budget)};
  rules(club, {op: 'serviceDone', id: s.id, do: op, amount, key: key ?? null, value}, now);
  return {value, member};
}
