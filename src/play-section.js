// The Play section (#138): one place for playing, joining and running clubs,
// in tabs, each with its own address:
//   #play   Play: your clubs' tables, a game you can resume, or the bots
//   #join   Join: a code or a pasted link
//   #host   Host: start a game now, or create a club
//   #clubs  My clubs: the club you run or help run (only then)
// play.js and clubs.js each draw their part of every tab (their `view`);
// this file draws the tab bar, the Join form, and the badges (#145): the
// count of things waiting for you on My clubs, a dot on Play when a table
// you can sit at opens, and the count in the window title.

import { openPlay, closePlay, joinTable, tableName } from './play.js';
import {
  anyClubs, closeClubs, joinClub, managesClub, memberName, needsYou, onClubsChange, openClubs, openSeats, showClubPlayers, startClubs,
} from './clubs.js';
import { parseInvite } from './club.js';
import { linkedHost, normCode, relayUrl } from './play-net.js';
import { myName, notifyOn, openPlayerSettings } from './player-settings.js';
import { hostPick, onHostPick, setHostPick } from './host-choice.js';

export const TABS = ['play', 'join', 'host', 'clubs'];
const LABELS = {play: 'Play', join: 'Join', host: 'Host', clubs: 'My clubs'};
const TAB_KEY = 'ducyPlayTab';
const TITLE = document.title;

let tab = null; // the tab showing, or null when the section is closed
let seenSeats = 0; // open seats the last time the Play tab was looked at
let joinNote = '';
let joinRoot = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const el = id => document.getElementById(id);

// The tab to go back to when Play is clicked in the top navigation.
export function lastTab() {
  try { const t = localStorage.getItem(TAB_KEY); return TABS.includes(t) && (t !== 'clubs' || managesClub()) ? t : 'play'; } catch { return 'play'; }
}

export const sectionOpen = () => !!tab;

// Opens tab `t` (one of TABS); `shortcut` goes to play.js (#codedoug).
export function openSection(t, shortcut) {
  // My clubs is for a club you run or help run; anyone else gets Play,
  // which lists the clubs they're in. The clubs may still be loading (an
  // always-on club's record can be in IndexedDB only), so it waits for them.
  if (t === 'clubs' && !managesClub()) {
    startClubs().then(() => {
      if (tab !== 'clubs') return;
      if (managesClub()) { renderTabs(); return; }
      history.replaceState(null, '', location.pathname + location.search + '#play');
      openSection('play');
    });
  }
  // Coming to Host from another tab starts at its two choices (a club being
  // created picks itself again, clubs.js).
  if (t === 'host' && tab !== 'host') setHostPick(null);
  tab = t;
  try { localStorage.setItem(TAB_KEY, t); } catch {}
  if (t === 'play') seenSeats = openSeats();
  const sec = el('psec');
  sec.dataset.tab = t;
  for (const x of TABS) document.body.classList.toggle('tab-' + x, x === t);
  renderTabs();
  if (!joinRoot) {
    joinRoot = el('pjoin');
    joinRoot.addEventListener('submit', onJoin);
    joinRoot.addEventListener('click', onHostClick);
    onHostPick(() => { if (tab === 'host') renderHost(); });
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

function renderTabs() {
  const nav = el('pt-tabs');
  if (!nav) return;
  const n = needsYou();
  const dot = tab !== 'play' && openSeats() > seenSeats;
  let h = '';
  for (const t of TABS) {
    if (t === 'clubs' && !managesClub() && tab !== 'clubs') continue;
    const on = t === tab;
    let badge = '';
    if (t === 'clubs' && n) badge = `<span class="pt-badge" aria-label="${n} waiting for you">${n}</span>`;
    if (t === 'play' && dot) badge = '<span class="pt-dot" aria-label="A table opened"></span>';
    h += `<a class="pl-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" href="#${t}">${LABELS[t]}${badge}</a>`;
  }
  // You: name, player ID, backups and the rest, in a dialog (#144).
  h += `<button class="pt-me" type="button" data-pt="player" title="Player settings" aria-label="Player settings"><span class="pt-me-name">${esc(myName() || 'You')} </span><span aria-hidden="true">⚙</span></button>`;
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
  const n = needsYou();
  document.title = n ? `(${n}) ${TITLE}` : TITLE;
  const top = document.querySelector('.mode-tab[data-mode="play"]');
  if (top) top.dataset.badge = n ? String(n) : '';
  if (tab) renderTabs();
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

// ---- the Host tab's choices (#152) ----

// Two choices, each with what it is; once one is picked, play.js (a game) or
// clubs.js (a club) shows its steps, with a way back here.
function renderHost() {
  const p = hostPick();
  let h = '<div class="pl-wrap">';
  if (!p) {
    h += '<div class="pl-head"><h1>Host</h1><p>Start a game for tonight, or a club that lasts.</p></div>';
    h += '<div class="ph-choices">';
    h += '<button class="ph-choice" data-ph="game"><b>Start a game to invite friends</b><span>A table for now: share a code, play, and nothing is kept once everyone has left.</span></button>';
    h += '<button class="ph-choice" data-ph="club"><b>Create a club</b><span>A lasting club with members, chips and history. It runs on ducy’s server, so people can play whenever.</span></button>';
    h += '</div>';
  } else {
    h += '<p class="ph-back"><button class="link-btn" data-ph="back">← Host</button></p>';
  }
  joinRoot.innerHTML = h + '</div>';
  joinRoot.hidden = false;
}

function onHostClick(e) {
  const b = e.target.closest('[data-ph]');
  if (!b || tab !== 'host') return;
  setHostPick(b.dataset.ph === 'back' ? null : b.dataset.ph);
  scrollTo({top: 0});
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
  h += `<label class="pj-field"${name ? ' hidden' : ''}><span class="pl-label">Your name</span><input class="pl-text" name="name" maxlength="20" autocomplete="nickname" placeholder="What others see" value="${esc(name)}"></label>`;
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
