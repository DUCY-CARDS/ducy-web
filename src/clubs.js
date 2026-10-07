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
  approve, decline, hostReceive, inviteLink, MAX_CLUB_NAME, MAX_PLAYER_NAME, membersByStatus,
  newClub, newMembership, parseInvite, playerReceive, removeMember, revokeInvite,
} from './club.js';

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
  hostNet = connect(club.code, 'host', '', {
    onOpen() { hostOnline = true; render(); },
    onMessage: hostMessage,
    onStatus(s) { hostOnline = !s; render(); },
    onFail(reason) { hostNet = null; hostOnline = false; note = reason; render(); },
  }, {retryInUse: true, inUse: 'This club is already open in another tab or window. Only one can host it: close the other one, then click Reconnect.'});
}

async function hostMessage(msg) {
  if (!msg || !msg.from || !('data' in msg)) return;
  const r = await hostReceive(club, verifier, msg.data);
  if (msg.queued) hostNet?.send({ack: msg.queued});
  if (r.reason && r.reason !== 'replayed') console.warn('club: refused a message:', r.reason);
  for (const rep of r.replies) await sendToPlayer(rep);
  saveClub();
  render();
}

async function sendToPlayer(rep) {
  if (rep && hostNet) hostNet.send({to: rep.to, data: await signMessage(me, rep.body)});
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
  saveClub();
  startHosting();
  render();
}

async function decide(fn, id) {
  const rep = fn(club, id);
  if (!rep) return;
  saveClub();
  render();
  await sendToPlayer(rep);
}

function closeClub() {
  if (!confirm(`Close ${club.name}? Its members and records are deleted from this browser.`)) return;
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
  const entry = {net: null, online: false, hostHere: false};
  playerNets.set(mem.code, entry);
  const greet = async () => {
    const body = mem.status === 'new'
      ? {type: 'join', club: mem.code, invite: mem.invite, name: myName()}
      : {type: 'hello', club: mem.code, name: myName()};
    entry.net?.send(await signMessage(me, body));
  };
  entry.net = connect(mem.code, 'guest', me.id, {
    onOpen() { entry.online = true; entry.hostHere = true; mem.error = ''; greet(); render(); },
    async onMessage(msg) {
      if (msg?.type === 'host_away' || msg?.type === 'host_gone') { entry.hostHere = false; render(); return; }
      if (msg?.type === 'host_back') { entry.hostHere = true; greet(); render(); return; }
      if (msg?.type === 'queue_full') return;
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
  root.innerHTML = h;
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
  h += `<h3>Members${members.length ? ` (${members.length})` : ''}</h3>`;
  if (!members.length) h += '<p class="pl-meta">No members yet. Send someone the invite link.</p>';
  else {
    h += '<ul class="cl-list">';
    for (const m of members) {
      h += `<li><span class="cl-name">${esc(m.name)}</span><code>${esc(m.id)}</code><span class="pl-meta">joined ${when(m.joinedAt)}</span>`;
      h += `<span class="cl-acts"><button class="btn-small" data-cl="remove" data-id="${esc(m.id)}">Remove</button></span></li>`;
    }
    h += '</ul>';
  }
  h += '<div class="pl-actions"><button class="link-btn" data-cl="close">Close this club</button></div></section>';
  return h;
}

function membershipsHtml() {
  if (!memberships.length) return '';
  let h = '<section class="cl-card"><h2>Clubs you’ve joined</h2><ul class="cl-list">';
  for (const m of memberships) {
    const n = playerNets.get(m.code);
    const live = n?.online ? (n.hostHere ? 'Host online' : 'Host away') : 'Offline';
    h += `<li><span class="cl-name">${esc(m.name || m.code)}</span><span class="cl-status cl-${esc(m.status)}">${esc(STATUS_TEXT[m.status] || m.status)}</span>`;
    h += `<span class="pl-meta">${live}</span><span class="cl-acts">`;
    if (!n) h += `<button class="btn-small" data-cl="retry" data-code="${esc(m.code)}">Try again</button>`;
    h += `<button class="btn-small" data-cl="forget" data-code="${esc(m.code)}">Forget</button></span>`;
    if (m.error) h += `<span class="pl-desc pl-neterr cl-err">${esc(m.error)}</span>`;
    h += '</li>';
  }
  h += '</ul></section>';
  return h;
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
  else if (act === 'reconnect') { note = ''; startHosting(); render(); }
  else if (act === 'retry') { const m = memberships.find(x => x.code === b.dataset.code); if (m) { m.error = ''; connectMembership(m); render(); } }
}

function onKey(e) {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'cl-clubname') root.querySelector('[data-cl="create"]')?.click();
  if (e.target.id === 'cl-name') root.querySelector('[data-cl="join"]')?.click();
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
    window.addEventListener('pagehide', disconnectAll);
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', e => { if (e.persisted) reconnectAll(); });
    club = load(CLUB_KEY, null);
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
