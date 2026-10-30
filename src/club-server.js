// The host side of a club: the members' signed messages, the club's tables,
// encrypted table updates, agents' commands, and everything
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
//   onPlay()       a hand is in play at one of its tables (usage, #421)
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
//   hostInTab      the club runs in its host's own tab, so the host is
//                  around to answer help requests (#192) while it runs
//   limits         what the club's plan allows (#265): {tables (open at
//                  once), tourneysPerDay}; the relay's registry sets them for
//                  an always-on club. null: no cap. setLimits() changes them.
//   plan           the plan, for the owner's page: {plan: 'trial' | 'club',
//                  expires, temporary, provedAt, removesAt}; setLimits()
//                  may change it too
//   lastSeen()     when each player was last heard from, {id: ms}, kept by
//                  an always-on club's room (#401); its owner sees it (#426)
//
// An always-on club (#93) has an owner (club.ownerId) who runs it from their
// page: they send the same host actions signed (owner_cmd), get each result
// (owner_result), and get the whole club after every change (owner_view).

import { signMessage } from './identity.js';
import { account, hostReceive } from './club.js';
import { ensureChips } from './club-chips.js';
import { ledgerOf, startMoney } from './club-money.js';
import { cashOutEveryone, ensureTables, gameLabel, newTable, openTables, tableById, tablesBody } from './club-tables.js';
import { createTableHost } from './club-host.js';
import { cancelTourney, newTourney, register, tourneyById, tourneysBody, unregister } from './club-tourneys.js';
import { createTourneyHost } from './club-tourney-host.js';
import { dropManagers } from './club-log.js';
import { agentBody, answerAgent, isAgent, runAgent } from './club-agents.js';
import { askHelp, helpBody, staffOnline } from './club-help.js';
import { lobbyBody, sayInLobby } from './club-lobby.js';
import { addService, checkRequest, revokeService, runRequest, ServiceError, updateService } from './club-services.js';
import { chatLimiter } from './table-chat.js';
import { handRecord } from './hand-replay.js';
import { nextSettle, processHand, promosBody, settlePeriods } from './club-promos.js';
import { chipText } from './chip-format.js';
import { infoBody } from './club-info.js';
import { command, HOSTED } from './club-commands.js';
import { answerGroup, askGroup, endAsk, endGroup, GROUP_BY, groupById, makeGroup, pruneGroups, setGroupMin } from './club-groups.js';
import { isPublicKey, newKeyPair, seal, sharedKey } from './e2e.js';
import { HOST_KEEP_DAYS } from './hand-store.js';

export function createClubServer({
  identity, club, verifier, persist, transport, onChange = () => {}, onPlay = () => {}, storeHand = () => {}, engine = {},
  hostKeyPair = null, memberPubs = {}, onMemberKey = () => {}, extraOps = {}, hostInTab = false, limits = null, plan = null,
  lastSeen = () => ({}),
}) {
  const planInfo = () => (plan || limits ? {...(plan || {}), limits} : null);
  const online = new Set(); // members connected now
  let tableHost = null;
  let tourneyHost = null; // the club's tournaments (#81), started with the tables
  let linkOk = true;
  // Encrypted table updates (e2e.js): the host's key pair for this session,
  // and per member {pub, key, sends} (their public key, the shared AES key,
  // and a queue that keeps their updates in order).
  let hostKeysP = hostKeyPair ? Promise.resolve(hostKeyPair) : null;
  const hostKeys = () => (hostKeysP ||= newKeyPair());
  const memberKeys = new Map();
  const keysReady = Promise.all(Object.entries(memberPubs).map(([id, pub]) => memberKey(id, pub, false)));
  // Managers were removed (#454): the club's are plain members now. Its
  // money runs on links (club-money.js), moved over the first time.
  const onLinks = !!club.money;
  ensureChips(club);
  startMoney(club);
  if (dropManagers(club) || !onLinks) persist();

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

  // Agents (#75) see their account and players change as it happens, and an
  // always-on club's owner the club: after any change, at most every 200 ms.
  let adminTimer = null;
  function scheduleAdmin() {
    if (adminTimer) return;
    adminTimer = setTimeout(() => {
      adminTimer = null;
      for (const id of online) if (isAgent(club, id)) sendToPlayer({to: id, body: agentBody(club, id)});
      sendOwnerView();
    }, 200);
  }

  // An always-on club's owner sees the whole club, as their page's copy. It
  // carries the club's key for encrypted table updates, for watching a
  // table (#125).
  async function sendOwnerView() {
    const to = club.ownerId && online.has(club.ownerId) ? [club.ownerId] : [];
    if (!to.length) return;
    const running = (club.tables || []).filter(t => tableHost?.running(t.id)).map(t => t.id);
    // A copy: signing waits on WebCrypto, and the club may change before the
    // view is sent, which would no longer match its signature.
    const data = JSON.parse(JSON.stringify(club));
    const hostKey = (await hostKeys()).pub;
    // When each member was last heard from, for Members' Last active (#426).
    const seen = Object.fromEntries(Object.entries(lastSeen() || {}).filter(([mid]) => club.members[mid]));
    for (const id of to) sendToPlayer({to: id, body: {type: 'owner_view', club: club.code, data, seated: seatedCounts(), running, online: [...online], hostKey, tourneys: tourneyLive(), plan: planInfo(), owner: id === club.ownerId, seen}});
  }

  // The owner watching a table (#73, #125): its spectator view, encrypted
  // to them like a member's table updates. One table at a time.
  const watching = new Map(); // who → stop
  function unwatch(who = club.ownerId) { watching.get(who)?.(); watching.delete(who); }

  // The owner's check-in, or one of their actions (run): they get the
  // result, then the club as it is now.
  async function handleOwner({type, from, body}) {
    if (type === 'owner_cmd') {
      let error = '', value = null;
      const op = String(body.op), args = body.args && typeof body.args === 'object' ? body.args : {};
      try {
        if (from !== club.ownerId) throw new Error('Only the club’s owner can do that.');
        value = (await run(op, args)) ?? null;
      } catch (e) { error = e.message || String(e); }
      // Results are plain data (e.g. the list of hands, #125).
      value = value === undefined ? null : JSON.parse(JSON.stringify(value));
      await sendToPlayer({to: from, body: {type: 'owner_result', club: club.code, id: body.id ?? null, error, value}});
    }
    sendOwnerView();
  }

  const seatedCounts = () => tableHost?.seatedCounts() || {};

  // Help requests (#192): member `id` gets who's around and their own
  // requests; when the owner comes or goes, every member online hears
  // about it.
  const isStaff = id => id === club.ownerId;
  const sendHelp = id => sendToPlayer({to: id, body: helpBody(club, id, staffOnline(club, online, hostInTab))});
  function broadcastHelp() {
    for (const id of online) if (club.members[id]?.status === 'member') sendHelp(id);
  }
  const tourneyLive = () => tourneyHost?.live() || {};

  // The lobby (club-lobby.js): who's online and the chat, to every member
  // online, at most every 300 ms. The host's page draws it from the club.
  const lobbyLimit = chatLimiter();
  let lobbyTimer = null;
  function broadcastLobby() {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      const body = lobbyBody(club, online, hostInTab);
      for (const id of online) if (club.members[id]?.status === 'member') sendToPlayer({to: id, body});
      sendOwnerView();
      onChange();
    }, 300);
  }
  // `from` (a member, or the host) says `text` in the lobby.
  function lobbySay(from, text) {
    if (!lobbyLimit.allow(from)) throw new Error('Slow down a little.');
    sayInLobby(club, from, text);
    changed();
    broadcastLobby();
  }

  // The tournaments' lobby (#77) to every member online. Live standings
  // alone go out at most every few seconds.
  function broadcastTourneys() {
    clearTimeout(liveTimer);
    liveTimer = null;
    const body = tourneysBody(club, tourneyLive());
    for (const id of online) if (club.members[id]?.status === 'member') sendToPlayer({to: id, body});
    sendOwnerView();
  }
  let liveTimer = null;
  function liveChanged() {
    if (!liveTimer) liveTimer = setTimeout(broadcastTourneys, 3000);
  }

  // A member's account after a chip change.
  const accountTo = id => {
    const n = ledgerOf(club).findLast(e => e.member === id)?.n;
    sendToPlayer(account(club, id, n ? n - 1 : Infinity));
  };

  // A member registering, unregistering, or entering late (#77, #80).
  async function handleTourney({id: tid, op, from}) {
    try {
      if (op === 'register') register(club, tid, from);
      else if (op === 'unregister') unregister(club, tid, from);
      else if (op === 'enter') {
        if (!tourneyHost) throw new Error('The club’s tables aren’t running.');
        await tourneyHost.enter(tid, from);
      }
      accountTo(from);
      changed();
      broadcastTourneys();
    } catch (e) {
      sendToPlayer({to: from, body: {type: 'tourney_error', club: club.code, tourney: tid, reason: e.message}});
    }
  }

  // High Hand promotions (#267, club-promos.js). Members online get the
  // promotions after any change, and a word when they win or someone takes
  // the lead.
  const memberIds = () => [...online].filter(id => club.members[id]?.status === 'member');
  // A hand's name mid-sentence: "two pair, kings and twos", "a royal flush".
  const midSentence = s => s.charAt(0).toLowerCase() + s.slice(1);
  function broadcastPromos() {
    if (!club.promos?.list?.length) return;
    const body = promosBody(club);
    for (const id of memberIds()) sendToPlayer({to: id, body});
  }
  const promoEvent = (to, kind, text) => sendToPlayer({to, body: {type: 'promo_event', club: club.code, kind, text}});
  // Winners online hear they won.
  function promoEvents(awards) {
    for (const a of awards) {
      if (a.status === 'paid' && online.has(a.member)) promoEvent(a.member, 'award', `${a.promoName}: you won ${chipText(a.amount)} for ${midSentence(a.handName)}.`);
    }
  }
  function promoPaid(awards) {
    for (const a of awards) if (a.status === 'paid') accountTo(a.member);
    promoEvents(awards);
  }
  // A finished hand at a club table: bonuses and leaderboards.
  // Resolves to whether the hand counted for any promotion (qualifying or not).
  function promoHand(rec, players) {
    if (!club.promos?.list?.some(p => p.status === 'running')) return false;
    let r;
    try { r = processHand(club, rec, players || []); } catch (e) { console.warn('club: promotions:', e); return false; }
    if (!r.paid.length && !r.leads.length && !club.promos.hands.some(h => h.hand === rec.id)) return false;
    promoPaid(r.paid);
    for (const l of r.leads) {
      for (const id of memberIds()) promoEvent(id, 'lead', `New high hand in ${gameLabel(l.game)}: ${midSentence(l.hand.hand)}, ${l.hand.name}.`);
    }
    changed();
    broadcastPromos();
    armPromos();
    return true;
  }
  // A tournament hand (#274): recorded like a cash table's, as table
  // `tourney:<id>` (as members record it), and kept in the host's history
  // when it counted for a promotion, so its prize can be replayed.
  function promoTourneyHand(tid, table, view) {
    const t = tourneyById(club, tid);
    const rec = handRecord({club: club.code, table: `tourney:${tid}`, tableName: t?.name || 'Tournament', game: t?.game || '', view, who: 'host'});
    rec.tourney = tid;
    rec.sub = table;
    const players = view.seats.map((s, i) => ({seat: i, client_id: s.id})).filter(p => p.client_id);
    if (promoHand(rec, players)) storeHand(rec, {days: club.keepDays ?? HOST_KEEP_DAYS});
  }
  // Periods ending pay their high hands: on a timer for the soonest end
  // (the room's alarm in an always-on club, #135), and whenever the club
  // opens, so a period that ended while it slept pays on waking.
  const promoTimers = engine.timers || {set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h)};
  let promoTimer = null;
  function armPromos() {
    if (promoTimer != null) promoTimers.clear(promoTimer);
    promoTimer = null;
    const next = club.promos ? nextSettle(club) : null;
    if (next != null) promoTimer = promoTimers.set(settlePromos, Math.min(Math.max(0, next - Date.now()) + 1000, 2 ** 31 - 1));
  }
  function settlePromos() {
    promoTimer = null;
    if (club.promos) {
      const paid = settlePeriods(club);
      if (paid.length) {
        promoPaid(paid);
        changed();
      }
      broadcastPromos();
    }
    armPromos();
  }

  // The tables for members, saying too whether the club is temporary (#395:
  // no backup of it proved), which they see on its page.
  const tablesNow = () => ({...tablesBody(club, seatedCounts()), ...(plan?.temporary ? {temporary: true} : {})});
  function broadcastTables() {
    if (!tableHost) return;
    // Who's at which table shows in the lobby.
    broadcastLobby();
    const body = tablesNow();
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
      chipsChanged: accountTo,
      // Closed tables leave their groups (#501).
      tablesChanged: () => { if (pruneGroups(club)) persist(); broadcastTables(); onChange(); },
      online: id => online.has(id),
      onPlay,
      groupFull: gid => askAboutTable(gid),
      onHand: (tid, view, players) => {
        const t = tableById(club, tid);
        const rec = handRecord({club: club.code, table: tid, tableName: t?.name || '', game: t?.game || '', view, who: 'host'});
        storeHand(rec, {days: club.keepDays ?? HOST_KEEP_DAYS});
        promoHand(rec, players);
      },
      ...engine,
    });
    tableHost.setLink(linkOk);
    for (const t of live) started(tableHost.start(t, {resume: true}));
    // Tournaments (#81): each starts at its time; one that was running
    // when the club stopped carries on from where it was saved.
    tourneyHost = createTourneyHost({
      club: () => club,
      save: () => { persist(); scheduleAdmin(); onChange(); },
      sendTable: sendSealed,
      chipsChanged: accountTo,
      tourneysChanged: broadcastTourneys,
      liveChanged: () => { liveChanged(); onChange(); },
      online: id => online.has(id),
      onPlay,
      // Only while a promotion counts tournament hands (#274).
      onHand: (tid, table, view) => { if (club.promos?.list?.some(p => p.status === 'running' && p.tourneys)) promoTourneyHand(tid, table, view); },
      ...engine,
    });
    tourneyHost.startAll();
    // A "Join?" question open when the club last stopped closes on time.
    for (const g of club.groups || []) if (g.ask) armAsk(g.id);
  }

  // ---- grouped tables (#501, club-groups.js) ----
  //
  // When a group's tables are full and someone is turned away, everyone
  // online but those at its tables is asked "We're starting a new table.
  // Join?" for a minute. Once the group's minimum say yes, a table like the
  // main one opens at the end of the group: those seated elsewhere move to
  // it after their hand, the rest are told to sit down. Time running out
  // first: no table, and those who said yes are told.
  const askTimers = new Map(); // group id → timer
  const groupMsg = (to, gid, kind, extra = {}) => sendToPlayer({to, body: {type: 'group', club: club.code, group: gid, kind, ...extra}});

  function askAboutTable(gid) {
    const g = groupById(club, gid);
    const main = tableById(club, g?.tables[0]);
    if (!g || !main || (g.ask && g.ask.until > Date.now())) return [];
    let asked;
    try { asked = askGroup(club, gid, [...online]); } catch { return []; }
    if (!asked.length) return [];
    changed();
    const until = groupById(club, gid).ask.until;
    for (const id of asked) groupMsg(id, gid, 'ask', {name: main.name, until});
    armAsk(gid);
    return asked;
  }

  function armAsk(gid) {
    const g = groupById(club, gid);
    if (askTimers.has(gid)) promoTimers.clear(askTimers.get(gid));
    askTimers.delete(gid);
    if (g?.ask) askTimers.set(gid, promoTimers.set(() => { askTimers.delete(gid); finishAsk(gid); }, Math.max(0, g.ask.until - Date.now())));
  }

  // Member `from` answered group `gid`'s question.
  function groupAnswer(from, gid, yes) {
    let enough;
    try { enough = answerGroup(club, String(gid), from, yes); } catch (e) { groupMsg(from, gid, 'closed', {reason: e.message}); return; }
    changed();
    if (enough) finishAsk(gid);
  }

  async function finishAsk(gid) {
    if (askTimers.has(gid)) promoTimers.clear(askTimers.get(gid));
    askTimers.delete(gid);
    const asked = groupById(club, gid)?.ask?.asked || [];
    let end;
    try { end = endAsk(club, gid, limits?.tables ?? null); } catch (e) { console.warn('club: a group’s new table:', e.message); end = {opened: null, yes: [], moves: []}; }
    changed();
    const t = end.opened ? tableById(club, end.opened) : null;
    // Everyone asked hears how it ended; those who said yes and aren't
    // seated sit down there, and those seated elsewhere are moved there.
    for (const id of asked) {
      if (!t) groupMsg(id, gid, 'closed', end.yes.includes(id) ? {reason: 'Not enough players for a new table.'} : {});
      else if (!end.yes.includes(id)) groupMsg(id, gid, 'closed');
    }
    if (!t) return;
    if (tableHost) await started(tableHost.start(t));
    const moving = new Set(end.moves.map(m => m.id));
    for (const id of end.yes) if (!moving.has(id)) groupMsg(id, gid, 'open', {table: t.id, name: t.name});
    for (const m of end.moves) {
      try { await tableHost?.reserve(m.to, m.id, {by: GROUP_BY}); } catch {}
    }
  }

  // An agent's answer to the offer, or their command, already verified as from `from`.
  function handleAdmin({type, from, body}) {
    if (type === 'agent_reply') {
      const r = answerAgent(club, from, !!body.accept);
      if (r) sendToPlayer(r);
      return;
    }
    try {
      const r = runAgent(club, from, body.cmd, Date.now());
      for (const rep of r.replies) sendToPlayer(rep);
      if (r.approved && tableHost) sendToPlayer({to: r.approved, body: tablesNow()});
      sendToPlayer({to: from, body: {type: 'admin_result', club: club.code, error: ''}});
    } catch (e) {
      sendToPlayer({to: from, body: {type: 'admin_result', club: club.code, error: e.message}});
    }
  }

  // A message from the relay: a member connecting or leaving, or their signed message.
  async function message(msg) {
    if (!msg || !msg.from) return;
    if (msg.event === 'open') { online.add(msg.from); tableHost?.presence(msg.from); if (isStaff(msg.from)) broadcastHelp(); broadcastLobby(); return; }
    if (msg.event === 'close') {
      online.delete(msg.from);
      broadcastLobby();
      if (isStaff(msg.from)) broadcastHelp();
      unwatch(msg.from);
      tableHost?.disconnected(msg.from);
      tableHost?.presence(msg.from);
      tourneyHost?.disconnected(msg.from);
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
      // An answer to "We're starting a new table. Join?" (#501), sent to
      // the group's main table.
      if (r.table.cmd?.type === 'group_answer') groupAnswer(msg.from, String(r.table.cmd.group ?? ''), r.table.cmd.yes === true);
      else if (r.table.cmd?.type === 'join' && !memberKeys.has(msg.from)) {
        sendToPlayer({to: msg.from, body: {type: 'table_error', club: club.code, table: r.table.id, reason: 'This page couldn’t set up encryption with the club. Reload and try again.'}});
      } else if (r.table.id.startsWith('tourney:')) tourneyHost?.handle(r.table.id.slice(8), r.table.from, r.table.cmd);
      else tableHost?.handle(r.table.id, r.table.from, r.table.cmd);
    }
    if (r.tourney && r.tourney.from === msg.from) { await handleTourney(r.tourney); return; }
    if (r.admin && r.admin.from === msg.from) { handleAdmin(r.admin); changed(); return; }
    if (r.owner && r.owner.from === msg.from) { await handleOwner(r.owner); return; }
    if (r.help && r.help.from === msg.from) {
      try { askHelp(club, msg.from, r.help.text, r.help.table); changed(); } catch (e) { console.warn('club: help request refused:', e.message); }
      sendHelp(msg.from);
      return;
    }
    if (r.lobby && r.lobby.from === msg.from) {
      try { lobbySay(msg.from, r.lobby.text); } catch (e) { console.warn('club: lobby message refused:', e.message); }
      return;
    }
    const m = club.members[msg.from];
    if (msg.data?.body?.type === 'hello' && m?.status === 'member') {
      // Members checking in get the tables, the host's key for encrypted
      // table updates, and an agent their view.
      if (tableHost) sendToPlayer({to: msg.from, body: tablesNow()});
      sendToPlayer({to: msg.from, body: tourneysBody(club, tourneyLive())});
      if (club.promos?.list?.length) sendToPlayer({to: msg.from, body: promosBody(club)});
      if (club.info) sendToPlayer({to: msg.from, body: infoBody(club)});
      sendToPlayer({to: msg.from, body: {type: 'host_key', club: club.code, key: (await hostKeys()).pub}});
      sendHelp(msg.from);
      if (m.agent) sendToPlayer({to: msg.from, body: {type: 'agent_role', club: club.code, agent: m.agent}});
      if (isAgent(club, msg.from)) sendToPlayer({to: msg.from, body: agentBody(club, msg.from)});
      // A new name shows in the lobby too.
      broadcastLobby();
    }
    if (r.changed || r.replies.length) changed();
  }

  // Everything else the host can do: what drives the running tables and
  // tournaments, services, and the host's lobby line. (The club host runs
  // the rest: HOSTED, club-commands.js.) Each takes one object of
  // arguments, and throws (with a message for the host) when it can't be done.
  const OPS = {
    // The host's line in the lobby chat.
    lobby_say: ({text}) => lobbySay(actor(), text),
    // Services (club-services.js): outside servers that give chips within
    // limits. Only an always-on club has them: its room answers their requests.
    service_add: async args => { const s = await addService(club, args || {}); changed(); return s.id; },
    service_update: ({id, ...args}) => { updateService(club, String(id), args); changed(); },
    service_revoke: ({id}) => { revokeService(club, String(id)); changed(); },
    new_table: ({table}) => {
      const t = newTable(club, table, Date.now(), limits);
      changed();
      if (tableHost) started(tableHost.start(t));
      return t.id;
    },
    // The owner of an always-on club watches table `table` from their page
    // (#125); in a host's tab, watching goes through `watch` below instead.
    watch: ({table}) => {
      if (!club.ownerId) throw new Error('Only an always-on club’s owner watches this way.');
      if (!tableHost?.running(table)) throw new Error('That table isn’t running.');
      if (!memberKeys.has(actor())) throw new Error('This page couldn’t set up encryption with the club. Reload and try again.');
      const who = actor();
      unwatch(who);
      watching.set(who, tableHost.watch(table, u => sendSealed(who, {table, update: u})));
    },
    unwatch: () => unwatch(actor()),
    // Tournaments (#77, #79): a new one (it starts at its time), cancelling
    // one (every buy-in refunded), and the host's payouts (null: defaults).
    new_tourney: ({tourney}) => {
      const t = newTourney(club, tourney, Date.now(), limits);
      changed();
      tourneyHost?.schedule(t);
      broadcastTourneys();
      return t.id;
    },
    cancel_tourney: ({id}) => {
      const t = tourneyById(club, id);
      if (!t) throw new Error('No such tournament.');
      const who = [...new Set(t.entries.map(e => e.member))];
      if (tourneyHost) tourneyHost.cancel(id);
      else { cancelTourney(club, id, Date.now(), 'the manager cancelled it'); changed(); }
      for (const m of who) accountTo(m);
      broadcastTourneys();
    },
    // Removing a player from a table without closing it (#414): after the
    // hand in play, never in the middle of it (#476); keep_player is Undo.
    remove_player: async ({table, id}) => {
      if (!tableHost?.running(table)) throw new Error('That table isn’t running.');
      await tableHost.removePlayer(table, String(id), {by: actor()});
      changed();
    },
    keep_player: async ({table, id}) => {
      await tableHost?.keepPlayer(table, String(id));
      changed();
    },
    // Moving a player to a seat held at table `to` (#425): they leave after
    // the hand in play and sit down there.
    move_player: async ({table, id, to}) => {
      if (!tableHost?.running(table)) throw new Error('That table isn’t running.');
      await tableHost.movePlayer(table, String(id), String(to), {by: actor()});
      changed();
    },
    // Grouped tables with must-move (#501): a group with `table` as its
    // main table, its minimum to start a new table, ending it, and asking
    // about a new table now.
    make_group: ({table, min}) => {
      const g = makeGroup(club, String(table), min == null ? null : Number(min));
      changed();
      broadcastTables();
      return g.id;
    },
    set_group_min: ({id, min}) => { setGroupMin(club, String(id), Number(min)); changed(); },
    end_group: ({id}) => { endGroup(club, String(id)); changed(); broadcastTables(); },
    ask_group: ({id}) => {
      if (!tableHost) throw new Error('The club’s tables aren’t running.');
      const g = groupById(club, String(id));
      if (!g) throw new Error('No such group.');
      if (g.ask && g.ask.until > Date.now()) throw new Error('They’re being asked already.');
      const asked = askAboutTable(g.id);
      if (!asked.length) throw new Error(`Fewer than ${g.min} players are online to ask.`);
      return asked.length;
    },
    close_table: ({table}) => {
      const t = tableById(club, table);
      if (!t || t.status !== 'open') return;
      t.status = 'closing';
      changed();
      if (tableHost) tableHost.close(table); else t.status = 'closed';
      broadcastTables();
    },
  };

  // Who the actions are by, for the activity log.
  const actor = () => club.ownerId || club.hostId;

  // A command the club host runs (club-commands.js, #456): it changes the
  // club, then what it means for everyone else is carried out here.
  async function hosted(op, args) {
    const out = command(club, op, args);
    changed();
    for (const r of out.replies) await sendToPlayer(r);
    for (const a of out.accounts) sendToPlayer(account(club, a.id, a.since ?? Infinity));
    // A new member gets the tables straight away.
    if (tableHost) for (const id of out.tablesTo) sendToPlayer({to: id, body: tablesNow()});
    for (const id of out.helpTo) if (online.has(id)) sendHelp(id);
    if (op === 'approve_award') {
      const a = club.promos?.awards?.find(x => x.id === String(args.id));
      if (a) promoEvents([a]);
    }
    const tell = new Set(out.tell);
    if (tell.has('lobby')) broadcastLobby();
    if (tell.has('tables')) broadcastTables();
    if (tell.has('tourneys')) broadcastTourneys();
    if (tell.has('promos')) broadcastPromos();
    if (tell.has('info')) {
      const body = infoBody(club);
      for (const id of memberIds()) sendToPlayer({to: id, body});
    }
    if (out.armPromos) armPromos();
    return out.value ?? undefined;
  }

  // `extraOps`: actions only where the club runs can do them (an always-on
  // club's room: deleting the club, #98).
  function run(op, args = {}) {
    if (Object.hasOwn(extraOps, op)) return extraOps[op](args);
    if (HOSTED.has(op)) return hosted(op, args && typeof args === 'object' ? args : {});
    if (!Object.hasOwn(OPS, op)) throw new Error(`no host action ${op}`);
    return OPS[op](args);
  }

  // A service's signed request (club-services.js), from the relay's HTTP
  // endpoint. Resolves to {status, body}: the answer to send back. Requests
  // are taken one at a time, so two can't both spend the same budget.
  let serviceQueue = Promise.resolve();
  function serviceRequest(env) {
    const run = async () => {
      const before = JSON.stringify([club.services, club.serviceRefused]);
      try {
        const s = await checkRequest(club, env);
        const {value, member} = runRequest(club, s, env.body);
        changed();
        if (member) accountTo(member);
        return {status: 200, body: {ok: true, value}};
      } catch (e) {
        // A refusal still counts against the service, and is saved.
        if (JSON.stringify([club.services, club.serviceRefused]) !== before) changed();
        if (e instanceof ServiceError) return {status: e.status, body: {ok: false, error: e.message}};
        return {status: 409, body: {ok: false, error: e.message || String(e)}};
      }
    };
    const p = serviceQueue.then(run);
    serviceQueue = p.catch(() => {});
    return p;
  }

  return {
    club, verifier, online, serviceRequest,
    // The relay accepted this as the club's host: it says again who's
    // connected, and the tables start (only once: a second tab, refused by
    // the relay, never runs them).
    async relayOpen() { await keysReady; online.clear(); startTables(); settlePromos(); onChange(); },
    message,
    run,
    // The host's link to the relay is up or down: tables stop their clocks
    // while it's down (club-host.js).
    setLink(ok) { linkOk = ok; tableHost?.setLink(ok); },
    hostKeyPub: async () => (await hostKeys()).pub,
    seatedCounts,
    running: tid => !!tableHost?.running(tid),
    watch: (tid, fn) => tableHost?.watch(tid, fn),
    tourneyLive,
    tablesRunning: () => !!tableHost,
    // The plan's limits changed (the super admin, #265).
    // A backup proved (#395) changes `temporary`: members hear of it.
    setLimits(l, p = plan) {
      const was = !!plan?.temporary;
      limits = l || null;
      plan = p;
      scheduleAdmin();
      if (was !== !!plan?.temporary) broadcastTables();
    },
    limits: () => limits,
  };
}
