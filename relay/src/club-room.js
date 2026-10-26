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
//   hands, hand:<…>      finished hands, as the host saw them (#125)
//   seen                 when each player was last heard from, {id: ms} (#401)

import { checkSignature, createIdentity, exportIdentity, importIdentity, signMessage, Verifier } from '../../src/identity.js';
import { newClub } from '../../src/club.js';
import { ensureTables } from '../../src/club-tables.js';
import { createClubServer } from '../../src/club-server.js';
import { clubEngine } from '../../src/club-engine.js';
import { keyPairFromJSON, keyPairToJSON, newKeyPair } from '../../src/e2e.js';
import { FREE_LIMITS, removesAt } from './registry.js';

// How old a create request may be (its seq is at least the time it was signed).
const CREATE_WINDOW_MS = 5 * 60_000;
// Hands kept for the owner's history (#125); about 1–2 KB each.
const MAX_HANDS = 500;
// How often a player's last-seen time is saved (#401).
const SEEN_EVERY_MS = 60_000;
// Finished hands the admin page shows (#401).
const ADMIN_HANDS = 100;

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
  await claim(env.from, code, String(body.name || '').slice(0, 50));
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
  await claim(env.from, code, String(data.name || '').slice(0, 50));
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

// What anyone may learn from a club's code (GET /code/<code>, #393): that
// it's a club; and, only when it lets people ask to join with the code,
// its name and host ID, so they can. Nothing about its members or tables.
// With an `invite` token that's the club's (or an agent's): its About the
// club too (#398), for the invite screen.
export function codeInfo(club, invite = '') {
  const about = invite && club?.info?.about && (invite === club.invite || Object.values(club.members || {}).some(m => m.agent === 'yes' && m.agentInvite === invite))
    ? {about: String(club.info.about).slice(0, 2000)} : {};
  if (club?.codeJoin !== true) return {kind: 'club', ask: false, ...about};
  return {kind: 'club', ask: true, name: String(club.name || ''), hostId: club.hostId, ...about};
}

// A finished hand without its cards (#401): no one's hole cards, board or
// events (which name cards), unless the admin chose to see them.
const handNoCards = h => ({...h, board: [], board2: undefined, events: [], seats: (h.seats || []).map(s => ({...s, cards: null})), hidden: true});

// What the super admin sees of the club in `storage` (#401), read from
// storage, so the club needn't be opened:
//   'full'    everything it stores, read-only; the lobby chat and the
//             cards in finished hands only with `reveal`
//   'people'  each player it knows: [{id, name, status, role, agent,
//             balance, lastSeen}], the owner too
//   'person'  player `id`'s part in it: their member record, ledger
//             entries, chip requests, help requests and log lines
// null when the room holds no club.
export async function adminView(storage, what, {reveal = false, id = ''} = {}) {
  const club = await storage.get('club');
  if (!club) return null;
  const seen = (await storage.get('seen')) || {};
  const members = Object.values(club.members || {});
  const nameOf = mid => club.members?.[mid]?.name || '';
  if (what === 'people') {
    const people = members.map(m => ({id: m.id, name: m.name, status: m.status, role: m.role || null, agent: m.agent || null, balance: m.balance ?? 0, lastSeen: seen[m.id] || null}));
    if (club.ownerId && !club.members?.[club.ownerId]) people.push({id: club.ownerId, name: '', status: null, role: 'owner', balance: null, lastSeen: seen[club.ownerId] || null});
    return {name: club.name, people};
  }
  if (what === 'person') {
    const m = club.members?.[id] || null;
    const log = club.log || [];
    return {
      member: m && {...m, lastSeen: seen[id] || null},
      lastSeen: seen[id] || null,
      ledger: (club.chips?.ledger || []).filter(e => e.member === id),
      requests: (club.requestLog || []).filter(r => r.member === id),
      help: (club.help || []).filter(h => h.from === id),
      log: log.filter(e => e.by === id || (m?.name && String(e.text || '').includes(m.name))),
    };
  }
  const index = (await storage.get('hands')) || [];
  const hands = [];
  for (const h of index.slice(-ADMIN_HANDS).reverse()) {
    const rec = await storage.get(h.key);
    if (rec) hands.push(reveal ? rec : handNoCards(rec));
  }
  const {lobby, members: _, chips, promos, ...rest} = club;
  return {
    ...rest,
    members: members.map(m => ({...m, lastSeen: seen[m.id] || null})),
    ownerSeen: seen[club.ownerId] || null,
    chips: {issued: chips?.issued || 0, reclaimed: chips?.reclaimed || 0},
    ledger: (chips?.ledger || []).map(e => ({...e, name: nameOf(e.member)})),
    promos: promos && {...promos, hands: reveal ? promos.hands : undefined},
    hands,
    revealed: reveal,
    lobby: reveal ? lobby || [] : null,
    lobbyCount: (lobby || []).length,
  };
}

// The club server's plan and limits from its registry record (#265). An
// older club with no record keeps the free limits. `temporary` (#395):
// no backup of it proved yet.
function planOf(record) {
  const limits = record?.limits || FREE_LIMITS;
  return {limits: {...limits}, plan: record ? {plan: record.plan, expires: record.expires ?? null, temporary: !!record.temporary, provedAt: record.provedAt ?? null, removesAt: removesAt(record)} : null};
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
// `timers`: {set(fn, ms), clear(handle)} for the tables' clocks (#135); the
// Worker backs it with the room's alarm, the local relay uses plain timers.
// `record`: the club's record in the registry (registry.js, #265), for its
// plan and limits; server.setRecord(record) when the super admin changes it.
// `onProved(owner)`: the owner proved a backup works (#395, the
// backup_proved action); the caller records it in the registry and
// resolves to the club's new record.
export async function openClub({storage, send, online = [], MultiTable, onUsage = () => {}, onDeleted = () => {}, onSaved = () => {}, onProved = null, timers = null, record = null}) {
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
    const keys = ['club', 'identity', 'hostKey', 'verifier', 'memberPubs', 'handoff', 'playingSince', 'hands', 'seen', ...hands, ...(club.tables || []).map(t => `table:${t.id}`)];
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
  // Only the owner's signed owner_cmd reaches this (club-server.js).
  async function backupProved() {
    if (!onProved) throw new Error('ducy’s server can’t record that right now.');
    server.setRecord(await onProved(club.ownerId));
  }
  const server = createClubServer({
    identity, club, verifier,
    onChange: checkPlay,
    extraOps: {delete_club: deleteClub, hands, backup_proved: backupProved},
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
      ...(timers ? {timers} : {}),
    },
    hostKeyPair, memberPubs,
    onMemberKey: (id, pub) => { memberPubs[id] = pub; later(() => storage.put('memberPubs', {...memberPubs})); },
    ...planOf(record),
  });
  server.setRecord = rec => { const p = planOf(rec); server.setLimits(p.limits, p.plan); };
  // What the super admin sees of the club (#265): its shape and activity,
  // no one's cards or chats.
  server.adminInfo = async () => {
    const members = Object.values(club.members);
    const count = s => members.filter(m => m.status === s).length;
    const index = (await storage.get('hands')) || [];
    const day = Date.now() - 864e5;
    return {
      name: club.name, ownerId: club.ownerId, createdAt: club.createdAt,
      members: {member: count('member'), pending: count('pending'), online: server.online.size, seated: members.filter(m => m.seat).length},
      tables: (club.tables || []).filter(t => t.status !== 'closed').map(t => ({name: t.name, game: t.game, sb: t.sb, bb: t.bb, seats: t.seats, status: t.status, running: server.running(t.id), seated: server.seatedCounts()[t.id] || 0})),
      tourneys: (club.tourneys || []).filter(t => ['scheduled', 'running'].includes(t.status) || Date.now() - (t.endedAt || 0) < 7 * 864e5)
        .map(t => ({name: t.name, game: t.game, status: t.status, startsAt: t.startsAt, entries: t.entries.length})),
      hands: {kept: index.length, lastDay: index.filter(h => h.at >= day).length, last: index.length ? index[index.length - 1].at : null},
      ledger: (club.chips?.ledger || []).slice(-15).map(e => ({at: e.at, kind: e.kind, amount: e.amount, member: club.members[e.member]?.name || e.member})),
      limits: server.limits(),
    };
  };
  // A club that moved here from a browser (#98): its old host's handoff,
  // which members need before they'll accept this room's messages. It's
  // kept, and given to everyone as they connect.
  let handoff = (await storage.get('handoff')) || null;
  // When each player was last heard from, for the admin page's People
  // (#401): saved at most once a minute per player.
  const seen = (await storage.get('seen')) || {};
  const noteSeen = id => {
    if (typeof id !== 'string' || Date.now() - (seen[id] || 0) < SEEN_EVERY_MS) return;
    seen[id] = Date.now();
    later(() => storage.put('seen', {...seen}));
  };
  const message = server.message;
  server.message = async msg => {
    noteSeen(msg?.from);
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
