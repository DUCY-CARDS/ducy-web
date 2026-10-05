// Hidden page at #play: no-limit Hold'em or pot-limit Omaha (4, 5 or 6 cards)
// against ducy's personality bots.
// The engine (ducy-wasm's BotTable) runs the hand; this file only draws the
// table, paces the bots' actions, and sends the player's decisions. The table
// runs in a worker (play-worker.js) so the page stays responsive while a bot
// thinks. Each finished hand also feeds the stats tracker (play-stats.js).
// With friends (play-net.js), the host's tab runs the table (MultiTable) and
// relays each player their own view; a guest's tab only draws the views it
// receives and sends its actions to the host.

import { countHand, recordHand, rates, pct, afText, ADVERTISED } from './play-stats.js';
import { clientId, connect, joinLink, linkedCode, newCode, normCode, relayUrl } from './play-net.js';

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
const DEAL_DELAY = 1500; // ms before auto-dealing after a hand with no showdown
const SHOWDOWN_DEAL_DELAY = 3000; // ...and after a showdown, to read the hands
const SETUP_KEY = 'ducyPlaySetup';
const STATS_KEY = 'ducyPlayStats';
// Games the engine's BotTable plays: id, labels, hole cards, pot-limit.
const GAMES = [
  {id: 'nlhe', label: 'Hold’em', name: 'No-limit Hold’em', cards: 2, pl: false},
  {id: 'plo4', label: 'PLO4', name: 'Pot-limit Omaha', cards: 4, pl: true},
  {id: 'plo5', label: 'PLO5', name: 'Pot-limit Omaha 5', cards: 5, pl: true},
  {id: 'plo6', label: 'PLO6', name: 'Pot-limit Omaha 6', cards: 6, pl: true},
];
const gameOf = id => GAMES.find(g => g.id === id) || GAMES[0];

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
let statsSort = {key: 'seat', dir: 1};
// Multiplayer: 'solo' against bots, 'host' running a table for friends, or
// 'guest' at someone else's table.
let mode = 'solo';
let net = null; // relay connection
let room = ''; // table code
let netNote = ''; // connection status, e.g. "Reconnecting…"
let shownSeq = -1; // state number on screen, so late results are dropped
let hostChain = Promise.resolve(); // host calls to the worker, in order
let hostTimer = null; // turn clock for the host
let clockTimer = null;
let turnEnds = 0; // when the acting person's time runs out (Date.now() ms)
let openSeats = 0;
let lastView = null; // a guest's last view from the host
let joinCode = linkedCode();

function loadSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(SETUP_KEY) || 'null');
    if (s && Array.isArray(s.bots)) return {game: 'nlhe', hud: true, statsScope: 'session', autoDeal: false, name: '', open: 1, turnSecs: 30, ...s};
  } catch {}
  return {game: 'nlhe', count: 5, bots: [], sb: 1, bb: 2, buyIn: 200, hud: true, statsScope: 'session', autoDeal: false, name: '', open: 1, turnSecs: 30};
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

function renderSetup() {
  fillBots();
  let h = '<div class="pl-wrap"><div class="pl-head"><h1>Play the bots</h1>';
  h += '<p>No-limit Hold’em or pot-limit Omaha against ducy’s bot personalities. Each one plays a different style, and some adapt to how you play.</p></div>';
  h += '<div class="pl-setup">';
  h += '<div class="pl-row"><span class="pl-label">Game</span><div class="pl-opts">';
  for (const g of GAMES) h += `<button class="cc-btn${setup.game === g.id ? ' on' : ''}" data-pgame="${g.id}">${g.label}</button>`;
  h += '</div></div>';
  h += '<div class="pl-row"><span class="pl-label">Opponents</span><div class="pl-opts">';
  for (let n = 1; n <= 8; n++) h += `<button class="cc-btn${setup.count === n ? ' on' : ''}" data-count="${n}">${n}</button>`;
  h += '</div></div>';
  h += '<div class="pl-row"><span class="pl-label">Blinds</span><div class="pl-opts">';
  for (const [sb, bb] of [[1, 2], [5, 10], [25, 50]]) h += `<button class="cc-btn${setup.bb === bb ? ' on' : ''}" data-blinds="${sb}/${bb}">${sb}/${bb}</button>`;
  h += '</div></div>';
  h += '<div class="pl-row"><span class="pl-label">Buy-in</span><div class="pl-opts">';
  for (const bbs of [50, 100, 200]) h += `<button class="cc-btn${setup.buyIn === bbs * setup.bb ? ' on' : ''}" data-buyin="${bbs}">${bbs} BB</button>`;
  h += '</div></div>';
  h += '<div class="pl-bots">';
  setup.bots.forEach((id, i) => {
    const p = botChoices().find(x => x.id === id);
    h += `<label class="pl-bot"><span class="pl-seatno">Seat ${i + 2}</span><select data-bot="${i}">`;
    for (const q of botChoices()) h += `<option value="${q.id}"${q.id === id ? ' selected' : ''}>${esc(q.name)}</option>`;
    h += `</select><span class="pl-desc">${esc(p ? p.description : '')}</span></label>`;
  });
  h += '</div>';
  if (gtoAvailable && !gtoAllowed()) h += '<p class="pl-desc">Play heads-up No-limit Hold’em (1 opponent) to face the GTO bot.</p>';
  if (setupNote) h += `<p class="pl-desc">${esc(setupNote)}</p>`;
  h += '<div class="pl-actions"><button class="btn-small" data-act="shuffle">Random opponents</button>';
  h += '<button class="tr-start" data-act="sit">Sit down</button></div>';
  h += '</div>';
  if (relayUrl()) h += multiSetupHtml();
  h += '</div>';
  root.innerHTML = h;
}

// Hosting uses the game, blinds and opponents above; open seats are bot
// seats friends can take (the bot plays them until someone joins).
function multiSetupHtml() {
  let h = '<div class="pl-setup pl-multi"><h2>Play with friends</h2>';
  h += `<div class="pl-row"><span class="pl-label">Your name</span><input class="pl-text" id="pl-name" maxlength="20" placeholder="Name" value="${esc(setup.name)}"></div>`;
  h += '<div class="pl-row"><span class="pl-label">Open seats</span><div class="pl-opts">';
  for (let n = 1; n <= setup.count; n++) h += `<button class="cc-btn${Math.min(setup.open, setup.count) === n ? ' on' : ''}" data-open="${n}">${n}</button>`;
  h += '</div></div>';
  h += '<div class="pl-row"><span class="pl-label">Turn time</span><div class="pl-opts">';
  for (const t of [15, 30, 60, 0]) h += `<button class="cc-btn${setup.turnSecs === t ? ' on' : ''}" data-turn="${t}">${t ? t + 's' : 'None'}</button>`;
  h += '</div></div>';
  h += '<p class="pl-desc">Bots play the open seats until friends join, and take them back when they leave.</p>';
  h += '<div class="pl-actions"><button class="tr-start" data-act="host">Host a table</button></div>';
  h += '<div class="pl-row"><span class="pl-label">Join</span><div class="pl-opts">';
  h += `<input class="pl-text" id="pl-code" maxlength="9" placeholder="Table code" value="${esc(joinCode)}">`;
  h += '<button class="tr-btn" data-act="join">Join table</button></div></div>';
  if (netNote) h += `<p class="pl-desc pl-neterr">${esc(netNote)}</p>`;
  h += '</div>';
  return h;
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
    turnEnds = snap.turnMsLeft != null ? Date.now() + num(snap.turnMsLeft) : 0;
  }
  state = mode === 'solo' ? snap.state : withStatIds(snap.state);
  botToAct = snap.botToAct;
  recordStats();
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
  return !state.legal && !state.complete && !me.folded && !me.all_in;
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
  const snap = await request('create', setup.bots, setup.buyIn, setup.sb, setup.bb, Math.floor(Math.random() * 2 ** 32), setup.game);
  if (snap) show(snap);
}

async function nextHand() {
  if (mode === 'guest') return; // the host deals
  cancelDeal();
  raiseTo = 0;
  foldQueued = false;
  const snap = await request('newHand');
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
  dealAt = performance.now() + (state.showdown ? SHOWDOWN_DEAL_DELAY : DEAL_DELAY);
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

// Calls the host's MultiTable in order, and relays the messages it returns.
function hostCall(op, ...args) {
  const p = hostChain.then(() => call(op, ...args)).then(r => {
    for (const m of r.out) net?.send({to: m.to, data: m.data});
    openSeats = r.openSeats;
    return r;
  });
  hostChain = p.catch(() => {});
  return p;
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
  if (!await prepareGto()) { render(); return; }
  saveSetup();
  tableGame = gameOf(setup.game);
  mode = 'host';
  sessionStats = {};
  recordedHand = 0;
  room = newCode();
  netNote = '';
  shownSeq = -1;
  seated = true;
  state = null;
  raiseTo = 0;
  foldQueued = false;
  const mine = session;
  net = connect(room, 'host', null, {
    onOpen() {},
    onMessage(m) {
      if (mine !== session) return;
      if (m.event === 'close') hostEvent('hostDisconnected', m.from);
      else if (m.data) hostEvent('hostHandle', m.from, m.data);
    },
    onStatus(t) { netNote = t; render(); },
    onFail(t) { leaveTable(t); },
  });
  const open = setup.bots.map((_, i) => i < Math.min(setup.open, setup.count));
  request('create', setup.bots, open, setup.name, setup.buyIn, setup.sb, setup.bb, Math.floor(Math.random() * 2 ** 32), setup.game, setup.turnSecs * 1000)
    .then(snap => { if (snap) show(snap); });
  hostTimer = setInterval(() => { if (turnEnds && Date.now() >= turnEnds) hostEvent('hostTick'); }, 250);
  startClock();
}

function joinTable() {
  readNameInput();
  const code = normCode(root.querySelector('#pl-code')?.value || joinCode);
  if (!code) { netNote = 'Enter the 8-character table code.'; render(); return; }
  saveSetup();
  joinCode = code;
  mode = 'guest';
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
  const mine = session;
  net = connect(code, 'guest', clientId(), {
    onOpen() { net.send({type: 'join', name: setup.name}); },
    onMessage(m) { if (mine === session) guestMessage(m); },
    onStatus(t) { netNote = t; render(); },
    onFail(t) { leaveTable(t); },
  });
  render();
  startClock();
}

function guestMessage(m) {
  if (m.type === 'state') {
    lastView = m.view;
    tableGame = GAMES.find(g => g.cards === num(m.view.hole_cards) && g.pl === m.view.pot_limit) || GAMES[0];
    netNote = '';
    show({seq: num(m.seq), state: m.view, botToAct: false, turnMsLeft: m.turn_ms_left});
  } else if (m.type === 'rejected') {
    if (m.reason === 'the table is full') { leaveTable('That table is full.'); return; }
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
  }, 250);
}

function clockText() {
  return turnEnds ? Math.max(0, Math.ceil((turnEnds - Date.now()) / 1000)) + 's' : '';
}

function leaveTable(note = '') {
  clearTimeout(timer);
  cancelDeal();
  clearInterval(hostTimer);
  clearInterval(clockTimer);
  if (mode === 'guest') net?.send({type: 'leave'});
  net?.close();
  net = null;
  session++;
  mode = 'solo';
  seated = false;
  state = null;
  foldQueued = false;
  turnEnds = 0;
  netNote = note;
  render();
}

async function copyLink() {
  try { await navigator.clipboard.writeText(joinLink(room)); netNote = 'Link copied'; } catch { netNote = joinLink(room); }
  render();
}

const num = v => Number(v); // serde sends u64 as numbers (or BigInt for very large)

function seatPos(i, n) {
  // The player (seat 0) sits at the bottom; the rest go clockwise around the oval.
  const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
  return {x: 50 + 44 * Math.cos(a), y: 50 + 40 * Math.sin(a)};
}

function eventText(e) {
  const who = e.seat != null ? nameOf(e.seat) : '';
  // "You call" but "Rampart calls".
  const v = (base, s = base + 's') => (e.seat === 0 ? base : s);
  const allIn = e.all_in ? ' (all-in)' : '';
  switch (e.type) {
    case 'small_blind': return `${who} ${v('post')} the small blind ${num(e.amount)}`;
    case 'big_blind': return `${who} ${v('post')} the big blind ${num(e.amount)}`;
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
  h += `<button class="cc-btn${setup.hud ? ' on' : ''}" data-act="hud" aria-pressed="${!!setup.hud}">HUD</button>`;
  h += `<button class="cc-btn${statsOpen ? ' on' : ''}" data-act="stats" aria-pressed="${statsOpen}">Stats</button>`;
  h += '<button class="link-btn" data-act="leave">Leave table</button></span></div>';
  h += '<div class="pl-felt">';
  h += `<div class="pl-center"><div class="pl-board">${[0, 1, 2, 3, 4].map(i => (s.board[i] ? cardHtml(s.board[i]) : '<span class="pl-card slot"></span>')).join('')}</div>`;
  h += `<div class="pl-pot">Pot ${num(s.pot)}</div></div>`;
  s.seats.forEach((seat, i) => {
    const p = seatPos(i, n);
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

function controlsHtml() {
  const s = state;
  if (s.complete) {
    const winners = s.seats.map((x, i) => ({...x, i})).filter(x => num(x.won) > 0);
    const text = winners.map(w => `${esc(w.name)} ${w.i === 0 ? 'win' : 'wins'} ${num(w.won)}`).join(', ');
    // Before the first hand of a hosted table there's no result yet.
    const result = num(s.hand_number) ? `${text}${s.showdown ? '' : ' (no showdown)'}` : 'Waiting for players';
    if (mode === 'guest') return `<div class="pl-controls done"><span class="pl-result">${result}</span><span class="pl-meta">The host deals the next hand</span></div>`;
    const label = num(s.hand_number) ? nextLabel() : 'Deal';
    let h = `<div class="pl-controls done"><span class="pl-result">${result}</span>`;
    h += `<button class="tr-start" data-act="next"><span id="pl-next">${label}</span> <kbd>Space</kbd></button>`;
    if (setup.autoDeal && num(s.hand_number)) h += `<button class="btn-small" id="pl-pause" data-act="pause">${pauseLabel()} <kbd>P</kbd></button>`;
    return h + '</div>';
  }
  const L = s.legal;
  if (foldQueued) {
    // With the turn here, the queued fold (or check) is on its way.
    if (L) return `<div class="pl-controls wait"><span>${L.can_fold ? 'Folding' : 'Checking'}…</span></div>`;
    return '<div class="pl-controls wait"><span>Folding when it’s your turn</span>' +
      '<button class="tr-btn" data-act="prefold">Undo <kbd>F</kbd></button></div>';
  }
  if (!L) {
    const fold = canPrefold() ? '<button class="tr-btn no" data-act="prefold">Fold <kbd>F</kbd></button>' : '';
    return `<div class="pl-controls wait"><span>${esc(nameOf(s.to_act))} is thinking…</span>${fold}</div>`;
  }
  const range = L.raise || L.bet;
  const word = L.raise ? 'Raise to' : 'Bet';
  let h = '<div class="pl-controls">';
  if (L.can_fold) h += '<button class="tr-btn no" data-act="fold">Fold <kbd>F</kbd></button>';
  if (L.can_check) h += '<button class="tr-btn" data-act="check">Check <kbd>C</kbd></button>';
  else if (L.call != null) h += `<button class="tr-btn" data-act="call">Call ${num(L.call)} <kbd>C</kbd></button>`;
  if (range) {
    const min = num(range.min_to), max = num(range.max_to);
    if (!raiseTo || raiseTo < min || raiseTo > max) raiseTo = min;
    h += '<div class="pl-raise">';
    h += `<div class="pl-sizes">${sizeButtons(min, max)}</div>`;
    h += `<input type="range" id="pl-amt" min="${min}" max="${max}" step="1" value="${raiseTo}" aria-label="Amount">`;
    h += `<button class="tr-btn yes" data-act="${L.raise ? 'raise' : 'bet'}">${word} <b id="pl-amtv">${raiseTo}</b> <kbd>R</kbd></button>`;
    h += '</div>';
  }
  h += '</div>';
  return h;
}

// Pot-fraction sizes: the street total after calling and then adding that
// fraction of the pot, clamped to the legal range.
function sizeButtons(min, max) {
  const s = state, me = s.seats[0];
  const call = num(s.current_bet) - num(me.street_bet);
  const potAfterCall = num(s.pot) + call;
  const size = f => Math.max(min, Math.min(max, num(s.current_bet) + Math.round(potAfterCall * f)));
  // In pot-limit the largest bet is the pot (the engine's max_to), so Pot is
  // the last button, and it's all-in when the stack can't cover a full pot.
  const sizes = [['½ pot', size(0.5)], ['¾ pot', size(0.75)]];
  if (tableGame.pl) sizes.push([max >= allInTo() ? 'All-in' : 'Pot', max]);
  else sizes.push(['Pot', size(1)], ['All-in', max]);
  return sizes.map(([t, v]) => `<button class="btn-small" data-size="${v}">${t}</button>`).join('');
}

// The street total that puts the person all-in.
function allInTo() {
  const me = state.seats[0];
  return num(me.street_bet) + num(me.stack);
}

function netBarHtml() {
  let h = `<span class="pl-meta">Table <b>${esc(room)}</b>`;
  if (mode === 'host') h += ` · ${openSeats} open seat${openSeats === 1 ? '' : 's'}</span><button class="link-btn" data-act="copy">Copy link</button>`;
  else h += '</span>';
  if (netNote) h += `<span class="pl-meta pl-neterr">${esc(netNote)}</span>`;
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
  if (!state || !state.complete || num(state.hand_number) === recordedHand) return;
  recordedHand = num(state.hand_number);
  const g = tableGame.id;
  const counts = countHand(state);
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
  h += '<p class="pl-meta">Raw rates with the sample size in brackets. Bots are tracked by personality, so their stats follow them to new tables. Each game keeps its own stats.</p>';
  h += '</div>';
  return h;
}

function resetStats() {
  const all = setup.statsScope === 'all';
  if (!confirm(`Reset ${all ? 'all-time' : 'this session’s'} ${tableGame.name} stats for everyone?`)) return;
  if (all) { delete allStats[tableGame.id]; saveStats(); }
  else delete sessionStats[tableGame.id];
  render();
}

// ---- events ----

function onClick(e) {
  const el = e.target.closest('[data-pgame],[data-count],[data-blinds],[data-buyin],[data-open],[data-turn],[data-act],[data-size],[data-scope],[data-sort]');
  if (!el) return;
  if (el.dataset.scope) { setup.statsScope = el.dataset.scope; saveSetup(); render(); }
  else if (el.dataset.sort) {
    const key = el.dataset.sort;
    // Numbers sort biggest first; the player column goes back to seat order.
    statsSort = statsSort.key === key ? {key, dir: -statsSort.dir} : {key, dir: key === 'seat' ? 1 : -1};
    render();
  }
  else if (el.dataset.act === 'hud') { setup.hud = !setup.hud; saveSetup(); render(); }
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
  else if (el.dataset.open) { readNameInput(); setup.open = +el.dataset.open; render(); }
  else if (el.dataset.turn) { readNameInput(); setup.turnSecs = +el.dataset.turn; render(); }
  else if (el.dataset.size) { raiseTo = +el.dataset.size; render(); }
  else if (el.dataset.act === 'shuffle') { setup.bots = []; render(); }
  else if (el.dataset.act === 'sit') startTable();
  else if (el.dataset.act === 'next') nextHand();
  else if (el.dataset.act === 'pause') hold('user', !holds.has('user'));
  else if (el.dataset.act === 'autodeal') { setup.autoDeal = !setup.autoDeal; saveSetup(); holds.delete('user'); render(); armDeal(); }
  else if (el.dataset.act === 'leave') leaveTable();
  else if (el.dataset.act === 'host') hostTable();
  else if (el.dataset.act === 'join') joinTable();
  else if (el.dataset.act === 'copy') copyLink();
  else if (el.dataset.act === 'prefold') togglePrefold();
  else if (['fold', 'check', 'call', 'allin'].includes(el.dataset.act)) act(el.dataset.act);
  else if (el.dataset.act === 'bet' || el.dataset.act === 'raise') {
    // Only a bet of the whole stack is "allin"; in pot-limit the top of the
    // range is usually the pot, which the engine takes as a plain bet/raise.
    act(raiseTo >= allInTo() ? 'allin' : el.dataset.act, raiseTo);
  }
}

function onInput(e) {
  if (e.target.id === 'pl-amt') {
    raiseTo = +e.target.value;
    const v = root.querySelector('#pl-amtv');
    if (v) v.textContent = raiseTo;
  }
}

function onChange(e) {
  if (e.target.dataset.bot != null) { setup.bots[+e.target.dataset.bot] = e.target.value; render(); }
}

// The countdown waits while a mouse is over the result or the log, so the
// hand can be read.
function onPointer(e) {
  if (e.pointerType !== 'mouse') return;
  hold('hover', e.type === 'pointerover' && !!e.target.closest('.pl-result, .pl-log'));
}

function onVisibility() {
  hold('hidden', document.hidden);
}

function onKey(e) {
  if (!open || !state || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (state.complete && (k === ' ' || k === 'enter')) { e.preventDefault(); nextHand(); return; }
  if (state.complete && k === 'p' && setup.autoDeal) { hold('user', !holds.has('user')); return; }
  const L = state.legal;
  if (!L) {
    // Before the player's turn, F queues a fold (or cancels one) and Esc cancels.
    if ((k === 'f' && (foldQueued || canPrefold())) || (k === 'escape' && foldQueued)) togglePrefold();
    return;
  }
  if (foldQueued) return; // the queued action is already being sent
  if (k === 'f' && L.can_fold) act('fold');
  else if (k === 'c') act(L.can_check ? 'check' : 'call');
  else if (k === 'r' && (L.raise || L.bet)) root.querySelector('[data-act="raise"],[data-act="bet"]')?.click();
}

export async function openPlay(el) {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('pointerover', onPointer);
    root.addEventListener('pointerleave', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
  }
  open = true;
  if (document.hidden) holds.add('hidden'); else holds.delete('hidden');
  if (!personalities.length) {
    root.innerHTML = '<div class="pl-wrap"><p class="pl-meta">Loading the bots…</p></div>';
    personalities = await call('personalities');
    try { gtoAvailable = (await fetch(GTO_MANIFEST, {cache: 'no-cache'})).ok; } catch {}
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
