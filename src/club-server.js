// The host side of a club: the members' signed messages, the club's tables,
// encrypted table updates, assistants' and agents' commands, and everything
// the host can do (`run`). It runs wherever the club lives: today the host's
// tab (clubs.js), and for an always-on club the relay's Worker (#93). No
// page, no storage of its own: the caller passes in how to save and send.
//
//   const server = createClubServer({identity, club, verifier, persist, transport, ...});
//   server.relayOpen()        the relay accepted us as host: tables start
//   server.message(msg)       a message from the relay ({from, data} or {from, event})
//   server.run(op, args)      a host action (see OPS); throws why not
//
// Options:
//   identity       the club's signing identity (identity.js); players check
//                  every message against the host ID in their invite
//   club, verifier the club (club.js) and its Verifier, changed in place
//   persist()      the club or verifier changed: save them
//   transport      {send(to, data), ack(n)}: the relay connection
//   onChange()     something the host's view shows changed
//   storeHand(rec, {days})  a finished hand, for the host's history (#71)
//   engine         {call, store} for the tables (club-host.js); defaults to
//                  the page's worker and IndexedDB
//   hostKeyPair    the host's key pair for encrypted table updates (e2e.js);
//                  by default a fresh one for this session
//   memberPubs     members' public keys already known ({id: pub}), and
//   onMemberKey(id, pub)  a member sent a new one: an always-on club keeps
//                  them, so it can carry on after its object restarts
//   extraOps       more host actions {op: fn(args)}, where only the club's
//                  home can do them
//
// An always-on club (#93) has an owner (club.ownerId) who runs it from their
// page: they send the same host actions signed (owner_cmd), get each result
// (owner_result), and get the whole club after every change (owner_view).

import { signMessage } from './identity.js';
import { account, approve, decline, hostReceive, removeMember, revokeInvite } from './club.js';
import { declineRequest, grantRequest, issue, reclaim } from './club-chips.js';
import { cashOutEveryone, ensureTables, newTable, openTables, tableById, tablesBody } from './club-tables.js';
import { createTableHost } from './club-host.js';
import { adminBody, answerRole, isAssistant, offerAssistant, revokeRole, runAdmin } from './club-roles.js';
import {
  agentBody, answerAgent, assignToAgent, isAgent, offerAgent, revokeAgent, runAgent, setCreditLimit, settle,
} from './club-agents.js';
import { handRecord } from './hand-replay.js';
import { isPublicKey, newKeyPair, seal, sharedKey } from './e2e.js';
import { HOST_KEEP_DAYS } from './hand-store.js';

// A host's settings and what each may be.
const SETTINGS = {
  ratholeHours: n => Number.isSafeInteger(n) && n >= 0 && n <= 24 * 30,
  sitOutMins: n => Number.isSafeInteger(n) && n >= 0 && n <= 240,
  keepDays: n => Number.isSafeInteger(n) && n >= 1 && n <= 3650,
};

export function createClubServer({
  identity, club, verifier, persist, transport, onChange = () => {}, storeHand = () => {}, engine = {},
  hostKeyPair = null, memberPubs = {}, onMemberKey = () => {}, extraOps = {},
}) {
  const online = new Set(); // members connected now
  let tableHost = null;
  let linkOk = true;
  // Encrypted table updates (e2e.js): the host's key pair for this session,
  // and per member {pub, key, sends} (their public key, the shared AES key,
  // and a queue that keeps their updates in order).
  let hostKeysP = hostKeyPair ? Promise.resolve(hostKeyPair) : null;
  const hostKeys = () => (hostKeysP ||= newKeyPair());
  const memberKeys = new Map();
  const keysReady = Promise.all(Object.entries(memberPubs).map(([id, pub]) => memberKey(id, pub, false)));

  function changed() {
    persist();
    scheduleAdmin();
    onChange();
  }

  // A member sent their session key (with join or hello): derive the shared key.
  async function memberKey(id, pub, isNew = true) {
    if (!isPublicKey(pub) || memberKeys.get(id)?.pub === pub) return;
    if (isNew) onMemberKey(id, pub);
    const hk = await hostKeys();
    const key = await sharedKey(hk, pub, {context: `club:${club.code}`, hostId: club.hostId, playerId: id, hostPub: hk.pub, playerPub: pub});
    memberKeys.set(id, {pub, key, sends: memberKeys.get(id)?.sends || Promise.resolve()});
  }

  // A table update for member `to`, encrypted to them. Without their key it
  // isn't sent at all: nothing goes over the relay in the clear.
  function sendSealed(to, msg) {
    const k = memberKeys.get(to);
    if (!k) { console.warn('club: no key for', to, '- table update not sent'); return; }
    k.sends = k.sends.then(async () => {
      transport.send(to, {type: 'table', table: msg.table, enc: await seal(k.key, msg.update)});
    }).catch(e => console.warn(e));
  }

  // Signed messages go out one at a time, in order: a player ignores anything
  // with a lower sequence number than one it has seen.
  let sends = Promise.resolve();
  function sendToPlayer(rep) {
    if (!rep) return sends;
    // Whoever gets the tables gets the host's key first, so they can read the
    // encrypted updates once they sit down.
    if (rep.body?.type === 'tables') {
      sends = sends.then(async () => {
        transport.send(rep.to, await signMessage(identity, {type: 'host_key', club: club.code, key: (await hostKeys()).pub}));
      }).catch(e => console.warn(e));
    }
    sends = sends.then(async () => transport.send(rep.to, await signMessage(identity, rep.body))).catch(e => console.warn(e));
    return sends;
  }

  // Assistants (#62) see the club change as it happens: after any change, the
  // online ones get a fresh view (at most every 200 ms); agents (#75) their
  // account and players.
  let adminTimer = null;
  function scheduleAdmin() {
    if (adminTimer) return;
    adminTimer = setTimeout(() => {
      adminTimer = null;
      const body = adminBody(club, seatedCounts());
      for (const id of online) if (isAssistant(club, id)) sendToPlayer({to: id, body});
      for (const id of online) if (isAgent(club, id)) sendToPlayer({to: id, body: agentBody(club, id)});
      sendOwnerView();
    }, 200);
  }

  // An always-on club's owner sees the whole club, as their page's copy.
  // It carries the club's key for encrypted table updates, for watching a
  // table (#125).
  async function sendOwnerView() {
    if (!club.ownerId || !online.has(club.ownerId)) return;
    const running = (club.tables || []).filter(t => tableHost?.running(t.id)).map(t => t.id);
    // A copy: signing waits on WebCrypto, and the club may change before the
    // view is sent, which would no longer match its signature.
    const data = JSON.parse(JSON.stringify(club));
    const hostKey = (await hostKeys()).pub;
    sendToPlayer({to: club.ownerId, body: {type: 'owner_view', club: club.code, data, seated: seatedCounts(), running, online: [...online], hostKey}});
  }

  // The owner watching a table (#73, #125): its spectator view, encrypted to
  // them like a member's table updates.
  let stopWatch = null;
  function unwatch() { stopWatch?.(); stopWatch = null; }

  // The owner's check-in, or one of their host actions (run): they get the
  // result, then the club as it is now.
  async function handleOwner({type, from, body}) {
    if (type === 'owner_cmd') {
      let error = '', value = null;
      try { value = (await run(String(body.op), body.args && typeof body.args === 'object' ? body.args : {})) ?? null; } catch (e) { error = e.message || String(e); }
      // Results are plain data (e.g. the list of hands, #125).
      value = value === undefined ? null : JSON.parse(JSON.stringify(value));
      await sendToPlayer({to: from, body: {type: 'owner_result', club: club.code, id: body.id ?? null, error, value}});
    }
    sendOwnerView();
  }

  const seatedCounts = () => tableHost?.seatedCounts() || {};

  function broadcastTables() {
    if (!tableHost) return;
    const body = tablesBody(club, seatedCounts());
    for (const id of online) if (club.members[id]?.status === 'member') sendToPlayer({to: id, body});
  }

  const started = p => p.then(() => { broadcastTables(); onChange(); });

  // The club's tables (#68). Starting means any tables that were running
  // stopped. Open and closing tables saved with a hand in progress resume it
  // (#107, #117, club-host.js; a closing one then closes after the hand);
  // everyone seated anywhere else is cashed out first (club-tables.js).
  function startTables() {
    if (tableHost) return;
    ensureTables(club);
    const live = openTables(club).filter(t => t.status === 'open' || t.status === 'closing');
    if (cashOutEveryone(club, Date.now(), new Set(live.map(t => t.id))).length) persist();
    tableHost = createTableHost({
      club: () => club,
      save: () => { persist(); scheduleAdmin(); onChange(); },
      sendTable: sendSealed,
      chipsChanged: id => {
        const n = club.chips.ledger.filter(e => e.member === id).at(-1)?.n;
        sendToPlayer(account(club, id, n ? n - 1 : Infinity));
      },
      tablesChanged: () => { broadcastTables(); onChange(); },
      online: id => online.has(id),
      onHand: (tid, view) => {
        const t = tableById(club, tid);
        storeHand(handRecord({club: club.code, table: tid, tableName: t?.name || '', game: t?.game || '', view, who: 'host'}),
          {days: club.keepDays ?? HOST_KEEP_DAYS});
      },
      ...engine,
    });
    tableHost.setLink(linkOk);
    for (const t of live) started(tableHost.start(t, {resume: true}));
  }

  // A role answer, or an assistant's or agent's command, already verified as from `from`.
  function handleAdmin({type, from, body}) {
    if (type === 'role_reply' || type === 'agent_reply') {
      const r = (type === 'role_reply' ? answerRole : answerAgent)(club, from, !!body.accept);
      if (r) sendToPlayer(r);
      return;
    }
    try {
      const r = (type === 'agent_cmd' ? runAgent : runAdmin)(club, from, body.cmd);
      for (const rep of r.replies) sendToPlayer(rep);
      if (r.approved && tableHost) sendToPlayer({to: r.approved, body: tablesBody(club, seatedCounts())});
      if (r.table?.start && tableHost) started(tableHost.start(r.table.start));
      if (r.table?.close) tableHost ? tableHost.close(r.table.close) : (tableById(club, r.table.close).status = 'closed');
      if (r.table) broadcastTables();
      sendToPlayer({to: from, body: {type: 'admin_result', club: club.code, error: ''}});
    } catch (e) {
      sendToPlayer({to: from, body: {type: 'admin_result', club: club.code, error: e.message}});
    }
  }

  // A message from the relay: a member connecting or leaving, or their signed message.
  async function message(msg) {
    if (!msg || !msg.from) return;
    if (msg.event === 'open') { online.add(msg.from); tableHost?.presence(msg.from); return; }
    if (msg.event === 'close') {
      online.delete(msg.from);
      if (msg.from === club.ownerId) unwatch();
      tableHost?.disconnected(msg.from);
      tableHost?.presence(msg.from);
      return;
    }
    if (!('data' in msg)) return;
    await keysReady;
    const r = await hostReceive(club, verifier, msg.data);
    if (msg.queued) transport.ack(msg.queued);
    if (r.reason && r.reason !== 'replayed') console.warn('club: refused a message:', r.reason);
    // A verified message from this member may carry their session key.
    const verified = !['malformed', 'bad signature', 'id does not match key', 'id in use', 'replayed'].includes(r.reason);
    if (verified && msg.data?.from === msg.from && msg.data?.body?.key) await memberKey(msg.from, msg.data.body.key);
    for (const rep of r.replies) sendToPlayer(rep);
    // A table command, from the member who signed it (the relay's sender id
    // must match, so no one can act for someone else). No one is seated
    // without a key: their cards would have to cross the relay in the clear.
    if (r.table && r.table.from === msg.from) {
      if (r.table.cmd?.type === 'join' && !memberKeys.has(msg.from)) {
        sendToPlayer({to: msg.from, body: {type: 'table_error', club: club.code, table: r.table.id, reason: 'This page couldn’t set up encryption with the host. Reload and try again.'}});
      } else tableHost?.handle(r.table.id, r.table.from, r.table.cmd);
    }
    if (r.admin && r.admin.from === msg.from) { handleAdmin(r.admin); changed(); return; }
    if (r.owner && r.owner.from === msg.from) { await handleOwner(r.owner); return; }
    const m = club.members[msg.from];
    if (msg.data?.body?.type === 'hello' && m?.status === 'member') {
      // Members checking in get the tables, the host's key for encrypted
      // table updates, their role, and an assistant or agent their view.
      if (tableHost) sendToPlayer({to: msg.from, body: tablesBody(club, seatedCounts())});
      sendToPlayer({to: msg.from, body: {type: 'host_key', club: club.code, key: (await hostKeys()).pub}});
      if (m.role) sendToPlayer({to: msg.from, body: {type: 'role', club: club.code, role: m.role}});
      if (isAssistant(club, msg.from)) sendToPlayer({to: msg.from, body: adminBody(club, seatedCounts())});
      if (m.agent) sendToPlayer({to: msg.from, body: {type: 'agent_role', club: club.code, agent: m.agent, creditLimit: m.creditLimit || 0}});
      if (isAgent(club, msg.from)) sendToPlayer({to: msg.from, body: agentBody(club, msg.from)});
    }
    if (r.changed || r.replies.length) changed();
  }

  // A decision about member `id` (approve, decline, remove): tell them.
  async function decide(fn, id) {
    const rep = fn(club, id);
    if (!rep) return;
    changed();
    for (const r of [rep].flat()) await sendToPlayer(r);
    // A new member gets the tables straight away.
    if (fn === approve && tableHost) sendToPlayer({to: id, body: tablesBody(club, seatedCounts())});
  }

  // A chip change for member `id`; then they get their updated account.
  function chips(id, fn) {
    const e = fn();
    changed();
    return sendToPlayer(account(club, id, e?.n ? e.n - 1 : Infinity));
  }

  // Sends a reply, if there is one, and saves.
  const reply = r => { if (r) { sendToPlayer(r); changed(); } };

  // Everything the host can do. Each takes one object of arguments, and
  // throws (with a message for the host) when it can't be done.
  const OPS = {
    approve: ({id}) => decide(approve, id),
    decline: ({id}) => decide(decline, id),
    remove: ({id}) => decide(removeMember, id),
    revoke_invite: () => { revokeInvite(club); changed(); },
    give: ({id, amount, note = ''}) => chips(id, () => issue(club, id, amount, Date.now(), note)),
    take: ({id, amount, note = ''}) => chips(id, () => reclaim(club, id, amount, Date.now(), note)),
    grant: ({id, amount}) => chips(id, () => grantRequest(club, id, amount)),
    deny: ({id}) => chips(id, () => { declineRequest(club, id); return null; }),
    settle: ({id, amount, note = ''}) => chips(id, () => settle(club, id, amount, Date.now(), note)),
    offer_agent: ({id, amount}) => reply(offerAgent(club, id, amount)),
    credit_limit: ({id, amount}) => reply(setCreditLimit(club, id, amount)),
    revoke_agent: ({id}) => reply(revokeAgent(club, id)),
    assign_agent: ({id, agent}) => { assignToAgent(club, id, agent || null); changed(); },
    offer_assistant: ({id}) => reply(offerAssistant(club, id)),
    revoke_role: ({id}) => reply(revokeRole(club, id)),
    settings: values => {
      for (const [k, v] of Object.entries(values)) {
        if (!SETTINGS[k]?.(v)) throw new Error(`Not a valid ${k}.`);
      }
      Object.assign(club, values);
      changed();
    },
    new_table: ({table}) => {
      const t = newTable(club, table);
      changed();
      if (tableHost) started(tableHost.start(t));
      return t.id;
    },
    // The owner of an always-on club watches table `table` from their page
    // (#125); in a host's tab, watching goes through `watch` below instead.
    watch: ({table}) => {
      if (!club.ownerId) throw new Error('Only an always-on club’s owner watches this way.');
      if (!tableHost?.running(table)) throw new Error('That table isn’t running.');
      if (!memberKeys.has(club.ownerId)) throw new Error('This page couldn’t set up encryption with the club. Reload and try again.');
      unwatch();
      stopWatch = tableHost.watch(table, u => sendSealed(club.ownerId, {table, update: u}));
    },
    unwatch: () => unwatch(),
    close_table: ({table}) => {
      const t = tableById(club, table);
      if (!t || t.status !== 'open') return;
      t.status = 'closing';
      changed();
      if (tableHost) tableHost.close(table); else t.status = 'closed';
      broadcastTables();
    },
  };

  // `extraOps`: actions only where the club runs can do them (an always-on
  // club's room: deleting the club, #98).
  function run(op, args = {}) {
    if (Object.hasOwn(extraOps, op)) return extraOps[op](args);
    if (!Object.hasOwn(OPS, op)) throw new Error(`no host action ${op}`);
    return OPS[op](args);
  }

  return {
    club, verifier, online,
    // The relay accepted this as the club's host: it says again who's
    // connected, and the tables start (only once: a second tab, refused by
    // the relay, never runs them).
    async relayOpen() { await keysReady; online.clear(); startTables(); onChange(); },
    message,
    run,
    // The host's link to the relay is up or down: tables stop their clocks
    // while it's down (club-host.js).
    setLink(ok) { linkOk = ok; tableHost?.setLink(ok); },
    hostKeyPub: async () => (await hostKeys()).pub,
    seatedCounts,
    running: tid => !!tableHost?.running(tid),
    watch: (tid, fn) => tableHost?.watch(tid, fn),
    tablesRunning: () => !!tableHost,
  };
}
