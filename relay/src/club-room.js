// An always-on club (#93): its room on the relay is its host. The room runs
// the same host code as a host's tab (src/club-server.js, with the engine
// from src/club-engine.js) and keeps everything in the room's storage, so
// the club goes on with no browser open, and picks up where it was after
// the room restarts (e.g. after hibernating while no one plays).
//
// Shared by the Cloudflare Worker (worker.js, Durable Object storage) and
// the local relay (dev-server.mjs, in memory).
//
// storage: {get(key), put(key, value), delete(key)}, async, JSON-like values:
//   club, verifier       the club (club.js) and its Verifier's senders
//   identity             the club's signing identity (identity.js export):
//                        players check every message against its ID
//   hostKey              its key pair for encrypted table updates (e2e.js)
//   memberPubs           members' public keys for those, {id: pub}
//   table:<id>           a table saved mid-hand (club-host.js)

import { checkSignature, createIdentity, exportIdentity, importIdentity, Verifier } from '../../src/identity.js';
import { newClub } from '../../src/club.js';
import { ensureTables } from '../../src/club-tables.js';
import { createClubServer } from '../../src/club-server.js';
import { clubEngine } from '../../src/club-engine.js';
import { keyPairFromJSON, keyPairToJSON, newKeyPair } from '../../src/e2e.js';

// How old a create request may be (its seq is at least the time it was signed).
const CREATE_WINDOW_MS = 5 * 60_000;

// A signed request to create an always-on club in room `code`:
// {type: 'create_club', club: code, name}. Returns {hostId, invite}, or
// throws why not. The room must be empty: the caller checks there's no host
// and no one else in it.
export async function createClub(storage, env, code) {
  if (await storage.get('club')) throw new Error('That club code is in use.');
  if (await checkSignature(env)) throw new Error('The request isn’t signed properly.');
  const body = env.body || {};
  if (body.type !== 'create_club' || body.club !== code) throw new Error('Not a request for this club.');
  if (Math.abs(Date.now() - Number(env.seq)) > CREATE_WINDOW_MS) throw new Error('The request is too old; try again.');
  const identity = await createIdentity();
  const club = newClub(body.name, code, identity.id);
  club.ownerId = env.from;
  club.alwaysOn = true;
  ensureTables(club);
  const hostKey = await newKeyPair({keep: true});
  await storage.put('identity', await exportIdentity(identity));
  await storage.put('hostKey', await keyPairToJSON(hostKey));
  await storage.put('verifier', {});
  await storage.put('memberPubs', {});
  await storage.put('club', club);
  return {hostId: identity.id, invite: club.invite};
}

// Opens the club in this room, if there is one: a running club server
// (club-server.js), with `online` (the member IDs connected now) told it's
// open. `send(to, data)` delivers to a member's connections; `MultiTable` is
// the initialised engine. Returns null when the room isn't a club.
export async function openClub({storage, send, online = [], MultiTable}) {
  const club = await storage.get('club');
  if (!club) return null;
  const identity = await importIdentity(await storage.get('identity'));
  const verifier = new Verifier((await storage.get('verifier')) || {});
  const hostKeyPair = await keyPairFromJSON(await storage.get('hostKey'));
  const memberPubs = (await storage.get('memberPubs')) || {};
  const engine = clubEngine(MultiTable);
  // Saves go out in order, one at a time.
  let saving = Promise.resolve();
  const later = fn => { saving = saving.then(fn).catch(e => console.warn('club: not saved:', e)); return saving; };
  const server = createClubServer({
    identity, club, verifier,
    persist: () => later(() => Promise.all([storage.put('club', club), storage.put('verifier', verifier.toJSON())])),
    transport: {send, ack() {}},
    engine: {
      call: async (op, ...args) => engine.ops[op](...args),
      store: {
        get: async (code, tid) => (await storage.get(`table:${tid}`)) ?? null,
        put: (code, tid, rec) => later(() => storage.put(`table:${tid}`, rec)),
        drop: (code, tid) => later(() => storage.delete(`table:${tid}`)),
      },
    },
    hostKeyPair, memberPubs,
    onMemberKey: (id, pub) => { memberPubs[id] = pub; later(() => storage.put('memberPubs', {...memberPubs})); },
  });
  await server.relayOpen();
  for (const id of online) await server.message({from: id, event: 'open'});
  server.flush = () => saving;
  return server;
}
