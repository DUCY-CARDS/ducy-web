// A club connection's passkey unlock (#575), as rooms check it: the Worker
// (worker.js, kept on the socket so it lasts through hibernation) and the
// local relay (dev-server.mjs).
//
// A club connection can't act until it's unlocked: the page signs in with
// its passkey (passkeys.js) and sends {type: 'unlock', token}; the room asks
// the relay's passkeys whether that session is live and this player's, and
// answers {type: 'unlocked', at} or {type: 'locked', reason}. Anything else
// from a connection that isn't unlocked, or that has been idle IDLE_MS, is
// dropped with {type: 'locked'}. A message that moves chips also needs the
// sign-in to be under FRESH_MS old, or it's dropped with
// {type: 'unlock_again'}. Heartbeats aren't messages to the club and pass.
//
// Friends tables and browser-run clubs (a host's tab) aren't gated: only a
// room that runs a club, or is asked to become one, checks.

import { FRESH_MS, IDLE_MS } from './passkeys.js';
import { managerOnly, movesChips } from '../../src/chip-moves.js';

export { managerOnly, movesChips };

// How often a connection's session is checked again, so a passkey removed
// (a lost device) stops its connections too.
export const RECHECK_MS = 5 * 60_000;

// What to do with message `m` (parsed) from a connection whose unlock is
// `u` ({token, at, origin, seen, checked} or null): 'unlock' (it's an unlock: check
// its token), 'recheck' (check u.token again, then gate it again),
// 'locked' or 'unlock_again' (drop it and say so), or '' (let it through;
// `u.seen` is then updated by the caller).
export function gate(m, u, now = Date.now()) {
  if (m?.type === 'unlock') return 'unlock';
  if (!u || now - u.seen > IDLE_MS) return 'locked';
  if (now - u.checked > RECHECK_MS) return 'recheck';
  if (movesChips(m) && now - u.at > FRESH_MS) return 'unlock_again';
  return '';
}

// Whether a connection with unlock `u` is unlocked now, without counting
// as activity or checking its session again: for a reading the page sends
// on its own (a location, #581), which mustn't keep an idle connection
// unlocked. Such a message from a connection that isn't is dropped quietly.
// Whether message `m`, unlocked as `u`, may go on from a connection whose
// page is `origin` (#637): running a club (managerOnly: making or moving
// one, the owner's connection and commands, an agent's commands) only from
// a club site, `clubOrigins`, with a session made there too. With none
// (a local relay), anywhere.
export function siteOk(m, u, origin, clubOrigins = []) {
  if (!clubOrigins.length || !managerOnly(m)) return true;
  return clubOrigins.includes(origin) && clubOrigins.includes(u?.origin);
}
export const CLUB_SITE_REPLY = {type: 'club_site', reason: 'Clubs are run on the club site.'};

export const unlockedNow =(u, now = Date.now()) => !!u && now - u.seen <= IDLE_MS && now - u.checked <= RECHECK_MS;

// Runs the gate for message `m` from player `id`: `u` is the connection's
// unlock, `session(token)` the relay's check ({id, at, movedFrom, origin}
// or null). Resolves to {pass, u (the unlock to keep, or null), reply (to
// send back, or null), movedFrom}.
export async function check(m, u, id, session, now = Date.now()) {
  let g = gate(m, u, now);
  if (g === 'unlock' || g === 'recheck') {
    const token = g === 'unlock' ? String(m.token || '') : u.token;
    const s = await session(token).catch(() => null);
    if (!s || s.id !== id) return {pass: false, u: null, reply: {type: 'locked', reason: 'Unlock with your passkey.'}};
    // `origin`: the page the session was made on (#637: club sites only
    // run clubs).
    u = {token, at: s.at, origin: s.origin || '', seen: now, checked: now};
    if (g === 'unlock') return {pass: false, u, reply: {type: 'unlocked', at: s.at}, movedFrom: s.movedFrom || null};
    g = gate(m, u, now);
  }
  if (g === 'locked') return {pass: false, u: null, reply: {type: 'locked', reason: 'Unlock with your passkey.'}};
  if (g === 'unlock_again') return {pass: false, u, reply: {type: 'unlock_again', reason: 'Unlock with your passkey again to move chips.'}};
  return {pass: true, u: {...u, seen: now}, reply: null};
}
