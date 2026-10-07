// Hidden page at #clubs (#66): host a club, invite players with a link and
// approve them, and see the clubs you belong to. club.js has the rules; this
// file draws the page and carries signed messages over the relay
// (play-net.js, in queue mode so join requests wait while the host is away).
//
// Storage (this browser only, #61):
//   ducyClub          the club this browser hosts (one per host for now)
//   ducyClubSenders   the host's Verifier state (players' keys, last seq)
//   ducyClubs         clubs this browser has asked to join
//   ducyClubName      the display name sent with join requests

import { loadIdentity, signMessage, Verifier } from './identity.js';
import { connect, DEFAULT_RELAY, newCode, relayUrl, wsUrl } from './play-net.js';
import {
  account, approve, decline, hostReceive, inviteLink, lastEntry, MAX_CLUB_NAME, MAX_PLAYER_NAME, membersByStatus,
  newClub, newMembership, parseInvite, playerReceive, removeMember, revokeInvite,
} from './club.js';
import { declineRequest, ensureChips, grantRequest, issue, MAX_NOTE, reclaim, totals } from './club-chips.js';
import {
  cashOutEveryone, ensureTables, gameLabel, GAMES, MAX_SEATS, MAX_TABLE_NAME, newTable, openTables, tableById, tablesBody,
} from './club-tables.js';
import { createTableHost } from './club-host.js';
import { adminBody, answerRole, isAssistant, offerAssistant, revokeRole, runAdmin } from './club-roles.js';
import {
  accountOf, agentBody, answerAgent, assignToAgent, isAgent, offerAgent, revokeAgent, runAgent, setCreditLimit, settle,
} from './club-agents.js';
import { handRecord, replayFrames, streetStarts, summary, tableSessions, totalsByMember, STREETS } from './hand-replay.js';
import { getHand, HOST_KEEP_DAYS, listHands, PLAYER_KEEP_HANDS, prune, saveHand } from './hand-store.js';
import { joinTableVia } from './play.js';
import { isPublicKey, newKeyPair, open as openBox, seal, sharedKey } from './e2e.js';

const CLUB_KEY = 'ducyClub', SENDERS_KEY = 'ducyClubSenders', MEMBERSHIPS_KEY = 'ducyClubs', NAME_KEY = 'ducyClubName';

let root = null, open = false;
let me = null; // identity
let club = null; // the club this browser hosts
let verifier = null;
let hostNet = null, hostOnline = false;
let memberships = []; // clubs this browser asked to join
const playerNets = new Map(); // club code → {net, online, hostHere}
let invite = null; // an invite from the page address, not yet acted on
let note = '', copied = false;
let tableHost = null; // runs the hosted club's tables (club-host.js)
const online = new Set(); // members connected to the hosted club
// Encrypted table updates (e2e.js): the host's key pair for this session,
// and per member {pub, key, sends} (their public key, the shared AES key,
// and a queue that keeps their updates in order).
let hostKeysP = null;
const hostKeys = () => (hostKeysP ||= newKeyPair()); // made once, on first use
const memberKeys = new Map();

// A member sent their session key (with join or hello): derive the shared key.
async function memberKey(id, pub) {
  if (!isPublicKey(pub) || memberKeys.get(id)?.pub === pub) return;
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
    hostNet?.send({to, data: {type: 'table', table: msg.table, enc: await seal(k.key, msg.update)}});
  }).catch(e => console.warn(e));
}
let tableForm = false; // the open New table form: true (the host's), or a club code (an assistant's)
let seatedAt = null; // the club table this browser plays at: {code, table, handlers}

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const when = t => (t ? new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : '');
const myName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };

const STATUS_TEXT = {
  new: 'Sending your request…',
  pending: 'Waiting for the host to approve you',
  member: 'Member',
  declined: 'The host declined your request',
  removed: 'You were removed from this club',
  bad_invite: 'That invite link isn’t valid any more; ask the host for a new one',
};

// ---- hosting ----

function saveClub() {
  save(CLUB_KEY, club);
  save(SENDERS_KEY, verifier.toJSON());
  scheduleAdmin();
}

// Assistants (#62) see the club change as it happens: after any change, the
// online ones get a fresh view (at most every 200 ms).
let adminTimer = null;
function scheduleAdmin() {
  if (adminTimer || !club) return;
  adminTimer = setTimeout(() => {
    adminTimer = null;
    if (!club) return;
    const body = adminBody(club, tableHost?.seatedCounts() || {});
    for (const id of online) if (isAssistant(club, id)) sendToPlayer({to: id, body});
    // Agents (#75) see their account and their players.
    for (const id of online) if (isAgent(club, id)) sendToPlayer({to: id, body: agentBody(club, id)});
  }, 200);
}

// A role answer or an assistant's command, already verified as from `from`.
function handleAdmin({type, from, body}) {
  if (type === 'role_reply' || type === 'agent_reply') {
    const r = (type === 'role_reply' ? answerRole : answerAgent)(club, from, !!body.accept);
    if (r) sendToPlayer(r);
    return;
  }
  try {
    const r = (type === 'agent_cmd' ? runAgent : runAdmin)(club, from, body.cmd);
    for (const rep of r.replies) sendToPlayer(rep);
    if (r.approved && tableHost) sendToPlayer({to: r.approved, body: tablesBody(club, tableHost.seatedCounts())});
    if (r.table?.start) tableHost?.start(r.table.start).then(() => { broadcastTables(); render(); });
    if (r.table?.close) tableHost ? tableHost.close(r.table.close) : (tableById(club, r.table.close).status = 'closed');
    if (r.table) broadcastTables();
    sendToPlayer({to: from, body: {type: 'admin_result', club: club.code, error: ''}});
  } catch (e) {
    sendToPlayer({to: from, body: {type: 'admin_result', club: club.code, error: e.message}});
  }
}

function startHosting() {
  if (!club || hostNet) return;
  startTables();
  hostNet = connect(club.code, 'host', '', {
    // The relay tells us again who's connected.
    onOpen() { hostOnline = true; online.clear(); render(); },
    onMessage: hostMessage,
    onStatus(s) { hostOnline = !s; render(); },
    onFail(reason) { hostNet = null; hostOnline = false; tableHost?.setLink(false); note = reason; render(); },
    // Tables stop their clocks while the relay can't be reached (club-host.js).
    onHealth(ok) { tableHost?.setLink(ok); render(); },
  }, {heartbeat: true, persistent: true, retryInUse: true, inUse: 'This club is already open in another tab or window. Only one can host it: close the other one, then click Reconnect.'});
}

// The club's tables (#68). The page opening again means any tables that were
// running stopped: everyone seated is cashed out first (club-tables.js).
function startTables() {
  if (tableHost) return;
  ensureTables(club);
  const back = cashOutEveryone(club);
  if (back.length) saveClub();
  tableHost = createTableHost({
    club: () => club,
    save: () => { saveClub(); render(); },
    sendTable: sendSealed,
    chipsChanged: id => {
      const n = club.chips.ledger.filter(e => e.member === id).at(-1)?.n;
      sendToPlayer(account(club, id, n ? n - 1 : Infinity));
    },
    tablesChanged: () => { broadcastTables(); render(); },
    online: id => online.has(id),
    onHand: (tid, view) => {
      const t = tableById(club, tid);
      storeHand(handRecord({club: club.code, table: tid, tableName: t?.name || '', game: t?.game || '', view, who: 'host'}),
        {days: club.keepDays ?? HOST_KEEP_DAYS});
    },
  });
  for (const t of openTables(club)) {
    if (t.status === 'open') tableHost.start(t);
  }
}

function broadcastTables() {
  if (!club || !tableHost) return;
  const body = tablesBody(club, tableHost.seatedCounts());
  for (const id of online) if (club.members[id]?.status === 'member') sendToPlayer({to: id, body});
}

async function hostMessage(msg) {
  if (!msg || !msg.from) return;
  if (msg.event === 'open') { online.add(msg.from); tableHost?.presence(msg.from); return; }
  if (msg.event === 'close') { online.delete(msg.from); tableHost?.disconnected(msg.from); tableHost?.presence(msg.from); return; }
  if (!('data' in msg)) return;
  const r = await hostReceive(club, verifier, msg.data);
  if (msg.queued) hostNet?.send({ack: msg.queued});
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
  if (r.admin && r.admin.from === msg.from) { handleAdmin(r.admin); saveClub(); render(); return; }
  // Members checking in get the tables too.
  const hello = msg.data?.body?.type === 'hello' && club.members[msg.from]?.status === 'member';
  if (hello && tableHost) sendToPlayer({to: msg.from, body: tablesBody(club, tableHost.seatedCounts())});
  // …and the host's key for encrypted table updates (signed, like the rest).
  if (hello) {
    sendToPlayer({to: msg.from, body: {type: 'host_key', club: club.code, key: (await hostKeys()).pub}});
  }
  // …and their role, and an assistant their view of the club.
  if (hello && club.members[msg.from].role) sendToPlayer({to: msg.from, body: {type: 'role', club: club.code, role: club.members[msg.from].role}});
  if (hello && isAssistant(club, msg.from)) sendToPlayer({to: msg.from, body: adminBody(club, tableHost?.seatedCounts() || {})});
  const ag = hello && club.members[msg.from].agent;
  if (ag) sendToPlayer({to: msg.from, body: {type: 'agent_role', club: club.code, agent: ag, creditLimit: club.members[msg.from].creditLimit || 0}});
  if (hello && isAgent(club, msg.from)) sendToPlayer({to: msg.from, body: agentBody(club, msg.from)});
  if (r.changed || r.replies.length) { saveClub(); render(); }
}

// Signed messages go out one at a time, in order: a player ignores anything
// with a lower sequence number than one it has seen.
let hostSends = Promise.resolve();
function sendToPlayer(rep) {
  if (!rep) return hostSends;
  // Whoever gets the tables gets the host's key first, so they can read the
  // encrypted updates once they sit down.
  if (rep.body?.type === 'tables') {
    hostSends = hostSends.then(async () => {
      const env = await signMessage(me, {type: 'host_key', club: club.code, key: (await hostKeys()).pub});
      hostNet?.send({to: rep.to, data: env});
    }).catch(e => console.warn(e));
  }
  hostSends = hostSends.then(async () => {
    const env = await signMessage(me, rep.body);
    hostNet?.send({to: rep.to, data: env});
  }).catch(e => console.warn(e));
  return hostSends;
}

async function createClub(name) {
  try {
    club = newClub(name, newCode(), me.id);
  } catch (e) {
    note = e.message;
    render();
    return;
  }
  verifier = new Verifier();
  note = '';
  ensureTables(club);
  saveClub();
  startHosting();
  render();
}

// The host's New table form: native, so the browser checks the numbers.
// `code`: an assistant's form for that club (sent to its host), else the host's.
function tableFormHtml(code = '') {
  let h = `<form class="cl-tableform" data-tableform="1"${code ? ` data-code="${esc(code)}"` : ''}>`;
  h += `<label>Name<input class="pl-text" name="name" maxlength="${MAX_TABLE_NAME}" placeholder="${code ? 'Table name' : `Table ${(club.tables?.length || 0) + 1}`}"></label>`;
  h += `<label>Game<select class="pl-text" name="game">${GAMES.map(g => `<option value="${g.id}">${esc(g.label)}</option>`).join('')}</select></label>`;
  h += '<label>Small blind<input class="pl-text" name="sb" type="number" required min="1" step="1" value="1"></label>';
  h += '<label>Big blind<input class="pl-text" name="bb" type="number" required min="1" step="1" value="2"></label>';
  h += '<label>Min buy-in (BB)<input class="pl-text" name="minBB" type="number" required min="1" step="1" value="40"></label>';
  h += '<label>Max buy-in (BB)<input class="pl-text" name="maxBB" type="number" required min="1" step="1" value="100"></label>';
  h += `<label>Seats<input class="pl-text" name="seats" type="number" required min="2" max="${MAX_SEATS}" step="1" value="${MAX_SEATS}"></label>`;
  h += `<label>Turn time<select class="pl-text" name="turnSecs">${[15, 30, 60, 0].map(s => `<option value="${s}"${s === 30 ? ' selected' : ''}>${s ? s + ' s' : 'None'}</option>`).join('')}</select></label>`;
  // Sit-out limit (#70): this table's, starting from the club's default (an
  // assistant's browser doesn't have the club, so theirs starts at 10 minutes).
  const defOut = club?.sitOutMins ?? 10;
  h += `<label>Sit-out limit<select class="pl-text" name="sitOutMins">${[5, 10, 15, 30, 0].map(m => `<option value="${m}"${m === defOut ? ' selected' : ''}>${m ? m + ' min' : 'None'}</option>`).join('')}</select></label>`;
  h += '<div class="cl-formacts"><button class="btn-small primary" type="submit">Open table</button><button class="btn-small" type="button" data-cl="cancel-table">Cancel</button></div></form>';
  return h;
}

function submitTable(f) {
  const v = name => f.elements[name].value;
  const settings = {
    name: v('name'), game: v('game'), sb: Number(v('sb')), bb: Number(v('bb')),
    minBB: Number(v('minBB')), maxBB: Number(v('maxBB')), seats: Number(v('seats')), turnSecs: Number(v('turnSecs')),
    sitOutMins: Number(v('sitOutMins')),
  };
  // An assistant's: the host opens it.
  if (f.dataset.code) {
    tableForm = false;
    adminCmd(f.dataset.code, {op: 'new_table', table: settings});
    render();
    return;
  }
  try {
    const t = newTable(club, settings);
    tableForm = false;
    saveClub();
    tableHost?.start(t).then(() => { broadcastTables(); render(); });
  } catch (e) {
    alert(e.message);
  }
  render();
}

// The host watches a table (#73) on the #play page: a spectator's view from
// the engine (no one's cards before they're shown down), nothing to act on.
function watchTable(id) {
  const t = tableById(club, id);
  if (!t || !tableHost?.running(id)) return;
  joinTableVia(handlers => {
    const stop = tableHost.watch(id, u => (u.type === 'closed' ? handlers.onFail('The table closed.') : handlers.onMessage(u)));
    return {send() {}, close: stop};
  }, {
    label: `${club.name} · ${t.name} (watching)`,
    watch: true,
    onLeave: why => { note = why || ''; location.hash = 'clubs'; },
  });
  location.hash = 'play';
}

function closeTable(id) {
  const t = club.tables.find(x => x.id === id);
  if (!t || !confirm(`Close ${t.name}? Everyone is cashed out at the end of the hand.`)) return;
  t.status = 'closing';
  saveClub();
  if (tableHost) tableHost.close(id); else t.status = 'closed';
  broadcastTables();
  render();
}

function tablesHtml() {
  const tables = openTables(club);
  const counts = tableHost?.seatedCounts() || {};
  let h = `<h3>Tables${tables.length ? ` (${tables.length})` : ''}</h3>`;
  if (tables.length) {
    h += '<ul class="cl-list">';
    for (const t of tables) {
      h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameLabel(t.game))} · ${t.sb}/${t.bb} · buy-in ${t.minBB}–${t.maxBB} BB · ${counts[t.id] || 0}/${t.seats} seated</span>`;
      h += t.status === 'closing'
        ? '<span class="cl-acts pl-meta">Closing after this hand…</span>'
        : `<span class="cl-acts"><button class="btn-small" data-cl="watch" data-table="${esc(t.id)}"${tableHost?.running(t.id) ? "" : " disabled"}>Watch</button><button class="btn-small" data-cl="close-table" data-table="${esc(t.id)}">Close</button></span>`;
      const seated = Object.values(club.members).filter(m => m.seat?.table === t.id);
      if (seated.length) h += `<span class="pl-desc cl-err">${seated.map(m => `${esc(m.name)} ${chips(m.seat.stack)}`).join(' · ')}</span>`;
      h += '</li>';
    }
    h += '</ul>';
  } else if (tableForm !== true) h += '<p class="pl-meta">No tables yet.</p>';
  h += tableForm === true ? tableFormHtml() : '<div class="pl-actions"><button class="btn-small primary" data-cl="new-table">New table</button></div>';
  return h;
}

async function decide(fn, id) {
  const rep = fn(club, id);
  if (!rep) return;
  saveClub();
  render();
  for (const r of [rep].flat()) await sendToPlayer(r);
  // A new member gets the tables straight away.
  if (fn === approve && tableHost) sendToPlayer({to: id, body: tablesBody(club, tableHost.seatedCounts())});
}

const chips = n => Number(n || 0).toLocaleString();

// The host's open chip form, under a member's row: {kind, id}, kind 'give',
// 'take' or 'grant' (a request, for another amount). One at a time.
let chipForm = null;

const FORM_TEXT = {
  give: m => ({label: `Give ${m.name}`, submit: 'Give', value: '', max: null, note: true}),
  take: m => ({label: `Take back from ${m.name} (has ${chips(m.balance)})`, submit: 'Take back', value: m.balance, max: m.balance, note: true}),
  grant: m => ({label: `Give ${m.name} (asked for ${chips(m.request?.amount)})`, submit: 'Give', value: m.request?.amount ?? '', max: null, note: false}),
  // Agents (#74, #76).
  agent: m => ({label: `Make ${m.name} an agent with a credit limit of`, submit: 'Offer', value: 0, max: null, note: false, min: 0}),
  limit: m => ({label: `${m.name}'s credit limit`, submit: 'Save', value: m.creditLimit || 0, max: null, note: false, min: 0}),
  settle: m => ({label: `Record a settlement from ${m.name} (credit used ${chips(accountOf(club, m.id).creditUsed)})`, submit: 'Record', value: accountOf(club, m.id).creditUsed || '', max: null, note: true}),
};

// A native form: the browser checks the amount (required, whole, at least
// 1, at most the balance when taking back) before it submits.
function chipFormHtml(m) {
  if (!chipForm || chipForm.id !== m.id) return '';
  const t = FORM_TEXT[chipForm.kind](m);
  let h = `<form class="cl-chipform" data-chipform="${chipForm.kind}" data-id="${esc(m.id)}">`;
  h += `<label class="cl-formlabel" for="cl-amt">${esc(t.label)}</label>`;
  h += `<input class="pl-text" id="cl-amt" name="amount" type="number" inputmode="numeric" required min="${t.min ?? 1}" step="1"${t.max != null ? ` max="${t.max}"` : ''} value="${esc(t.value)}" placeholder="Chips">`;
  if (t.note) h += `<input class="pl-text" name="note" maxlength="${MAX_NOTE}" placeholder="Note (optional)">`;
  h += `<button class="btn-small primary" type="submit">${t.submit}</button><button class="btn-small" type="button" data-cl="cancel-form">Cancel</button></form>`;
  return h;
}

function openChipForm(kind, id) {
  chipForm = chipForm?.kind === kind && chipForm.id === id ? null : {kind, id};
  render();
  const input = root.querySelector('#cl-amt');
  if (input) { input.focus(); input.select(); }
}

function onSubmit(e) {
  const tf = e.target.closest('form[data-tableform]');
  if (tf) { e.preventDefault(); submitTable(tf); return; }
  const gf = e.target.closest('form[data-agentform]');
  if (gf) {
    e.preventDefault();
    const amount = Number(gf.elements.amount.value);
    agentForm = null;
    agentCmd(gf.dataset.code, {op: gf.dataset.agentform, id: gf.dataset.id, amount});
    render();
    return;
  }
  const af = e.target.closest('form[data-adminform]');
  if (af) {
    e.preventDefault();
    const amount = Number(af.elements.amount.value);
    adminForm = null;
    adminCmd(af.dataset.code, {op: af.dataset.adminform, id: af.dataset.id, amount});
    render();
    return;
  }
  const f = e.target.closest('form[data-chipform]');
  if (!f) return;
  e.preventDefault();
  const id = f.dataset.id, kind = f.dataset.chipform;
  const amount = Number(f.elements.amount.value);
  const why = f.elements.note?.value || '';
  chipForm = null;
  if (kind === 'give') chipAction(id, () => issue(club, id, amount, Date.now(), why));
  else if (kind === 'take') chipAction(id, () => reclaim(club, id, amount, Date.now(), why));
  else if (kind === 'grant') chipAction(id, () => grantRequest(club, id, amount));
  else if (kind === 'agent' || kind === 'limit') {
    try { sendToPlayer(kind === 'agent' ? offerAgent(club, id, amount) : setCreditLimit(club, id, amount)); saveClub(); } catch (err) { alert(err.message); }
    render();
  } else if (kind === 'settle') chipAction(id, () => settle(club, id, amount, Date.now(), why));
}

// Runs a chip change for member `id`, then sends them their updated account.
async function chipAction(id, fn) {
  let e;
  try {
    e = fn();
  } catch (err) {
    alert(err.message);
    return;
  }
  saveClub();
  render();
  await sendToPlayer(account(club, id, e?.n ? e.n - 1 : Infinity));
}

function closeClub() {
  if (Object.values(club.members).some(m => m.seat)) { alert('People are still at tables. Close the tables first.'); return; }
  if (!confirm(`Close ${club.name}? Its members and records are deleted from this browser.`)) return;
  tableHost = null;
  hostNet?.close();
  hostNet = null;
  club = null;
  verifier = null;
  try { localStorage.removeItem(CLUB_KEY); localStorage.removeItem(SENDERS_KEY); } catch {}
  render();
}

function link() {
  const relay = relayUrl();
  return inviteLink(club, location.href, relay !== wsUrl(DEFAULT_RELAY) ? relay : '');
}

// ---- joining ----

function saveMemberships() {
  save(MEMBERSHIPS_KEY, memberships);
}

function connectMembership(mem) {
  if (playerNets.has(mem.code)) return;
  // keys: this connection's key pair for encrypted table updates (e2e.js);
  // aes: the key shared with the host, for the host key in aesFor.
  const entry = {net: null, online: false, hostHere: false, sends: Promise.resolve(), inbox: Promise.resolve(), keys: newKeyPair(), aes: null, aesFor: ''};
  playerNets.set(mem.code, entry);
  const greet = async () => {
    // Never ask to join without a name: the host would see a nameless player.
    if (mem.status === 'new' && !myName()) { mem.error = 'Enter your name above and click Save to send your request.'; render(); return; }
    const key = (await entry.keys).pub;
    const body = mem.status === 'new'
      ? {type: 'join', club: mem.code, invite: mem.invite, name: myName(), key}
      : {type: 'hello', club: mem.code, name: myName(), since: lastEntry(mem), key};
    sendToHost(mem.code, body);
    // Back at a club table after the host (or this page) reconnected.
    if (seatedAt?.code === mem.code) sendToHost(mem.code, {type: 'table', club: mem.code, table: seatedAt.table, cmd: {type: 'join', name: myName()}});
  };
  const handle = async msg => {
    if (msg?.type === 'host_away' || msg?.type === 'host_gone') {
      entry.hostHere = false;
      if (seatedAt?.code === mem.code) seatedAt.handlers.onMessage({type: 'host_gone'});
      render();
      return;
    }
    if (msg?.type === 'host_back') { entry.hostHere = true; greet(); render(); return; }
    if (msg?.type === 'queue_full') return;
    // A club table's update for this player: only ones encrypted with the
    // key shared with the host count. Anything else (the relay can send
    // whatever it likes) is ignored.
    if (msg?.type === 'table' && !msg.sig) {
      if (!msg.enc || !entry.aes) return;
      let update;
      try { update = await openBox(entry.aes, msg.enc); } catch { console.warn('club: a table update didn’t decrypt; ignored'); return; }
      if (seatedAt?.code === mem.code && seatedAt.table === msg.table) tableUpdate(update);
      return;
    }
    if (await playerReceive(mem, msg)) {
      // A new host key (the host's page restarted): derive the shared key.
      if (mem.hostKey && mem.hostKey !== entry.aesFor) {
        const keys = await entry.keys;
        entry.aes = await sharedKey(keys, mem.hostKey, {context: `club:${mem.code}`, hostId: mem.hostId, playerId: me.id, hostPub: mem.hostKey, playerPub: keys.pub});
        entry.aesFor = mem.hostKey;
      }
      if (mem.tableError) {
        const {table, reason} = mem.tableError;
        mem.tableError = null;
        if (seatedAt?.code === mem.code && seatedAt.table === table) tableUpdate({type: 'rejected', reason, fatal: true});
      }
      saveMemberships();
      render();
    }
  };
  entry.net = connect(mem.code, 'guest', me.id, {
    onOpen() { entry.online = true; entry.hostHere = true; mem.error = ''; greet(); render(); },
    // One message at a time, in order: a new host key must be in place
    // before the encrypted updates after it.
    onMessage(msg) { entry.inbox = entry.inbox.then(() => handle(msg)).catch(e => console.warn(e)); },
    onStatus(s) { entry.online = !s; render(); },
    // 4004 means the relay had no host and doesn't hold requests (a relay
    // older than queue mode).
    onFail(reason) {
      entry.online = false;
      playerNets.delete(mem.code);
      mem.error = /No table/.test(reason) ? 'The host isn’t online, and this relay can’t hold your request. Try again when the host is online.' : reason;
      render();
    },
  }, {queue: true, persistent: true});
}

function joinFromInvite(name) {
  const n = String(name || '').trim().slice(0, MAX_PLAYER_NAME);
  if (!n) { note = 'Enter the name the host will see.'; render(); return; }
  try { localStorage.setItem(NAME_KEY, n); } catch {}
  let mem = memberships.find(m => m.code === invite.code);
  if (mem) {
    mem.invite = invite.invite;
    if (mem.status !== 'member' && mem.status !== 'pending') mem.status = 'new';
  } else {
    mem = newMembership(invite);
    memberships.push(mem);
  }
  saveMemberships();
  invite = null;
  note = '';
  clearInviteFromAddress();
  const existing = playerNets.get(mem.code);
  if (existing) { existing.net.close(); playerNets.delete(mem.code); }
  connectMembership(mem);
  render();
}

// Saves the display name and tells each club's host: a pending request is
// sent (or re-sent) with it, and members' names are updated.
async function setName(name) {
  const n = String(name || '').trim().slice(0, MAX_PLAYER_NAME);
  if (!n) { alert('Enter a name.'); return; }
  try { localStorage.setItem(NAME_KEY, n); } catch {}
  for (const m of memberships) {
    m.error = '';
    const body = m.status === 'new'
      ? {type: 'join', club: m.code, invite: m.invite, name: n}
      : {type: 'hello', club: m.code, name: n};
    sendToHost(m.code, body);
  }
  render();
}

// ---- hand history (#71) and the replayer (#72) ----

const KEEP_KEY = 'ducyKeepHands';
const keepHands = () => { try { return Number(localStorage.getItem(KEEP_KEY)) || PLAYER_KEEP_HANDS; } catch { return PLAYER_KEEP_HANDS; } };
const handLists = new Map(); // `${club}|${who}` → records, newest first (loaded on demand)
let historyOpen = new Set(); // which history sections are open: `${club}|${who}`
let historyTable = {}; // `${club}|${who}` → table filter ('' for all)
let replay = null; // {rec, frames, i, playing}

async function storeHand(rec, keep) {
  try {
    await saveHand(rec);
    await prune(rec.club, rec.who, keep);
    if (historyOpen.has(`${rec.club}|${rec.who}`)) await loadHands(rec.club, rec.who);
  } catch (e) {
    console.warn('hand history:', e);
  }
}

async function loadHands(code, who) {
  try {
    handLists.set(`${code}|${who}`, await listHands(code, who));
  } catch (e) {
    console.warn(e);
    handLists.set(`${code}|${who}`, []);
  }
  render();
}

function toggleHistory(code, who) {
  const k = `${code}|${who}`;
  if (historyOpen.has(k)) historyOpen.delete(k);
  else { historyOpen.add(k); loadHands(code, who); }
  render();
}

const SUIT = {s: '♠', h: '♥', d: '♦', c: '♣'};
const cardSpan = c => (c ? `<span class="cl-card s-${c[1]}">${esc(c[0])}${SUIT[c[1]] || ''}</span>` : '<span class="cl-card back"></span>');

// A club's stored hands for `who`, with a table filter, as a list to replay.
function handsHtml(code, who, label) {
  const k = `${code}|${who}`;
  const isOpen = historyOpen.has(k);
  let h = `<div class="cl-hands"><button class="link-btn" data-cl="hands" data-code="${esc(code)}" data-who="${esc(who)}">${isOpen ? '▾' : '▸'} ${esc(label)}</button>`;
  if (!isOpen) return h + '</div>';
  const all = handLists.get(k);
  if (!all) return h + '<span class="pl-meta">Loading…</span></div>';
  const tables = [...new Map(all.map(r => [r.table, r.tableName])).entries()];
  const filter = historyTable[k] || '';
  const rows = all.filter(r => !filter || r.table === filter);
  if (tables.length > 1) {
    h += `<select class="pl-text cl-handfilter" data-handfilter="${esc(k)}"><option value="">All tables</option>${tables.map(([id, n]) => `<option value="${esc(id)}"${id === filter ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  }
  if (!rows.length) return h + '<p class="pl-meta">No hands yet.</p></div>';
  h += '<ul class="cl-list cl-handlist">';
  for (const r of rows.slice(0, 100)) {
    const mine = r.who !== 'host' ? r.seats[0] : null;
    h += `<li><span class="pl-meta">${new Date(r.at).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}</span>`;
    h += `<span>${esc(r.tableName)} #${r.hand}</span><span class="cl-chips">pot ${chips(r.pot)}</span>`;
    h += mine ? `<span class="${mine.net > 0 ? 'cl-up' : mine.net < 0 ? 'cl-down' : 'pl-meta'}">${mine.net > 0 ? '+' : ''}${chips(mine.net)}</span>` : `<span class="pl-meta">${esc(summary(r))}</span>`;
    h += `<span class="cl-acts"><button class="btn-small" data-cl="replay" data-id="${esc(r.id)}">Replay</button></span></li>`;
  }
  return h + '</ul></div>';
}

// Win/loss per table session (from the ledger) and totals.
function resultsHtml(entries, names = null, tableNames = {}) {
  const sessions = tableSessions(entries);
  if (!sessions.length) return '';
  const totals = totalsByMember(sessions);
  const name = id => (names ? names[id] || id : 'You');
  let h = '<details class="cl-history"><summary>Results by table session</summary>';
  if (names) {
    h += '<ul class="cl-results">' + Object.entries(totals).sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `<li><span>${esc(name(id))}</span><span class="${n > 0 ? 'cl-up' : n < 0 ? 'cl-down' : ''}">${n > 0 ? '+' : ''}${chips(n)}</span></li>`).join('') + '</ul>';
  }
  h += '<ul>';
  for (const s of sessions.slice(0, 100)) {
    h += `<li><span class="pl-meta">${when(s.start)}</span> ${names ? `${esc(name(s.member))} · ` : ''}${esc(tableNames[s.table] || 'table')}: in ${chips(s.put)}${s.open ? ', still playing' : `, out ${chips(s.took)} → <strong class="${s.net > 0 ? 'cl-up' : s.net < 0 ? 'cl-down' : ''}">${s.net > 0 ? '+' : ''}${chips(s.net)}</strong>`}</li>`;
  }
  return h + '</ul></details>';
}

async function openReplay(id) {
  const rec = await getHand(id);
  if (!rec) return;
  replay = {rec, frames: replayFrames(rec), i: 0, playing: null};
  render();
}

function stepReplay(to) {
  if (!replay) return;
  replay.i = Math.max(0, Math.min(replay.frames.length - 1, to));
  render();
}

function toggleReplayPlay() {
  if (!replay) return;
  if (replay.playing) { clearInterval(replay.playing); replay.playing = null; render(); return; }
  if (replay.i >= replay.frames.length - 1) replay.i = 0;
  replay.playing = setInterval(() => {
    if (!replay || replay.i >= replay.frames.length - 1) { clearInterval(replay?.playing); if (replay) replay.playing = null; render(); return; }
    stepReplay(replay.i + 1);
  }, 900);
  render();
}

function closeReplay() {
  if (replay?.playing) clearInterval(replay.playing);
  replay = null;
  render();
}

function replayHtml() {
  const {rec, frames, i} = replay;
  const f = frames[i];
  const starts = streetStarts(frames);
  let h = '<div class="cl-replay-bg" data-cl="replay-close"></div><div class="cl-replay" role="dialog" aria-label="Hand replay">';
  h += `<div class="cl-replay-head"><b>${esc(rec.tableName)} · hand ${rec.hand}</b><span class="pl-meta">${new Date(rec.at).toLocaleString()} · blinds ${rec.sb}/${rec.bb}</span><button class="link-btn" data-cl="replay-close">Close</button></div>`;
  h += `<div class="cl-replay-board">${[0, 1, 2, 3, 4].map(k => (f.board[k] ? cardSpan(f.board[k]) : '<span class="cl-card slot"></span>')).join('')}<span class="cl-chips">Pot ${chips(f.pot)}</span></div>`;
  h += '<ul class="cl-replay-seats">';
  f.seats.forEach((s, k) => {
    if (!s.inHand) return;
    const btn = k === rec.button ? ' <span class="pl-meta">(D)</span>' : '';
    // Cards the viewer saw: their own, and any shown down (only at the end).
    const shownNow = s.cards && (rec.who !== 'host' && k === 0 || i === frames.length - 1);
    const cards = s.cards && shownNow ? s.cards.map(cardSpan).join('') : new Array(rec.holeCards).fill(null).map(cardSpan).join('');
    h += `<li class="${s.folded ? 'folded' : ''}${f.event?.seat === k ? ' acting' : ''}"><span class="cl-name">${esc(s.name)}${btn}</span><span class="cl-hole">${cards}</span>`;
    h += `<span class="cl-chips">${chips(s.stack)}</span>${s.bet ? `<span class="cl-bet">bet ${chips(s.bet)}</span>` : ''}${s.folded ? '<span class="pl-meta">folded</span>' : ''}${s.allIn ? '<span class="pl-meta">all-in</span>' : ''}</li>`;
  });
  h += '</ul>';
  h += `<p class="cl-replay-text">${esc(f.text)}</p>`;
  h += '<div class="cl-replay-controls">';
  h += `<button class="btn-small" data-cl="replay-to" data-i="0" title="Start">⏮</button><button class="btn-small" data-cl="replay-to" data-i="${i - 1}"${i ? '' : ' disabled'} title="Back (←)">◀</button>`;
  h += `<button class="btn-small primary" data-cl="replay-play">${replay.playing ? 'Pause' : 'Play'}</button>`;
  h += `<button class="btn-small" data-cl="replay-to" data-i="${i + 1}"${i < frames.length - 1 ? '' : ' disabled'} title="Forward (→)">▶</button><button class="btn-small" data-cl="replay-to" data-i="${frames.length - 1}" title="End">⏭</button>`;
  h += `<span class="pl-meta">${i + 1}/${frames.length}</span>`;
  h += STREETS.filter(s => s in starts).map(s => `<button class="cc-btn${f.street === s ? ' on' : ''}" data-cl="replay-to" data-i="${starts[s]}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('');
  return h + '</div></div>';
}

// ---- playing at a club table ----

// Sits down at a club table: the #play page draws it (play.js), and its
// commands go to the host signed, over this club's connection.
function sitAt(code, table) {
  const mem = memberships.find(m => m.code === code);
  const t = mem?.tables?.find(x => x.id === table);
  if (!mem || !t) return;
  joinTableVia(handlers => {
    seatedAt = {code, table, handlers};
    return {
      send: cmd => sendToHost(code, {type: 'table', club: code, table, cmd}),
      close: () => { if (seatedAt?.table === table) seatedAt = null; },
    };
  }, {
    label: `${mem.name} · ${t.name}`,
    onLeave: why => { seatedAt = null; note = why || ''; location.hash = 'clubs'; },
    // Each hand you played goes in your hand history (#71), as you saw it.
    onHand: view => {
      if (view.seats[0]?.sitting_out || view.seats[0]?.empty) return;
      storeHand(handRecord({club: code, table, tableName: t.name, game: t.game, view, who: me.id}), {keep: keepHands()});
    },
  });
  location.hash = 'play';
}

function tableUpdate(u) {
  if (!seatedAt || !u) return;
  // Refused for good (not a member, at another table, table closed).
  if (u.type === 'rejected' && u.fatal) { seatedAt.handlers.onFail(u.reason); return; }
  seatedAt.handlers.onMessage(u);
}

function leaveMembership(code) {
  const mem = memberships.find(m => m.code === code);
  if (!mem || !confirm(`Forget ${mem.name || code}? You can rejoin with an invite link.`)) return;
  playerNets.get(code)?.net.close();
  playerNets.delete(code);
  memberships = memberships.filter(m => m.code !== code);
  saveMemberships();
  render();
}

// Keeps ?relay= (it's this browser's setting) and drops the invite.
function clearInviteFromAddress() {
  const u = new URL(location.href);
  for (const k of ['club', 'invite', 'host']) u.searchParams.delete(k);
  history.replaceState(null, '', u.toString());
}

// ---- drawing ----

function render() {
  if (!open || !root) return;
  let h = '<div class="pl-wrap cl-wrap">';
  h += '<div class="pl-head"><h1>Clubs</h1><p>Run a regular game with friends: invite them with a link, approve who joins, and (soon) run tables and give out chips. Chips are play money.</p></div>';
  if (!me) {
    h += `<p class="pl-meta">${esc(note || 'Loading…')}</p></div>`;
    root.innerHTML = h;
    return;
  }
  if (note) h += `<p class="pl-desc pl-neterr">${esc(note)}</p>`;
  if (invite) h += inviteHtml();
  h += hostHtml();
  h += membershipsHtml();
  if (memberships.length) {
    h += `<p class="pl-meta">Keep your last ${[100, 500, 2000].map(n => `<button class="cc-btn${keepHands() === n ? ' on' : ''}" data-cl="keep-hands" data-n="${n}">${n}</button>`).join(' ')} hands in each club.</p>`;
  }
  h += `<p class="pl-meta">Your player ID is <code class="pl-pid">${esc(me.id)}</code>. Back it up from Play → Play with friends.</p>`;
  h += relayHtml();
  if (replay) h += replayHtml();
  h += '</div>';
  // Messages arriving redraw the page; keep what the host is typing in an open form.
  const typing = root.querySelector('form[data-chipform]');
  const kept = typing && {key: typing.dataset.chipform + typing.dataset.id, values: [...typing.elements].map(el => el.value), focus: document.activeElement?.name};
  root.innerHTML = h;
  const form = root.querySelector('form[data-chipform]');
  if (kept && form && form.dataset.chipform + form.dataset.id === kept.key) {
    [...form.elements].forEach((el, i) => { if (kept.values[i] != null && el.tagName === 'INPUT') el.value = kept.values[i]; });
    if (kept.focus) form.elements[kept.focus]?.focus();
  }
}

// Which relay this page uses. A page served locally but using the site's
// relay is almost always a mistake when testing, so it says so.
function relayHtml() {
  const relay = relayUrl();
  const live = relay === wsUrl(DEFAULT_RELAY);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (live && local) return `<p class="pl-desc pl-neterr">This local page is using the live relay (${esc(relay)}). To test against a local relay, open it with <code>?relay=ws://localhost:8788</code>; invite links then carry it.</p>`;
  return `<p class="pl-meta">Relay: ${esc(relay)}</p>`;
}

function inviteHtml() {
  let h = '<section class="cl-card cl-invite"><h2>You’re invited</h2>';
  if (invite.hostId === me.id) {
    h += '<p class="pl-desc">That’s an invite to your own club.</p><div class="pl-actions"><button class="btn-small" data-cl="dismiss">OK</button></div></section>';
    return h;
  }
  h += `<p class="pl-desc">Ask to join club <strong>${esc(invite.code)}</strong>, hosted by player <code>${esc(invite.hostId)}</code>. The host sees your name and player ID and approves your request.</p>`;
  h += `<div class="pl-row"><span class="pl-label">Your name</span><input class="pl-text" id="cl-name" maxlength="${MAX_PLAYER_NAME}" placeholder="Name" value="${esc(myName())}"></div>`;
  h += '<div class="pl-actions"><button class="tr-start" data-cl="join">Ask to join</button><button class="btn-small" data-cl="dismiss">Not now</button></div></section>';
  return h;
}

function hostHtml() {
  if (!club) {
    let h = '<section class="cl-card"><h2>Host a club</h2>';
    h += '<p class="pl-desc">The club lives in this browser: keep this page open while you run it. Players who ask to join while you’re away are waiting for you when you come back.</p>';
    h += `<div class="pl-row"><span class="pl-label">Club name</span><input class="pl-text" id="cl-clubname" maxlength="${MAX_CLUB_NAME}" placeholder="Friday Night Game"></div>`;
    h += '<div class="pl-actions"><button class="tr-start" data-cl="create">Create club</button></div></section>';
    return h;
  }
  const pending = membersByStatus(club, 'pending');
  const members = membersByStatus(club, 'member');
  const stalled = hostOnline && hostNet && !hostNet.healthy();
  const badge = stalled ? 'No answer from the relay' : hostOnline ? 'Open' : hostNet ? 'Connecting…' : 'Offline';
  let h = `<section class="cl-card"><div class="cl-title"><h2>${esc(club.name)}</h2><span class="cl-badge${hostOnline ? ' on' : ''}">${badge}</span>`;
  if (!hostNet) h += '<button class="btn-small" data-cl="reconnect">Reconnect</button>';
  h += '</div>';
  if (hostNet && (stalled || !hostOnline)) h += '<p class="pl-desc pl-neterr">The tables are paused until the connection is back: no one is folded or timed out meanwhile.</p>';
  if (!hostNet) h += '<p class="pl-desc pl-neterr">This tab isn’t hosting the club right now, so players can’t reach it from here, and changes made here reach them only when they next connect. If the club is open in another tab, use that one.</p>';
  h += `<p class="pl-meta">You host this club · code ${esc(club.code)} · ${members.length} member${members.length === 1 ? '' : 's'}</p>`;
  h += '<div class="pl-row"><span class="pl-label">Invite link</span><div class="pl-opts cl-link">';
  h += `<input class="pl-text" readonly value="${esc(link())}" id="cl-link">`;
  h += `<button class="btn-small" data-cl="copy">${copied ? 'Copied' : 'Copy'}</button><button class="btn-small" data-cl="revoke" title="Make a new link; the old one stops working">New link</button></div></div>`;
  h += `<h3>Requests to join${pending.length ? ` (${pending.length})` : ''}</h3>`;
  if (!pending.length) h += '<p class="pl-meta">No one is waiting.</p>';
  else {
    h += '<ul class="cl-list">';
    for (const m of pending) {
      h += `<li><span class="cl-name">${esc(m.name)}</span><code>${esc(m.id)}</code><span class="pl-meta">asked ${when(m.requestedAt)}${m.agentOf && club.members[m.agentOf] ? ` · via ${esc(club.members[m.agentOf].name)}` : ''}</span>`;
      h += `<span class="cl-acts"><button class="btn-small primary" data-cl="approve" data-id="${esc(m.id)}">Approve</button><button class="btn-small" data-cl="decline" data-id="${esc(m.id)}">Decline</button></span></li>`;
    }
    h += '</ul>';
  }
  const asking = members.filter(m => m.request && !m.agentOf).sort((a, b) => a.request.at - b.request.at);
  if (asking.length) {
    h += `<h3>Chip requests (${asking.length})</h3><ul class="cl-list">`;
    for (const m of asking) {
      h += `<li><span class="cl-name">${esc(m.name)}</span><span class="cl-chips">asks for ${chips(m.request.amount)}</span>`;
      if (m.request.note) h += `<span class="pl-meta">“${esc(m.request.note)}”</span>`;
      h += `<span class="cl-acts"><button class="btn-small primary" data-cl="grant" data-id="${esc(m.id)}">Give ${chips(m.request.amount)}</button>`;
      h += `<button class="btn-small" data-cl="grant-other" data-id="${esc(m.id)}">Other amount</button><button class="btn-small" data-cl="deny" data-id="${esc(m.id)}">Decline</button></span>`;
      if (chipForm?.kind === 'grant') h += chipFormHtml(m);
      h += '</li>';
    }
    h += '</ul>';
  }
  h += tablesHtml();
  h += `<h3>Members${members.length ? ` (${members.length})` : ''}</h3>`;
  if (!members.length) h += '<p class="pl-meta">No members yet. Send someone the invite link.</p>';
  else {
    // Agents' players are listed under their agent (#75).
    const agents = members.filter(m => m.agent === 'yes');
    const order = members.filter(m => !m.agentOf || !agents.some(a => a.id === m.agentOf))
      .flatMap(m => (m.agent === 'yes' ? [m, ...members.filter(p => p.agentOf === m.id)] : [m]));
    h += '<ul class="cl-list">';
    for (const m of order) h += memberRowHtml(m, agents);
    h += '</ul>';
  }
  const t = totals(club);
  h += `<p class="pl-meta">Chips out: ${chips(t.issued - t.reclaimed)} (given ${chips(t.issued)}, taken back ${chips(t.reclaimed)}) · in balances ${chips(t.balances)} · on tables ${chips(t.onTables)}${t.conserved ? '' : ' · <span class="pl-neterr">doesn’t add up</span>'}</p>`;
  h += '<div class="pl-row"><span class="pl-label">Rathole</span><div class="pl-opts">';
  h += [0, 1, 2, 4, 8, 24].map(n => `<button class="cc-btn${club.ratholeHours === n ? ' on' : ''}" data-cl="rathole" data-hours="${n}">${n ? n + ' h' : 'Off'}</button>`).join('');
  h += '</div><span class="pl-desc">A player who leaves a table must come back to it with at least what they left with, for this long.</span></div>';
  h += '<div class="pl-row"><span class="pl-label">Sit-out limit</span><div class="pl-opts">';
  h += [5, 10, 15, 30, 0].map(m => `<button class="cc-btn${(club.sitOutMins ?? 10) === m ? ' on' : ''}" data-cl="sitout-mins" data-mins="${m}">${m ? m + ' min' : 'None'}</button>`).join('');
  h += '</div><span class="pl-desc">The default for new tables: someone sitting out longer gives up their seat, and their chips go back to their balance.</span></div>';
  // Hand history and results (#71): the host's hands show no hidden cards.
  h += '<h3>History</h3>';
  h += handsHtml(club.code, 'host', 'Hands at your tables');
  const names = Object.fromEntries(Object.values(club.members).map(m => [m.id, m.name]));
  const tableNames = Object.fromEntries((club.tables || []).map(t => [t.id, t.name]));
  h += resultsHtml(club.chips.ledger, names, tableNames);
  h += `<div class="pl-row"><span class="pl-label">Keep hands</span><div class="pl-opts">${[1, 7, 30].map(d => `<button class="cc-btn${(club.keepDays ?? HOST_KEEP_DAYS) === d ? ' on' : ''}" data-cl="keep-days" data-days="${d}">${d} day${d > 1 ? 's' : ''}</button>`).join('')}</div></div>`;
  if (club.log?.length) {
    h += `<details class="cl-history"><summary>Assistant activity (${club.log.length})</summary><ul>`;
    for (const l of [...club.log].reverse().slice(0, 100)) h += `<li><span class="pl-meta">${when(l.at)}</span> ${esc(l.text)}</li>`;
    h += '</ul></details>';
  }
  h += '<div class="pl-actions"><button class="link-btn" data-cl="close">Close this club</button></div></section>';
  return h;
}

// One member on the host's dashboard: balance, chips on a table, and what the
// host can do. An agent shows their account and credit (#75, #76); a player
// under an agent is indented, and any non-agent can be assigned to an agent.
function memberRowHtml(m, agents) {
  const under = m.agentOf && club.members[m.agentOf];
  let h = `<li class="${under ? 'cl-under' : ''}"><span class="cl-name">${esc(m.name)}</span><code>${esc(m.id)}</code><span class="cl-chips" title="Club balance">${chips(m.balance)} chips</span>`;
  if (m.seat) h += `<span class="pl-meta">${chips(m.seat.stack)} on a table</span>`;
  if (m.agent === 'yes') {
    const a = accountOf(club, m.id);
    h += `<span class="pl-meta">agent · account ${chips(a.total)} · credit used ${chips(a.creditUsed)}/${chips(a.limit)}</span>`;
  }
  h += `<span class="cl-acts"><button class="btn-small" data-cl="give" data-id="${esc(m.id)}">Give</button>`;
  h += `<button class="btn-small" data-cl="take" data-id="${esc(m.id)}"${m.balance > 0 ? '' : ' disabled'}>Take back</button>`;
  h += m.role === 'assistant'
    ? `<button class="btn-small" data-cl="revoke-role" data-id="${esc(m.id)}" title="Stop ${esc(m.name)} being a game assistant">Assistant ✕</button>`
    : m.role === 'offered'
      ? `<button class="btn-small" data-cl="revoke-role" data-id="${esc(m.id)}" title="Withdraw the offer">Offered ✕</button>`
      : `<button class="btn-small" data-cl="offer-role" data-id="${esc(m.id)}" title="Let ${esc(m.name)} help run the club">Make assistant</button>`;
  if (m.agent === 'yes') {
    h += `<button class="btn-small" data-cl="settle" data-id="${esc(m.id)}">Settle</button><button class="btn-small" data-cl="limit" data-id="${esc(m.id)}">Credit limit</button>`;
    h += `<button class="btn-small" data-cl="revoke-agent" data-id="${esc(m.id)}" title="Stop ${esc(m.name)} being an agent">Agent ✕</button>`;
  } else if (m.agent === 'offered') {
    h += `<button class="btn-small" data-cl="revoke-agent" data-id="${esc(m.id)}" title="Withdraw the offer">Agent offered ✕</button>`;
  } else if (!m.agentOf) {
    h += `<button class="btn-small" data-cl="make-agent" data-id="${esc(m.id)}" title="Let ${esc(m.name)} bring in and back players">Make agent</button>`;
  }
  h += `<button class="btn-small" data-cl="remove" data-id="${esc(m.id)}">Remove</button></span>`;
  if (!m.agent && agents.length) {
    h += `<label class="pl-meta cl-assign">Agent <select class="pl-text" data-assign="${esc(m.id)}"><option value="">none</option>`;
    h += agents.map(a => `<option value="${esc(a.id)}"${m.agentOf === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('') + '</select></label>';
  }
  if (chipForm && chipForm.kind !== 'grant') h += chipFormHtml(m);
  return h + '</li>';
}

function membershipsHtml() {
  if (!memberships.length) return '';
  let h = '<section class="cl-card"><h2>Clubs you’ve joined</h2>';
  h += `<div class="pl-row"><span class="pl-label">Your name</span><input class="pl-text" id="cl-myname" maxlength="${MAX_PLAYER_NAME}" placeholder="Name" value="${esc(myName())}">`;
  h += '<button class="btn-small" data-cl="setname">Save</button><span class="pl-desc">What hosts see.</span></div><ul class="cl-list">';
  for (const m of memberships) {
    const n = playerNets.get(m.code);
    const live = n?.online ? (n.hostHere ? 'Host online' : 'Host away') : 'Offline';
    h += `<li><span class="cl-name">${esc(m.name || m.code)}</span><span class="cl-status cl-${esc(m.status)}">${esc(STATUS_TEXT[m.status] || m.status)}</span>`;
    h += `<span class="pl-meta">${live}</span><span class="cl-acts">`;
    if (!n) h += `<button class="btn-small" data-cl="retry" data-code="${esc(m.code)}">Try again</button>`;
    h += `<button class="btn-small" data-cl="forget" data-code="${esc(m.code)}">Forget</button></span>`;
    if (m.error) h += `<span class="pl-desc pl-neterr cl-err">${esc(m.error)}</span>`;
    if (m.status === 'member') h += accountHtml(m, !!n?.hostHere);
    if (m.status === 'member' && m.role === 'offered') {
      h += '<div class="cl-account cl-offer"><span>The host asked you to be a <b>game assistant</b>: approve players, give out chips from your own balance, and open and close tables.</span>';
      h += `<span><button class="btn-small primary" data-cl="role-yes" data-code="${esc(m.code)}">Accept</button> <button class="btn-small" data-cl="role-no" data-code="${esc(m.code)}">No thanks</button></span></div>`;
    }
    if (m.status === 'member' && m.role === 'assistant') h += adminHtml(m, !!n?.hostHere);
    if (m.status === 'member' && m.agent === 'offered') {
      h += `<div class="cl-account cl-offer"><span>The host asked you to be an <b>agent</b>, with a credit limit of ${chips(m.creditLimit)}: recruit your own players, give them chips from your balance, and back them on credit.</span>`;
      h += `<span><button class="btn-small primary" data-cl="agent-yes" data-code="${esc(m.code)}">Accept</button> <button class="btn-small" data-cl="agent-no" data-code="${esc(m.code)}">No thanks</button></span></div>`;
    }
    if (m.status === 'member' && m.agent === 'yes') h += agentHtml(m, !!n?.hostHere);
    h += '</li>';
  }
  h += '</ul></section>';
  return h;
}

const KIND_TEXT = {issue: 'Given by the host', grant: 'Request granted', reclaim: 'Taken back by the host', buy_in: 'Bought in', top_up: 'Topped up', cash_out: 'Cashed out', transfer_in: 'Received chips', transfer_out: 'Gave chips', settle: 'Settlement recorded'};

// A member's chips in a club: balance, a request, and their own ledger copy.
function accountHtml(m, hostHere) {
  let h = '<div class="cl-account">';
  h += `<div class="cl-balance"><span class="cl-chips">${chips(m.balance)} chips</span>`;
  if (m.entries?.length) h += m.ledgerOk === false
    ? '<span class="pl-neterr" title="Your copy of the ledger doesn’t add up to the balance the host reports">✗ doesn’t match your records</span>'
    : '<span class="pl-meta" title="Your copy of the ledger adds up to this balance">✓ matches your records</span>';
  h += '</div>';
  if (m.request) {
    h += `<div class="pl-row"><span class="pl-meta">You asked for ${chips(m.request.amount)}${m.request.note ? ` (“${esc(m.request.note)}”)` : ''}; waiting for the host.</span>`;
    h += `<button class="btn-small" data-cl="cancel-ask" data-code="${esc(m.code)}"${hostHere ? '' : ' disabled'}>Cancel</button></div>`;
  } else {
    h += `<div class="pl-row cl-ask"><input class="pl-text" type="number" min="1" step="1" placeholder="Chips" data-ask-amt="${esc(m.code)}">`;
    h += `<input class="pl-text" maxlength="${MAX_NOTE}" placeholder="Note (optional)" data-ask-note="${esc(m.code)}">`;
    h += `<button class="btn-small primary" data-cl="ask" data-code="${esc(m.code)}"${hostHere ? '' : ' disabled title="The host is away"'}>Ask for chips</button></div>`;
  }
  if (m.tables?.length) {
    h += '<ul class="cl-tables">';
    for (const t of m.tables) {
      const here = seatedAt?.code === m.code && seatedAt.table === t.id;
      h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameLabel(t.game))} · ${t.sb}/${t.bb} · buy-in ${chips(t.min)}–${chips(t.max)} · ${t.taken}/${t.seats} seated</span>`;
      h += here
        ? '<button class="btn-small primary" data-cl="to-table">Back to the table</button>'
        : `<button class="btn-small primary" data-cl="sit" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${hostHere && !seatedAt && t.taken < t.seats ? '' : ' disabled'}>Sit</button>`;
      h += '</li>';
    }
    h += '</ul>';
  } else h += '<p class="pl-meta">No tables open right now.</p>';
  h += handsHtml(m.code, me.id, 'Your hands');
  const tableNames = Object.fromEntries((m.tables || []).map(t => [t.id, t.name]));
  h += resultsHtml(m.entries || [], null, tableNames);
  if (m.entries?.length) {
    h += `<details class="cl-history"><summary>History (${m.entries.length})</summary><ul>`;
    for (const e of [...m.entries].reverse().slice(0, 50)) {
      const sign = ['reclaim', 'buy_in', 'top_up', 'transfer_out'].includes(e.kind) ? '−' : '+';
      h += `<li><span class="pl-meta">${when(e.at)}</span> ${esc(KIND_TEXT[e.kind] || e.kind)} <strong>${sign}${chips(e.amount)}</strong>${e.note ? ` <span class="pl-meta">“${esc(e.note)}”</span>` : ''} <span class="pl-meta">→ ${chips(e.balance)}</span></li>`;
    }
    h += '</ul></details>';
  }
  return h + '</div>';
}

// ---- an agent's tools (#74, #75, #76) ----

let agentForm = null; // {code, kind: 'give' | 'take' | 'grant', id}

function agentCmd(code, cmd) {
  const mem = memberships.find(m => m.code === code);
  if (mem) mem.adminNote = '';
  sendToHost(code, {type: 'agent_cmd', club: code, cmd});
}

function agentFormHtml(code, x) {
  if (agentForm?.code !== code || agentForm.id !== x.id) return '';
  const {kind} = agentForm;
  const label = kind === 'take' ? `Take back from ${x.name} (has ${chips(x.balance)})`
    : kind === 'grant' ? `Give ${x.name} (asked for ${chips(x.request?.amount)})` : `Give ${x.name}`;
  const value = kind === 'take' ? x.balance : kind === 'grant' ? x.request?.amount : '';
  let h = `<form class="cl-chipform" data-agentform="${kind}" data-code="${esc(code)}" data-id="${esc(x.id)}">`;
  h += `<label class="cl-formlabel" for="cl-gamt">${esc(label)}</label>`;
  h += `<input class="pl-text" id="cl-gamt" name="amount" type="number" inputmode="numeric" required min="1" step="1"${kind === 'take' ? ` max="${x.balance}"` : ''} value="${esc(value ?? '')}" placeholder="Chips">`;
  h += `<button class="btn-small primary" type="submit">${kind === 'take' ? 'Take back' : 'Give'}</button><button class="btn-small" type="button" data-cl="cancel-gform">Cancel</button></form>`;
  return h;
}

// The agent's link: like the club's, with their own invite token, so the
// people who use it are their players.
function agentLink(m) {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('club', m.code);
  u.searchParams.set('invite', m.agentView.invite);
  u.searchParams.set('host', m.hostId);
  const relay = relayUrl();
  if (relay !== wsUrl(DEFAULT_RELAY)) u.searchParams.set('relay', relay);
  u.hash = 'clubs';
  return u.toString();
}

function agentHtml(m, hostHere) {
  const a = m.agentView;
  let h = '<div class="cl-account cl-admin"><b>Agent tools</b>';
  if (!hostHere) h += '<span class="pl-meta">The host is away: these work again when the host is back.</span>';
  if (m.adminNote) h += `<span class="pl-neterr">${esc(m.adminNote)}</span>`;
  if (!a) return h + '<span class="pl-meta">Loading…</span></div>';
  const dis = hostHere ? '' : ' disabled';
  h += `<span>Your account: <b class="cl-chips">${chips(a.total)}</b> <span class="pl-meta">(your balance ${chips(a.own)} + your players’ ${chips(a.shares)})</span></span>`;
  h += `<span class="${a.creditUsed ? 'cl-down' : 'pl-meta'}">Credit used ${chips(a.creditUsed)} of ${chips(a.limit)} · you can still give out ${chips(Math.max(0, a.room))}</span>`;
  h += `<div class="pl-row"><span class="pl-label">Your link</span><div class="pl-opts cl-link"><input class="pl-text" readonly value="${esc(agentLink(m))}" data-aglink="${esc(m.code)}"><button class="btn-small" data-cl="ag-copy" data-code="${esc(m.code)}">Copy</button></div></div>`;
  const btn = (act, x, label, extra = '') => `<button class="btn-small${extra}" data-cl="${act}" data-code="${esc(m.code)}" data-id="${esc(x.id)}"${dis}>${label}</button>`;
  if (a.recruits.length) {
    h += `<span class="pl-meta">Asking to join through you (${a.recruits.length})</span><ul class="cl-list">`;
    for (const x of a.recruits) h += `<li><span class="cl-name">${esc(x.name)}</span><code>${esc(x.id)}</code><span class="cl-acts">${btn('ag-approve', x, 'Approve', ' primary')}${btn('ag-decline', x, 'Decline')}</span></li>`;
    h += '</ul>';
  }
  h += `<span class="pl-meta">Your players (${a.players.length})</span>`;
  if (!a.players.length) h += '<span class="pl-meta">No players yet. Send someone your link.</span>';
  else {
    h += '<ul class="cl-list">';
    for (const x of a.players) {
      h += `<li><span class="cl-name">${esc(x.name)}</span><span class="cl-chips">${chips(x.balance)} chips</span>${x.seated ? '<span class="pl-meta">at a table</span>' : ''}`;
      if (x.request) h += `<span class="pl-meta">asks for ${chips(x.request.amount)}</span>`;
      h += '<span class="cl-acts">';
      h += x.request ? `${btn('ag-grant', x, 'Give', ' primary')}${btn('ag-deny', x, 'Decline')}` : btn('ag-give', x, 'Give');
      h += `${btn('ag-take', x, 'Take back')}</span>${agentFormHtml(m.code, x)}</li>`;
    }
    h += '</ul>';
  }
  return h + '</div>';
}

// ---- a game assistant's tools (#62) ----

// The assistant's open form: {code, kind: 'give' | 'grant', id}.
let adminForm = null;

function adminCmd(code, cmd) {
  const mem = memberships.find(m => m.code === code);
  if (mem) mem.adminNote = '';
  sendToHost(code, {type: 'admin_cmd', club: code, cmd});
}

function adminFormHtml(code, x) {
  if (adminForm?.code !== code || adminForm.id !== x.id) return '';
  const grant = adminForm.kind === 'grant';
  let h = `<form class="cl-chipform" data-adminform="${adminForm.kind}" data-code="${esc(code)}" data-id="${esc(x.id)}">`;
  h += `<label class="cl-formlabel" for="cl-aamt">${grant ? `Give ${esc(x.name)} from your chips (asked for ${chips(x.request?.amount)})` : `Give ${esc(x.name)} from your chips`}</label>`;
  h += `<input class="pl-text" id="cl-aamt" name="amount" type="number" inputmode="numeric" required min="1" step="1" value="${grant ? esc(x.request?.amount) : ''}" placeholder="Chips">`;
  h += '<button class="btn-small primary" type="submit">Give</button><button class="btn-small" type="button" data-cl="cancel-aform">Cancel</button></form>';
  return h;
}

function adminHtml(m, hostHere) {
  const a = m.admin;
  let h = '<div class="cl-account cl-admin"><b>Assistant tools</b>';
  if (!hostHere) h += '<span class="pl-meta">The host is away: these work again when the host is back.</span>';
  if (m.adminNote) h += `<span class="pl-neterr">${esc(m.adminNote)}</span>`;
  if (!a) return h + '<span class="pl-meta">Loading…</span></div>';
  const dis = hostHere ? '' : ' disabled';
  const btn = (act, x, label, extra = '') => `<button class="btn-small${extra}" data-cl="${act}" data-code="${esc(m.code)}" data-id="${esc(x.id)}"${dis}>${label}</button>`;
  if (a.pending.length) {
    h += `<span class="pl-meta">Requests to join (${a.pending.length})</span><ul class="cl-list">`;
    for (const x of a.pending) h += `<li><span class="cl-name">${esc(x.name)}</span><code>${esc(x.id)}</code><span class="cl-acts">${btn('a-approve', x, 'Approve', ' primary')}${btn('a-decline', x, 'Decline')}</span></li>`;
    h += '</ul>';
  }
  const asking = a.members.filter(x => x.request);
  if (asking.length) {
    h += `<span class="pl-meta">Chip requests (${asking.length})</span><ul class="cl-list">`;
    for (const x of asking) {
      h += `<li><span class="cl-name">${esc(x.name)}</span><span class="cl-chips">asks for ${chips(x.request.amount)}</span>`;
      h += `<span class="cl-acts">${btn('a-grant', x, 'Give from mine', ' primary')}${btn('a-deny', x, 'Decline')}</span>${adminFormHtml(m.code, x)}</li>`;
    }
    h += '</ul>';
  }
  const others = a.members.filter(x => x.id !== me?.id);
  h += `<span class="pl-meta">Members (${a.members.length})</span><ul class="cl-list">`;
  for (const x of others) {
    h += `<li><span class="cl-name">${esc(x.name)}</span><span class="cl-chips">${chips(x.balance)} chips</span>${x.assistant ? '<span class="pl-meta">assistant</span>' : ''}`;
    h += `<span class="cl-acts">${btn('a-give', x, 'Give')}${x.assistant ? '' : btn('a-remove', x, 'Remove')}</span>${!x.request ? adminFormHtml(m.code, x) : ''}</li>`;
  }
  h += '</ul>';
  const open = a.tables.filter(t => t.status !== 'closed');
  const closed = a.tables.filter(t => t.status === 'closed');
  h += `<span class="pl-meta">Tables (${open.length})</span><ul class="cl-list">`;
  for (const t of open) {
    h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameLabel(t.game))} · ${t.sb}/${t.bb} · ${t.taken}/${t.seats} seated${t.status === 'closing' ? ' · closing' : ''}</span>`;
    if (t.status === 'open') h += `<span class="cl-acts"><button class="btn-small" data-cl="a-close-table" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${dis}>Close</button></span>`;
    h += '</li>';
  }
  for (const t of closed) h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">closed</span><span class="cl-acts"><button class="btn-small" data-cl="a-hide-table" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${dis}>Remove</button></span></li>`;
  h += '</ul>';
  h += tableForm === m.code ? tableFormHtml(m.code) : `<div class="pl-actions"><button class="btn-small" data-cl="a-new-table" data-code="${esc(m.code)}"${dis}>New table</button></div>`;
  return h + '</div>';
}

// Signed messages to a club's host go out one at a time, in order: the host
// refuses one with a lower sequence number than it has seen.
function sendToHost(code, body) {
  const n = playerNets.get(code);
  if (!n) return Promise.resolve();
  n.sends = n.sends.then(async () => {
    const env = await signMessage(me, body);
    n.net?.send(env);
  }).catch(e => console.warn(e));
  return n.sends;
}

// ---- events ----

async function onClick(e) {
  const b = e.target.closest('[data-cl]');
  if (!b) return;
  const act = b.dataset.cl;
  if (act === 'create') createClub(root.querySelector('#cl-clubname')?.value);
  else if (act === 'join') joinFromInvite(root.querySelector('#cl-name')?.value);
  else if (act === 'dismiss') { invite = null; clearInviteFromAddress(); render(); }
  else if (act === 'approve') decide(approve, b.dataset.id);
  else if (act === 'decline') decide(decline, b.dataset.id);
  else if (act === 'remove') { if (confirm('Remove this member from the club?')) decide(removeMember, b.dataset.id); }
  else if (act === 'revoke') { if (confirm('Make a new invite link? The current link stops working for anyone who hasn’t used it yet.')) { revokeInvite(club); saveClub(); render(); } }
  else if (act === 'copy') {
    try { await navigator.clipboard.writeText(link()); } catch { root.querySelector('#cl-link')?.select(); }
    copied = true;
    render();
    setTimeout(() => { copied = false; render(); }, 1500);
  } else if (act === 'close') closeClub();
  else if (act === 'forget') leaveMembership(b.dataset.code);
  else if (act === 'setname') setName(root.querySelector('#cl-myname')?.value);
  else if (act === 'reconnect') { note = ''; startHosting(); render(); }
  else if (act === 'retry') { const m = memberships.find(x => x.code === b.dataset.code); if (m) { m.error = ''; connectMembership(m); render(); } }
  else if (act === 'give') openChipForm('give', b.dataset.id);
  else if (act === 'take') openChipForm('take', b.dataset.id);
  else if (act === 'grant-other') openChipForm('grant', b.dataset.id);
  else if (act === 'cancel-form') { chipForm = null; render(); }
  else if (act === 'grant') { chipForm = null; chipAction(b.dataset.id, () => grantRequest(club, b.dataset.id)); }
  else if (act === 'deny') chipAction(b.dataset.id, () => { declineRequest(club, b.dataset.id); return null; });
  else if (act === 'rathole') { club.ratholeHours = Number(b.dataset.hours); saveClub(); render(); }
  else if (act === 'sitout-mins') { club.sitOutMins = Number(b.dataset.mins); saveClub(); render(); }
  else if (act === 'new-table') { tableForm = true; render(); root.querySelector('form[data-tableform] [name=name]')?.focus(); }
  else if (act === 'cancel-table') { tableForm = false; render(); }
  // The host: agents.
  else if (act === 'make-agent') openChipForm('agent', b.dataset.id);
  else if (act === 'limit') openChipForm('limit', b.dataset.id);
  else if (act === 'settle') openChipForm('settle', b.dataset.id);
  else if (act === 'revoke-agent') { try { const r = revokeAgent(club, b.dataset.id); if (r) { sendToPlayer(r); saveClub(); render(); } } catch (err) { alert(err.message); } }
  // A member: answering an agent offer.
  else if (act === 'agent-yes' || act === 'agent-no') sendToHost(b.dataset.code, {type: 'agent_reply', club: b.dataset.code, accept: act === 'agent-yes'});
  // An agent's tools.
  else if (['ag-give', 'ag-take', 'ag-grant'].includes(act)) {
    const kind = act.slice(3);
    agentForm = agentForm?.id === b.dataset.id && agentForm.kind === kind ? null : {code: b.dataset.code, kind, id: b.dataset.id};
    render();
    root.querySelector('#cl-gamt')?.focus();
  } else if (act === 'cancel-gform') { agentForm = null; render(); }
  else if (act === 'ag-deny') agentCmd(b.dataset.code, {op: 'deny', id: b.dataset.id});
  else if (act === 'ag-approve' || act === 'ag-decline') agentCmd(b.dataset.code, {op: act.slice(3), id: b.dataset.id});
  else if (act === 'ag-copy') {
    const v = root.querySelector(`[data-aglink="${b.dataset.code}"]`)?.value || '';
    try { await navigator.clipboard.writeText(v); } catch { root.querySelector(`[data-aglink="${b.dataset.code}"]`)?.select(); }
  }
  // The host: assistants.
  else if (act === 'offer-role') { try { sendToPlayer(offerAssistant(club, b.dataset.id)); saveClub(); render(); } catch (err) { alert(err.message); } }
  else if (act === 'revoke-role') { const r = revokeRole(club, b.dataset.id); if (r) { sendToPlayer(r); saveClub(); render(); } }
  // A member: answering an offer.
  else if (act === 'role-yes' || act === 'role-no') sendToHost(b.dataset.code, {type: 'role_reply', club: b.dataset.code, accept: act === 'role-yes'});
  // An assistant's tools.
  else if (act === 'a-approve') adminCmd(b.dataset.code, {op: 'approve', id: b.dataset.id});
  else if (act === 'a-decline') adminCmd(b.dataset.code, {op: 'decline', id: b.dataset.id});
  else if (act === 'a-remove') { if (confirm('Remove this member from the club? Their chips go back to the host.')) adminCmd(b.dataset.code, {op: 'remove', id: b.dataset.id}); }
  else if (act === 'a-deny') adminCmd(b.dataset.code, {op: 'deny', id: b.dataset.id});
  else if (act === 'a-give' || act === 'a-grant') {
    const kind = act === 'a-give' ? 'give' : 'grant';
    adminForm = adminForm?.id === b.dataset.id && adminForm.kind === kind ? null : {code: b.dataset.code, kind, id: b.dataset.id};
    render();
    root.querySelector('#cl-aamt')?.focus();
  } else if (act === 'cancel-aform') { adminForm = null; render(); }
  else if (act === 'a-close-table') { if (confirm('Close this table? Everyone is cashed out at the end of the hand.')) adminCmd(b.dataset.code, {op: 'close_table', table: b.dataset.table}); }
  else if (act === 'a-hide-table') adminCmd(b.dataset.code, {op: 'hide_table', table: b.dataset.table});
  else if (act === 'a-new-table') { tableForm = b.dataset.code; render(); root.querySelector('form[data-tableform] [name=name]')?.focus(); }
  else if (act === 'close-table') closeTable(b.dataset.table);
  else if (act === 'watch') watchTable(b.dataset.table);
  // Hand history and the replayer.
  else if (act === 'hands') toggleHistory(b.dataset.code, b.dataset.who);
  else if (act === 'replay') openReplay(b.dataset.id);
  else if (act === 'replay-to') stepReplay(Number(b.dataset.i));
  else if (act === 'replay-play') toggleReplayPlay();
  else if (act === 'replay-close') closeReplay();
  else if (act === 'keep-days') { club.keepDays = Number(b.dataset.days); saveClub(); prune(club.code, 'host', {days: club.keepDays}).then(() => loadHands(club.code, 'host')); render(); }
  else if (act === 'keep-hands') { try { localStorage.setItem(KEEP_KEY, b.dataset.n); } catch {} for (const m of memberships) prune(m.code, me.id, {keep: keepHands()}); render(); }
  else if (act === 'sit') sitAt(b.dataset.code, b.dataset.table);
  else if (act === 'to-table') location.hash = 'play';
  else if (act === 'ask') {
    const code = b.dataset.code;
    const amount = Number(root.querySelector(`[data-ask-amt="${code}"]`)?.value);
    const why = root.querySelector(`[data-ask-note="${code}"]`)?.value || '';
    if (!Number.isSafeInteger(amount) || amount <= 0) { alert('Enter a whole number of chips above 0.'); return; }
    sendToHost(code, {type: 'chip_request', club: code, amount, note: why});
  } else if (act === 'cancel-ask') sendToHost(b.dataset.code, {type: 'cancel_request', club: b.dataset.code});
}

// The replayer's keys: ← → step, Space plays, Esc closes.
function onDocKey(e) {
  if (!replay || !open || e.target.closest?.('input, select, textarea')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); stepReplay(replay.i + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepReplay(replay.i - 1); }
  else if (e.key === ' ') { e.preventDefault(); toggleReplayPlay(); }
  else if (e.key === 'Escape') closeReplay();
}

function onFilter(e) {
  const pid = e.target.dataset?.assign;
  if (pid != null) {
    try { assignToAgent(club, pid, e.target.value || null); saveClub(); } catch (err) { alert(err.message); }
    render();
    return;
  }
  const k = e.target.dataset?.handfilter;
  if (k == null) return;
  historyTable[k] = e.target.value;
  render();
}

function onKey(e) {
  if (e.key === 'Escape' && chipForm && e.target.closest('form[data-chipform]')) { chipForm = null; render(); return; }
  if (e.key === 'Escape' && tableForm && e.target.closest('form[data-tableform]')) { tableForm = false; render(); return; }
  if (e.key !== 'Enter') return;
  if (e.target.id === 'cl-clubname') root.querySelector('[data-cl="create"]')?.click();
  if (e.target.id === 'cl-name') root.querySelector('[data-cl="join"]')?.click();
  if (e.target.id === 'cl-myname') root.querySelector('[data-cl="setname"]')?.click();
}

// Leaving the site can keep this page frozen in the back/forward cache with
// its sockets open, and the relay would keep handing messages to a host that
// isn't there. So the connections close when the page is hidden for good and
// reopen if it comes back.
function disconnectAll() {
  hostNet?.close();
  hostNet = null;
  hostOnline = false;
  for (const n of playerNets.values()) n.net?.close();
  playerNets.clear();
}

function reconnectAll() {
  if (!me) return;
  startHosting();
  for (const m of memberships) connectMembership(m);
  render();
}

// Another tab of this browser changed the club or the memberships (only one
// tab can host, but any tab can show the club): show what it saved.
function onStorage(e) {
  if (e.key === CLUB_KEY) {
    club = load(CLUB_KEY, null);
    verifier = new Verifier(load(SENDERS_KEY, {}));
    if (!club) { hostNet?.close(); hostNet = null; hostOnline = false; }
  } else if (e.key === MEMBERSHIPS_KEY) {
    const saved = load(MEMBERSHIPS_KEY, []);
    // Keep this tab's connection state; take the other tab's data.
    memberships = saved.map(s => Object.assign(memberships.find(m => m.code === s.code) || {}, s));
  } else return;
  render();
}

export async function openClubs(el) {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('change', onFilter);
    document.addEventListener('keydown', onDocKey);
    window.addEventListener('pagehide', disconnectAll);
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', e => { if (e.persisted) reconnectAll(); });
    club = load(CLUB_KEY, null);
    if (club) { ensureChips(club); ensureTables(club); }
    verifier = new Verifier(load(SENDERS_KEY, {}));
    memberships = load(MEMBERSHIPS_KEY, []);
  }
  open = true;
  invite = parseInvite(location.href) || invite;
  render();
  if (!me) {
    try {
      me = await loadIdentity();
    } catch (e) {
      console.warn(e);
      note = 'This browser can’t keep a player ID (private mode or storage blocked), so it can’t use clubs.';
      render();
      return;
    }
  }
  reconnectAll();
}

// Leaving the page keeps the connections open, so a host's club stays
// reachable while the tab is open.
export function closeClubs() {
  open = false;
}
