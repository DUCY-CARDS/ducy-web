// V3's front pages (#225): the landing page and the two places it leads.
//   #        the landing page: Study or Play, nothing else
//   #study   Study, what you do on your own: Equity, Pre-flop ranges and
//            Heads-up training
//   #challenge  Heads-up training: the GTO bot
//   #lobby   Play: friends, private clubs, the Regulars and the heads-up
//            challenge
// The pages behind them (#equity, #trainer, #ladder, #practice, #host,
// #join, #clubs) are the ones there were before V3; each shows where it is
// with a breadcrumb back to Study or Play (`crumbFor`). Pure: the page
// strings are built from what `hubData` reads, so they can be tested.

import { HOLDEM_PERCENTILE } from './holdem-rank.js';
import { skillTable } from './trainer-skills.js';
import { ORDER, loadProgress as loadLadder } from './ladder.js';
import { avatarUrl } from './avatars.js';

export const HUBS = ['home', 'study', 'challenge', 'lobby'];

// The window title of each hub ("Study · DUCY"); the landing page has none.
export const HUB_TITLES = {home: '', study: 'Study', challenge: 'Heads-up training', lobby: 'Play'};

// Where each older page sits in V3, and what it's called there.
const CRUMBS = {
  equity: ['study', 'Equity'],
  trainer: ['study', 'Pre-flop ranges'],
  ladder: ['lobby', 'Heads-up challenge'],
  practice: ['lobby', 'Play the Regulars'],
  host: ['lobby', 'Start a game'],
  join: ['lobby', 'Join a game'],
  clubs: ['lobby', 'Private clubs'],
};
const PARENTS = {study: ['home', 'Study'], challenge: ['study', 'Heads-up training'], lobby: ['home', 'Play']};

/**
 * The breadcrumb for page `p`: [{href, label}], from the hub above it to the
 * page itself (whose href is null). `table` is the table you're at
 * ('train', 'play' or 'clubs' from play.js), for the 'play' page.
 */
export function crumbFor(p, table) {
  let page = p;
  if (p === 'play') page = table === 'play' ? 'host' : table === 'clubs' ? 'clubs' : 'practice';
  const here = CRUMBS[page];
  if (!here) return [];
  const [hub, label] = here;
  const trail = [];
  for (let h = hub; h && h !== 'home'; h = PARENTS[h][0]) trail.unshift({href: '#' + h, label: PARENTS[h][1]});
  trail.push({href: null, label: p === 'play' && table ? 'Table' : label});
  return trail;
}

/**
 * Study or Play, whichever side `side` is on ('study' or 'play'; else
 * neither): two links to cross between them from any page.
 */
export function sideSwitch(side) {
  const a = (s, href, label) => `<a href="${href}"${s === side ? ' aria-current="true"' : ''}>${label}</a>`;
  return `<nav class="v3-switch" aria-label="Study or Play">${a('study', '#study', 'Study')}${a('play', '#lobby', 'Play')}</nav>`;
}

/** Which side page `p` is on: 'study', 'play' or '' (the landing page). */
export function sideOf(p, table) {
  const crumbs = crumbFor(p, table);
  const top = crumbs[0]?.href || (p === 'study' || p === 'challenge' ? '#study' : p === 'lobby' ? '#lobby' : '');
  return top === '#study' ? 'study' : top === '#lobby' ? 'play' : '';
}

// The trainer's skills: the games it drills and its top-% targets.
const SKILL_GAMES = [2, 4, 5, 6];
const SKILL_TARGETS = [10, 15, 20, 25, 30, 40, 50];

/** What the hubs show about you, from this browser's storage. */
export function hubData(storage = globalThis.localStorage) {
  let progress = {};
  try { progress = JSON.parse(storage.getItem('ducyTrainerProgress') || '{}') || {}; } catch {}
  const skills = skillTable(progress, SKILL_GAMES, SKILL_TARGETS);
  const ladder = loadLadder(storage);
  const rungs = ORDER.length + 1; // the Regulars, then the GTO bot
  return {
    mastered: skills.mastered,
    skills: skills.total,
    rung: Math.min(rungs, ladder.level + 1),
    rungs,
    gto: gtoRecords(storage),
  };
}

// Your record against the GTO bot in each game, from the bot tables' saved
// stats (play.js, 'ducyPlayStats'): the GTO bot only plays heads-up, so you
// won what it lost. [{hash, name, hands, bb100}], bb100 null with no hands.
export const GTO_GAMES = [
  {hash: 'codedoug', name: 'Hold’em', game: 'nlhe', bot: 'gto'},
  {hash: 'gto-plo4', name: 'Omaha 4', game: 'plo4', bot: 'gto-plo'},
  {hash: 'gto-plo6', name: 'Omaha 6', game: 'plo6', bot: 'gto-plo6'},
];
function gtoRecords(storage) {
  let games = {};
  try {
    const s = JSON.parse(storage.getItem('ducyPlayStats') || 'null');
    if (s && s.v === 1 && s.games) games = s.games;
  } catch {}
  return GTO_GAMES.map(g => {
    const c = games[g.game]?.[g.bot];
    const hands = c?.hands || 0;
    return {hash: g.hash, name: g.name, hands, bb100: hands ? (-(c.netBB || 0) / hands) * 100 : null};
  });
}

const bbText = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} bb/100`;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export const SPADE_PATH = 'M16 3.5c-3.2 4.2-10 8.1-10 13.2 0 3 2.3 5 4.9 5 1.7 0 3.1-.8 3.9-2-.3 2.6-1.2 4.4-2.8 5.8h8c-1.6-1.4-2.5-3.2-2.8-5.8.8 1.2 2.2 2 3.9 2 2.6 0 4.9-2 4.9-5 0-5.1-6.8-9-10-13.2z';
const STITCH = 'M16 5.4c-3 3.7-8.6 7.2-8.6 11.3 0 2.2 1.7 3.6 3.5 3.6 1.9 0 3.2-1.1 4.2-3.1M16 5.4c3 3.7 8.6 7.2 8.6 11.3 0 2.2-1.7 3.6-3.5 3.6-1.9 0-3.2-1.1-4.2-3.1';

const spade = (size, cls = '') =>
  `<svg class="v3-spade ${cls}" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true"><path d="${SPADE_PATH}"/></svg>`;

// The stitched spade, big: the landing page's logo.
const bigSpade = () =>
  '<svg class="v3-bigspade" viewBox="0 0 32 32" role="img" aria-label="DUCY">' +
  `<path class="v3-bigspade-shadow" d="${SPADE_PATH}" transform="translate(0.6 0.7)"/>` +
  `<path class="v3-bigspade-face" d="${SPADE_PATH}"/>` +
  `<path class="v3-bigspade-stitch" d="${STITCH}"/></svg>`;

// Each page's top: the spade home, the way back, and Study or Play (`side`).
function head(title, back, side) {
  let h = '<header class="v3-head"><a class="v3-home-link" href="#" aria-label="DUCY home">' + spade(32) + '</a>';
  if (back) h += `<a class="v3-back" href="${back.href}">${esc(back.label)} ›</a>`;
  return h + `<h1>${esc(title)}</h1>${sideSwitch(side)}</header>`;
}

// A 13×13 chart of the top 40% of Hold'em hands (the Study card's picture).
function rangeChart() {
  const r = 'AKQJT98765432';
  let h = '<div class="v3-chart" aria-hidden="true">';
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const hi = Math.min(i, j), lo = Math.max(i, j);
      const cls = i === j ? r[i] + r[j] : r[hi] + r[lo] + (i < j ? 's' : 'o');
      h += `<span class="${HOLDEM_PERCENTILE[cls] < 40 ? 'in' : ''}">${cls}</span>`;
    }
  }
  return h + '</div>';
}

// A small table of faces (the Play card's and the Regulars tile's picture).
function miniTable(ids) {
  let h = '<div class="v3-minitable" aria-hidden="true"><div class="v3-minitable-felt"></div>';
  ids.forEach((id, i) => { h += `<img class="v3-seat v3-seat-${i}" src="${avatarUrl(id)}" alt="">`; });
  return h + '</div>';
}

function homePage() {
  let h = '<div class="v3-page v3-landing">';
  h += `<section class="v3-hero"><div class="v3-hero-art">${bigSpade()}<img class="v3-peek" src="${avatarUrl('the_mathematician')}" alt=""></div>`;
  h += '<div class="v3-hero-text"><span class="v3-word">DUCY</span><h1>Pull up a chair.</h1></div></section>';
  h += '<div class="v3-doors">';
  h += '<a class="v3-door v3-door-study" href="#study"><span class="v3-door-head"><span class="v3-door-name">Study</span><span aria-hidden="true">→</span></span>';
  h += `<span class="v3-door-art">${rangeChart()}</span></a>`;
  h += '<a class="v3-door v3-door-play" href="#lobby"><span class="v3-door-head"><span class="v3-door-name">Play</span><span aria-hidden="true">→</span></span>';
  h += `<span class="v3-door-art">${miniTable(['player-01', 'player-02', 'player-03', 'player-04', 'player-05'])}</span></a>`;
  return h + '</div></div>';
}

function studyPage(d) {
  let h = '<div class="v3-page">' + head('Study', null, 'study');
  h += '<div class="v3-games"><span class="v3-label">Games</span><span class="v3-chip">Hold’em</span><span class="v3-chip">Omaha · 4, 5 or 6 cards</span><span class="v3-chip">Omaha 8-or-better · 4, 5 or 6 cards</span></div>';
  h += '<a class="v3-tile v3-tile-dark v3-tile-wide" href="#equity"><span class="v3-tile-text"><span class="v3-tile-name">Equity</span></span>';
  h += '<span class="v3-bars" aria-hidden="true"><span style="height:46%"></span><span style="height:54%"></span></span></a>';
  h += '<div class="v3-tiles">';
  const pct = d.skills ? Math.round(100 * d.mastered / d.skills) : 0;
  h += `<a class="v3-tile v3-tile-cream" href="#trainer"><span class="v3-ring" style="--pct:${pct}%" aria-hidden="true"><span>${d.mastered}</span></span>`;
  h += `<span class="v3-tile-text"><span class="v3-tile-name">Pre-flop ranges</span><b>${d.mastered} of ${d.skills} skills mastered</b></span></a>`;
  h += '<a class="v3-tile v3-tile-red" href="#challenge"><span class="v3-tile-name">Heads-up training</span>';
  h += `<span class="v3-versus" aria-hidden="true"><img src="${avatarUrl('player-01')}" alt=""><b>vs</b><img src="${avatarUrl('gto')}" alt=""></span></a>`;
  return h + '</div></div>';
}

function challengePage(d) {
  let h = '<div class="v3-page">' + head('Heads-up training', {href: '#study', label: 'Study'}, 'study');
  h += '<p class="v3-note">Against Ducybot, 100 big blinds every hand.</p><div class="v3-tiles v3-tiles-3">';
  for (const g of d.gto || GTO_GAMES.map(x => ({...x, hands: 0, bb100: null}))) {
    h += `<a class="v3-tile v3-tile-dark" href="#${g.hash}"><img class="v3-tile-av" src="${avatarUrl('gto')}" alt=""><span class="v3-tile-name">${g.name}</span>`;
    if (g.hands) h += `<span class="v3-record${g.bb100 < 0 ? ' down' : ''}">${bbText(g.bb100)}</span><span class="v3-dim">${g.hands} hands</span>`;
    else h += '<span class="v3-record none">Not played yet</span>';
    h += '<b>Play →</b></a>';
  }
  return h + '</div></div>';
}

function lobbyPage(d) {
  let h = '<div class="v3-page">' + head('Play', null, 'play');
  h += '<div class="v3-tile v3-tile-dark v3-tile-wide"><span class="v3-tile-text"><span class="v3-tile-name">Friends</span></span>';
  h += '<form class="v3-join" data-v3join><label class="v3-sr" for="v3-code">Game code</label><input id="v3-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Enter a code"><button type="submit">Join</button>';
  h += '<span class="v3-or">or</span><a class="v3-btn-red" href="#host">Start a game</a></form></div>';
  h += '<div class="v3-tiles">';
  h += '<a class="v3-tile v3-tile-cream" href="#clubs"><span class="v3-tile-name">Private clubs</span><span class="v3-members" aria-hidden="true">';
  for (const id of ['player-06', 'player-07', 'player-08', 'player-09', 'player-10']) h += `<img src="${avatarUrl(id)}" alt="">`;
  h += '</span></a>';
  h += `<a class="v3-tile v3-tile-red" href="#practice"><span class="v3-tile-name">Play the Regulars</span>${miniTable(['doug_poker', 'milk_king', 'phil_bigmouth', 'nik_airbag', 'jen_silly'])}</a>`;
  h += '</div>';
  // The heads-up challenge: one Regular at a time, up the ladder.
  h += '<a class="v3-tile v3-tile-cream v3-tile-wide" href="#ladder"><span class="v3-tile-text"><span class="v3-tile-name">Heads-up challenge</span></span>';
  h += `<span class="v3-rungs" aria-label="Rung ${d.rung} of ${d.rungs}">`;
  for (let i = 1; i <= d.rungs; i++) h += spade(26, i < d.rung ? 'won' : i === d.rung ? 'next' : 'open');
  h += '</span></a>';
  return h + '</div>';
}

/** The html of hub `name` (one of HUBS), with `d` from hubData. */
export function hubHtml(name, d) {
  if (name === 'study') return studyPage(d);
  if (name === 'challenge') return challengePage(d);
  if (name === 'lobby') return lobbyPage(d);
  return homePage();
}

// ---- the page ----

let root = null;
let showing = null;

export const hubOpen = () => !!showing;

/** Shows hub `name` in `el`; `onJoin(code)` handles Play's code box. */
export function openHub(el, name, onJoin) {
  showing = name;
  if (!root) {
    root = el;
    root.addEventListener('submit', e => {
      const f = e.target.closest('form[data-v3join]');
      if (!f) return;
      e.preventDefault();
      onJoin(String(f.elements.code.value || '').trim());
    });
  }
  root.innerHTML = hubHtml(name, hubData());
  root.hidden = false;
  window.scrollTo(0, 0);
}

export function closeHub() {
  showing = null;
  if (root) { root.hidden = true; root.innerHTML = ''; }
}
