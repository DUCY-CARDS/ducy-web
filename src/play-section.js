// The site's navigation (#209): Train · Play · Clubs, each with its tabs
// under the top bar, and the section that holds the playing tabs (#138):
//   #play / #practice   Bots (Train): a game you can resume, or the bots;
//                       and whichever table you're at
//   #ladder Ladder (Train): heads-up against the bots, easiest first (#212)
//   #join   Join (Play): what a link or Play's Enter a code (#393) asks to
//           join, a table or a club, and your club requests
//   #host   Start a game (Play): a table for friends
//   #clubs  Clubs: the club you run or help run (on the club manager), and
//           the clubs you're in
// Train's other tabs are main.js's: Drills (#trainer) and Equity.
// play.js and clubs.js each draw their part of every tab (their `view`);
// this file draws the tabs, the Join form, and the badges (#145): the count
// of things waiting for you on Clubs, a dot on it when a table you can sit
// at opens, and the count in the window title.

import { openPlay, closePlay, joinTable, tableGroup, tableName, showQuestGames, takeQuestSeat, watchQuestSeat } from './play.js';
import {
  anyClubs, closeClubs, clubCrumb, clubPage, joinClub, memberName, needsYou, onClubsChange, openClubs, openSeats, showClubPlayers, startClubs,
} from './clubs.js';
import { MAX_CLUB_NAME, parseInvite } from './club.js';
import { isPlayerId } from './identity.js';
import { linkedHost, lookupCode, normCode, relayUrl } from './play-net.js';
import { myName, notifyOn, openPlayerSettings } from './player-settings.js';
import { setTitleSection, setTitleWaiting } from './title.js';
import { crumbFor, sideOf, sideSwitch } from './home.js';
// One-off tournaments (#394): their form and page on Start a game, and a
// code that turns out to be one's.
import './private-tourney-room.js';

export const TABS = ['play', 'ladder', 'quest', 'join', 'host', 'clubs'];
// Each tab's window title (#195): "Private clubs · DUCY".
const TITLES = {play: 'Play the Regulars', ladder: 'Heads-up challenge', quest: 'Bankroll Quest', join: 'Join a game', host: 'Start a game', clubs: 'Private clubs'};

let tab = null; // the tab showing, or null when the section is closed
let seenSeats = 0; // open seats the last time Clubs was looked at
let joinNote = '';
let joinRoot = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const el = id => document.getElementById(id);

// The page showing (a tab, 'trainer' or 'equity'), for the breadcrumb.
let page = null;

// Shows where `p` is (#225): a breadcrumb back to Study or Play.
export function showNav(p) {
  page = p;
  renderTabs();
}

export const sectionOpen = () => !!tab;

// Opens tab `t` (one of TABS); `shortcut` goes to play.js (#codedoug).
export function openSection(t, shortcut) {
  tab = t;
  setTitleSection(TITLES[t]);
  if (t === 'clubs') seenSeats = openSeats();
  const sec = el('psec');
  sec.dataset.tab = t;
  for (const x of TABS) document.body.classList.toggle('tab-' + x, x === t);
  showNav(t);
  if (!joinRoot) {
    joinRoot = el('pjoin');
    joinRoot.addEventListener('submit', onJoin);
  }
  if (t === 'join') renderJoin();
  else if (t === 'host') renderHost();
  else joinRoot.hidden = true;
  openClubs(el('clubs'), t);
  openPlay(el('play'), shortcut, t);
}

export function closeSection() {
  tab = null;
  for (const x of TABS) document.body.classList.remove('tab-' + x);
  closeClubs();
  closePlay();
}

// The page has loaded: with clubs in this browser, connect them now, so
// requests and tables arrive whichever page is showing (#145).
export function startBackground() {
  onClubsChange(changed);
  anyClubs().then(yes => { if (yes) startClubs(); });
  changed();
  // Your name on a Bankroll Quest list: say so when the seat is ready,
  // whatever you're doing, and from the system while the page isn't in front.
  // A new game in your room says so too, for a few seconds.
  watchQuestSeat((text, label, kind = 'seat') => {
    const go = kind === 'games' ? showQuestGames : takeQuestSeat;
    toast(text, label, go, kind === 'games' ? 10_000 : 0);
    if (document.hidden && notifyOn()) {
      try {
        const note = new Notification('ducy', {body: text, tag: kind === 'games' ? 'ducy-quest-game' : 'ducy-quest-seat'});
        note.onclick = () => { window.focus(); go(); note.close(); };
      } catch {}
    }
  });
}

// ---- tabs and badges ----

// Where you are, under the top bar, with Player settings.
function renderTabs() {
  const nav = el('sub-tabs');
  if (!nav) return;
  const crumbs = crumbFor(page || 'equity', page === 'play' ? tableGroup() : null);
  // A club's page (#225): Play › Private clubs › its name.
  const inClub = page === 'clubs' && clubCrumb();
  if (inClub) crumbs.splice(-1, 1, {...crumbs.at(-1), href: '#clubs'}, {label: inClub});
  let h = '<span class="v3-crumbs">';
  crumbs.forEach((c, i) => {
    if (i) h += '<span class="v3-crumb-sep" aria-hidden="true">›</span>';
    h += c.href ? `<a href="${c.href}">${esc(c.label)}</a>` : `<span aria-current="page">${esc(c.label)}</span>`;
  });
  h += '</span>';
  // You: name, player ID, backups and the rest, in a dialog (#144).
  // Across to the other side, from any page (#225).
  h += sideSwitch(sideOf(page || 'equity', page === 'play' ? tableGroup() : null));
  h += `<button class="pt-me" type="button" data-pt="player" title="Player settings" aria-label="Player settings"><span class="pt-me-name">${esc(myName() || 'You')} </span><span aria-hidden="true">⚙</span></button>`;
  // Redrawn as the clubs change: only when it reads differently.
  if (nav.dataset.html === h) return;
  nav.dataset.html = h;
  nav.innerHTML = h;
  if (!nav.dataset.ready) {
    nav.dataset.ready = '1';
    nav.addEventListener('click', e => { if (e.target.closest('[data-pt=player]')) openPlayerSettings(); });
  }
}

// Something changed in the clubs: the tab bar, and the top navigation's Play
// and the window title, show what's waiting. With notifications on (Player
// settings), a new request while the page isn't in front says so.
let lastNeeds = 0;
function changed() {
  // A club's name arriving, for the breadcrumb.
  if (tab === 'clubs') renderTabs();
  const n = needsYou();
  setTitleWaiting(n);
  // The home spade in the top bar: what's waiting for you in your clubs, or
  // a dot when a table you can sit at opened (#209, #225).
  const top = document.querySelector('.wordmark');
  if (top) {
    top.dataset.badge = n ? String(n) : '';
    top.dataset.dot = !n && tab !== 'clubs' && openSeats() > seenSeats ? '1' : '';
  }
  if (n > lastNeeds) {
    const text = n === 1 ? 'Someone is waiting for you in your club.' : `${n} requests are waiting for you in your clubs.`;
    // On the page, whichever tab is showing (#152); and with notifications on
    // (Player settings), from the system while the page isn't in front.
    toast(text);
    if (document.hidden && notifyOn()) {
      try {
        const note = new Notification('ducy', {body: text, tag: 'ducy-needs'});
        note.onclick = () => { window.focus(); showClubPlayers(); note.close(); };
      } catch {}
    }
  }
  lastNeeds = n;
}

// A notice at the bottom of the page, with a way to what it's about: by
// default a new club request and See requests, gone after `ms`.
let toastTimer = null;
let toastAction = null;
function toast(text, label = 'See requests', action = showClubPlayers, ms = 10_000) {
  let t = el('pt-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'pt-toast';
    t.className = 'pt-toast';
    t.setAttribute('role', 'status');
    t.addEventListener('click', e => {
      if (e.target.closest('[data-toast=open]')) toastAction?.();
      t.hidden = true;
    });
    document.body.append(t);
  }
  toastAction = action;
  t.innerHTML = `<span>${esc(text)}</span><button class="btn-small primary" data-toast="open">${esc(label)}</button><button class="link-btn" aria-label="Dismiss">✕</button>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  // `ms` 0: it stays until it's answered or closed.
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- Start a game (#152, #209) ----

// What it is; play.js draws its steps. A club that lasts is on Clubs.
// Since V3 (#225) play.js draws the whole page, heading included.
function renderHost() {
  joinRoot.innerHTML = '';
  joinRoot.hidden = true;
}

// ---- the Join tab (#141) ----

// A club found by its code on Play (#393): {code, hostId, name}. Join shows
// it like an invite, and asking to join sends no invite token.
let codeClub = null;

// What the page address asks to join: a club invite, or a friends table;
// or the club Enter a code found.
function linked() {
  const inv = parseInvite(location.href);
  if (inv) return {kind: 'club', inv, text: location.href};
  if (codeClub) return {kind: 'club', inv: {...codeClub, invite: ''}, text: codeClub.code};
  const code = normCode(new URLSearchParams(location.search).get('table') || '');
  if (code) return {kind: 'table', code, hostId: linkedHost(), text: code};
  return null;
}

// Reads what was typed or pasted: a club invite link, a table link, or a
// table code. Null if it's none of those.
export function readJoin(text) {
  const s = String(text || '').trim();
  if (/^https?:\/\//i.test(s) || s.includes('?')) {
    let u;
    try { u = new URL(s, location.href); } catch { return null; }
    const inv = parseInvite(u.href);
    if (inv) return {kind: 'club', inv};
    const code = normCode(u.searchParams.get('table') || '');
    const host = u.searchParams.get('host') || '';
    if (code) return {kind: 'table', code, hostId: /^[1-9A-HJ-NP-Za-km-z]{8}$/.test(host) ? host : ''};
    return null;
  }
  const code = normCode(s);
  return code ? {kind: 'table', code, hostId: ''} : null;
}

// Play's Enter a code (#393). A link goes where it did. A code: a club of
// yours opens (no network needed); else the relay says what it is: a club
// that takes requests by code shows on Join as an invite, with Ask to join;
// one that doesn't is said so here; anything else is joined as a game.
// Resolves to a word for under the code box, or '' once it has gone on.
export async function enterCode(text) {
  const what = readJoin(text);
  if (!what) return 'That isn’t a code or a link. Codes look like ABCD-EFGH.';
  codeClub = null;
  if (what.kind === 'club') { location.href = String(text).trim(); return ''; }
  const bare = !!normCode(text);
  if (bare) {
    const page = clubPage(what.code);
    if (page) { location.href = page; return ''; }
    const info = await lookupCode(what.code);
    if (info?.kind === 'club') {
      if (!info.ask || !isPlayerId(info.hostId)) return 'That’s a club’s code. To join the club, ask its host for the invite link.';
      codeClub = {code: what.code, hostId: info.hostId, name: String(info.name || '').slice(0, MAX_CLUB_NAME)};
    }
  }
  // Join, with it filled in: a game joins straight away when your name is known.
  const u = new URL(location.href);
  for (const k of ['club', 'invite', 'host', 'table', 'name', 'by']) u.searchParams.delete(k);
  if (!codeClub) {
    u.searchParams.set('table', what.code);
    if (what.hostId) u.searchParams.set('host', what.hostId);
  }
  u.hash = '';
  history.replaceState(null, '', u.toString().replace(/#$/, '') + '#lobby');
  location.hash = 'join';
  return '';
}

const knownName = () => tableName() || memberName();

function renderJoin() {
  const link = linked();
  const name = knownName();
  // V3 (#225): a cream form like Start a game's.
  let h = '<div class="pl-wrap"><div class="pl-head"><h1>Join a game</h1></div>';
  if (!relayUrl()) {
    joinRoot.innerHTML = h + '<p class="pl-meta">Games with other people need ducy’s relay, which isn’t set up here.</p></div>';
    joinRoot.hidden = false;
    return;
  }
  // Codes are entered on Play (#393): with nothing to join here, Join is
  // your club requests (clubs.js) and why a game didn't join (play.js).
  if (!link) {
    joinRoot.innerHTML = h + '<p class="pl-meta">To join a game or a club, enter its code on <a href="#lobby">Play</a>.</p></div>';
    joinRoot.hidden = false;
    return;
  }
  const club = link.kind === 'club' ? link.inv : null;
  h += '<form class="pj-form sg-form" data-joinform>';
  // An invite says what you're joining, and who sent it (#185); joining is
  // always your click.
  if (club) {
    h += `<div class="pj-invite"><span class="sg-label">You’re invited to</span><b class="pj-club">${esc(club.name || `club ${club.code}`)}</b>`;
    h += `<span class="pj-meta">${club.by ? `from ${esc(club.by)} · ` : ''}code ${esc(club.code)}</span>`;
    h += '<p class="pj-meta">The host sees your name, lets you in, and gives you chips (play money) for the club’s tables.</p></div>';
  }
  if (!club) h += `<p class="pj-meta">Game <b>${esc(link.code)}</b></p>`;
  h += `<label class="pj-field"${name ? ' hidden' : ''}><span class="sg-label">${club && name ? 'Your name in this club' : 'Your name'}</span><input class="pl-text" name="name" maxlength="20" autocomplete="nickname" placeholder="What others see" value="${esc(name)}"></label>`;
  if (joinNote) h += `<p class="pl-neterr">${esc(joinNote)}</p>`;
  h += `<button class="tr-start sg-open" type="submit">${club ? 'Ask to join' : 'Join'}</button>`;
  if (name) h += `<p class="pj-meta">${club ? 'Asking' : 'Joining'} as <b>${esc(name)}</b>. <button type="button" class="link-btn" data-pj="rename">Change</button></p>`;
  h += '</form>';
  h += '</div>';
  joinRoot.innerHTML = h;
  joinRoot.hidden = false;
  joinRoot.querySelector('[data-pj="rename"]')?.addEventListener('click', () => {
    const f = joinRoot.querySelector('[name=name]').closest('label');
    f.hidden = false;
    f.querySelector('input').select();
  });
  const input = joinRoot.querySelector('[name=name]');
  if (!name && !matchMedia('(pointer: coarse)').matches) input.focus();
  // A friends table's link, with a name already known: join straight away.
  // A club invite waits for Ask to join (#185).
  if (link.kind === 'table' && name && !autoJoined.has(link.text)) {
    autoJoined.add(link.text);
    go(link, name);
  }
}
const autoJoined = new Set();

function onJoin(e) {
  const f = e.target.closest('form[data-joinform]');
  if (!f) return;
  e.preventDefault();
  const what = linked();
  const name = String(f.elements.name.value || '').trim();
  if (!what) { renderJoin(); return; }
  if (!name) {
    joinNote = 'Enter your name: it’s what the others see.';
    renderJoin();
    joinRoot.querySelector('[name=name]').closest('label').hidden = false;
    joinRoot.querySelector('[name=name]').focus();
    return;
  }
  go(what, name);
}

function go(what, name) {
  joinNote = '';
  codeClub = null;
  clearLink();
  if (what.kind === 'club') {
    joinClub(what.inv, name);
    renderJoin();
  } else joinTable({code: what.code, name, hostId: what.hostId});
}

// The link's join is under way: drop it from the address (keeping ?relay=),
// so a reload doesn't ask again.
function clearLink() {
  const u = new URL(location.href);
  for (const k of ['club', 'invite', 'host', 'table']) u.searchParams.delete(k);
  history.replaceState(null, '', u.toString());
}
