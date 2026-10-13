// The site's navigation (#209): Train · Play · Clubs, each with its tabs
// under the top bar, and the section that holds the playing tabs (#138):
//   #play / #practice   Bots (Train): a game you can resume, or the bots;
//                       and whichever table you're at
//   #ladder Ladder (Train): heads-up against the bots, easiest first (#212)
//   #join   Join (Play): a code or a pasted link, for a table or a club
//   #host   Start a game (Play): a table for friends
//   #clubs  Clubs: the club you run or help run, the clubs you're in, and
//           creating a club
// Train's other tabs are main.js's: Drills (#trainer) and Equity.
// play.js and clubs.js each draw their part of every tab (their `view`);
// this file draws the tabs, the Join form, and the badges (#145): the count
// of things waiting for you on Clubs, a dot on it when a table you can sit
// at opens, and the count in the window title.

import { openPlay, closePlay, joinTable, tableGroup, tableName } from './play.js';
import {
  anyClubs, closeClubs, clubCrumb, joinClub, memberName, needsYou, onClubsChange, openClubs, openSeats, showClubPlayers, startClubs,
} from './clubs.js';
import { parseInvite } from './club.js';
import { linkedHost, normCode, relayUrl } from './play-net.js';
import { myName, notifyOn, openPlayerSettings } from './player-settings.js';
import { setTitleSection, setTitleWaiting } from './title.js';
import { crumbFor, sideOf, sideSwitch } from './home.js';

export const TABS = ['play', 'ladder', 'join', 'host', 'clubs'];
// Each tab's window title (#195): "Private clubs · DUCY".
const TITLES = {play: 'Play the Regulars', ladder: 'Climb the ladder', join: 'Join a game', host: 'Start a game', clubs: 'Private clubs'};

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

// A notice at the bottom of the page for a new request, with a way to it.
let toastTimer = null;
function toast(text) {
  let t = el('pt-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'pt-toast';
    t.className = 'pt-toast';
    t.setAttribute('role', 'status');
    t.addEventListener('click', e => {
      if (e.target.closest('[data-toast=open]')) showClubPlayers();
      t.hidden = true;
    });
    document.body.append(t);
  }
  t.innerHTML = `<span>${esc(text)}</span><button class="btn-small primary" data-toast="open">See requests</button><button class="link-btn" aria-label="Dismiss">✕</button>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 10_000);
}

// ---- Start a game (#152, #209) ----

// What it is; play.js draws its steps. A club that lasts is on Clubs.
// Since V3 (#225) play.js draws the whole page, heading included.
function renderHost() {
  joinRoot.innerHTML = '';
  joinRoot.hidden = true;
}

// ---- the Join tab (#141) ----

// What the page address asks to join: a club invite, or a friends table.
function linked() {
  const inv = parseInvite(location.href);
  if (inv) return {kind: 'club', inv, text: location.href};
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

const knownName = () => tableName() || memberName();

function renderJoin() {
  const link = linked();
  const name = knownName();
  let h = '<div class="pl-wrap"><div class="pl-head"><h1>Join a game</h1>';
  h += '<p>Type the code someone gave you, or paste their link.</p></div>';
  if (!relayUrl()) {
    joinRoot.innerHTML = h + '<p class="pl-meta">Games with other people need ducy’s relay, which isn’t set up here.</p></div>';
    joinRoot.hidden = false;
    return;
  }
  const club = link?.kind === 'club' ? link.inv : null;
  h += '<form class="pj-form" data-joinform>';
  // An invite says what you're joining, and who sent it (#185); joining is
  // always your click.
  if (club) {
    h += `<div class="pj-invite"><span class="pl-label">You’re invited to</span><b class="pj-club">${esc(club.name || `club ${club.code}`)}</b>`;
    h += `<span class="pl-meta">${club.by ? `from ${esc(club.by)} · ` : ''}code ${esc(club.code)}</span>`;
    h += '<p class="pl-desc">Ask to join: the host sees your name and lets you in, then gives you chips (play money) to play at the club’s tables.</p></div>';
  }
  h += `<label class="pj-field"${club ? ' hidden' : ''}><span class="pl-label">Code</span><input class="pl-text pj-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH, or a link" value="${esc(link?.text || '')}"></label>`;
  h += `<label class="pj-field"${name ? ' hidden' : ''}><span class="pl-label">${club && name ? 'Your name in this club' : 'Your name'}</span><input class="pl-text" name="name" maxlength="20" autocomplete="nickname" placeholder="What others see" value="${esc(name)}"></label>`;
  h += `<div class="pl-actions"><button class="tr-start" type="submit">${club ? 'Ask to join' : 'Join'}</button></div>`;
  if (name) h += `<p class="pl-meta">${club ? 'Asking' : 'Joining'} as <b>${esc(name)}</b>. <button type="button" class="link-btn" data-pj="rename">Change</button></p>`;
  h += '</form>';
  if (joinNote) h += `<p class="pl-desc pl-neterr">${esc(joinNote)}</p>`;
  h += '</div>';
  joinRoot.innerHTML = h;
  joinRoot.hidden = false;
  joinRoot.querySelector('[data-pj="rename"]')?.addEventListener('click', () => {
    const f = joinRoot.querySelector('[name=name]').closest('label');
    f.hidden = false;
    f.querySelector('input').select();
  });
  const input = joinRoot.querySelector('[name=code]');
  if (input && !input.value && !matchMedia('(pointer: coarse)').matches) input.focus();
  // A friends table's link, with a name already known: join straight away.
  // A club invite waits for Ask to join (#185).
  if (link?.kind === 'table' && name && !autoJoined.has(link.text)) {
    autoJoined.add(link.text);
    go(link, name);
  }
}
const autoJoined = new Set();

function onJoin(e) {
  const f = e.target.closest('form[data-joinform]');
  if (!f) return;
  e.preventDefault();
  const what = readJoin(f.elements.code.value);
  const name = String(f.elements.name.value || '').trim();
  if (!what) { joinNote = 'That isn’t a code or a link to a game. Codes look like ABCD-EFGH.'; renderJoin(); return; }
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
