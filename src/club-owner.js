// The owner's page for an always-on club (#93). The club runs in its room on
// the relay (relay/src/club-room.js); this page connects to the room like a
// member, sends the host's actions as signed commands (owner_cmd), and keeps
// the latest signed view of the club (owner_view) to draw.
//
//   const owner = createOwner({identity, onChange, onNote});
//   owner.start()            reconnect to this browser's always-on club, if any
//   await owner.create(name) make one: a fresh room becomes the club
//   await owner.run(op, args)  a host action (club-server.js OPS); throws why not
//   owner.club, owner.view   the club and {seated, running, online}, or null
//
// Storage: {code, hostId, name}, the always-on club this browser owns (one
// for now), in localStorage (ducyClubRemote, read at once) and IndexedDB
// (table-store.js, written durably): losing it would cut the owner off
// from their club, and a browser that crashes can lose recent localStorage.

import { checkSignature, signMessage, Verifier } from './identity.js';
import { newKeyPair, open as openBox, sharedKey } from './e2e.js';
import { connect, newCode } from './play-net.js';
import { dropTable, getTable, putTable } from './table-store.js';

const KEY = 'ducyClubRemote';
const DB_KEY = ['owner', 'club'];
const RESULT_MS = 20_000;
const CREATE_MS = 15_000;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
function save(v) {
  try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {}
  return (v ? putTable(...DB_KEY, v) : dropTable(...DB_KEY)).catch(e => console.warn('club: owner record not saved:', e));
}

export function createOwner({identity, onChange = () => {}, onNote = () => {}}) {
  let rec = load();
  let net = null, online = false, view = null;
  let creating = null; // {name, resolve, reject} while asking a room to become the club
  const verifier = new Verifier();
  const waiting = new Map(); // command id → {resolve, reject, timer}
  // Watching a table (#125): this page's key pair for encrypted table
  // updates, the key shared with the club (for its key in aesFor), and the
  // function updates go to.
  const keys = newKeyPair();
  let aes = null, aesFor = '', watching = null;
  let nextId = 0;

  const sendSigned = async body => net?.send(await signMessage(identity, {club: rec?.code || creating?.code, ...body}));

  function connectTo(code) {
    net?.close();
    net = connect(code, 'guest', identity.id, {
      async onOpen() {
        online = true;
        if (creating?.attach) net.send(await signMessage(identity, {type: 'owner_hello', club: code, key: (await keys).pub}));
        else if (creating?.data) net.send(await signMessage(identity, {type: 'import_club', club: code, data: creating.data, senders: creating.senders}));
        else if (creating) net.send(await signMessage(identity, {type: 'create_club', club: code, name: creating.name}));
        else await sendSigned({type: 'owner_hello', key: (await keys).pub});
        onChange();
      },
      onMessage: m => receive(m).catch(e => console.warn(e)),
      onStatus(s) { online = !s; onChange(); },
      onFail(reason) {
        net = null;
        online = false;
        creating?.reject(new Error(reason));
        creating = null;
        onNote(reason);
        onChange();
      },
    }, {queue: true, persistent: true});
  }

  async function receive(m) {
    // A watched table's update, encrypted with the key shared with the club.
    // Anything else unsigned is ignored.
    if (m?.type === 'table' && !m.sig) {
      if (!watching || !aes || !m.enc) return;
      try { watching(await openBox(aes, m.enc)); } catch { console.warn('club: a table update didn’t decrypt; ignored'); }
      return;
    }
    if ((m?.type === 'club_created' || m?.type === 'club_imported') && creating) {
      rec = {code: creating.code, hostId: m.hostId, name: creating.name};
      await save(rec);
      // A club that moved here: as its old host, tell its members to follow
      // the club's new identity (#98).
      if (m.type === 'club_imported') await sendSigned({type: 'host_moved', hostId: m.hostId});
      creating.resolve(rec);
      creating = null;
      await sendSigned({type: 'owner_hello', key: (await keys).pub});
      return;
    }
    if (m?.type === 'club_error' && creating) {
      creating.reject(new Error(m.reason));
      creating = null;
      net?.close();
      net = null;
      return;
    }
    // Opening a club this player owns from another browser: the club's
    // first signed view, naming this player as owner, says who it is.
    if (creating?.attach && m?.body?.type === 'owner_view') {
      const d = m.body.data;
      if (m.body.club !== creating.code || d?.ownerId !== identity.id || d?.hostId !== m.from || await checkSignature(m)) return;
      rec = {code: creating.code, hostId: m.from, name: d.name};
      await save(rec);
      clearTimeout(creating.timer);
      creating.resolve(rec);
      creating = null;
    }
    // Everything else is signed by the club itself, in order.
    if (!rec || m?.from !== rec.hostId) return;
    const v = await verifier.verify(m);
    if (!v.ok || v.body?.club !== rec.code) return;
    const body = v.body;
    if (body.type === 'owner_view') {
      if (typeof body.hostKey === 'string' && body.hostKey !== aesFor) {
        const k = await keys;
        aes = await sharedKey(k, body.hostKey, {context: `club:${rec.code}`, hostId: rec.hostId, playerId: identity.id, hostPub: body.hostKey, playerPub: k.pub});
        aesFor = body.hostKey;
      }
      view = {seated: body.seated || {}, running: body.running || [], online: body.online || []};
      owner.club = body.data;
      onChange();
    } else if (body.type === 'owner_result') {
      const w = waiting.get(body.id);
      if (!w) return;
      waiting.delete(body.id);
      clearTimeout(w.timer);
      body.error ? w.reject(new Error(body.error)) : w.resolve(body.value);
    }
  }

  const owner = {
    club: null,
    get view() { return view; },
    get online() { return online; },
    get record() { return rec; },
    // Connects to this browser's always-on club, if it has one. Resolves to
    // whether it does (looking in IndexedDB when localStorage lost it).
    async start() {
      if (!rec) {
        const r = await getTable(...DB_KEY).catch(() => null);
        if (r?.code && r.hostId) { rec = {code: r.code, hostId: r.hostId, name: r.name}; save(rec); onChange(); }
      }
      if (rec && !net) connectTo(rec.code);
      return !!rec;
    },
    // The page is going away (or into the back/forward cache): disconnect;
    // start() connects again.
    stop() { net?.close(); net = null; online = false; },
    // Watches table `table`: its spectator updates go to onUpdate (#125).
    watch(table, onUpdate) {
      watching = onUpdate;
      return owner.run('watch', {table}).catch(e => { watching = null; throw e; });
    },
    unwatch() {
      if (!watching) return;
      watching = null;
      owner.run('unwatch').catch(() => {});
    },
    // Rejects if the relay doesn't answer in time, so the page can offer to
    // run the club in the browser instead (#134).
    create(name) {
      return new Promise((resolve, reject) => {
        const code = newCode();
        const timer = setTimeout(() => {
          if (creating?.code !== code) return;
          creating = null;
          owner.stop();
          reject(new Error('ducy’s server didn’t answer.'));
        }, CREATE_MS);
        const done = f => v => { clearTimeout(timer); f(v); };
        creating = {name, code, resolve: done(resolve), reject: done(reject)};
        connectTo(code);
      });
    },
    // Opens the always-on club with this code, owned by this player, from
    // this browser (e.g. after restoring the player ID from a backup).
    attach(code) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (creating?.attach) { creating = null; owner.stop(); }
          reject(new Error('No always-on club of yours has that code.'));
        }, 15_000);
        creating = {attach: true, code, resolve, reject, timer};
        connectTo(code);
      });
    },
    // Moves a browser-run club (club.js) to its room on the relay (#98),
    // keeping its code, so members' links and memberships carry on. `senders`
    // is its Verifier's state. This page must have stopped hosting it.
    moveHere(club, senders) {
      return new Promise((resolve, reject) => {
        creating = {name: club.name, code: club.code, data: club, senders, resolve, reject};
        connectTo(club.code);
      });
    },
    run(op, args = {}) {
      if (!net || !online) return Promise.reject(new Error('Not connected to the club right now; try again in a moment.'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('The club didn’t answer; try again.')); }, RESULT_MS);
        waiting.set(id, {resolve, reject, timer});
        sendSigned({type: 'owner_cmd', op, args, id}).catch(reject);
      });
    },
    // Stops running the club from this browser. The club itself keeps going
    // in its room; it can't be deleted yet (#98).
    forget() {
      net?.close();
      net = null;
      online = false;
      rec = null;
      view = null;
      owner.club = null;
      save(null);
    },
  };
  return owner;
}
