// Hidden page at #play: no-limit Hold'em or pot-limit Omaha (4, 5 or 6 cards)
// against ducy's personality bots.
// The engine (ducy-wasm's BotTable) runs the hand; this file only draws the
// table, paces the bots' actions, and sends the player's decisions. The table
// runs in a worker (play-worker.js) so the page stays responsive while a bot
// thinks. Each finished hand also feeds the stats tracker (play-stats.js).
// With friends (play-net.js), the host's tab runs the table (MultiTable) and
// relays each player their own view; a guest's tab only draws the views it
// receives and sends its actions to the host. A friends table has no bots:
// seats stay empty until people join, and chips are real, handed out by the
// host on request within the table's buy-in limits.
// Heads-up against the GTO bot is training: both players start every hand
// with 100 BB, and each finished hand's decisions are reviewed against the
// bot's strategy (play-review.js) in the background.

import { countHand, recordHand, rates, pct, afText, ADVERTISED } from './play-stats.js';
import { emptyTotals, addReview, addTotals, per100, bbText, mixText, isVariant, FLAGGED, GRADE_LABEL } from './play-review.js';
import { clientId, connect, joinLink, linkedCode, linkedHost, newCode, normCode, relayUrl } from './play-net.js';
import {
  backupNeedsPassword, checkSignature, exportLockedIdentity, importIdentity, loadIdentity, MIN_PASSWORD, saveIdentity, showId, signMessage,
} from './identity.js';
import { isPublicKey, newKeyPair, open as openBox, seal, sharedKey } from './e2e.js';
import { dropTable, getTable, putTable } from './table-store.js';

let worker = null;
let nextId = 0;
const pending = new Map();

function call(op, ...args) {
  if (!worker) {
    worker = new Worker(new URL('./play-worker.js', import.meta.url), {type: 'module'});
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if ('error' in e.data) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    worker.postMessage({id, op, args});
  });
}

const SUITS = {s: '♠', h: '♥', d: '♦', c: '♣'};
const BOT_DELAY = 650; // ms between bot actions
// Seconds before auto-dealing the next hand, picked in the table bar.
const DEAL_DELAYS = [0.5, 1, 2, 3];
const SETUP_KEY = 'ducyPlaySetup';
const STATS_KEY = 'ducyPlayStats';
const REVIEW_KEY = 'ducyPlayReview';
const GTO_BUY_IN_BB = 100; // the depth the GTO bot is trained for
// Games the engine's BotTable plays: id, labels, hole cards, pot-limit.
const GAMES = [
  {id: 'nlhe', label: 'Hold’em', name: 'No-limit Hold’em', cards: 2, pl: false},
  {id: 'plo4', label: 'PLO4', name: 'Pot-limit Omaha', cards: 4, pl: true},
  {id: 'plo5', label: 'PLO5', name: 'Pot-limit Omaha 5', cards: 5, pl: true},
  {id: 'plo6', label: 'PLO6', name: 'Pot-limit Omaha 6', cards: 6, pl: true},
];
const gameOf = id => GAMES.find(g => g.id === id) || GAMES[0];
// A friends table: game, blinds, seats in all (the host's included) and the
// buy-in limits in big blinds.
const FRIENDS_DEFAULT = {game: 'nlhe', sb: 1, bb: 2, seats: 6, minBB: 50, maxBB: 200};
const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const MIN_BUY_INS = [20, 40, 50, 100];
const MAX_BUY_INS = [100, 200, 300, 500];

let root = null;
let open = false;
let personalities = [];
// The GTO bot: a solver-trained strategy for heads-up No-limit Hold'em. Its
// files are hosted at gto/ (see scripts/upload-gto.sh); it's offered when
// they're there.
const GTO_MANIFEST = new URL('gto/current.json', document.baseURI).href;
const GTO = {id: 'gto', name: 'GTO', description: 'Plays a near game-theory-optimal strategy, trained for heads-up No-limit Hold’em at 100 big blinds.'};
let gtoAvailable = false;
let gtoReady = false;
let setupNote = '';
let seated = false; // a table is in play
let botToAct = false;
let busy = false; // a request to the table is in flight
let session = 0; // bumped on leaving, so late replies are ignored
let state = null;
let timer = null;
let dealTimer = null; // auto-deal countdown, separate from the bot pacing
let dealAt = 0; // when the auto-deal fires (performance.now() time)
const holds = new Set(); // what's pausing the countdown: 'hidden', 'hover', 'user'
let raiseTo = 0;
let foldQueued = false; // fold (or check, when free) as soon as it's the player's turn
let tableGame = GAMES[0]; // the game of the table in play
let setup = loadSetup();
// Stats per game, each {playerId: counts}: since sitting down, and all time
// (kept in localStorage).
let sessionStats = {};
let allStats = loadStats();
let recordedHand = 0; // hand_number of the last hand added to the stats
let statsOpen = false;
// GTO training: the table is heads-up against the GTO bot.
let gtoTable = false;
// The last finished hand's review: {hand, data} once it's back, {hand,
// pending: true} while it's worked out. `reviewOpen` holds the decisions
// expanded to show the bot's mix.
let review = null;
let reviewOpen = new Set();
// Review totals since sitting down, and all time (kept in localStorage).
let sessionReview = emptyTotals();
let allReview = loadReviewTotals();
let statsSort = {key: 'seat', dir: 1};
// Multiplayer: 'solo' against bots, 'host' running a table for friends, or
// 'guest' at someone else's table.
let mode = 'solo';
let net = null; // relay connection
let room = ''; // table code
let netNote = ''; // connection status, e.g. "Reconnecting…"
let noteUntil = 0; // keep netNote on screen until then (a refused chip request)
let shownSeq = -1; // state number on screen, so late results are dropped
let hostChain = Promise.resolve(); // host calls to the worker, in order
let hostTimer = null; // turn clock for the host
let clockTimer = null;
let turnEnds = 0; // when the acting person's time runs out (Date.now() ms)
// A hosted table's clock stops while the host can't reach the relay or none
// of the people seated is connected, so an outage doesn't fold everyone:
// no turn runs out and no hand is dealt until someone is back.
let linkOk = false;
const guestsOnline = new Set();
let guestsSeated = [];
let clockStopped = 0; // when the clock stopped (Date.now() ms), or 0
let openSeats = 0;
// The host's side of a friends table: who's in, chip requests, limits.
let hostInfo = {playersIn: 0, chipRequests: [], buyIn: null, hostPendingChips: 0};
// A guest's chips at a friends table: {min, max, requested, approved}.
let myChips = null;
// A guest's own seat (#70): {sitting_out, waiting_for_big_blind, missed_small_blind,
// missed_big_blind, outEnds}, from the host's updates.
let mySeat = null;
let chipAsk = 0; // the amount in a guest's request box
let lastView = null; // a guest's last view from the host
let joinCode = linkedCode();
// This browser's player identity for clubs (identity.js), loaded on open.
let me = null;
let idNote = '';

function defaultSetup() {
  return {game: 'nlhe', count: 5, bots: [], sb: 1, bb: 2, buyIn: 200, hud: true, statsScope: 'session', autoDeal: false, dealSecs: 1, name: '', turnSecs: 30, review: true, tab: 'bots', friends: {...FRIENDS_DEFAULT}};
}

function loadSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(SETUP_KEY) || 'null');
    if (s && Array.isArray(s.bots)) return {...defaultSetup(), ...s, friends: {...FRIENDS_DEFAULT, ...(s.friends || {})}};
  } catch {}
  return defaultSetup();
}

function saveSetup() {
  try { localStorage.setItem(SETUP_KEY, JSON.stringify(setup)); } catch {}
}

function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    if (s && typeof s === 'object' && s.v === 1 && s.games && typeof s.games === 'object') return s.games;
  } catch {}
  return {};
}

function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify({v: 1, games: allStats})); } catch {}
}

function loadReviewTotals() {
  try {
    const s = JSON.parse(localStorage.getItem(REVIEW_KEY) || 'null');
    if (s && s.v === 1 && s.totals && typeof s.totals === 'object') return addTotals(emptyTotals(), s.totals);
  } catch {}
  return emptyTotals();
}

function saveReviewTotals() {
  try { localStorage.setItem(REVIEW_KEY, JSON.stringify({v: 1, totals: allReview})); } catch {}
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function cardHtml(c) {
  if (!c) return '<span class="pl-card back"></span>';
  const red = c[1] === 'h' || c[1] === 'd';
  return `<span class="pl-card s-${c[1]}${red ? ' r' : ''}">${c[0]}${SUITS[c[1]]}</span>`;
}

const nameOf = seat => (state ? state.seats[seat].name : '');

// ---- setup ----

// The GTO bot plays heads-up No-limit Hold'em only.
const gtoAllowed = () => gtoAvailable && setup.game === 'nlhe' && setup.count === 1;
const botChoices = () => (gtoAllowed() ? [GTO, ...personalities] : personalities);

// Fills empty or unknown bot picks with random personalities not already seated.
function fillBots() {
  const ids = personalities.map(p => p.id);
  const valid = botChoices().map(p => p.id);
  const bots = setup.bots.slice(0, setup.count).map(b => (valid.includes(b) ? b : null));
  while (bots.length < setup.count) bots.push(null);
  for (let i = 0; i < bots.length; i++) {
    if (bots[i]) continue;
    const free = ids.filter(id => !bots.includes(id));
    bots[i] = (free.length ? free : ids)[Math.floor(Math.random() * (free.length || ids.length))];
  }
  setup.bots = bots;
}

// The setup screen: playing the bots, or (with a relay) a table for friends.
function renderSetup() {
  const tabs = !!relayUrl();
  const friends = tabs && setup.tab === 'friends';
  let h = '<div class="pl-wrap">';
  if (tabs) {
    const tab = (id, label) => `<button class="pl-tab${(id === 'friends') === friends ? ' on' : ''}" role="tab" aria-selected="${(id === 'friends') === friends}" data-tab="${id}">${label}</button>`;
    h += `<div class="pl-tabs" role="tablist">${tab('bots', 'Play the bots')}${tab('friends', 'Play with friends')}</div>`;
  }
  h += friends ? friendsSetupHtml() : botsSetupHtml();
  h += '</div>';
  root.innerHTML = h;
}

function optsRow(label, items) {
  return `<div class="pl-row"><span class="pl-label">${label}</span><div class="pl-opts">${items.join('')}</div></div>`;
}

const optBtn = (on, attr, value, text) => `<button class="cc-btn${on ? ' on' : ''}" ${attr}="${value}">${text}</button>`;

function botsSetupHtml() {
  fillBots();
  let h = '<div class="pl-head"><h1>Play the bots</h1>';
  h += '<p>No-limit Hold’em or pot-limit Omaha against ducy’s bot personalities. Each one plays a different style, and some adapt to how you play.</p></div>';
  h += '<div class="pl-setup">';
  h += optsRow('Game', GAMES.map(g => optBtn(setup.game === g.id, 'data-pgame', g.id, g.label)));
  h += optsRow('Opponents', [1, 2, 3, 4, 5, 6, 7, 8].map(n => optBtn(setup.count === n, 'data-count', n, n)));
  h += optsRow('Blinds', [[1, 2], [5, 10], [25, 50]].map(([sb, bb]) => optBtn(setup.bb === bb, 'data-blinds', `${sb}/${bb}`, `${sb}/${bb}`)));
  h += optsRow('Buy-in', [50, 100, 200].map(bbs => optBtn(setup.buyIn === bbs * setup.bb, 'data-buyin', bbs, `${bbs} BB`)));
  h += '<div class="pl-bots">';
  setup.bots.forEach((id, i) => {
    const p = botChoices().find(x => x.id === id);
    h += `<label class="pl-bot"><span class="pl-seatno">Seat ${i + 2}</span><select data-bot="${i}">`;
    for (const q of botChoices()) h += `<option value="${q.id}"${q.id === id ? ' selected' : ''}>${esc(q.name)}</option>`;
    h += `</select><span class="pl-desc">${esc(p ? p.description : '')}</span></label>`;
  });
  h += '</div>';
  if (gtoAvailable && !gtoAllowed()) h += '<p class="pl-desc">Play heads-up No-limit Hold’em (1 opponent) to face the GTO bot.</p>';
  if (gtoAllowed() && setup.bots[0] === 'gto') h += `<p class="pl-desc">GTO training: you both start every hand with ${GTO_BUY_IN_BB} BB, whatever the buy-in, and your decisions are reviewed after each hand.</p>`;
  if (setupNote) h += `<p class="pl-desc">${esc(setupNote)}</p>`;
  h += '<div class="pl-actions"><button class="btn-small" data-act="shuffle">Random opponents</button>';
  h += '<button class="tr-start" data-act="sit">Sit down</button></div>';
  h += '</div>';
  return h;
}

// A table for friends: no bots, seats stay empty until people join, and
// everyone asks the host for chips within the buy-in limits.
function friendsSetupHtml() {
  const f = setup.friends;
  let h = '<div class="pl-head"><h1>Play with friends</h1>';
  h += '<p>Host a table and send friends the link. Seats stay empty until people join; each player asks you for chips, and you approve them. Running a regular game? <a href="#clubs">Start a club</a>.</p></div>';
  h += '<div class="pl-setup pl-multi">';
  if (savedTable && mode !== 'host') {
    const ago = Math.max(1, Math.round((Date.now() - savedTable.at) / 60_000));
    h += `<div class="pl-resume"><p>Your table <b>${esc(savedTable.room)}</b> stopped ${ago < 60 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago with a hand in progress. Resume it, and players rejoin with the same code.</p>`;
    h += '<div class="pl-actions"><button class="tr-start" data-act="resumehost">Resume table</button><button class="btn-small" data-act="forgethost">Discard</button></div></div>';
  }
  h += `<div class="pl-row"><span class="pl-label">Your name</span><input class="pl-text" id="pl-name" maxlength="20" placeholder="Name" value="${esc(setup.name)}"></div>`;
  h += identityRowHtml();
  h += optsRow('Game', GAMES.map(g => optBtn(f.game === g.id, 'data-fgame', g.id, g.label)));
  h += optsRow('Blinds', [[1, 2], [5, 10], [25, 50]].map(([sb, bb]) => optBtn(f.bb === bb, 'data-fblinds', `${sb}/${bb}`, `${sb}/${bb}`)));
  h += optsRow('Table size', TABLE_SIZES.map(n => optBtn(f.seats === n, 'data-fseats', n, n)));
  h += optsRow('Min buy-in', MIN_BUY_INS.map(n => optBtn(f.minBB === n, 'data-fmin', n, `${n} BB`)));
  h += optsRow('Max buy-in', MAX_BUY_INS.map(n => optBtn(f.maxBB === n, 'data-fmax', n, `${n} BB`)));
  h += optsRow('Turn time', [15, 30, 60, 0].map(t => optBtn(setup.turnSecs === t, 'data-turn', t, t ? t + 's' : 'None')));
  h += `<p class="pl-desc">Up to ${f.seats} players, you included. Everyone, you too, holds between ${f.minBB * f.bb} and ${f.maxBB * f.bb} chips after a top-up (${f.minBB}–${f.maxBB} BB); chips carry over from hand to hand.</p>`;
  h += '<div class="pl-actions"><button class="tr-start" data-act="host">Host a table</button></div>';
  h += '<h2>Join a table</h2>';
  h += '<div class="pl-row"><span class="pl-label">Table code</span><div class="pl-opts">';
  h += `<input class="pl-text" id="pl-code" maxlength="9" placeholder="ABCD-EFGH" value="${esc(joinCode)}">`;
  h += '<button class="tr-btn" data-act="join">Join table</button></div></div>';
  if (netNote) h += `<p class="pl-desc pl-neterr">${esc(netNote)}</p>`;
  h += '</div>';
  return h;
}

// The player ID, with backup and restore. The ID only lives in this browser,
// so a backup file is the way to keep it after clearing site data or to use
// it on another device.
function identityRowHtml() {
  let h = '<div class="pl-row"><span class="pl-label">Player ID</span><div class="pl-opts">';
  h += `<code class="pl-pid" title="Your ID in clubs">${me ? esc(showId(me.id)) : '…'}</code>`;
  h += `<button class="btn-small" data-act="idbackup"${me ? '' : ' disabled'}>Back up</button>`;
  h += '<label class="btn-small">Restore<input type="file" id="pl-idfile" accept=".json,application/json" hidden></label>';
  h += '</div></div>';
  if (idForm?.kind === 'backup') {
    h += '<form class="pl-idform" data-idform="backup">';
    h += '<p class="pl-desc">Choose a password for the backup file. You’ll need it to restore; it isn’t kept anywhere, so if you forget it the file can’t be opened.</p>';
    h += `<label>Password<input class="pl-text" type="password" name="pw" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
    h += `<label>Again<input class="pl-text" type="password" name="pw2" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
    h += '<div class="pl-actions"><button class="btn-small primary" type="submit">Save backup</button><button class="btn-small" type="button" data-act="idcancel">Cancel</button></div></form>';
  } else if (idForm?.kind === 'restore') {
    h += '<form class="pl-idform" data-idform="restore">';
    h += `<p class="pl-desc">This backup of player ID ${esc(showId(idForm.id))} is locked. Enter its password.</p>`;
    h += '<label>Password<input class="pl-text" type="password" name="pw" required autocomplete="current-password"></label>';
    h += '<div class="pl-actions"><button class="btn-small primary" type="submit">Restore</button><button class="btn-small" type="button" data-act="idcancel">Cancel</button></div></form>';
  }
  if (idNote) h += `<p class="pl-desc">${esc(idNote)}</p>`;
  return h;
}

// The backup and restore forms: {kind: 'backup'}, or {kind: 'restore', text,
// id} for a locked file waiting for its password.
let idForm = null;

// Saves a backup file locked with `password` (identity.js).
async function backupIdentity(password) {
  if (!me) return;
  try {
    const blob = new Blob([await exportLockedIdentity(me, password)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ducy-identity-${showId(me.id)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    idForm = null;
    idNote = 'Backup saved, locked with your password. Keep the file and the password safe: with both, anyone can play as you.';
  } catch (e) {
    idNote = e.message;
  }
  render();
}

// A backup file was chosen: a locked one asks for its password first.
async function chooseBackup(file) {
  const text = await file.text();
  if (backupNeedsPassword(text)) {
    let id = '';
    try { id = JSON.parse(text).id || ''; } catch {}
    idForm = {kind: 'restore', text, id};
    idNote = '';
    render();
    root.querySelector('form[data-idform] [name=pw]')?.focus();
    return;
  }
  restoreIdentity(text, '');
}

async function restoreIdentity(text, password) {
  try {
    const ident = await importIdentity(text, password);
    if (me && ident.id !== me.id && !confirm(`Replace player ID ${showId(me.id)} with ${showId(ident.id)}? Clubs that know ${showId(me.id)} won’t recognize this browser any more.`)) return;
    await saveIdentity(ident);
    me = ident;
    idForm = null;
    idNote = `Restored player ID ${showId(ident.id)}.${password ? '' : ' That backup had no password: make a new one with Back up, and delete the old file.'}`;
  } catch (e) {
    idNote = e.message;
  }
  render();
}

function onIdSubmit(e) {
  const f = e.target.closest('form[data-idform]');
  if (!f) return;
  e.preventDefault();
  const pw = f.elements.pw.value;
  if (f.dataset.idform === 'backup') {
    if (pw !== f.elements.pw2.value) { idNote = 'The passwords don’t match.'; render(); return; }
    backupIdentity(pw);
  } else if (idForm?.kind === 'restore') {
    restoreIdentity(idForm.text, pw);
  }
}

// ---- table ----

// Sends one request to the table and returns its {state, botToAct}, or null
// if it failed or the player left the table meanwhile.
async function request(op, ...args) {
  if (busy) return null;
  busy = true;
  const mine = session;
  try {
    const snap = await (mode === 'host' ? hostCall('host' + op[0].toUpperCase() + op.slice(1), ...args) : call(op, ...args));
    return mine === session ? snap : null;
  } catch (e) {
    console.warn(e);
    return null;
  } finally {
    busy = false;
  }
}

function show(snap) {
  if (snap.seq != null) {
    // A newer state is already on screen (results can arrive out of order).
    if (snap.seq < shownSeq) { pace(); return; }
    shownSeq = snap.seq;
    turnEnds = snap.turnMsLeft != null ? (clockStopped || Date.now()) + num(snap.turnMsLeft) : 0;
  }
  state = mode === 'solo' ? snap.state : withStatIds(snap.state);
  botToAct = snap.botToAct;
  // A finished hand, for a club player's hand history (#71).
  const hn = num(snap.state.hand_number);
  if (handHook && snap.state.complete && hn && hn !== hookedHand) { hookedHand = hn; handHook(snap.state); }
  recordStats();
  startReview();
  if (state.complete || state.seats[0].folded) foldQueued = false;
  // A queued fold folds when facing a bet, and checks (staying queued) when
  // it's free to see more cards.
  const L = state.legal;
  const auto = foldQueued && L ? (L.can_fold ? 'fold' : L.can_check ? 'check' : null) : null;
  if (L && !auto) foldQueued = false;
  render();
  armDeal();
  if (!auto) { pace(); return; }
  act(auto).then(ok => { if (!ok) { foldQueued = false; render(); } });
}

// The player can queue a fold while someone else is to act in a hand they're
// still in.
function canPrefold() {
  const me = state.seats[0];
  return !state.legal && !state.complete && !me.folded && !me.all_in && !me.sitting_out && !me.empty;
}

function togglePrefold() {
  foldQueued = !foldQueued && canPrefold();
  render();
}

// Downloads (the first time) and loads the GTO bot's files in the worker.
async function prepareGto() {
  if (gtoReady || !setup.bots.includes('gto')) return true;
  root.innerHTML = '<div class="pl-wrap"><p class="pl-meta">Loading the GTO bot (about 3 MB the first time, then it’s kept on this device)…</p></div>';
  try { navigator.storage?.persist?.(); } catch {}
  try {
    await call('loadGto', GTO_MANIFEST);
    gtoReady = true;
    return true;
  } catch (e) {
    console.warn(e);
    setupNote = 'The GTO bot couldn’t be loaded. Try again, or pick another opponent.';
    return false;
  }
}

async function startTable() {
  setupNote = '';
  if (!await prepareGto()) { render(); return; }
  saveSetup();
  tableGame = gameOf(setup.game);
  mode = 'solo';
  seated = true;
  raiseTo = 0;
  holds.delete('user');
  foldQueued = false;
  sessionStats = {};
  recordedHand = 0;
  gtoTable = setup.game === 'nlhe' && setup.bots.length === 1 && setup.bots[0] === 'gto';
  review = null;
  sessionReview = emptyTotals();
  const buyIn = gtoTable ? GTO_BUY_IN_BB * setup.bb : setup.buyIn;
  const snap = await request('create', setup.bots, buyIn, setup.sb, setup.bb, crypto.getRandomValues(new Uint32Array(1))[0], setup.game);
  if (snap) show(snap);
}

async function nextHand() {
  if (mode === 'guest') return; // the host deals
  if (mode === 'host' && hostInfo.playersIn < 2) return; // no one to deal to
  cancelDeal();
  raiseTo = 0;
  foldQueued = false;
  // GTO training starts every hand at 100 BB: no chips carry over.
  const snap = await request('newHand', ...(mode === 'solo' && gtoTable ? [true] : []));
  if (!snap) return;
  holds.delete('user'); // a pause lasts until the next hand
  show(snap);
}

// ---- auto-deal ----

function cancelDeal() {
  clearTimeout(dealTimer);
  dealTimer = null;
}

// Starts (or restarts) the countdown to the next hand when a hand is over,
// auto-deal is on, and nothing is pausing it; otherwise cancels it.
function armDeal() {
  cancelDeal();
  // A hosted table waits for the host's first deal; guests never deal.
  if (!open || !seated || !state || !state.complete || !setup.autoDeal || holds.size || mode === 'guest' || !num(state.hand_number)) { syncDeal(); return; }
  dealAt = performance.now() + 1000 * (DEAL_DELAYS.includes(setup.dealSecs) ? setup.dealSecs : 1);
  const mine = session;
  const tick = () => {
    if (mine !== session) return;
    const left = dealAt - performance.now();
    if (left <= 0) { dealTimer = null; nextHand(); return; }
    // Wake when the shown whole second changes.
    dealTimer = setTimeout(tick, left - (Math.ceil(left / 1000) - 1) * 1000);
    syncDeal();
  };
  tick();
}

// Pauses (on) or resumes (off) the countdown for one reason; resuming
// restarts it from the top.
function hold(why, on) {
  if (on === holds.has(why)) return;
  if (on) holds.add(why); else holds.delete(why);
  armDeal();
}

function nextLabel() {
  if (!setup.autoDeal) return 'Next hand';
  if (holds.size || !dealTimer) return 'Next hand (paused)';
  return `Next hand in ${Math.max(1, Math.ceil((dealAt - performance.now()) / 1000))}…`;
}

const pauseLabel = () => (holds.has('user') ? 'Resume' : 'Pause');

// Updates the countdown buttons in place, so the log isn't redrawn under the pointer.
function syncDeal() {
  if (!root) return;
  const next = root.querySelector('#pl-next');
  if (next) next.textContent = nextLabel();
  const pause = root.querySelector('#pl-pause');
  if (pause) pause.firstChild.textContent = pauseLabel() + ' ';
}

// Lets bots act one at a time until it's the player's turn or the hand is
// over. The bot starts thinking right away; its action is shown once at least
// BOT_DELAY has passed, so fast decisions still read one at a time.
async function pace() {
  clearTimeout(timer);
  if (!open || !seated || !botToAct || busy) return;
  const started = performance.now();
  const snap = await request('advance');
  if (!snap || !open) return;
  timer = setTimeout(() => show(snap), Math.max(0, BOT_DELAY - (performance.now() - started)));
}

// Resolves to whether the table took the action.
async function act(kind, amount = 0) {
  if (mode === 'guest') return guestAct(kind, amount);
  const snap = await request('act', kind, amount);
  if (!snap) return false;
  raiseTo = 0;
  show(snap);
  return true;
}

// ---- multiplayer ----

// ---- encrypted updates at a friends table (e2e.js) ----
// The relay forwards everything, so every update to a guest (which has
// their hole cards) is encrypted with a key only the host and that guest
// share. The host signs its key with its player identity and the invite
// link names the host (?host=ID), so a guest can tell the relay didn't swap
// it; a guest who typed the code instead trusts the first host key it gets.
let e2eHost = null; // host: {keys, guests: Map(client → {key, sends, inbox})}
let e2eGuest = null; // guest: {keys, aes, aesFor, hostId, inbox}

const e2eContext = (client, hostPub, guestPub) => ({context: `table:${room}`, hostId: '', playerId: client, hostPub, playerPub: guestPub});

function hostGuest(client) {
  let g = e2eHost.guests.get(client);
  if (!g) e2eHost.guests.set(client, (g = {key: null, sends: Promise.resolve(), inbox: Promise.resolve()}));
  return g;
}

// The host's signed key, for a guest who just connected.
async function sendHostKey(client) {
  const key = (await e2eHost.keys).pub;
  const body = {type: 'host_key', table: room, key};
  net?.send({to: client, data: me ? await signMessage(me, body) : body});
}

// A message from guest `client`, in the order it arrived: their key first
// (derive the shared key), then their commands for the table.
function hostIncoming(client, data) {
  const g = hostGuest(client);
  g.inbox = g.inbox.then(async () => {
    if (data?.type === 'e2e_key') {
      if (!isPublicKey(data.key)) return;
      const hk = await e2eHost.keys;
      g.key = await sharedKey(hk, data.key, e2eContext(client, hk.pub, data.key));
      return;
    }
    hostEvent('hostHandle', client, data);
  }).catch(e => console.warn(e));
}

// An update for guest `to`, encrypted; without their key it isn't sent.
function sendToGuest(to, data) {
  const g = e2eHost?.guests.get(to);
  if (!g?.key) { console.warn('table: no key for', to, '- update not sent'); return; }
  g.sends = g.sends.then(async () => { net?.send({to, data: {enc: await seal(g.key, data)}}); }).catch(e => console.warn(e));
}

// A guest's incoming message, in order: the host's key, then encrypted
// updates. Relay notices (host_gone) come in the clear; anything else
// unencrypted is ignored, since only the host can make an update that opens.
function guestIncoming(m) {
  e2eGuest.inbox = e2eGuest.inbox.then(async () => {
    if (m?.type === 'host_key' || m?.body?.type === 'host_key') {
      const signed = !!m.sig;
      if (signed && (await checkSignature(m) || (e2eGuest.hostId && m.from !== e2eGuest.hostId))) { console.warn('table: a host key that isn’t from the host; ignored'); return; }
      if (!signed && e2eGuest.hostId) { console.warn('table: an unsigned host key; ignored'); return; }
      const hostPub = signed ? m.body.key : m.key;
      if (!isPublicKey(hostPub) || hostPub === e2eGuest.aesFor) return;
      const gk = await e2eGuest.keys;
      e2eGuest.aes = await sharedKey(gk, hostPub, e2eContext(clientId(), hostPub, gk.pub));
      e2eGuest.aesFor = hostPub;
      return;
    }
    if (m?.enc) {
      if (!e2eGuest.aes) return;
      let update;
      try { update = await openBox(e2eGuest.aes, m.enc); } catch { console.warn('table: an update didn’t decrypt; ignored'); return; }
      guestMessage(update);
      return;
    }
    if (m?.type === 'host_gone') guestMessage(m);
  }).catch(e => console.warn(e));
}

// Calls the host's MultiTable in order, and relays the messages it returns.
function hostCall(op, ...args) {
  const p = hostChain.then(() => call(op, ...args)).then(async r => {
    // Saved before anyone is told, so a resumed table is never behind what
    // players were shown (#117).
    await saveHostTable(r);
    for (const m of r.out) sendToGuest(m.to, m.data);
    guestsSeated = r.players || [];
    syncHostClock();
    openSeats = r.openSeats;
    hostInfo = {
      playersIn: r.playersIn ?? 0,
      chipRequests: r.chipRequests || [],
      buyIn: r.buyIn ? {min: num(r.buyIn.min), max: num(r.buyIn.max)} : null,
      hostPendingChips: num(r.hostPendingChips || 0),
    };
    return r;
  });
  hostChain = p.catch(() => {});
  return p;
}

// Stops or restarts the friends table's clock to match who can be reached.
function syncHostClock() {
  const stop = mode === 'host' && (!linkOk || (guestsSeated.length > 0 && !guestsSeated.some(p => guestsOnline.has(p.client_id))));
  if (stop === !!clockStopped) return;
  // The turn shown on screen resumes with the time it had left.
  if (stop) clockStopped = Date.now();
  else { if (turnEnds) turnEnds += Date.now() - clockStopped; clockStopped = 0; }
  hostChain = hostChain.then(() => call('clockPause', 'host', stop)).catch(e => console.warn(e));
  hold('offline', stop);
  render();
}

// A host call that isn't the player's own request (a message, the clock).
function hostEvent(op, ...args) {
  const mine = session;
  hostCall(op, ...args).then(r => {
    if (mine === session && mode === 'host' && r.seq !== shownSeq) show(r);
  }, e => console.warn(e));
}

async function hostTable() {
  readNameInput();
  setupNote = '';
  saveSetup();
  const f = setup.friends;
  forgetSavedTable();
  startHosting(newCode(), f.game);
  // The host starts with 100 BB, kept within the table's limits.
  const min = f.minBB * f.bb, max = f.maxBB * f.bb;
  const hostChips = Math.max(min, Math.min(max, 100 * f.bb));
  request('friends', f.seats, setup.name, hostChips, min, max, f.sb, f.bb, crypto.getRandomValues(new Uint32Array(1))[0], f.game, setup.turnSecs * 1000)
    .then(snap => { if (snap) show(snap); });
}

// Hosting a friends table with code `code`: the relay connection, keys and
// clocks, for a new table (hostTable) or one resumed (resumeHosting).
function startHosting(code, game) {
  tableGame = gameOf(game);
  hostGame = game;
  mode = 'host';
  hostInfo = {playersIn: 1, chipRequests: [], buyIn: null, hostPendingChips: 0};
  gtoTable = false;
  review = null;
  sessionStats = {};
  recordedHand = 0;
  room = code;
  netNote = '';
  shownSeq = -1;
  seated = true;
  state = null;
  raiseTo = 0;
  foldQueued = false;
  const mine = session;
  e2eHost = {keys: newKeyPair(), guests: new Map()};
  linkOk = false;
  guestsOnline.clear();
  guestsSeated = [];
  clockStopped = 0;
  net = connect(room, 'host', null, {
    // The relay tells us again who's connected.
    onOpen() { if (mine === session) guestsOnline.clear(); },
    onMessage(m) {
      if (mine !== session) return;
      if (m.event === 'open') { guestsOnline.add(m.from); syncHostClock(); sendHostKey(m.from); maybeResume(); }
      else if (m.event === 'close') { guestsOnline.delete(m.from); syncHostClock(); hostEvent('hostDisconnected', m.from); }
      else if (m.data) hostIncoming(m.from, m.data);
    },
    onStatus(t) { netNote = t; render(); },
    onFail(t) { leaveTable(t); },
    onHealth(ok) { if (mine !== session) return; linkOk = ok; syncHostClock(); },
  }, {heartbeat: true, persistent: true});
  hostTimer = setInterval(() => { if (!clockStopped && turnEnds && Date.now() >= turnEnds) hostEvent('hostTick'); }, 250);
  startClock();
}

// ---- resuming a friends table (#117) ----
//
// After every change the host's table is saved in this browser (with
// ducy's MultiTable.save: every card of the hand in progress, so only this
// page reads it). If the page closes or the browser restarts, the setup
// screen offers to resume: the table comes back under the same code, so
// players' pages, which keep reconnecting, find it again. Play waits until
// everyone seated is back, or RESUME_GRACE_MS, after which whoever is
// missing counts as disconnected. Leaving the table forgets it.

const SAVED = ['friends', 'host']; // its table-store key
const SAVED_FOR_MS = 24 * 3600_000; // older saves aren't offered
const RESUME_GRACE_MS = 60_000;
let savedTable = null; // {json, room, game, seq, at}, if there's one to offer
let hostGame = ''; // the game being hosted, saved with the table
let savedSeq = -1, noSave = false; // the last state saved; the engine can't save
let resuming = null; // while a resumed table waits for its players: the grace timer

getTable(...SAVED).then(rec => {
  if (rec && Date.now() - rec.at < SAVED_FOR_MS) { savedTable = rec; render(); }
}).catch(() => {});

// Saves the hosted table when its state changed. A table that can't be saved
// (an older ducy-wasm, or storage blocked) just plays on, as before.
async function saveHostTable(r) {
  if (mode !== 'host' || noSave || r.seq == null || r.seq === savedSeq || resuming) return;
  try {
    const json = await call('hostSave');
    if (json == null) { noSave = true; return; }
    await putTable(...SAVED, {json, room, game: hostGame, seq: r.seq, at: Date.now()});
    savedSeq = r.seq;
  } catch (e) {
    console.warn('table: not saved:', e);
  }
}

function forgetSavedTable() {
  savedTable = null;
  savedSeq = -1;
  noSave = false;
  dropTable(...SAVED).catch(() => {});
}

async function resumeHosting() {
  const rec = savedTable;
  if (!rec) return;
  readNameInput();
  setupNote = '';
  savedTable = null;
  savedSeq = rec.seq;
  noSave = false;
  startHosting(rec.room, rec.game);
  resuming = setTimeout(() => wake(), RESUME_GRACE_MS);
  try {
    show(await hostCall('hostRestore', rec.json));
    netNote = 'Resumed: play goes on once everyone is back (at most a minute).';
    maybeResume();
  } catch (e) {
    console.warn(e);
    clearTimeout(resuming);
    resuming = null;
    forgetSavedTable();
    leaveTable('That table couldn’t be resumed. Host a new one.');
  }
}

// A player came back: once everyone seated is, play goes on.
function maybeResume() {
  if (resuming && guestsSeated.length && guestsSeated.every(p => guestsOnline.has(p.client_id))) wake();
}

// The resumed table plays on: everyone not back yet counts as disconnected
// (they check or fold, and their seat waits for them as usual).
function wake() {
  if (!resuming) return;
  clearTimeout(resuming);
  resuming = null;
  netNote = '';
  for (const p of guestsSeated) if (!guestsOnline.has(p.client_id)) hostEvent('hostDisconnected', p.client_id);
  hostEvent('hostResume');
}

function joinTable() {
  readNameInput();
  const code = normCode(root.querySelector('#pl-code')?.value || joinCode);
  if (!code) { netNote = 'Enter the 8-character table code.'; render(); return; }
  saveSetup();
  joinCode = code;
  startGuest(code);
  const mine = session;
  e2eGuest = {keys: newKeyPair(), aes: null, aesFor: '', hostId: linkedHost(), inbox: Promise.resolve()};
  net = connect(code, 'guest', clientId(), {
    // Our key first, then the join, so the host can encrypt from the start.
    async onOpen() {
      const key = (await e2eGuest.keys).pub;
      net.send({type: 'e2e_key', key});
      net.send({type: 'join', name: setup.name});
    },
    onMessage(m) { if (mine === session) guestIncoming(m); },
    onStatus(t) { netNote = t; render(); },
    onFail(t) { leaveTable(t); },
    // Once in, keep trying through an outage: the host holds the seat and
    // the hand waits (a wrong code still fails at once).
  }, {persistent: true});
  render();
  startClock();
}

// Sits down at a table reached some other way than a table code: a club
// table (clubs.js). `open(handlers)` returns {send(command), close()} and
// calls handlers.onMessage(update) for each update from the table's host,
// handlers.onStatus(text) and handlers.onFail(reason). Leaving the table
// calls `onLeave`.
let leaveHook = null;
// With `watch`, only watch the table (a club host, #73): no seat, nothing to
// act on, and the hands aren't added to your stats.
export function joinTableVia(open, {label = '', onLeave = null, watch = false, onHand = null} = {}) {
  if (seated) leaveTable();
  startGuest(label);
  watching = watch;
  handHook = onHand;
  hookedHand = 0;
  leaveHook = onLeave;
  const mine = session;
  net = open({
    onMessage(m) { if (mine === session) guestMessage(m); },
    onStatus(t) { if (mine === session) { netNote = t; render(); } },
    onFail(t) { if (mine === session) leaveTable(t); },
  });
  if (!watch) net.send({type: 'join', name: setup.name});
  render();
  startClock();
}
let watching = false;
let handHook = null, hookedHand = 0; // joinTableVia's onHand(view), and the last hand it saw

function startGuest(code) {
  mode = 'guest';
  myChips = null;
  mySeat = null;
  chipAsk = 0;
  gtoTable = false;
  review = null;
  sessionStats = {};
  recordedHand = 0;
  room = code;
  netNote = 'Connecting…';
  shownSeq = -1;
  seated = true;
  state = null;
  lastView = null;
  raiseTo = 0;
  foldQueued = false;
}

function guestMessage(m) {
  if (m.type === 'state') {
    lastView = m.view;
    myChips = m.chips ? {min: num(m.chips.min), max: num(m.chips.max), requested: num(m.chips.requested), approved: num(m.chips.approved)} : null;
    // Sitting out (#70): out or not, missed blinds, time left before the seat goes.
    mySeat = m.me ? {...m.me, outEnds: m.me.out_ms_left != null ? Date.now() + num(m.me.out_ms_left) : 0} : null;
    tableGame = GAMES.find(g => g.cards === num(m.view.hole_cards) && g.pl === m.view.pot_limit) || GAMES[0];
    if (Date.now() > noteUntil) netNote = '';
    show({seq: num(m.seq), state: m.view, botToAct: false, turnMsLeft: m.turn_ms_left});
  } else if (m.type === 'rejected') {
    if (m.reason === 'the table is full') { leaveTable('That table is full.'); return; }
    if (/sat out too long/.test(m.reason || '')) { leaveTable('You sat out too long, so your seat was given up. Your chips went back to you.'); return; }
    // A chip request the host turned down, with why (a club table: not
    // enough chips in the club, the rathole rule).
    if (m.chips) { netNote = m.reason; noteUntil = Date.now() + 6000; render(); return; }
    // Our action didn't count (e.g. the turn moved on): back to the last view.
    if (lastView) { state = lastView; render(); }
  } else if (m.type === 'host_gone') {
    netNote = 'The host is reconnecting…';
    render();
  }
}

// Sends the action to the host; the next view shows the result.
function guestAct(kind, amount) {
  if (!state?.legal) return false;
  net?.send({type: 'act', seq: shownSeq, kind, amount});
  raiseTo = 0;
  state = {...state, legal: null};
  render();
  return true;
}

// Stats follow ids: at a shared table you are 'you' wherever you sit, and
// friends are kept by name.
function withStatIds(view) {
  return {...view, seats: view.seats.map((x, i) => ({...x, id: i === 0 ? 'you' : x.human ? 'friend:' + x.name : x.id}))};
}

function readNameInput() {
  const el = root.querySelector('#pl-name');
  if (el) setup.name = el.value.trim().slice(0, 20);
}

// Ticks the turn clocks on screen.
function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    for (const el of root.querySelectorAll('[data-clock]')) el.textContent = clockText();
    for (const el of root.querySelectorAll('[data-outclock]')) el.textContent = outClockText();
  }, 250);
}

function clockText() {
  if (!turnEnds) return '';
  const left = Math.max(0, Math.ceil((turnEnds - (clockStopped || Date.now())) / 1000)) + 's';
  return clockStopped ? left + ' (paused)' : left;
}

function leaveTable(note = '') {
  clearTimeout(timer);
  clearTimeout(resuming);
  resuming = null;
  cancelDeal();
  clearInterval(hostTimer);
  clearInterval(clockTimer);
  clockStopped = 0;
  holds.delete('offline');
  if (mode === 'guest' && !watching) net?.send({type: 'leave'});
  watching = false;
  handHook = null;
  net?.close();
  net = null;
  session++;
  mode = 'solo';
  seated = false;
  state = null;
  foldQueued = false;
  turnEnds = 0;
  netNote = note;
  const hook = leaveHook;
  leaveHook = null;
  if (hook) hook(note);
  else render();
}

async function copyLink() {
  try { await navigator.clipboard.writeText(joinLink(room, me?.id)); netNote = 'Link copied'; } catch { netNote = joinLink(room, me?.id); }
  render();
}

const num = v => Number(v); // serde sends u64 as numbers (or BigInt for very large)

function seatPos(i, n) {
  // The player (seat 0) sits at the bottom; the rest go clockwise around the oval.
  const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
  return {x: 50 + 44 * Math.cos(a), y: 50 + 40 * Math.sin(a)};
}

function eventText(e) {
  // Seat 0 is you: "You call" but "Rampart calls". At friends and club tables
  // your seat shows your name, so the log says "You" rather than "Ann call".
  // Watching a club table (#73), seat 0 is someone else.
  const me0 = e.seat === 0 && !watching;
  const who = e.seat == null ? '' : me0 ? 'You' : nameOf(e.seat);
  const v = (base, s = base + 's') => (me0 ? base : s);
  const allIn = e.all_in ? ' (all-in)' : '';
  switch (e.type) {
    case 'small_blind': return `${who} ${v('post')} the small blind ${num(e.amount)}`;
    case 'big_blind': return `${who} ${v('post')} the big blind ${num(e.amount)}`;
    // Coming back after sitting out (#70): missed blinds, dead and live.
    case 'post': return `${who} ${v('post')} missed blinds: ${[num(e.dead) && `${num(e.dead)} dead`, num(e.live) && `${num(e.live)} live`].filter(Boolean).join(' + ')}`;
    case 'ante': return `${who} ${v('ante')} ${num(e.amount)}`;
    case 'fold': return `${who} ${v('fold')}`;
    case 'check': return `${who} ${v('check')}`;
    case 'call': return `${who} ${v('call')} ${num(e.amount)}${allIn}`;
    case 'bet': return `${who} ${v('bet')} ${num(e.to)}${allIn}`;
    case 'raise': return `${who} ${v('raise', 'raises')} to ${num(e.to)}${allIn}`;
    case 'board': return `${String(e.street)}: ${e.cards.join(' ')}`;
    case 'award': return `${who} ${v('win')} ${num(e.amount)}${e.pot > 0 ? ' (side pot)' : ''}`;
    default: return '';
  }
}

// The latest action by each seat on the current street, shown under its name.
function lastActions() {
  const out = {};
  for (const e of state.events) {
    if (e.type === 'board') { for (const k of Object.keys(out)) if (out[k] !== 'Fold') delete out[k]; continue; }
    if (e.seat == null || e.type === 'award') continue;
    const t = {small_blind: 'SB', big_blind: 'BB', ante: 'Ante', fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise'}[e.type];
    if (t) out[e.seat] = t;
  }
  return out;
}

function renderTable() {
  const s = state, n = s.seats.length;
  const last = lastActions();
  let h = '<div class="pl-wrap pl-play">';
  h += '<div class="pl-bar">';
  h += `<span class="pl-meta">${tableGame.name} · hand ${num(s.hand_number)} · blinds ${num(s.small_blind ?? setup.sb)}/${num(s.big_blind ?? setup.bb)}</span>`;
  if (mode !== 'solo') h += netBarHtml();
  h += '<span class="pl-tools">';
  h += `<button class="cc-btn${setup.autoDeal ? ' on' : ''}" data-act="autodeal" aria-pressed="${!!setup.autoDeal}">Auto-deal</button>`;
  if (setup.autoDeal) h += `<button class="cc-btn" data-act="dealdelay" title="Wait before the next hand">${setup.dealSecs}s</button>`;
  h += `<button class="cc-btn${setup.hud ? ' on' : ''}" data-act="hud" aria-pressed="${!!setup.hud}">HUD</button>`;
  if (gtoTable && mode === 'solo') h += `<button class="cc-btn${setup.review ? ' on' : ''}" data-act="review" aria-pressed="${!!setup.review}" title="Grade your decisions against the GTO bot after each hand">Review</button>`;
  h += `<button class="cc-btn${statsOpen ? ' on' : ''}" data-act="stats" aria-pressed="${statsOpen}">Stats</button>`;
  h += `<button class="link-btn" data-act="leave">${watching ? 'Stop watching' : 'Leave table'}</button></span></div>`;
  h += '<div class="pl-felt">';
  h += `<div class="pl-center"><div class="pl-board">${[0, 1, 2, 3, 4].map(i => (s.board[i] ? cardHtml(s.board[i]) : '<span class="pl-card slot"></span>')).join('')}</div>`;
  h += `<div class="pl-pot">Pot ${num(s.pot)}</div></div>`;
  s.seats.forEach((seat, i) => {
    const p = seatPos(i, n);
    if (seat.empty) {
      h += `<div class="pl-seat empty" style="left:${p.x}%;top:${p.y}%" data-seat="${i}"><div class="pl-plate"><b>Empty seat</b></div>`;
      if (s.button === i) h += '<div class="pl-button">D</div>';
      h += '</div>';
      return;
    }
    if (seat.sitting_out) {
      const why = num(seat.stack) === 0 ? 'Needs chips' : seat.away ? 'Away' : 'Sitting out';
      h += `<div class="pl-seat out${i === 0 ? ' hero' : ''}" style="left:${p.x}%;top:${p.y}%" data-seat="${i}"><div class="pl-plate"><b>${esc(seat.name)}</b><span>${num(seat.stack)}</span></div><div class="pl-note">${why}</div></div>`;
      return;
    }
    const cls = ['pl-seat', i === 0 ? 'hero' : '', seat.folded ? 'folded' : '', i === 0 && foldQueued ? 'prefold' : '', s.to_act === i ? 'acting' : '', s.complete && num(seat.won) > 0 ? 'winner' : ''].filter(Boolean).join(' ');
    const shown = seat.cards || (seat.folded ? null : new Array(tableGame.cards).fill(null));
    h += `<div class="${cls}" style="left:${p.x}%;top:${p.y}%" data-seat="${i}">`;
    if (shown) h += `<div class="pl-hole n${shown.length}">${shown.map(cardHtml).join('')}</div>`;
    h += `<div class="pl-plate"><b>${esc(seat.name)}</b><span>${num(seat.stack)}</span></div>`;
    const note = s.complete ? (num(seat.net) > 0 ? `+${num(seat.net)}` : '') : (seat.away ? 'Away' : seat.all_in ? 'All-in' : last[i] || '');
    if (note) h += `<div class="pl-note">${note}</div>`;
    if (s.to_act === i && turnEnds) h += `<div class="pl-clock" data-clock>${clockText()}</div>`;
    if (setup.hud) h += hudHtml(seatId(i));
    if (num(seat.street_bet) > 0) h += `<div class="pl-bet">${num(seat.street_bet)}</div>`;
    if (s.button === i) h += '<div class="pl-button">D</div>';
    h += '</div>';
  });
  h += '</div>';
  h += controlsHtml();
  h += sitOutHtml();
  h += chipsHtml();
  h += reviewHtml();
  if (statsOpen) h += statsHtml();
  const log = s.events.map(eventText).filter(Boolean);
  h += `<div class="pl-log" id="pl-log">${log.map(t => `<div>${esc(t)}</div>`).join('')}</div>`;
  h += '</div>';
  // Keep the stats table's sideways scroll across re-renders (narrow screens).
  const scrollX = root.querySelector('.pl-stats-scroll')?.scrollLeft || 0;
  root.innerHTML = h;
  const sx = root.querySelector('.pl-stats-scroll');
  if (sx) sx.scrollLeft = scrollX;
  const lg = root.querySelector('#pl-log');
  if (lg) lg.scrollTop = lg.scrollHeight;
}

// The action bar keeps every control in a fixed slot, whatever the state:
// a status line, then a row of Fold, Check/Call and Bet/Raise, then the bet
// sizes (½ pot, ¾ pot, Pot, All-in), then the amount slider. An action that
// isn't available leaves its slot blank, so a button never moves under the
// pointer: a click aimed at Fold can't land on Call or Raise because the
// screen changed. Between hands Next hand sits in the Raise slot.
function controlsHtml() {
  const s = state;
  const blank = '<span class="pl-slot" aria-hidden="true"></span>';
  let status = '', fold = blank, call = blank, raise = blank, sizes = blank, amount = blank;
  const L = s.legal;
  if (s.complete) {
    const winners = s.seats.map((x, i) => ({...x, i})).filter(x => num(x.won) > 0);
    const text = winners.map(w => `${esc(w.name)} ${w.i === 0 ? 'win' : 'wins'} ${num(w.won)}`).join(', ');
    // Before the first hand of a hosted table there's no result yet.
    status = `<span class="pl-result">${num(s.hand_number) ? `${text}${s.showdown ? '' : ' (no showdown)'}` : 'Waiting for players'}</span>`;
    if (mode === 'guest') {
      status += ' <span class="pl-meta">· The host deals the next hand</span>';
    } else if (mode === 'host' && hostInfo.playersIn < 2) {
      status += ' <span class="pl-meta">· Dealing needs two players with chips</span>';
    } else {
      const label = num(s.hand_number) ? nextLabel() : 'Deal';
      raise = `<button class="tr-start" data-act="next"><span id="pl-next">${label}</span> <kbd>Space</kbd></button>`;
      if (setup.autoDeal && num(s.hand_number)) call = `<button class="tr-btn" id="pl-pause" data-act="pause">${pauseLabel()} <kbd>P</kbd></button>`;
    }
  } else if (foldQueued) {
    if (L) {
      // With the turn here, the queued fold (or check) is on its way.
      status = `${L.can_fold ? 'Folding' : 'Checking'}…`;
    } else {
      status = 'Folding when it’s your turn';
      fold = '<button class="tr-btn" data-act="prefold">Undo <kbd>F</kbd></button>';
    }
  } else if (!L) {
    status = `${esc(nameOf(s.to_act))} is thinking…`;
    if (canPrefold()) fold = '<button class="tr-btn no" data-act="prefold">Fold <kbd>F</kbd></button>';
  } else {
    status = 'Your turn';
    if (L.can_fold) fold = '<button class="tr-btn no" data-act="fold">Fold <kbd>F</kbd></button>';
    if (L.can_check) call = '<button class="tr-btn" data-act="check">Check <kbd>C</kbd></button>';
    else if (L.call != null) call = `<button class="tr-btn" data-act="call">Call ${num(L.call)} <kbd>C</kbd></button>`;
    const range = L.raise || L.bet;
    if (range) {
      const min = num(range.min_to), max = num(range.max_to);
      // Pot-limit defaults to the pot, no-limit to the minimum.
      if (!raiseTo || raiseTo < min || raiseTo > max) raiseTo = tableGame.pl ? max : min;
      const word = L.raise ? 'Raise to' : 'Bet';
      raise = `<button class="tr-btn yes" data-act="${L.raise ? 'raise' : 'bet'}">${word} <b id="pl-amtv">${raiseTo}</b> <kbd>R</kbd></button>`;
      sizes = `<span class="pl-sizes">${sizeButtons(min, max)}</span>`;
      amount = `<input type="range" id="pl-amt" min="${min}" max="${max}" step="1" value="${raiseTo}" aria-label="Amount">`;
    }
  }
  return `<div class="pl-controls"><div class="pl-status">${status}</div>` +
    `<div class="pl-act-fold">${fold}</div><div class="pl-act-call">${call}</div><div class="pl-act-raise">${raise}</div>` +
    `<div class="pl-act-sizes">${sizes}</div><div class="pl-act-amount">${amount}</div></div>`;
}

// Pot-fraction sizes: the street total after calling and then adding that
// fraction of the pot, clamped to the legal range.
function potSize(f, min, max) {
  const s = state, call = num(s.current_bet) - num(s.seats[0].street_bet);
  return Math.max(min, Math.min(max, num(s.current_bet) + Math.round((num(s.pot) + call) * f)));
}

// The Pot button's amount (the P key). In pot-limit the largest bet is the
// pot (the engine's max_to), and it's all-in when the stack can't cover it.
const potTo = (min, max) => (tableGame.pl ? max : potSize(1, min, max));

function sizeButtons(min, max) {
  const pot = `${tableGame.pl && max >= allInTo() ? 'All-in' : 'Pot'} <kbd>P</kbd>`;
  const sizes = [['½ pot', potSize(0.5, min, max)], ['¾ pot', potSize(0.75, min, max)], [pot, potTo(min, max)]];
  if (!tableGame.pl) sizes.push(['All-in', max]);
  // Always four slots, so the sizes never shift (pot-limit has no separate All-in).
  return sizes.map(([t, v]) => `<button class="btn-small" data-size="${v}">${t}</button>`).join('') +
    '<span class="pl-size-slot" aria-hidden="true"></span>'.repeat(4 - sizes.length);
}

// The street total that puts the person all-in.
function allInTo() {
  const me = state.seats[0];
  return num(me.street_bet) + num(me.stack);
}

// ---- chips at a friends table ----

// The host's panel: chip requests to approve, the people seated (to remove),
// and the host's own top-up. A guest's: their chips and a request.
// Sitting out at a friends or club table (#70): a Sit out button, and while
// out, how to come back. Missed blinds are posted at once (one small blind
// dead, one big blind live) or by waiting for the big blind.
function sitOutHtml() {
  if (mode !== 'guest' || !mySeat || watching) return '';
  if (mySeat.waiting_for_big_blind) {
    return '<div class="pl-sitout"><span>You’re back: you’ll be dealt in when the big blind reaches you.</span></div>';
  }
  if (!mySeat.sitting_out) {
    return '<div class="pl-sitout"><button class="link-btn" data-act="sitout">Sit out next hand</button></div>';
  }
  const owed = [mySeat.missed_small_blind && 'the small blind', mySeat.missed_big_blind && 'the big blind'].filter(Boolean);
  let h = '<div class="pl-sitout on"><b>You’re sitting out.</b> No blinds while you’re out.';
  if (mySeat.outEnds) h += ` <span class="pl-meta">Your seat is given up in <span data-outclock>${outClockText()}</span>.</span>`;
  h += '<div class="pl-sitout-acts">';
  if (owed.length) {
    h += `<button class="tr-btn yes" data-act="sitin" data-wait="0">Post ${owed.join(' and ')} now</button>`;
    h += '<button class="tr-btn" data-act="sitin" data-wait="1">Wait for the big blind</button>';
  } else h += '<button class="tr-btn yes" data-act="sitin" data-wait="0">Sit back in</button>';
  return h + '</div></div>';
}

function outClockText() {
  if (!mySeat?.outEnds) return '';
  const s = Math.max(0, Math.ceil((mySeat.outEnds - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function chipsHtml() {
  if (mode === 'host' && hostInfo.buyIn) return hostChipsHtml();
  if (mode === 'guest' && myChips) return guestChipsHtml();
  return '';
}

function hostChipsHtml() {
  const {min, max} = hostInfo.buyIn;
  let h = '<div class="pl-chips">';
  if (hostInfo.chipRequests.length) {
    h += '<div class="pl-chips-head"><b>Chip requests</b></div><ul class="pl-chip-list">';
    for (const r of hostInfo.chipRequests) {
      h += `<li><span><b>${esc(r.name)}</b> asks for ${num(r.amount)} chips <span class="pl-meta">(has ${num(r.stack)})</span></span>`;
      h += `<span class="pl-chip-acts"><button class="tr-btn yes" data-approve="${r.seat}">Approve</button><button class="tr-btn" data-deny="${r.seat}">Deny</button></span></li>`;
    }
    h += '</ul>';
  }
  const people = state.seats.map((x, i) => ({...x, i})).filter(x => x.i > 0 && x.human && !x.empty);
  if (people.length) {
    h += '<div class="pl-chips-head"><b>Players</b></div><ul class="pl-chip-list">';
    for (const p of people) {
      const note = p.away ? ' · away' : p.sitting_out ? (num(p.stack) === 0 ? ' · needs chips' : ' · sitting out') : '';
      h += `<li><span>${esc(p.name)} <span class="pl-meta">${num(p.stack)} chips${note}</span></span><button class="link-btn" data-remove="${p.i}">Remove</button></li>`;
    }
    h += '</ul>';
  }
  const mine = num(state.seats[0].stack) + hostInfo.hostPendingChips;
  const room = max - mine;
  h += '<div class="pl-chips-head"><b>Your chips</b>';
  h += `<span class="pl-meta">${num(state.seats[0].stack)}${hostInfo.hostPendingChips ? ` (+${hostInfo.hostPendingChips} next hand)` : ''} · stacks ${min}–${max} after a top-up</span></div>`;
  if (room > 0) {
    const lo = Math.max(1, min - mine);
    const v = Math.max(lo, Math.min(room, chipAsk || room));
    h += `<div class="pl-chip-ask"><input class="pl-text" type="number" id="pl-chipamt" min="${lo}" max="${room}" value="${v}" aria-label="Chips to add"><button class="tr-btn" data-act="hostchips">Add chips</button></div>`;
  }
  return h + '</div>';
}

function guestChipsHtml() {
  const {min, max, requested, approved} = myChips;
  const stack = num(state.seats[0].stack) + approved;
  let h = '<div class="pl-chips"><div class="pl-chips-head"><b>Your chips</b>';
  h += `<span class="pl-meta">${num(state.seats[0].stack)}${approved ? ` (+${approved} next hand)` : ''} · stacks ${min}–${max} after a top-up</span></div>`;
  if (requested) {
    h += `<div class="pl-chip-ask"><span>Asked the host for ${requested} chips…</span><button class="link-btn" data-act="cancelchips">Cancel</button></div>`;
  } else if (stack < max) {
    const lo = Math.max(1, min - stack), hi = max - stack;
    const v = Math.max(lo, Math.min(hi, chipAsk || hi));
    h += `<div class="pl-chip-ask"><input class="pl-text" type="number" id="pl-chipamt" min="${lo}" max="${hi}" value="${v}" aria-label="Chips to ask for"><button class="tr-btn yes" data-act="askchips">Ask for chips</button></div>`;
    if (stack === 0) h += '<p class="pl-meta">You’ll be dealt in once the host approves your chips.</p>';
  }
  return h + '</div>';
}

// The amount in the chips box.
function chipAmount() {
  const el = root.querySelector('#pl-chipamt');
  return el ? Math.floor(+el.value) || 0 : 0;
}

function netBarHtml() {
  let h = `<span class="pl-meta">Table <b>${esc(room)}</b>`;
  if (mode === 'host') h += ` · ${openSeats} empty seat${openSeats === 1 ? '' : 's'}</span><button class="link-btn" data-act="copy">Copy link</button>`;
  else h += '</span>';
  if (netNote) h += `<span class="pl-meta pl-neterr">${esc(netNote)}</span>`;
  if (mode === 'host' && clockStopped) h += `<span class="pl-meta pl-neterr">${linkOk ? 'Paused: no one else is connected.' : 'Paused: can’t reach the relay.'} No one is folded or timed out meanwhile.</span>`;
  return h;
}

function render() {
  if (!open) return;
  if (seated && state) renderTable();
  else if (seated) root.innerHTML = `<div class="pl-wrap"><p class="pl-meta">${esc(netNote || 'Connecting…')}</p><button class="link-btn" data-act="leave">Cancel</button></div>`;
  else renderSetup();
}

// ---- stats ----

// The stats id of a seat: "you", or the bot's personality id.
const seatId = i => state.seats[i].id || (i === 0 ? 'you' : setup.bots[i - 1]);

// Adds the hand to the stats once it's over (once per hand).
function recordStats() {
  if (watching || !state || !state.complete || num(state.hand_number) === recordedHand) return;
  recordedHand = num(state.hand_number);
  const g = tableGame.id;
  // Empty seats and people sitting out weren't in the hand.
  const counts = countHand(state).filter((_, i) => !state.seats[i].empty && !state.seats[i].sitting_out);
  recordHand(sessionStats[g] ||= {}, counts);
  recordHand(allStats[g] ||= {}, counts);
  saveStats();
}

const scopeStats = () => (setup.statsScope === 'all' ? allStats : sessionStats)[tableGame.id] || {};

function hudHtml(id) {
  const r = rates(scopeStats()[id]);
  if (!r.hands) return '<div class="pl-hud">no hands yet</div>';
  const p = x => (x.d ? Math.round(x.v * 100) : '–');
  return `<div class="pl-hud" title="VPIP / PFR / AF over ${r.hands} hands">${p(r.vpip)}/${p(r.pfr)}/${afText(r.af)} · ${r.hands}</div>`;
}

// Columns of the stats table: key, header, tooltip, cell text, sort value.
const signed = (v, d = 0) => (v > 0 ? '+' : '') + v.toFixed(d);
const STAT_COLS = [
  ['hands', 'Hands', 'Hands dealt', r => r.hands, r => r.hands],
  ['vpip', 'VPIP', 'Voluntarily put chips in preflop (blinds don’t count)', r => pct(r.vpip), r => r.vpip.v],
  ['pfr', 'PFR', 'Raised preflop', r => pct(r.pfr), r => r.pfr.v],
  ['threeBet', '3-bet', 'Re-raised a single preflop raise, of the chances', r => pct(r.threeBet), r => r.threeBet.v],
  ['af', 'AF', 'Aggression factor: postflop (bets + raises) / calls', r => afText(r.af), r => r.af.v],
  ['afq', 'AFq', 'Aggression frequency: postflop (bets + raises) / (bets + raises + calls + folds)', r => pct(r.afq), r => r.afq.v],
  ['foldToBet', 'Fold to bet', 'Folded to a postflop bet or raise', r => pct(r.foldToBet), r => r.foldToBet.v],
  ['wtsd', 'WTSD', 'Went to showdown, of the hands that saw the flop', r => pct(r.wtsd), r => r.wtsd.v],
  ['wsd', 'W$SD', 'Won at showdown', r => pct(r.wsd), r => r.wsd.v],
  ['net', 'Net', 'Chips won or lost (big blinds)', r => `${signed(r.net)} <small>(${signed(r.netBB, 1)} bb)</small>`, r => r.netBB],
  ['bb100', 'bb/100', 'Big blinds won per 100 hands', r => (r.bb100 == null ? '—' : signed(r.bb100, 1)), r => r.bb100],
];

function statsHtml() {
  const book = scopeStats();
  const rows = state.seats.map((seat, i) => ({i, name: seat.name, id: seatId(i), r: rates(book[seatId(i)])}));
  const col = STAT_COLS.find(c => c[0] === statsSort.key);
  if (col) {
    // Players without a sample sort last either way.
    const val = row => { const v = col[4](row.r); return v == null || Number.isNaN(v) ? null : v; };
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return a.i - b.i;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * statsSort.dir;
    });
  } else if (statsSort.dir < 0) rows.reverse();
  const all = setup.statsScope === 'all';
  let h = '<div class="pl-stats">';
  h += `<div class="pl-stats-head"><b>Stats · ${tableGame.name}</b><div class="pl-opts">`;
  h += `<button class="cc-btn${all ? '' : ' on'}" data-scope="session">This session</button>`;
  h += `<button class="cc-btn${all ? ' on' : ''}" data-scope="all">All time</button></div>`;
  h += '<button class="link-btn" data-act="reset-stats">Reset stats</button></div>';
  h += '<div class="pl-stats-scroll"><table class="pl-stats-table"><thead><tr>';
  const arrow = key => (statsSort.key === key ? (statsSort.dir > 0 ? ' ▲' : ' ▼') : '');
  h += `<th data-sort="seat">Player${arrow('seat')}</th>`;
  for (const [key, label, tip] of STAT_COLS) h += `<th data-sort="${key}" title="${esc(tip)}">${esc(label)}${arrow(key)}</th>`;
  h += '</tr></thead><tbody>';
  for (const row of rows) {
    const adv = tableGame.id === 'nlhe' && ADVERTISED[row.id];
    h += `<tr${row.i === 0 ? ' class="hero"' : ''}><th scope="row">${esc(row.name)}`;
    if (adv) h += `<small title="VPIP / PFR measured in ducy-play (6-handed no-limit Hold’em)">expects ${adv[0]}% / ${adv[1]}%</small>`;
    h += '</th>';
    for (const c of STAT_COLS) h += `<td>${c[3](row.r)}</td>`;
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  if (gtoTable && mode === 'solo') h += reviewTotalsHtml();
  h += '<p class="pl-meta">Raw rates with the sample size in brackets. Bots are tracked by personality, so their stats follow them to new tables. Each game keeps its own stats.</p>';
  h += '</div>';
  return h;
}

function resetStats() {
  const all = setup.statsScope === 'all';
  if (!confirm(`Reset ${all ? 'all-time' : 'this session’s'} ${tableGame.name} stats for everyone?`)) return;
  if (all) { delete allStats[tableGame.id]; saveStats(); }
  else delete sessionStats[tableGame.id];
  if (gtoTable) {
    if (all) { allReview = emptyTotals(); saveReviewTotals(); }
    else sessionReview = emptyTotals();
  }
  render();
}

// ---- hand review (GTO training) ----

// Asks the worker for the finished hand's review, once per hand, without
// holding up play: the review shows when it's back, and the next hand can be
// dealt meanwhile (the worker takes it right after).
function startReview() {
  if (mode !== 'solo' || !gtoTable || !setup.review || !state?.complete) return;
  const hand = num(state.hand_number);
  if (!hand || review?.hand === hand) return;
  review = {hand, pending: true};
  reviewOpen = new Set();
  const mine = session;
  call('review').then(data => {
    if (mine !== session) return;
    if (data) {
      addReview(sessionReview, data);
      addReview(allReview, data);
      saveReviewTotals();
    }
    if (review?.hand === hand) review = {hand, data};
    if (num(state?.hand_number) === hand) render();
  }, e => {
    console.warn(e);
    if (mine === session && review?.hand === hand) { review = {hand, error: true}; render(); }
  });
}

const STREET = {preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River'};

// "Ks 9d" as the card faces' text.
const boardText = b => (b ? b.split(' ').map(c => `${c[0]}${SUITS[c[1]] || ''}`).join(' ') : '');

function decisionHtml(d, i) {
  const flagged = FLAGGED.includes(d.grade);
  const open = reviewOpen.has(i);
  const cls = ['pl-rev-row', `g-${d.grade}`, open ? 'open' : ''].filter(Boolean).join(' ');
  let h = `<li class="${cls}"><button class="pl-rev-line" data-rev="${i}" aria-expanded="${open}">`;
  h += `<span class="pl-rev-street">${STREET[d.street] || esc(d.street)}${d.board ? ` <span class="pl-rev-board">${esc(boardText(d.board))}</span>` : ''}</span>`;
  h += `<span class="pl-rev-act">${esc(d.action)}</span>`;
  if (flagged && d.grade !== 'deviation' && d.best) h += `<span class="pl-rev-best">best: ${esc(d.best)}</span>`;
  else if (flagged || isVariant(d)) h += `<span class="pl-rev-best">GTO: ${esc(d.main)}</span>`;
  else h += '<span class="pl-rev-best"></span>';
  const cost = d.bb_lost > 0 ? `−${bbText(d.bb_lost)} bb` : '';
  const label = isVariant(d) ? 'Fine (mixed)' : GRADE_LABEL[d.grade] || d.grade;
  h += `<span class="pl-rev-grade">${esc(label)}${cost ? ` <b>${cost}</b>` : ''}</span>`;
  h += '</button>';
  if (open) {
    h += '<div class="pl-rev-more">';
    h += `<div>Pot ${bbText(d.pot)} bb${d.to_call > 0 ? `, ${bbText(d.to_call)} bb to call` : ''}</div>`;
    const mix = mixText(d.gto);
    if (mix) h += `<div>GTO mix with your hand: ${esc(mix)}</div>`;
    const valued = (d.gto || []).filter(a => a.ev != null);
    if (valued.length) {
      const evs = valued.slice().sort((a, b) => b.ev - a.ev).map(a => `${esc(a.action)} ${bbText(a.ev)}`).join(' · ');
      h += `<div>Value of each play (bb): ${evs}${d.stderr > 0 ? ` <span class="pl-meta">(± ${bbText(d.stderr)})</span>` : ''}</div>`;
    }
    if (d.note) h += `<div class="pl-meta">${esc(d.note[0].toUpperCase() + d.note.slice(1))}.</div>`;
    h += '</div>';
  }
  return h + '</li>';
}

// The review panel under the controls, once a hand against the GTO bot is
// over. It sits below the action bar, so the buttons never move.
function reviewHtml() {
  if (mode !== 'solo' || !gtoTable || !setup.review || !state.complete || !review || review.hand !== num(state.hand_number)) return '';
  let h = '<div class="pl-review"><div class="pl-review-head"><b>Hand review</b>';
  if (review.pending) return h + '<span class="pl-meta">Reviewing your decisions…</span></div></div>';
  if (review.error || !review.data) return h + '<span class="pl-meta">No review for this hand.</span></div></div>';
  const r = review.data;
  if (!r.decisions.length) return h + '<span class="pl-meta">You had no decisions this hand.</span></div></div>';
  const lost = r.bb_lost > 0 ? `<span class="pl-rev-total bad">−${bbText(r.bb_lost)} bb from your decisions</span>` : '<span class="pl-rev-total">No bb lost to mistakes</span>';
  h += `${lost}<span class="pl-meta">Result ${r.result > 0 ? '+' : ''}${bbText(r.result)} bb (luck included)</span></div>`;
  h += `<ul class="pl-rev-list">${r.decisions.map(decisionHtml).join('')}</ul>`;
  if (r.note) h += `<p class="pl-meta">${esc(r.note[0].toUpperCase() + r.note.slice(1))}.</p>`;
  h += '<p class="pl-meta pl-rev-caveat">Graded against the GTO bot’s own strategy, which is strong but not perfect, using the range it could hold, not its actual cards. Preflop plays are compared with its mix only.</p>';
  return h + '</div>';
}

// Review totals for the Stats panel.
function reviewTotalsHtml() {
  const all = setup.statsScope === 'all';
  const t = all ? allReview : sessionReview;
  let h = '<div class="pl-rev-totals"><b>GTO review</b> ';
  if (!t.hands) return h + '<span class="pl-meta">no reviewed hands yet</span></div>';
  const p = per100(t);
  h += `<span>${t.hands} hands · ${t.decisions} decisions · ${bbText(t.bbLost)} bb lost (${bbText(p)} per 100 hands)</span> `;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  h += `<span class="pl-meta">${n(t.inaccuracies, 'inaccuracy', 'inaccuracies')} · ${n(t.mistakes, 'mistake', 'mistakes')} · ${n(t.blunders, 'blunder', 'blunders')} · ${t.deviations} off-strategy preflop</span>`;
  return h + '</div>';
}

// ---- events ----

function onClick(e) {
  const el = e.target.closest('[data-pgame],[data-count],[data-blinds],[data-buyin],[data-turn],[data-act],[data-size],[data-scope],[data-sort],[data-tab],[data-fgame],[data-fblinds],[data-fseats],[data-fmin],[data-fmax],[data-approve],[data-deny],[data-remove],[data-rev]');
  if (!el) return;
  const d = el.dataset;
  if (d.rev != null) {
    const i = +d.rev;
    if (reviewOpen.has(i)) reviewOpen.delete(i); else reviewOpen.add(i);
    render();
    return;
  }
  if (d.tab) { readNameInput(); setup.tab = d.tab; saveSetup(); render(); return; }
  const f = setup.friends;
  if (d.fgame || d.fblinds || d.fseats || d.fmin || d.fmax) {
    readNameInput();
    if (d.fgame) f.game = d.fgame;
    if (d.fblinds) [f.sb, f.bb] = d.fblinds.split('/').map(Number);
    if (d.fseats) f.seats = +d.fseats;
    // Keep min ≤ max.
    if (d.fmin) { f.minBB = +d.fmin; f.maxBB = Math.max(f.maxBB, f.minBB); }
    if (d.fmax) { f.maxBB = +d.fmax; f.minBB = Math.min(f.minBB, f.maxBB); }
    saveSetup();
    render();
    return;
  }
  if (d.approve != null) { hostEvent('hostApprove', +d.approve); return; }
  if (d.deny != null) { hostEvent('hostDeny', +d.deny); return; }
  if (d.remove != null) {
    const who = state?.seats[+d.remove]?.name || 'this player';
    if (confirm(`Remove ${who} from the table? They fold out of this hand, and their chips leave with them.`)) hostEvent('hostRemove', +d.remove);
    return;
  }
  if (d.act === 'hostchips') { chipAsk = chipAmount(); hostEvent('hostChips', chipAsk); return; }
  if (d.act === 'askchips') { chipAsk = chipAmount(); net?.send({type: 'request_chips', amount: chipAsk}); return; }
  if (d.act === 'sitout') { net?.send({type: 'sit_out'}); return; }
  if (d.act === 'sitin') { net?.send({type: 'sit_in', wait_for_big_blind: d.wait === '1'}); return; }
  if (d.act === 'cancelchips') { net?.send({type: 'request_chips', amount: 0}); return; }
  if (el.dataset.scope) { setup.statsScope = el.dataset.scope; saveSetup(); render(); }
  else if (el.dataset.sort) {
    const key = el.dataset.sort;
    // Numbers sort biggest first; the player column goes back to seat order.
    statsSort = statsSort.key === key ? {key, dir: -statsSort.dir} : {key, dir: key === 'seat' ? 1 : -1};
    render();
  }
  else if (el.dataset.act === 'hud') { setup.hud = !setup.hud; saveSetup(); render(); }
  else if (el.dataset.act === 'review') { setup.review = !setup.review; saveSetup(); startReview(); render(); }
  else if (el.dataset.act === 'stats') { statsOpen = !statsOpen; render(); }
  else if (el.dataset.act === 'reset-stats') resetStats();
  else if (el.dataset.pgame) { setup.game = el.dataset.pgame; render(); }
  else if (el.dataset.count) { setup.count = +el.dataset.count; render(); }
  else if (el.dataset.blinds) {
    const bbs = setup.buyIn / setup.bb;
    [setup.sb, setup.bb] = el.dataset.blinds.split('/').map(Number);
    setup.buyIn = bbs * setup.bb;
    render();
  }
  else if (el.dataset.buyin) { setup.buyIn = +el.dataset.buyin * setup.bb; render(); }
  else if (el.dataset.turn) { readNameInput(); setup.turnSecs = +el.dataset.turn; render(); }
  else if (el.dataset.size) { raiseTo = +el.dataset.size; render(); }
  else if (el.dataset.act === 'shuffle') { setup.bots = []; render(); }
  else if (el.dataset.act === 'sit') startTable();
  else if (el.dataset.act === 'next') nextHand();
  else if (el.dataset.act === 'pause') hold('user', !holds.has('user'));
  else if (el.dataset.act === 'dealdelay') {
    // Cycles through the delays; restarts a running countdown with the new one.
    const i = DEAL_DELAYS.indexOf(setup.dealSecs);
    setup.dealSecs = DEAL_DELAYS[(i + 1) % DEAL_DELAYS.length];
    saveSetup();
    render();
    armDeal();
  }
  else if (el.dataset.act === 'autodeal') { setup.autoDeal = !setup.autoDeal; saveSetup(); holds.delete('user'); render(); armDeal(); }
  else if (el.dataset.act === 'leave') { if (mode === 'host') forgetSavedTable(); leaveTable(); }
  else if (el.dataset.act === 'resumehost') resumeHosting();
  else if (el.dataset.act === 'forgethost') { forgetSavedTable(); render(); }
  else if (el.dataset.act === 'host') hostTable();
  else if (el.dataset.act === 'join') joinTable();
  else if (el.dataset.act === 'copy') copyLink();
  else if (el.dataset.act === 'idbackup') { idForm = idForm?.kind === 'backup' ? null : {kind: 'backup'}; idNote = ''; render(); root.querySelector('form[data-idform] [name=pw]')?.focus(); }
  else if (el.dataset.act === 'idcancel') { idForm = null; render(); }
  else if (el.dataset.act === 'prefold') togglePrefold();
  else if (['fold', 'check', 'call', 'allin'].includes(el.dataset.act)) act(el.dataset.act);
  else if (el.dataset.act === 'bet' || el.dataset.act === 'raise') {
    // Only a bet of the whole stack is "allin"; in pot-limit the top of the
    // range is usually the pot, which the engine takes as a plain bet/raise.
    act(raiseTo >= allInTo() ? 'allin' : el.dataset.act, raiseTo);
  }
}

function onInput(e) {
  if (e.target.id === 'pl-chipamt') chipAsk = Math.floor(+e.target.value) || 0;
  if (e.target.id === 'pl-amt') {
    raiseTo = +e.target.value;
    const v = root.querySelector('#pl-amtv');
    if (v) v.textContent = raiseTo;
  }
}

function onChange(e) {
  if (e.target.dataset.bot != null) { setup.bots[+e.target.dataset.bot] = e.target.value; render(); }
  if (e.target.id === 'pl-idfile' && e.target.files[0]) { chooseBackup(e.target.files[0]); e.target.value = ''; }
}

// The countdown waits while a mouse is over the result, the log or the
// review, so the hand can be read.
function onPointer(e) {
  if (e.pointerType !== 'mouse') return;
  hold('hover', e.type === 'pointerover' && !!e.target.closest('.pl-result, .pl-log, .pl-review'));
}

function onVisibility() {
  hold('hidden', document.hidden);
}

function onKey(e) {
  if (!open || !state || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (state.complete && (k === ' ' || k === 'enter')) { e.preventDefault(); nextHand(); return; }
  if (state.complete && k === 'p' && setup.autoDeal) { hold('user', !holds.has('user')); return; }
  // The rest are only for the player's turn.
  const L = state.legal;
  if (!L) {
    // Before the player's turn, F queues a fold (or cancels one) and Esc cancels.
    if ((k === 'f' && (foldQueued || canPrefold())) || (k === 'escape' && foldQueued)) togglePrefold();
    return;
  }
  if (foldQueued) return; // the queued action is already being sent
  const range = L.raise || L.bet;
  if (k === 'f' && L.can_fold) act('fold');
  else if (k === 'c') act(L.can_check ? 'check' : 'call');
  else if (k === 'r' && range) clickBet();
  else if (k === 'p' && range) { raiseTo = potTo(num(range.min_to), num(range.max_to)); clickBet(); }
}

// Bets or raises raiseTo through the Bet/Raise button, so all-in is decided there.
const clickBet = () => root.querySelector('[data-act="raise"],[data-act="bet"]')?.click();

// `shortcut` 'gto' sits straight down heads-up No-limit Hold'em against the
// GTO bot with a 100 big blind buy-in (from #codedoug), unless a table is
// already in play.
export async function openPlay(el, shortcut) {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onIdSubmit);
    root.addEventListener('pointerover', onPointer);
    root.addEventListener('pointerleave', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
  }
  open = true;
  // An invite link opens on the friends tab, with the code filled in.
  if (joinCode && !seated && relayUrl()) setup.tab = 'friends';
  if (document.hidden) holds.add('hidden'); else holds.delete('hidden');
  if (!me) {
    loadIdentity().then(i => { me = i; if (!seated && personalities.length) render(); })
      .catch(e => { console.warn(e); idNote = 'This browser can’t keep a player ID (private mode or storage blocked).'; });
  }
  if (!personalities.length) {
    root.innerHTML = '<div class="pl-wrap"><p class="pl-meta">Loading the bots…</p></div>';
    personalities = await call('personalities');
    try { gtoAvailable = (await fetch(GTO_MANIFEST, {cache: 'no-cache'})).ok; } catch {}
  }
  if (shortcut === 'gto' && !seated) {
    setup.game = 'nlhe';
    setup.count = 1;
    setup.bots = ['gto'];
    setup.buyIn = 100 * setup.bb;
    if (gtoAvailable) { startTable(); return; }
    setupNote = 'The GTO bot isn’t available right now.';
  }
  render();
  pace();
  armDeal();
}

export function closePlay() {
  open = false;
  clearTimeout(timer);
  cancelDeal();
}

export function playOpen() {
  return open;
}
