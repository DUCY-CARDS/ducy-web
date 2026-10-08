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

import { checkSignature, createIdentity, exportIdentity, importIdentity, signMessage, Verifier } from '../../src/identity.js';
import { newClub } from '../../src/club.js';
import { ensureTables } from '../../src/club-tables.js';
import { createClubServer } from '../../src/club-server.js';
import { clubEngine } from '../../src/club-engine.js';
import { keyPairFromJSON, keyPairToJSON, newKeyPair } from '../../src/e2e.js';

// How old a create request may be (its seq is at least the time it was signed).
const CREATE_WINDOW_MS = 5 * 60_000;
// Hands kept for the owner's history (#125); about 1–2 KB each.
const MAX_HANDS = 500;

// A signed request to create an always-on club in room `code`:
// {type: 'create_club', club: code, name}. Returns {hostId, invite}, or
// throws why not. The room must be empty: the caller checks there's no host
// and no one else in it. `claim(owner, code)` asks the relay's registry
// (registry.js) whether this owner may have another club, and throws if not.
export async function createClub(storage, env, code, claim = async () => {}) {
  if (await storage.get('club')) throw new Error('That club code is in use.');
  if (await checkSignature(env)) throw new Error('The request isn’t signed properly.');
  const body = env.body || {};
  if (body.type !== 'create_club' || body.club !== code) throw new Error('Not a request for this club.');
  if (Math.abs(Date.now() - Number(env.seq)) > CREATE_WINDOW_MS) throw new Error('The request is too old; try again.');
  await claim(env.from, code);
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

// A browser-run club moving here (#98): {type: 'import_club', club: code,
// data, senders}, signed by the club's host (data.hostId), with its club
// (club.js) and its Verifier's senders. No one may be at a table. The club
// gets its own signing identity here, the host becomes its owner, and the
// members' keys and message counters carry over. Returns {hostId}: the host
// then signs a host_moved for it (see openClub), so members follow.
// `claim` as for createClub.
export async function importClub(storage, env, code, claim = async () => {}) {
  if (await storage.get('club')) throw new Error('That club is already on the server.');
  if (await checkSignature(env)) throw new Error('The request isn’t signed properly.');
  const body = env.body || {};
  const data = body.data;
  if (body.type !== 'import_club' || body.club !== code || data?.code !== code) throw new Error('Not a request for this club.');
  if (Math.abs(Date.now() - Number(env.seq)) > CREATE_WINDOW_MS) throw new Error('The request is too old; try again.');
  if (data.hostId !== env.from) throw new Error('Only the club’s host can move it.');
  if (!data.members || typeof data.members !== 'object' || !data.chips) throw new Error('That isn’t a club.');
  if (Object.values(data.members).some(m => m?.seat)) throw new Error('People are still at tables. Close the tables first.');
  await claim(env.from, code);
  const identity = await createIdentity();
  const club = {...data, hostId: identity.id, ownerId: env.from, alwaysOn: true};
  ensureTables(club);
  const hostKey = await newKeyPair({keep: true});
  await storage.put('identity', await exportIdentity(identity));
  await storage.put('hostKey', await keyPairToJSON(hostKey));
  await storage.put('verifier', body.senders && typeof body.senders === 'object' ? body.senders : {});
  await storage.put('memberPubs', {});
  await storage.put('club', club);
  return {hostId: identity.id};
}

// Is `env` the old host's signed handoff to this club's identity (#98)?
async function isHandoff(club, env) {
  const b = env?.body;
  return b?.type === 'host_moved' && b.club === club.code && b.hostId === club.hostId
    && env.from === club.ownerId && !(await checkSignature(env));
}

// Opens the club in this room, if there is one: a running club server
// (club-server.js), with `online` (the member IDs connected now) told it's
// open. `send(to, data)` delivers to a member's connections; `MultiTable` is
// the initialised engine. Returns null when the room isn't a club.
// `onUsage(minutes)`: the club's tables were in play that long (registry.js
// counts it against the free plan). `onDeleted()`: the owner deleted the
// club and its storage is gone; the caller drops the server and its
// connections. `onSaved()`: the club was saved (the caller may back it up,
// backup.js).
export async function openClub({storage, send, online = [], MultiTable, onUsage = () => {}, onDeleted = () => {}, onSaved = () => {}}) {
  const club = await storage.get('club');
  if (!club) return null;
  const identity = await importIdentity(await storage.get('identity'));
  const verifier = new Verifier((await storage.get('verifier')) || {});
  const hostKeyPair = await keyPairFromJSON(await storage.get('hostKey'));
  const memberPubs = (await storage.get('memberPubs')) || {};
  const engine = clubEngine(MultiTable);
  // Saves go out in order, one at a time.
  let saving = Promise.resolve();
  // Once the club is deleted nothing more is saved, so it can't come back.
  let deleted = false;
  const later = fn => { saving = saving.then(() => (deleted ? null : fn())).catch(e => console.warn('club: not saved:', e)); return saving; };
  // Usage (#98): from when someone sits at a table until no one is seated.
  // Kept in storage, so it survives the room restarting meanwhile.
  let playingSince = (await storage.get('playingSince')) ?? null;
  function checkPlay() {
    const seated = Object.values(club.members).some(m => m.seat);
    if (seated && playingSince == null) {
      playingSince = Date.now();
      later(() => storage.put('playingSince', playingSince));
    } else if (!seated && playingSince != null) {
      const minutes = (Date.now() - playingSince) / 60_000;
      playingSince = null;
      later(() => storage.delete('playingSince'));
      Promise.resolve(onUsage(minutes)).catch(e => console.warn('club: usage not reported:', e));
    }
  }
  // The owner deletes the club: members are told, and its storage goes.
  async function deleteClub() {
    if (Object.values(club.members).some(m => m.seat)) throw new Error('People are still at tables. Close the tables first.');
    for (const [id, m] of Object.entries(club.members)) {
      if (m.status === 'member' || m.status === 'pending') send(id, await signMessage(identity, {type: 'status', club: club.code, name: club.name, status: 'closed'}));
    }
    deleted = true;
    await saving;
    const hands = ((await storage.get('hands')) || []).map(h => h.key);
    const keys = ['club', 'identity', 'hostKey', 'verifier', 'memberPubs', 'handoff', 'playingSince', 'hands', ...hands, ...(club.tables || []).map(t => `table:${t.id}`)];
    for (const k of keys) await storage.delete(k);
    await onDeleted();
  }
  // The host's hand history (#71, #125): each finished hand as the host sees
  // it (no hidden cards), under its own key, with an index of {key, at}.
  // Kept for the club's days, and at most MAX_HANDS.
  async function storeHand(rec, {days}) {
    const key = `hand:${String(rec.at || Date.now()).padStart(15, '0')}:${Math.random().toString(36).slice(2, 8)}`;
    const index = (await storage.get('hands')) || [];
    index.push({key, at: rec.at || Date.now()});
    const keep = index.filter(h => Date.now() - h.at < days * 864e5).slice(-MAX_HANDS);
    const drop = index.filter(h => !keep.includes(h));
    await later(async () => {
      await storage.put(key, {...rec, id: key});
      await storage.put('hands', keep);
      for (const h of drop) await storage.delete(h.key);
    });
  }
  // The newest `limit` hands, for the owner's page.
  async function hands({limit = 100} = {}) {
    const index = (await storage.get('hands')) || [];
    const out = [];
    for (const h of index.slice(-Math.min(Math.max(1, Number(limit) || 100), 200)).reverse()) {
      const rec = await storage.get(h.key);
      if (rec) out.push(rec);
    }
    return out;
  }
  const server = createClubServer({
    identity, club, verifier,
    onChange: checkPlay,
    extraOps: {delete_club: deleteClub, hands},
    storeHand,
    persist: () => later(() => Promise.all([storage.put('club', club), storage.put('verifier', verifier.toJSON())])).then(() => onSaved()),
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
  // A club that moved here from a browser (#98): its old host's handoff,
  // which members need before they'll accept this room's messages. It's
  // kept, and given to everyone as they connect.
  let handoff = (await storage.get('handoff')) || null;
  const message = server.message;
  server.message = async msg => {
    if (msg?.event === 'open' && handoff) send(msg.from, handoff);
    if (msg?.data?.body?.type === 'host_moved') {
      if (!handoff && msg.from === club.ownerId && await isHandoff(club, msg.data)) {
        handoff = msg.data;
        await later(() => storage.put('handoff', handoff));
        for (const id of server.online) send(id, handoff);
      }
      return;
    }
    return message(msg);
  };
  await server.relayOpen();
  for (const id of online) await server.message({from: id, event: 'open'});
  server.flush = () => saving;
  return server;
}
