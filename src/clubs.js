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
  cashOutEveryone, ensureTables, gameLabel, GAMES, MAX_SEATS, MAX_TABLE_NAME, newTable, openTables, tablesBody,
} from './club-tables.js';
import { createTableHost } from './club-host.js';
import { joinTableVia } from './play.js';

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
let tableForm = false; // the host's New table form is open
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
}

function startHosting() {
  if (!club || hostNet) return;
  startTables();
  hostNet = connect(club.code, 'host', '', {
    onOpen() { hostOnline = true; render(); },
    onMessage: hostMessage,
    onStatus(s) { hostOnline = !s; render(); },
    onFail(reason) { hostNet = null; hostOnline = false; note = reason; render(); },
  }, {retryInUse: true, inUse: 'This club is already open in another tab or window. Only one can host it: close the other one, then click Reconnect.'});
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
    sendTable: (to, msg) => hostNet?.send({to, data: msg}),
    chipsChanged: id => {
      const n = club.chips.ledger.filter(e => e.member === id).at(-1)?.n;
      sendToPlayer(account(club, id, n ? n - 1 : Infinity));
    },
    tablesChanged: () => { broadcastTables(); render(); },
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
  if (msg.event === 'open') { online.add(msg.from); return; }
  if (msg.event === 'close') { online.delete(msg.from); tableHost?.disconnected(msg.from); return; }
  if (!('data' in msg)) return;
  const r = await hostReceive(club, verifier, msg.data);
  if (msg.queued) hostNet?.send({ack: msg.queued});
  if (r.reason && r.reason !== 'replayed') console.warn('club: refused a message:', r.reason);
  for (const rep of r.replies) sendToPlayer(rep);
  // A table command, from the member who signed it (the relay's sender id
  // must match, so no one can act for someone else).
  if (r.table && r.table.from === msg.from) tableHost?.handle(r.table.id, r.table.from, r.table.cmd);
  // Members checking in get the tables too.
  if (msg.data?.body?.type === 'hello' && club.members[msg.from]?.status === 'member' && tableHost) {
    sendToPlayer({to: msg.from, body: tablesBody(club, tableHost.seatedCounts())});
  }
  if (r.changed || r.replies.length) { saveClub(); render(); }
}

// Signed messages go out one at a time, in order: a player ignores anything
// with a lower sequence number than one it has seen.
let hostSends = Promise.resolve();
function sendToPlayer(rep) {
  if (!rep) return hostSends;
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
function tableFormHtml() {
  let h = '<form class="cl-tableform" data-tableform="1">';
  h += `<label>Name<input class="pl-text" name="name" maxlength="${MAX_TABLE_NAME}" placeholder="Table ${(club.tables?.length || 0) + 1}"></label>`;
  h += `<label>Game<select class="pl-text" name="game">${GAMES.map(g => `<option value="${g.id}">${esc(g.label)}</option>`).join('')}</select></label>`;
  h += '<label>Small blind<input class="pl-text" name="sb" type="number" required min="1" step="1" value="1"></label>';
  h += '<label>Big blind<input class="pl-text" name="bb" type="number" required min="1" step="1" value="2"></label>';
  h += '<label>Min buy-in (BB)<input class="pl-text" name="minBB" type="number" required min="1" step="1" value="40"></label>';
  h += '<label>Max buy-in (BB)<input class="pl-text" name="maxBB" type="number" required min="1" step="1" value="100"></label>';
  h += `<label>Seats<input class="pl-text" name="seats" type="number" required min="2" max="${MAX_SEATS}" step="1" value="${MAX_SEATS}"></label>`;
  h += `<label>Turn time<select class="pl-text" name="turnSecs">${[15, 30, 60, 0].map(s => `<option value="${s}"${s === 30 ? ' selected' : ''}>${s ? s + ' s' : 'None'}</option>`).join('')}</select></label>`;
  h += '<div class="cl-formacts"><button class="btn-small primary" type="submit">Open table</button><button class="btn-small" type="button" data-cl="cancel-table">Cancel</button></div></form>';
  return h;
}

function submitTable(f) {
  const v = name => f.elements[name].value;
  try {
    const t = newTable(club, {
      name: v('name'), game: v('game'), sb: Number(v('sb')), bb: Number(v('bb')),
      minBB: Number(v('minBB')), maxBB: Number(v('maxBB')), seats: Number(v('seats')), turnSecs: Number(v('turnSecs')),
    });
    tableForm = false;
    saveClub();
    tableHost?.start(t).then(() => { broadcastTables(); render(); });
  } catch (e) {
    alert(e.message);
  }
  render();
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
        : `<span class="cl-acts"><button class="btn-small" data-cl="close-table" data-table="${esc(t.id)}">Close</button></span>`;
      const seated = Object.values(club.members).filter(m => m.seat?.table === t.id);
      if (seated.length) h += `<span class="pl-desc cl-err">${seated.map(m => `${esc(m.name)} ${chips(m.seat.stack)}`).join(' · ')}</span>`;
      h += '</li>';
    }
    h += '</ul>';
  } else if (!tableForm) h += '<p class="pl-meta">No tables yet.</p>';
  h += tableForm ? tableFormHtml() : '<div class="pl-actions"><button class="btn-small primary" data-cl="new-table">New table</button></div>';
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
};

// A native form: the browser checks the amount (required, whole, at least
// 1, at most the balance when taking back) before it submits.
function chipFormHtml(m) {
  if (!chipForm || chipForm.id !== m.id) return '';
  const t = FORM_TEXT[chipForm.kind](m);
  let h = `<form class="cl-chipform" data-chipform="${chipForm.kind}" data-id="${esc(m.id)}">`;
  h += `<label class="cl-formlabel" for="cl-amt">${esc(t.label)}</label>`;
  h += `<input class="pl-text" id="cl-amt" name="amount" type="number" inputmode="numeric" required min="1" step="1"${t.max != null ? ` max="${t.max}"` : ''} value="${esc(t.value)}" placeholder="Chips">`;
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
  const entry = {net: null, online: false, hostHere: false, sends: Promise.resolve()};
  playerNets.set(mem.code, entry);
  const greet = async () => {
    // Never ask to join without a name: the host would see a nameless player.
    if (mem.status === 'new' && !myName()) { mem.error = 'Enter your name above and click Save to send your request.'; render(); return; }
    const body = mem.status === 'new'
      ? {type: 'join', club: mem.code, invite: mem.invite, name: myName()}
      : {type: 'hello', club: mem.code, name: myName(), since: lastEntry(mem)};
    sendToHost(mem.code, body);
    // Back at a club table after the host (or this page) reconnected.
    if (seatedAt?.code === mem.code) sendToHost(mem.code, {type: 'table', club: mem.code, table: seatedAt.table, cmd: {type: 'join', name: myName()}});
  };
  entry.net = connect(mem.code, 'guest', me.id, {
    onOpen() { entry.online = true; entry.hostHere = true; mem.error = ''; greet(); render(); },
    async onMessage(msg) {
      if (msg?.type === 'host_away' || msg?.type === 'host_gone') {
        entry.hostHere = false;
        if (seatedAt?.code === mem.code) seatedAt.handlers.onMessage({type: 'host_gone'});
        render();
        return;
      }
      if (msg?.type === 'host_back') { entry.hostHere = true; greet(); render(); return; }
      if (msg?.type === 'queue_full') return;
      // A club table's update for this player (unsigned: only the host can
      // reach a player through the relay).
      if (msg?.type === 'table' && !msg.sig) {
        if (seatedAt?.code === mem.code && seatedAt.table === msg.table) tableUpdate(msg.update);
        return;
      }
      if (await playerReceive(mem, msg)) { saveMemberships(); render(); }
    },
    onStatus(s) { entry.online = !s; render(); },
    // 4004 means the relay had no host and doesn't hold requests (a relay
    // older than queue mode).
    onFail(reason) {
      entry.online = false;
      playerNets.delete(mem.code);
      mem.error = /No table/.test(reason) ? 'The host isn’t online, and this relay can’t hold your request. Try again when the host is online.' : reason;
      render();
    },
  }, {queue: true});
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
  h += `<p class="pl-meta">Your player ID is <code class="pl-pid">${esc(me.id)}</code>. Back it up from Play → Play with friends.</p>`;
  h += relayHtml();
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
  const badge = hostOnline ? 'Open' : hostNet ? 'Connecting…' : 'Offline';
  let h = `<section class="cl-card"><div class="cl-title"><h2>${esc(club.name)}</h2><span class="cl-badge${hostOnline ? ' on' : ''}">${badge}</span>`;
  if (!hostNet) h += '<button class="btn-small" data-cl="reconnect">Reconnect</button>';
  h += '</div>';
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
      h += `<li><span class="cl-name">${esc(m.name)}</span><code>${esc(m.id)}</code><span class="pl-meta">asked ${when(m.requestedAt)}</span>`;
      h += `<span class="cl-acts"><button class="btn-small primary" data-cl="approve" data-id="${esc(m.id)}">Approve</button><button class="btn-small" data-cl="decline" data-id="${esc(m.id)}">Decline</button></span></li>`;
    }
    h += '</ul>';
  }
  const asking = members.filter(m => m.request).sort((a, b) => a.request.at - b.request.at);
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
    h += '<ul class="cl-list">';
    for (const m of members) {
      h += `<li><span class="cl-name">${esc(m.name)}</span><code>${esc(m.id)}</code><span class="cl-chips" title="Club balance">${chips(m.balance)} chips</span>`;
      if (m.seat) h += `<span class="pl-meta">${chips(m.seat.stack)} on a table</span>`;
      h += `<span class="cl-acts"><button class="btn-small" data-cl="give" data-id="${esc(m.id)}">Give</button>`;
      h += `<button class="btn-small" data-cl="take" data-id="${esc(m.id)}"${m.balance ? '' : ' disabled'}>Take back</button>`;
      h += `<button class="btn-small" data-cl="remove" data-id="${esc(m.id)}">Remove</button></span>`;
      if (chipForm && chipForm.kind !== 'grant') h += chipFormHtml(m);
      h += '</li>';
    }
    h += '</ul>';
  }
  const t = totals(club);
  h += `<p class="pl-meta">Chips out: ${chips(t.issued - t.reclaimed)} (given ${chips(t.issued)}, taken back ${chips(t.reclaimed)}) · in balances ${chips(t.balances)} · on tables ${chips(t.onTables)}${t.conserved ? '' : ' · <span class="pl-neterr">doesn’t add up</span>'}</p>`;
  h += '<div class="pl-row"><span class="pl-label">Rathole</span><div class="pl-opts">';
  h += [0, 1, 2, 4, 8, 24].map(n => `<button class="cc-btn${club.ratholeHours === n ? ' on' : ''}" data-cl="rathole" data-hours="${n}">${n ? n + ' h' : 'Off'}</button>`).join('');
  h += '</div><span class="pl-desc">A player who leaves a table must come back to it with at least what they left with, for this long.</span></div>';
  h += '<div class="pl-actions"><button class="link-btn" data-cl="close">Close this club</button></div></section>';
  return h;
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
    h += '</li>';
  }
  h += '</ul></section>';
  return h;
}

const KIND_TEXT = {issue: 'Given by the host', grant: 'Request granted', reclaim: 'Taken back by the host', buy_in: 'Bought in', top_up: 'Topped up', cash_out: 'Cashed out'};

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
  if (m.entries?.length) {
    h += `<details class="cl-history"><summary>History (${m.entries.length})</summary><ul>`;
    for (const e of [...m.entries].reverse().slice(0, 50)) {
      const sign = ['reclaim', 'buy_in', 'top_up'].includes(e.kind) ? '−' : '+';
      h += `<li><span class="pl-meta">${when(e.at)}</span> ${esc(KIND_TEXT[e.kind] || e.kind)} <strong>${sign}${chips(e.amount)}</strong>${e.note ? ` <span class="pl-meta">“${esc(e.note)}”</span>` : ''} <span class="pl-meta">→ ${chips(e.balance)}</span></li>`;
    }
    h += '</ul></details>';
  }
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
  else if (act === 'new-table') { tableForm = true; render(); root.querySelector('form[data-tableform] [name=name]')?.focus(); }
  else if (act === 'cancel-table') { tableForm = false; render(); }
  else if (act === 'close-table') closeTable(b.dataset.table);
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
