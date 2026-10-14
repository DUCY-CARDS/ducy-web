// Playing in the Play section (play-section.js, #138): no-limit Hold'em or
// pot-limit Omaha (4, 5 or 6 cards) against ducy's personality bots, a
// friends table, or a club's table (clubs.js seats you through joinTableVia).
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
// with 100 BB, and in Hold'em each finished hand's decisions are reviewed
// against the bot's strategy (play-review.js) in the background. PLO4 and
// PLO6 have their own GTO bots, without the review.
// The Ladder tab (#212) plays heads-up freezeouts against one bot at a time,
// easiest first, with the GTO bot at the top (ladder.js has the rules).

import { countHand, recordHand, rates, pct, afText, ADVERTISED } from './play-stats.js';
import { emptyTotals, addReview, addTotals, per100, bbText, mixCost, mixRows, isYourPlay, isVariant, FLAGGED, GRADE_LABEL } from './play-review.js';
import { clientId, connect, joinLink, newCode, relayUrl } from './play-net.js';
import { checkSignature, loadIdentity, signMessage } from './identity.js';
import { isPublicKey, newKeyPair, open as openBox, seal, sharedKey } from './e2e.js';
import { dropTable, getTable, putTable } from './table-store.js';
import { cardSound, chipsSound, hurrySound, potSound, shuffleSound, turnSound, unlockSounds } from './sounds.js';
import { chipText, chipInput, parseChips, CHIP_STEP } from './chip-format.js';
import { handText, handWords } from './hand-words.js';
import { BOT_AVATARS, PLAYER_AVATARS, avatarUrl } from './avatars.js';
import { defaultSeats, maxSeats } from './club-tables.js';
import { CHAT_MAX, addChat, chatLimiter, chatName, cleanChat, readChat } from './table-chat.js';
import { REGULARS_SEATS, betweenHands, pickRegulars, startBank } from './regulars.js';
import {
  BLINDS, START_BB, WINS_TO_TAKE, finishGame, keepGame, loadProgress, newProgress, pausedGame,
  opponentOf, rungsFor, saveProgress, startGame,
} from './ladder.js';
import { SPADE_PATH } from './home.js';

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
  {id: 'plo4', label: 'Omaha 4', name: 'Pot-limit Omaha', cards: 4, pl: true},
  {id: 'plo5', label: 'Omaha 5', name: 'Pot-limit Omaha 5', cards: 5, pl: true},
  {id: 'plo6', label: 'Omaha 6', name: 'Pot-limit Omaha 6', cards: 6, pl: true},
  // Bomb pots on two boards, at the Regulars only: everyone antes $5 (the
  // engine's ante is the big blind), no preflop betting, $500 stacks.
  {id: 'plo4-bomb', label: 'Bomb pot', name: 'Omaha bomb pot · two boards', cards: 4, pl: true, bomb: true, sb: 200, bb: 500, buyIn: 50000},
];
const gameOf = id => GAMES.find(g => g.id === id) || GAMES[0];
// A friends table: its name, game, blinds, seats in all (the host's
// included) and the buy-in limits in big blinds (min and max, in chips, are
// minBB × bb and maxBB × bb). Chips are hundredths (chip-format.js): 100/200
// shows as 1/2.
const FRIENDS_DEFAULT = {title: '', game: 'nlhe', sb: 100, bb: 200, seats: 9, minBB: 50, maxBB: 200};
const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9];
const FRIENDS_BLINDS = [[100, 200], [200, 500], [500, 1000], [2500, 5000]];
const BOT_BLINDS = [[100, 200], [500, 1000], [2500, 5000]];
const MAX_CHIPS = 1e11;
// An amount from the engine, for the screen: cash chips divided by 100,
// tournament chips whole (wholeChips, set for a club tournament's tables).
let wholeChips = false;
const c = n => chipText(num(n), {whole: wholeChips});
// The bet amount box, the same way: a value to show, what was typed, the step.
const amtInput = n => (wholeChips ? String(num(n)) : chipInput(n));
const readAmt = s => (wholeChips ? (/^\s*\d+\s*$/.test(String(s)) ? Number(s) : NaN) : parseChips(s));
const amtStep = () => (wholeChips ? '1' : CHIP_STEP);

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
// The PLO GTO bots, for heads-up PLO4 and PLO6 the same way, keyed by game:
// each hosted at gto/ with its own manifest, loaded by its own worker op, and
// offered when it's there and the engine can play it.
const GTO_PLOS = {
  plo4: {
    bot: {id: 'gto-plo', name: 'GTO', description: 'Plays a near game-theory-optimal strategy, trained for heads-up pot-limit Omaha at 100 big blinds.'},
    label: 'Omaha 4', manifest: new URL('gto/plo-current.json', document.baseURI).href,
    supported: 'gtoPloSupported', load: 'loadGtoPlo', available: false, ready: false,
  },
  plo6: {
    bot: {id: 'gto-plo6', name: 'GTO', description: 'Plays a near game-theory-optimal strategy, trained for heads-up six-card pot-limit Omaha at 100 big blinds.'},
    label: 'Omaha 6', manifest: new URL('gto/plo6-current.json', document.baseURI).href,
    supported: 'gtoPlo6Supported', load: 'loadGtoPlo6', available: false, ready: false,
  },
};
const GTO_IDS = [GTO.id, ...Object.values(GTO_PLOS).map(p => p.bot.id)];
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
// GTO training: the table is heads-up against a GTO bot.
let gtoTable = false;
// The bots at the table in play, one per seat after yours.
let tableBots = [];
// The ladder (#212): your progress, and the game in play, if it's a ladder
// game: {opp, rung, over: null | {won, outcome}}. `ladderNote` says how the
// last series went, on the Ladder tab.
let ladderProgress = loadProgress();
let ladder = null;
let ladderNote = '';
// Hand review works against the Hold'em GTO bot only.
const reviewTable = () => gtoTable && tableGame.id === 'nlhe';
// The last finished hand's review: {hand, data} once it's back, {hand,
// pending: true} while it's worked out. `reviewOpen` holds the decisions
// expanded to show the bot's mix.
let review = null;
let reviewOpen = new Set();
// Live feedback (#56): each of your decisions this hand, graded as soon as
// it's made. items are {data} once back, {pending: true} until then; keys
// in `liveOpen` are the ones expanded.
let live = {hand: 0, items: []};
let liveOpen = new Set();
// Review totals since sitting down, and all time (kept in localStorage).
let sessionReview = emptyTotals();
let allReview = loadReviewTotals();
let statsSort = {key: 'seat', dir: 1};
// Multiplayer: 'solo' against bots, 'host' running a table for friends, or
// 'guest' at someone else's table.
let mode = 'solo';
let net = null; // relay connection
let room = ''; // table code
// The last fair-deal check at a club table (#136): {hand, ok, why}.
let fairCheck = null;
export function showFairCheck(check) {
  fairCheck = check;
  render();
}
// A friends table's name (#152): the host's, sent to each player.
let hostTitle = '';
let tableTitle = '';
let netNote = ''; // connection status, e.g. "Reconnecting…"
let noteUntil = 0; // keep netNote on screen until then (a refused chip request)
let shownSeq = -1; // state number on screen, so late results are dropped
let hostChain = Promise.resolve(); // host calls to the worker, in order
let hostTimer = null; // turn clock for the host
let clockTimer = null;
let turnEnds = 0; // when the acting person's time runs out (Date.now() ms)
// Sounds at the table (sounds.js): the turn the chime was
// played for ("hand:events"), and the deadline its 5-second alert went for
// (0: none yet), so a time bank that extends the turn gets its own alert.
const HURRY_MS = 5000;
let soundTurn = '';
let hurried = 0;
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
// Your answer to running it twice, at a bot table or as the host: {hand, yes}.
// (A guest's comes back from the host in its seat status.)
let myRunAnswer = null;
let lastView = null; // a guest's last view from the host
let errView = null; // the tab netNote is about, after leaving a table
// This browser's player identity for clubs (identity.js), loaded on open.
let me = null;
// Chat at a friends table (table-chat.js): the messages on screen, how many
// came in while the chat was hidden, and flood control (the host's for
// everyone, and your own).
let chat = [];
let chatUnread = 0;
let chatLimit = chatLimiter();
let myChatLimit = chatLimiter();
let chatNote = '';

function defaultSetup() {
  return {game: 'nlhe', count: 5, bots: [], sb: 100, bb: 200, buyIn: 20000, chips: 'cents', hud: true, statsScope: 'session', sounds: true, gameSounds: true, autoDeal: true, gtoAutoDeal: false, autoDealV: 2, dealSecs: 1, name: '', avatar: '', turnSecs: 30, review: true, live: false, runTwice: 'ask', chat: true, friends: {...FRIENDS_DEFAULT}};
}

// Running it twice: ask each time, or always answer twice or once. Asking
// waits RUN_SECS, then runs once. Ladder games always run once.
const RUN_SECS = 5;
const RUN_PREFS = ['ask', 'twice', 'once'];
const RUN_LABELS = {ask: 'Run twice: ask', twice: 'Run twice: always', once: 'Run twice: never'};
let runTimer = null;
const runPref = () => (ladder ? 'once' : RUN_PREFS.includes(setup.runTwice) ? setup.runTwice : 'ask');

// An all-in with cards to come: the rest of the board is dealt slowly (the
// flop at once, then the turn, then the river) before the result, and when
// it's run twice the second board is dealt the same way after the first.
// The wait grows towards the river, and the slots about to be dealt pulse.
// Hole cards are face up during it only in tournament-style games (the
// ladder, club tournaments); otherwise they're shown at the end, as at
// showdown.
const PEEL_MS = {flop: 1500, turn: 2200, river: 3000, run2: 2200, result: 1800};
const peelWait = cards => (cards <= 3 ? PEEL_MS.flop : cards === 4 ? PEEL_MS.turn : PEEL_MS.river);
let peeling = false;

// Auto-deal is on by default, but off at GTO tables, where each hand's
// review is worth reading first; the choice at each is remembered.
const autoDealOn = () => !!(gtoTable ? setup.gtoAutoDeal : setup.autoDeal);
function setAutoDeal(on) {
  if (gtoTable) setup.gtoAutoDeal = on; else setup.autoDeal = on;
}

function loadSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(SETUP_KEY) || 'null');
    if (s && Array.isArray(s.bots)) {
      // Saved before chips were hundredths: its blinds and buy-in would show
      // a hundred times too small, so they start over.
      if (s.chips !== 'cents') { delete s.sb; delete s.bb; delete s.buyIn; delete s.friends; }
      // Saved before auto-deal was on by default (and off at GTO tables).
      if (s.autoDealV !== 2) { delete s.autoDeal; delete s.gtoAutoDeal; }
      return {...defaultSetup(), ...s, friends: {...FRIENDS_DEFAULT, ...(s.friends || {})}};
    }
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

// The GTO bots play heads-up only: one No-limit Hold'em, the others PLO4 and
// PLO6. The one for the game picked, or null.
function gtoBot() {
  if (setup.count !== 1) return null;
  if (setup.game === 'nlhe' && gtoAvailable) return GTO;
  const plo = GTO_PLOS[setup.game];
  return plo?.available ? plo.bot : null;
}
const botChoices = () => (gtoBot() ? [gtoBot(), ...personalities] : personalities);

// Fills empty or unknown bot picks with random personalities not already
// seated. A GTO pick follows the game when there's a GTO bot for it.
function fillBots() {
  const ids = personalities.map(p => p.id);
  const valid = botChoices().map(p => p.id);
  const bots = setup.bots.slice(0, setup.count)
    .map(b => (GTO_IDS.includes(b) && gtoBot() ? gtoBot().id : b))
    .map(b => (valid.includes(b) ? b : null));
  while (bots.length < setup.count) bots.push(null);
  for (let i = 0; i < bots.length; i++) {
    if (bots[i]) continue;
    const free = ids.filter(id => !bots.includes(id));
    bots[i] = (free.length ? free : ids)[Math.floor(Math.random() * (free.length || ids.length))];
  }
  setup.bots = bots;
}

// This module's part of each Play tab (play-section.js, #138):
//   'play'  the bots, and a friends table you can resume
//   'ladder' the heads-up ladder (#212), and its games
//   'host'  start a friends table (a temporary game)
//   'join'  only why joining a table didn't work (the form is the section's)
//   'clubs' nothing
// Seated at any table, the Play tab shows it.
let view = 'play';

function renderSetup() {
  let h = '';
  const err = netNote ? `<p class="pl-desc pl-neterr">${esc(netNote)}</p>` : '';
  if (view === 'play') h = err + resumeHtml() + botsSetupHtml();
  else if (view === 'ladder') h = err + ladderHtml();
  // Start a game (Play, #209): a table for friends.
  else if (view === 'host') h = err + resumeHtml() + (relayUrl() ? friendsSetupHtml() : '<p class="pl-meta">Games with friends need ducy’s relay, which isn’t set up here.</p>');
  else if (view === 'join') h = err;
  root.hidden = !h;
  root.innerHTML = h ? `<div class="pl-wrap">${h}</div>` : '';
}

// A friends table this browser hosted that stopped mid-hand (#117).
function resumeHtml() {
  if (!savedTable || mode === 'host') return '';
  const ago = Math.max(1, Math.round((Date.now() - savedTable.at) / 60_000));
  let h = `<section class="cl-card pl-resume"><h2>Your game ${esc(savedTable.room)}</h2><p>It stopped ${ago < 60 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago with a hand in progress. Resume it, and players rejoin with the same code.</p>`;
  return h + '<div class="pl-actions"><button class="tr-start" data-act="resumehost">Resume game</button><button class="btn-small" data-act="forgethost">Discard</button></div></section>';
}

function optsRow(label, items) {
  return `<div class="pl-row"><span class="pl-label">${label}</span><div class="pl-opts">${items.join('')}</div></div>`;
}

const optBtn = (on, attr, value, text) => `<button class="cc-btn${on ? ' on' : ''}" ${attr}="${value}">${text}</button>`;

// Play the Regulars (#225): pick a game and sit down with five random
// Regulars, new ones every time. Choosing your own opponents (and the GTO
// bot) is the advanced option, folded away whenever you arrive.
function botsSetupHtml() {
  fillBots();
  // V3 (#225): Start a game's cream form, with the game and Sit down up
  // front and choosing opponents folded away.
  let h = '<div class="pl-head"><h1>Play the Regulars</h1>';
  h += '<p>Play immediately against the Regulars.</p></div>';
  h += '<div class="pl-setup sg-form rg-form">';
  h += `<div class="sg-field"><span class="sg-label">Game</span><div class="sg-chips">${GAMES.map(g => `<button type="button" class="sg-chip${setup.game === g.id ? ' on' : ''}" data-pgame="${g.id}" aria-pressed="${setup.game === g.id}">${g.label}</button>`).join('')}</div></div>`;
  h += `<div class="rg-go"><button class="tr-start sg-open" data-act="sitregulars">Sit down</button><span class="rg-note">${REGULARS_SEATS} Regulars, picked at random.</span></div>`;
  // Choosing who you play is the advanced option, folded away.
  h += `<details class="tf-more"${setup.moreOpen ? ' open' : ''}><summary data-more>Advanced: choose your opponents</summary><div class="cl-more">`;
  h += optsRow('Opponents', [1, 2, 3, 4, 5, 6, 7, 8].map(n => optBtn(setup.count === n, 'data-count', n, n)));
  // Who sits where: heads-up, the one opponent stays in view (that's where
  // the GTO bot is picked); otherwise, with the blinds and buy-in, under
  // More options (#144), since random opponents and the defaults suit most.
  let picks = '<div class="pl-bots">';
  setup.bots.forEach((id, i) => {
    const p = botChoices().find(x => x.id === id);
    picks += `<label class="pl-bot"><span class="pl-seatno">Seat ${i + 2}</span><select data-bot="${i}">`;
    for (const q of botChoices()) picks += `<option value="${q.id}"${q.id === id ? ' selected' : ''}>${esc(q.name)}</option>`;
    picks += `</select><span class="pl-desc">${esc(p ? p.description : '')}</span></label>`;
  });
  picks += '</div>';
  h += picks;
  h += optsRow('Blinds', BOT_BLINDS.map(([sb, bb]) => optBtn(setup.bb === bb, 'data-blinds', `${sb}/${bb}`, `${chipText(sb)}/${chipText(bb)}`)));
  h += optsRow('Buy-in', [50, 100, 200].map(bbs => optBtn(setup.buyIn === bbs * setup.bb, 'data-buyin', bbs, `${bbs} BB`)));
  const gtoGames = [gtoAvailable && 'Hold’em', ...Object.values(GTO_PLOS).map(p => p.available && p.label)].filter(Boolean);
  const gamesText = gtoGames.length > 1 ? `${gtoGames.slice(0, -1).join(', ')} or ${gtoGames.at(-1)}` : gtoGames[0];
  if (gtoGames.length && !gtoBot()) h += `<p class="pl-desc">Play heads-up ${gamesText} (1 opponent) to face the GTO bot.</p>`;
  if (gtoBot() && setup.bots[0] === gtoBot().id) h += `<p class="pl-desc">GTO training: you both start every hand with ${GTO_BUY_IN_BB} BB, whatever the buy-in${setup.game === 'nlhe' ? ', and your decisions are reviewed after each hand' : ''}.</p>`;
  h += '<div class="pl-actions"><button class="btn-small" data-act="shuffle">Random opponents</button>';
  h += '<button class="tr-start" data-act="sit">Sit down with these</button></div>';
  h += '</div></details>';
  if (setupNote) h += `<p class="pl-desc">${esc(setupNote)}</p>`;
  h += '</div>';
  return h;
}

// ---- the ladder (#212) ----

const ladderRungs = () => rungsFor(personalities.map(p => p.id), gtoAvailable);
const botInfo = id => (id === GTO.id ? GTO : personalities.find(p => p.id === id)) || {id, name: id, description: ''};
const ladderAvatar = id => (BOT_AVATARS.has(id)
  ? `<span class="ld-av"><img src="${avatarUrl(id)}" alt=""></span>`
  : `<span class="ld-av none" aria-hidden="true">${esc([...botInfo(id).name][0] || '?')}</span>`);
const blindsText = ([sb, bb]) => `${chipText(sb)}/${chipText(bb)}`;
const mysteryAvatar = '<span class="ld-av none" aria-hidden="true">?</span>';
// A rung's bot stays hidden until you've played them: rungs below you,
// bots you've had a series against, and the current one once its series is under way.
const ladderRevealed = (p, rungs, i, level) =>
  i < level || !!p.record[rungs[i]] || (i === level && (p.wins + p.losses > 0 || !!pausedGame(p)));

// What a finished game or series means, in a sentence.
function ladderOutcomeText(won, outcome, opp, next) {
  const who = esc(botInfo(opp).name);
  if (outcome === 'game') return won ? `You beat ${who} in this game.` : `${who} took this game.`;
  if (outcome === 'up') return `You won the series against ${who}. On to the next rung.`;
  if (outcome === 'champion') return `You beat ${who}, the champion. You’re at the top of the ladder!`;
  if (outcome === 'down') return `${who} won the series. You drop a rung, to ${esc(botInfo(next).name)}.`;
  return `${who} won the series. Win two games to climb.`;
}

// Keeps the game so far (ladder.js keepGame), after every action: a game left
// in the middle, or a closed page, picks up with the same chips.
function ladderKeep(s) {
  if (!ladder || ladder.over || !s || !num(s.hand_number)) return;
  ladderProgress = keepGame(ladderProgress, num(s.seats[0].stack), ladder.handsBefore + num(s.hand_number));
  saveProgress(ladderProgress);
}

// Climb the ladder (V3, #225): the next series on a cream card, then every
// rung as a tile with a spade, filled for the ones beaten.
function ladderHtml() {
  const rungs = ladderRungs();
  const p = ladderProgress;
  const level = Math.min(p.level, rungs.length - 1);
  const opp = rungs[level];
  const info = botInfo(opp);
  let h = `<div class="pl-head"><h1>Climb the ladder</h1><p>Best of three. Win ${WINS_TO_TAKE} to climb, lose to drop.</p></div>`;
  if (ladderNote) h += `<p class="pl-desc ld-note">${ladderNote}</p>`;
  // The next series.
  const record = p.record[opp];
  const known = ladderRevealed(p, rungs, level, level);
  const game = p.wins + p.losses + 1;
  const them = known ? esc(info.name) : 'Them';
  h += '<section class="ld-next">';
  h += `<div class="ld-who">${known ? ladderAvatar(opp) : mysteryAvatar}<div><span class="ld-rungno">Rung ${level + 1} of ${rungs.length}${level === rungs.length - 1 ? ' · the champion' : ''}</span>`;
  h += known
    ? `<h2>${esc(info.name)}</h2><p class="ld-desc">${esc(info.description)}</p></div></div>`
    : '<h2>A new opponent</h2><p class="ld-desc">You’ll see who when you sit down.</p></div></div>';
  h += `<div class="ld-series"><span class="ld-game">Game ${game} of 3</span><span class="ld-tally"><b>${p.wins}</b> – <b>${p.losses}</b></span><span class="ld-sides">You · ${them}</span>`;
  if (record) h += `<span class="ld-before">Before: ${record.won} won, ${record.lost} lost</span>`;
  h += '</div>';
  const paused = pausedGame(p);
  if (paused) h += `<p class="ld-desc ld-paused">Paused: you ${c(paused.stacks[0])}, ${them} ${c(paused.stacks[1])}.</p>`;
  if (setupNote) h += `<p class="ld-desc">${esc(setupNote)}</p>`;
  const play = paused ? `Resume game ${game}` : game === 1 ? 'Start the series' : `Play game ${game}`;
  h += `<div class="ld-go"><button class="tr-start" data-act="ladder-play">${play}</button>`;
  h += `<span class="ld-rules">Hold’em, ${START_BB} big blinds each, blinds ${blindsText(BLINDS)}, no rebuys.</span></div>`;
  h += '</section>';
  // Every rung, easiest first: a filled spade for each one beaten.
  h += '<ol class="ld-rungs" aria-label="The ladder, easiest first">';
  for (let i = 0; i < rungs.length; i++) {
    const id = rungs[i], r = p.record[id];
    const cls = i === level ? 'here' : i < level ? 'below' : i <= p.best ? 'reached' : 'ahead';
    const tag = i === level ? 'You’re here' : i < level ? 'Beaten' : i <= p.best ? 'Reached before' : 'Ahead';
    const shown = ladderRevealed(p, rungs, i, level);
    const name = shown ? esc(botInfo(id).name) : '???';
    h += `<li class="ld-rung ${cls}"${i === level ? ' aria-current="step"' : ''} title="${name}: ${tag}${r ? ` (${r.won}–${r.lost})` : ''}">`;
    h += `<svg class="ld-spade" viewBox="0 0 32 32" width="18" height="18" aria-hidden="true"><path d="${SPADE_PATH}"/></svg>`;
    h += `${shown ? ladderAvatar(id) : mysteryAvatar}<span class="ld-num">${i + 1}</span><span class="ld-name">${name}</span></li>`;
  }
  h += '</ol>';
  h += '<div class="ld-foot">';
  if (p.titles) h += `<span class="pl-meta">Champion ${p.titles} time${p.titles === 1 ? '' : 's'}.</span>`;
  h += '<button class="link-btn" data-act="ladder-reset">Start the ladder over</button></div>';
  return h;
}

// Sits down for the next game of the series.
async function startLadderGame() {
  setupNote = '';
  const rungs = ladderRungs();
  const rung = Math.min(ladderProgress.level, rungs.length - 1);
  const opp = rungs[rung];
  if (!await prepareGto([opp])) { render(); return; }
  ladderNote = '';
  ladderProgress = startGame(ladderProgress);
  saveProgress(ladderProgress);
  const {stacks, hands} = ladderProgress.game;
  // Left with no chips behind (all-in when the page closed): that game is lost.
  if (stacks[0] <= 0 || stacks[1] <= 0) {
    const r = finishGame(ladderProgress, rungs, stacks[0] > 0);
    ladderProgress = r.progress;
    saveProgress(ladderProgress);
    ladderNote = ladderOutcomeText(stacks[0] > 0, r.outcome, opp, opponentOf(ladderProgress, rungs));
    render();
    return;
  }
  ladder = {opp, rung, over: null, handsBefore: hands};
  const [sb, bb] = BLINDS;
  await sitDown({bots: [opp], game: 'nlhe', buyIn: START_BB * bb, sb, bb, gto: false, stacks});
}

// After each hand: a game is over once someone has all the chips.
function ladderCheck() {
  if (!ladder || ladder.over || !state?.complete || !num(state.hand_number)) return;
  const mine = num(state.seats[0].stack), theirs = num(state.seats[1].stack);
  if (mine > 0 && theirs > 0) return;
  const rungs = ladderRungs();
  const r = finishGame(ladderProgress, rungs, mine > 0);
  ladderProgress = r.progress;
  saveProgress(ladderProgress);
  ladder.over = {won: mine > 0, outcome: r.outcome, next: opponentOf(ladderProgress, rungs)};
}

// Left before the game was over: it's paused with the chips as they stand (a
// hand in progress is folded), to pick up later.
function ladderLeave() {
  if (!ladder) return;
  if (!ladder.over) {
    if (!peeling) ladderKeep(state);
    const g = pausedGame(ladderProgress);
    ladderNote = g ? `Game paused: you have ${c(g.stacks[0])}, ${esc(botInfo(ladder.opp).name)} ${c(g.stacks[1])}. Pick it up any time.` : '';
  } else if (ladder.over.outcome !== 'game') {
    ladderNote = ladderOutcomeText(ladder.over.won, ladder.over.outcome, ladder.opp, ladder.over.next);
  }
  ladder = null;
}

// The table bar's line at a ladder game.
function ladderBarHtml() {
  // The game's hands: a resumed game counts on from where it was left.
  const s = state, played = (ladder.handsBefore || 0) + num(s.hand_number);
  const p = ladderProgress, name = esc(botInfo(ladder.opp).name);
  const score = ladder.over ? '' : ` · game ${p.wins + p.losses + 1} of 3, you ${p.wins} – ${p.losses}`;
  return `<span class="pl-meta">Ladder rung ${ladder.rung + 1}: ${name}${score} · hand ${played} · blinds ${c(s.small_blind)}/${c(s.big_blind)}</span>`;
}

// The game's result, where Next hand would be.
function ladderOverHtml() {
  const o = ladder.over;
  const p = ladderProgress;
  let text = ladderOutcomeText(o.won, o.outcome, ladder.opp, o.next);
  if (o.outcome === 'game') text += ` Series: you ${p.wins} – ${p.losses}.`;
  const label = o.outcome === 'game' ? `Play game ${p.wins + p.losses + 1}` : 'Back to the ladder';
  return {status: `<span class="pl-result ld-over ${o.won ? 'won' : 'lost'}">${text}</span>`, button: `<button class="tr-start" data-act="ladder-next">${label}</button>`};
}

// A table for friends (#152), on one form since V3 (#225): your name the
// first time, the game, blinds (presets or any values), seats, buy-in and
// an optional name. No bots; seats stay empty until people join, and everyone
// asks the host for chips within the buy-in. Turns use the default time.
let fstep = 1;
let fnote = '';
const FRIENDS_TURN_SECS = 30;

// V3 (#225): everything on one form, with the invite panel beside it.
function friendsSetupHtml() {
  const f = setup.friends;
  const chip = (on, attr, value, text) => `<button type="button" class="sg-chip${on ? ' on' : ''}" ${attr}="${value}" aria-pressed="${on}">${text}</button>`;
  const field = (label, body) => `<div class="sg-field"><span class="sg-label">${label}</span>${body}</div>`;
  let h = '<div class="pl-head"><h1>Start a game</h1></div><div class="sg-wrap"><div class="sg-form">';
  // Your name, the first time; after that it's in Player settings (#144).
  if (!setup.name) h += field('Your name', '<input class="pl-text" id="pl-name" maxlength="20" placeholder="What others see">');
  h += field('Game', `<div class="sg-chips">${GAMES.filter(g => !g.bomb).map(g => chip(f.game === g.id, 'data-fgame', g.id, g.id === 'nlhe' ? 'Hold’em' : `Omaha ${g.cards}`)).join('')}</div>`);
  const preset = FRIENDS_BLINDS.find(([sb, bb]) => sb === f.sb && bb === f.bb);
  let blinds = `<div class="sg-chips">${FRIENDS_BLINDS.map(([sb, bb]) => chip(preset?.[1] === bb && !f.customBlinds, 'data-fblinds', `${sb}/${bb}`, `${chipText(sb)}/${chipText(bb)}`)).join('')}${chip(!preset || !!f.customBlinds, 'data-fblinds', 'custom', 'Custom')}</div>`;
  if (!preset || f.customBlinds) {
    blinds += `<div class="sg-nums"><label class="pf-num">Small <input class="pl-text" type="number" id="pf-sb" min="0.01" step="${CHIP_STEP}" value="${chipInput(f.sb)}"></label>`;
    blinds += `<label class="pf-num">Big <input class="pl-text" type="number" id="pf-bb" min="0.01" step="${CHIP_STEP}" value="${chipInput(f.bb)}"></label></div>`;
  }
  h += field('Blinds', blinds);
  // No more seats than the game can deal to (PLO6: 6).
  h += field('Seats', `<div class="sg-chips">${TABLE_SIZES.filter(n => n <= maxSeats(f.game)).map(n => chip(f.seats === n, 'data-fseats', n, n)).join('')}</div>`);
  h += field('Buy-in', `<div class="sg-nums"><label class="pf-num">Min <input class="pl-text" type="number" id="pf-min" min="0.01" step="${CHIP_STEP}" value="${chipInput(f.minBB * f.bb)}"></label><label class="pf-num">Max <input class="pl-text" type="number" id="pf-max" min="0.01" step="${CHIP_STEP}" value="${chipInput(f.maxBB * f.bb)}"></label></div>`);
  h += field('Name it', `<input class="pl-text" id="pf-title" maxlength="40" placeholder="${esc(setup.name ? `${setup.name}’s game` : 'Friday night poker')}" value="${esc(f.title)}">`);
  if (fnote) h += `<p class="pl-desc pl-neterr">${esc(fnote)}</p>`;
  h += '<button class="tr-start sg-open" data-act="host">Open the table</button></div>';
  h += '<aside class="sg-invite"><span class="sg-invite-title">Invite your friends</span>';
  h += '<span>Once the table is open, share the code or the link.</span>';
  h += '<div class="sg-code" aria-hidden="true">····-····</div>';
  h += '<span class="sg-note">Nothing is kept once everyone leaves.</span></aside></div>';
  return h;
}

// Reads the step's fields into the setup; returns what's wrong, if anything.
function readFriendsStep() {
  const f = setup.friends;
  const val = id => root.querySelector('#' + id);
  readNameInput();
  if (val('pf-title')) f.title = val('pf-title').value.trim().slice(0, 40);
  if (!setup.name) return 'Enter your name: it’s what the others see.';
  if (val('pf-sb')) {
    const sb = parseChips(val('pf-sb').value), bb = parseChips(val('pf-bb').value);
    if (!(sb >= 1 && bb >= sb && bb <= MAX_CHIPS)) return 'Blinds are amounts like 1 or 0.25: a small blind of at least 0.01, and a big blind at least that.';
    f.sb = sb;
    f.bb = bb;
  }
  if (val('pf-min')) {
    const min = parseChips(val('pf-min').value), max = parseChips(val('pf-max').value);
    if (!(min >= f.bb)) return `The minimum buy-in must be at least the big blind (${chipText(f.bb)}).`;
    if (!(max >= min && max <= MAX_CHIPS)) return 'The maximum buy-in must be at least the minimum.';
    f.minBB = min / f.bb;
    f.maxBB = max / f.bb;
  }
  saveSetup();
  return '';
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

// How many board cards show at each reveal from `from` to `to`: the flop
// together, then a card at a time.
function revealCounts(from, to) {
  const counts = [];
  for (let k = from < 3 ? 3 : from + 1; k <= to; k += 1) counts.push(k);
  return counts;
}

// The states to show: the board as it stood with everyone all-in, then the
// flop (together), the turn and the river, without the result; run twice,
// then the second board the same way. Each carries `peelNext` (the board, 1
// or 2, and the slots dealt next, which pulse), `peelWait` (how long it
// stays before the next) and `peelRuns` (1, or 2 when it's run twice).
function peelSteps(before, after) {
  const from = before.board.length;
  const faceUp = !!ladder || wholeChips;
  const known = before.events.length;
  // Chips as they were before the pot was paid out.
  const pot = after.seats.reduce((t, x) => t + num(x.won), 0);
  const seats = after.seats.map((x, i) => ({
    ...x, stack: num(x.stack) - num(x.won), won: 0, net: 0, street_bet: 0,
    cards: faceUp || i === 0 || x.folded ? x.cards : before.seats[i]?.cards ?? null,
  }));
  const base = {...after, seats, pot, complete: false, showdown: false, legal: null, to_act: null, run_choice: false,
    peelRuns: after.second_board?.length ? 2 : 1};
  // The new events up to `boards` first-run boards: the last actions and the
  // boards dealt so far; no result, and no second run yet.
  const firstEvents = boards => {
    let seen = 0;
    return after.events.slice(0, known).concat(after.events.slice(known).filter(e => {
      if (e.type === 'award' || e.type === 'second_board') return false;
      if (e.type === 'board') { seen += 1; return seen <= boards; }
      return true;
    }));
  };
  const first = [from, ...revealCounts(from, after.board.length)];
  // A double board (bomb pots): both boards were out from the flop, so they're
  // dealt together, street by street.
  if (before.second_board?.length) {
    const together = boards => {
      let seen = 0;
      return after.events.slice(0, known).concat(after.events.slice(known).filter(e => {
        if (e.type === 'award') return false;
        if (e.type === 'board') seen += 1;
        return e.type === 'board' || e.type === 'second_board' ? seen <= boards : true;
      }));
    };
    return first.map((k, step) => ({
      ...base, peelRuns: 1, board: after.board.slice(0, k), second_board: after.second_board.slice(0, k), events: together(step),
      peelNext: step + 1 < first.length ? [1, k, first[step + 1]] : null,
      peelWait: step + 1 < first.length ? peelWait(first[step + 1]) : PEEL_MS.result,
    }));
  }
  const second = after.second_board?.length ? after.second_board : null;
  const steps = first.map((k, step) => ({
    ...base, board: after.board.slice(0, k), second_board: [], events: firstEvents(step),
    peelNext: step + 1 < first.length ? [1, k, first[step + 1]] : null,
    peelWait: step + 1 < first.length ? peelWait(first[step + 1]) : second ? PEEL_MS.run2 : PEEL_MS.result,
  }));
  if (!second) return steps;
  // The second run: its board appears with the cards both runs share, then
  // deals the rest. Its one event is split by street, so each deal has a sound.
  const shared = from;
  const cards = after.events.slice(known).find(e => e.type === 'second_board')?.cards || second.slice(shared);
  const all = firstEvents(first.length);
  const counts = [shared, ...revealCounts(shared, second.length)];
  return steps.concat(counts.map((k, step) => ({
    ...base, board: after.board, second_board: second.slice(0, k),
    events: all.concat(counts.slice(1, step + 1).map((c, j) => ({type: 'second_board', cards: cards.slice(counts[j] - shared, c - shared)}))),
    peelNext: step + 1 < counts.length ? [2, k, counts[step + 1]] : null,
    peelWait: step + 1 < counts.length ? peelWait(counts[step + 1]) : PEEL_MS.result,
  })));
}

let peelTimer = null;
let peeled = null; // the snapshot a finished peel hands on, shown as is
function peel(before, snap) {
  const steps = peelSteps(before, snap.state);
  const mine = session;
  peeling = true;
  // A ladder game keeps the result now, in case the page closes mid-reveal.
  ladderKeep(snap.state);
  let i = 0;
  const next = () => {
    if (mine !== session || !open) { peeling = false; return; }
    if (i < steps.length) {
      state = steps[i];
      gameSounds();
      render();
      peelTimer = setTimeout(next, steps[i].peelWait);
      i += 1;
    } else {
      peeling = false;
      peeled = snap;
      show(snap);
    }
  };
  clearTimeout(peelTimer);
  next();
}

// Running it twice: answer by the player's setting, or ask and run once if
// they haven't chosen within RUN_SECS. If the choice stays open anyway (it's
// someone else's, or it didn't take), let the table move on.
function armRunChoice() {
  clearTimeout(runTimer);
  runTimer = null;
  const s = state;
  if (!s?.run_choice || !seated) return false;
  const hn = num(s.hand_number);
  const me = s.seats[0];
  const asked = !watching && !me.folded && !me.sitting_out && !me.empty;
  const answered = mode === 'guest' ? mySeat?.run_twice != null : myRunAnswer?.hand === hn;
  if (asked && !answered && runPref() !== 'ask') { runChoice(runPref() === 'twice'); return true; }
  const mine = session;
  runTimer = setTimeout(() => {
    if (mine !== session || !state?.run_choice || num(state.hand_number) !== hn) return;
    const stillMine = mode === 'guest' ? mySeat?.run_twice == null : myRunAnswer?.hand !== hn;
    if (asked && stillMine) runChoice(false);
    else if (mode === 'solo') request('advance').then(snap => snap && show(snap));
  }, RUN_SECS * 1000);
  return false;
}

function show(snap) {
  if (peeling) return;
  // An all-in that ran out at a bot table: deal the rest slowly, both runs
  // when it's run twice.
  const before = state;
  if (snap !== peeled && mode === 'solo' && before && snap.state && !before.complete && snap.state.complete && snap.state.showdown
      && num(before.hand_number) === num(snap.state.hand_number)
      && (snap.state.board.length > before.board.length || snap.state.second_board?.length) && (snap.seq == null || snap.seq >= shownSeq)) {
    peel(before, snap);
    return;
  }
  if (snap.seq != null) {
    // A newer state is already on screen (results can arrive out of order).
    if (snap.seq < shownSeq) { pace(); return; }
    shownSeq = snap.seq;
    turnEnds = snap.turnMsLeft != null ? (clockStopped || Date.now()) + num(snap.turnMsLeft) : 0;
  }
  state = mode === 'solo' ? snap.state : withStatIds(snap.state);
  gameSounds();
  botToAct = snap.botToAct;
  // A finished hand, for a club player's hand history (#71).
  const hn = num(snap.state.hand_number);
  if (handHook && snap.state.complete && hn && hn !== hookedHand) { hookedHand = hn; handHook(snap.state); }
  recordStats();
  startReview();
  ladderCheck();
  ladderKeep(state);
  regularsCheck();
  if (armRunChoice()) return;
  if (state.complete || state.seats[0].folded) foldQueued = false;
  // A queued fold folds when facing a bet, and checks (staying queued) when
  // it's free to see more cards.
  const L = state.legal;
  const auto = foldQueued && L ? (L.can_fold ? 'fold' : L.can_check ? 'check' : null) : null;
  if (L && !auto) foldQueued = false;
  render();
  armDeal();
  if (!auto) { turnChime(); pace(); return; }
  act(auto).then(ok => { if (!ok) { foldQueued = false; render(); } });
}

// The player can queue a fold while someone else is to act in a hand they're
// still in.
function canPrefold() {
  const me = state.seats[0];
  return !state.legal && !state.complete && !me.folded && !me.all_in && !me.sitting_out && !me.empty;
}

// Whether checking is free for the player right now (e.g. the big blind,
// unraised): then a queued fold checks, so it's offered as Check/Fold.
function checkIsFree() {
  return num(state.seats[0].street_bet) >= num(state.current_bet);
}

function togglePrefold() {
  foldQueued = !foldQueued && canPrefold();
  render();
}

// Downloads (the first time) and loads the GTO bot's files in the worker.
async function prepareGto(bots = setup.bots) {
  const plo = Object.values(GTO_PLOS).find(p => bots.includes(p.bot.id));
  if (plo ? plo.ready : (gtoReady || !bots.includes(GTO.id))) return true;
  root.innerHTML = `<div class="pl-wrap"><p class="pl-meta">Loading the GTO bot (about ${plo ? 2 : 3} MB the first time, then it’s kept on this device)…</p></div>`;
  try { navigator.storage?.persist?.(); } catch {}
  try {
    if (plo) {
      await call(plo.load, plo.manifest, GTO_BUY_IN_BB);
      plo.ready = true;
    } else {
      await call('loadGto', GTO_MANIFEST);
      gtoReady = true;
    }
    return true;
  } catch (e) {
    console.warn(e);
    setupNote = 'The GTO bot couldn’t be loaded. Try again, or pick another opponent.';
    return false;
  }
}

// ---- Play the Regulars (#225) ----
// A 6-handed table of random Regulars run like a card room (regulars.js):
// between hands each tops up from a bankroll of three buy-ins, and one who
// has lost it all leaves for a new one. You rebuy or top up when you choose.
let regulars = null; // {bank, buyIn, done, pending} at a Regulars table
let regularsNote = ''; // who left and who sat down, after the last hand

async function sitRegulars() {
  setupNote = '';
  setup.count = REGULARS_SEATS;
  setup.bots = pickRegulars(personalities.map(p => p.id), REGULARS_SEATS);
  saveSetup();
  ladder = null;
  // A bomb pot table has its own fixed amounts.
  const g = gameOf(setup.game);
  const {sb, bb, buyIn} = g.bomb ? g : setup;
  await sitDown({bots: setup.bots, game: setup.game, buyIn, sb, bb, gto: false, regs: true});
}

const regularName = id => personalities.find(p => p.id === id)?.name || id;

// A hand just finished at a Regulars table: top up the Regulars who need it
// and replace the ones who are out, or who just got up to go (regulars.js
// LEAVE_CHANCE), once per hand. nextHand waits for it.
function regularsCheck() {
  if (!regulars || mode !== 'solo' || !state?.complete) return;
  const hn = num(state.hand_number);
  if (!hn || hn === regulars.done) return;
  regulars.done = hn;
  regulars.pending = regularsBetween().catch(e => console.warn(e));
}

async function regularsBetween() {
  const r = betweenHands({
    stacks: state.seats.map(x => num(x.stack)), bank: regulars.bank, bots: tableBots,
    buyIn: regulars.buyIn, all: personalities.map(p => p.id),
  });
  for (const {seat, chips} of r.sets) await call('setStack', seat, chips);
  const notes = [];
  const seated = [...tableBots];
  for (const sw of r.swaps) {
    if (await call('setBot', sw.seat, sw.id, sw.chips, crypto.getRandomValues(new Uint32Array(1))[0])) {
      seated[sw.seat - 1] = sw.id;
      notes.push(`${regularName(sw.from)} left. ${regularName(sw.id)} sat down.`);
    } else {
      // An older ducy-wasm can't change who sits there: the same Regular
      // buys in again.
      await call('setStack', sw.seat, sw.chips);
    }
  }
  tableBots = seated;
  regulars.bank = r.bank;
  regularsNote = notes.join(' ');
  if (notes.length) render();
}

// Rebuy (out of chips) or top up (below a buy-in) to a full buy-in.
async function rebuy() {
  if (!regulars || !state?.complete) return;
  if (regulars.pending) await regulars.pending;
  await call('setStack', 0, regulars.buyIn);
  state.seats[0].stack = regulars.buyIn;
  regularsNote = '';
  render();
  armDeal();
}

async function startTable() {
  setupNote = '';
  if (!await prepareGto()) { render(); return; }
  saveSetup();
  ladder = null;
  const gto = setup.bots.length === 1 && setup.bots[0] === gtoBot()?.id;
  // A bomb pot table has its own fixed amounts.
  const g = gameOf(setup.game);
  const {sb, bb} = g.bomb ? g : setup;
  const buyIn = gto ? GTO_BUY_IN_BB * setup.bb : g.bomb ? g.buyIn : setup.buyIn;
  await sitDown({bots: setup.bots, game: setup.game, buyIn, sb, bb, gto});
}

// Sits down at a new bot table and deals its first hand. `gto` is GTO
// training (every hand at 100 BB, with the review in Hold'em).
// `stacks`, when given, are each seat's chips for the first hand (a ladder
// game resuming), instead of the buy-in.
async function sitDown({bots, game, buyIn, sb, bb, gto, stacks = null, regs = false}) {
  clearTimeout(timer);
  regulars = regs ? {bank: startBank(bots, buyIn), buyIn, done: 0, pending: null} : null;
  regularsNote = '';
  cancelDeal();
  lastSummary = null;
  tableGame = gameOf(game);
  tableBots = [...bots];
  mode = 'solo';
  seated = true;
  raiseTo = 0;
  holds.delete('user');
  foldQueued = false;
  // A new table numbers its hands from 1 again: an answer about running it
  // twice at the last table mustn't count here (a ladder game would stall).
  myRunAnswer = null;
  sessionStats = {};
  recordedHand = 0;
  gtoTable = gto;
  review = null;
  live = {hand: 0, items: []};
  sessionReview = emptyTotals();
  const snap = await request('create', bots, buyIn, sb, bb, crypto.getRandomValues(new Uint32Array(1))[0], game, stacks);
  // At a Regulars table nothing tops you up: you rebuy when you choose.
  if (snap && regulars) await call('setTopUp', false);
  if (snap) show(snap);
}

async function nextHand() {
  if (mode === 'guest') return; // the host deals
  if (mode === 'host' && hostInfo.playersIn < 2) return; // no one to deal to
  // A ladder game that's over deals no more (ladder-next goes on).
  if (ladder?.over) return;
  // A Regulars table: the seats are settled first, and you need chips.
  if (mode === 'solo' && regulars) {
    if (regulars.pending) await regulars.pending;
    if (state && !num(state.seats[0].stack)) {
      regularsNote = 'You’re out of chips. Rebuy to keep playing.';
      cancelDeal();
      render();
      return;
    }
  }
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
  if (!open || !seated || !state || !state.complete || !autoDealOn() || holds.size || mode === 'guest' || !num(state.hand_number) || ladder?.over) { syncDeal(); return; }
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
  if (!autoDealOn()) return 'Next hand';
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
  // Asked for before the bot's turn, so it grades this decision; the worker
  // answers it first, inside the bot's minimum wait.
  startLive(snap.state);
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
      // The game's name, now that it can go encrypted (#152).
      if (hostTitle) sendToGuest(client, {type: 'table', name: hostTitle});
      return;
    }
    // Chat never reaches the table engine (table-chat.js).
    if (data?.type === 'chat') { await hostChat(client, g, data); return; }
    // The name a guest joined with is the one on their chat lines.
    if (data?.type === 'join') g.name = chatName(data.name);
    hostEvent('hostHandle', client, data);
  }).catch(e => console.warn(e));
}

// A guest's chat message: opened with their key, checked, and sent on to
// everyone with their name on it. Only someone who has joined can chat, and
// only a few messages at a time.
async function hostChat(client, g, data) {
  if (!g.key || !g.name || !data.enc) return;
  let body;
  try { body = await openBox(g.key, data.enc); } catch { return; }
  const text = cleanChat(body?.text);
  if (!text || !chatLimit.allow(client)) return;
  postChat({from: g.name, text, at: Date.now()});
}

// The host posts a chat line: on its own screen, and to every guest.
function postChat(msg) {
  addChatLine(msg);
  for (const [to, g] of e2eHost?.guests || []) if (g.key) sendToGuest(to, {type: 'chat', ...msg});
}

function addChatLine(msg) {
  chat = addChat(chat, msg);
  if (setup.chat === false) chatUnread++;
  syncChat();
}

// Sends what's typed in the chat box.
async function sendChat() {
  const box = chatEl?.querySelector('input');
  const text = cleanChat(box?.value);
  if (!text) return;
  if (!myChatLimit.allow('me')) { chatNote = 'Slow down a little: a few messages at a time.'; syncChat(); return; }
  chatNote = '';
  if (mode === 'host') {
    box.value = '';
    postChat({from: chatName(setup.name), text, at: Date.now()});
    return;
  }
  // A guest's goes to the host, which sends it back to everyone, us too.
  if (!e2eGuest?.aes) { chatNote = 'Not connected to the table yet.'; syncChat(); return; }
  box.value = '';
  net?.send({type: 'chat', enc: await seal(e2eGuest.aes, {text})});
  syncChat();
}

// Chat is for friends tables: the host and players who joined with the code.
const chatTable = () => mode === 'host' || (mode === 'guest' && joinedByCode && !watching);

function resetChat() {
  chat = [];
  chatUnread = 0;
  chatNote = '';
  chatLimit = chatLimiter();
  myChatLimit = chatLimiter();
  const box = chatEl?.querySelector('input');
  if (box) box.value = '';
}

// The chat panel sits next to the table rather than in it: the table is
// redrawn on every update, which would take the typing box away from
// whoever is typing. On a wide screen it floats at the bottom right; on a
// phone it comes after the table. Its header hides and shows it.
let chatEl = null;
let chatShown = null; // the messages the panel shows

function syncChat() {
  const on = open && seated && !!state && view === 'play' && chatTable();
  document.body.classList.toggle('pl-chat-on', on);
  document.body.classList.toggle('pl-chat-shut', setup.chat === false);
  if (!on) { if (chatEl) chatEl.hidden = true; return; }
  if (!chatEl) {
    chatEl = document.createElement('section');
    chatEl.className = 'pl-chat';
    chatEl.setAttribute('aria-label', 'Table chat');
    chatEl.innerHTML = '<button type="button" class="pl-chat-head" data-chat="toggle"></button>'
      + '<div class="pl-chat-body"><div class="pl-chat-log" aria-live="polite"></div>'
      + `<form class="pl-chat-send"><input type="text" maxlength="${CHAT_MAX}" placeholder="Message the table" autocomplete="off" enterkeyhint="send" aria-label="Chat message">`
      + '<button class="cc-btn" type="submit">Send</button></form><p class="pl-chat-note" hidden></p></div>';
    chatEl.addEventListener('submit', e => { e.preventDefault(); sendChat(); });
    chatEl.addEventListener('click', e => {
      if (!e.target.closest('[data-chat="toggle"]')) return;
      setup.chat = setup.chat === false;
      if (setup.chat) chatUnread = 0;
      saveSetup();
      syncChat();
      if (setup.chat) chatEl.querySelector('input')?.focus();
    });
    root.after(chatEl);
    chatShown = null;
  }
  chatEl.hidden = false;
  const shut = setup.chat === false;
  chatEl.classList.toggle('shut', shut);
  const head = chatEl.querySelector('.pl-chat-head');
  head.textContent = shut ? `Chat${chatUnread ? ` · ${chatUnread} new` : ''}` : 'Chat';
  head.setAttribute('aria-expanded', String(!shut));
  head.classList.toggle('unread', shut && chatUnread > 0);
  const note = chatEl.querySelector('.pl-chat-note');
  note.textContent = chatNote;
  note.hidden = !chatNote;
  if (chatShown !== chat) {
    const log = chatEl.querySelector('.pl-chat-log');
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.innerHTML = chat.length
      ? chat.map(m => `<div><b>${esc(m.from)}</b> ${esc(m.text)}</div>`).join('')
      : '<div class="pl-chat-empty">Nothing yet. Say hello to the table.</div>';
    if (atEnd || chatShown === null) log.scrollTop = log.scrollHeight;
    chatShown = chat;
  }
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
  fnote = readFriendsStep();
  if (fnote) { render(); return; }
  setupNote = '';
  const f = setup.friends;
  forgetSavedTable();
  startHosting(newCode(), f.game);
  hostTitle = f.title || `${setup.name}’s game`;
  fstep = 1;
  // The host starts with 100 BB, kept within the table's limits.
  const min = Math.round(f.minBB * f.bb), max = Math.round(f.maxBB * f.bb);
  const hostChips = Math.max(min, Math.min(max, 100 * f.bb));
  request('friends', Math.min(f.seats, maxSeats(f.game)), setup.name, hostChips, min, max, f.sb, f.bb, crypto.getRandomValues(new Uint32Array(1))[0], f.game, FRIENDS_TURN_SECS * 1000)
    .then(snap => { if (snap) show(snap); });
  // The table shows on the Play tab.
  location.hash = 'play';
}

// Hosting a friends table with code `code`: the relay connection, keys and
// clocks, for a new table (hostTable) or one resumed (resumeHosting).
function startHosting(code, game) {
  tableGame = gameOf(game);
  hostGame = game;
  mode = 'host';
  hostInfo = {playersIn: 1, chipRequests: [], buyIn: null, hostPendingChips: 0};
  resetChat();
  gtoTable = false;
  review = null;
  live = {hand: 0, items: []};
  myRunAnswer = null;
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
    await putTable(...SAVED, {json, room, game: hostGame, title: hostTitle, seq: r.seq, at: Date.now()});
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
  hostTitle = rec.title || '';
  location.hash = 'play';
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

// Joins the friends table `code` as `name` (the Join tab). `hostId`, from
// the link, is the host's player ID the table's encryption key is checked
// against. The table then shows on the Play tab; if joining fails, the Join
// tab says why.
export function joinTable({code, name, hostId = ''}) {
  if (seated) leaveTable();
  setup.name = String(name || '').trim().slice(0, 20);
  saveSetup();
  startGuest(code);
  joinedByCode = true;
  const mine = session;
  e2eGuest = {keys: newKeyPair(), aes: null, aesFor: '', hostId, inbox: Promise.resolve()};
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
  startClock();
  if (location.hash !== '#play') location.hash = 'play';
  else render();
}
let joinedByCode = false; // at a table joined with its code (joinTable)

// Where the table you're at belongs in the navigation (#209): bots under
// Train, a friends table under Play, a club's table under Clubs; null when
// you're not at one.
export const tableGroup = () => (!seated ? null : mode === 'solo' ? 'train' : mode === 'host' || joinedByCode ? 'play' : 'clubs');

// The name this browser plays friends tables as (Player settings, #144).
export const tableName = () => setup.name;
export function setTableName(n) {
  setup.name = String(n || '').trim().slice(0, 20);
  saveSetup();
  render();
}

// Table settings shown on the You page (player-settings.js, V3 #225), and a
// way to change each: auto-deal and sounds on or off, run it twice cycling
// ask, always, never.
export const tablePrefs = () => ({autoDeal: !!setup.autoDeal, runTwice: RUN_PREFS.includes(setup.runTwice) ? setup.runTwice : 'ask', sounds: !!setup.sounds, gameSounds: !!setup.gameSounds});
export function cycleTablePref(key) {
  if (key === 'autoDeal') setup.autoDeal = !setup.autoDeal;
  else if (key === 'sounds') setup.sounds = !setup.sounds;
  else if (key === 'gameSounds') setup.gameSounds = !setup.gameSounds;
  else if (key === 'runTwice') setup.runTwice = RUN_PREFS[(RUN_PREFS.indexOf(tablePrefs().runTwice) + 1) % RUN_PREFS.length];
  saveSetup();
  render();
}

// Your seat's avatar, picked in Player settings: one of PLAYER_AVATARS, or ''.
export const tableAvatar = () => (PLAYER_AVATARS.some(a => a.id === setup.avatar) ? setup.avatar : '');
export function setTableAvatar(id) {
  setup.avatar = PLAYER_AVATARS.some(a => a.id === id) ? id : '';
  saveSetup();
  render();
}

// Sits down at a table reached some other way than a table code: a club
// table (clubs.js). `open(handlers)` returns {send(command), close()} and
// calls handlers.onMessage(update) for each update from the table's host,
// handlers.onStatus(text) and handlers.onFail(reason). Leaving the table
// calls `onLeave`.
let leaveHook = null;
// With `watch`, only watch the table (a club host, #73): no seat, nothing to
// act on, and the hands aren't added to your stats.
export function joinTableVia(open, {label = '', onLeave = null, watch = false, onHand = null, whole = false} = {}) {
  if (seated) leaveTable();
  startGuest(label);
  wholeChips = whole;
  watching = watch;
  handHook = onHand;
  hookedHand = 0;
  leaveHook = onLeave;
  // Shows the clubs' testing notice above the table (style.css).
  document.body.classList.add('club-table');
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
  resetChat();
  wholeChips = false;
  joinedByCode = false;
  myChips = null;
  mySeat = null;
  chipAsk = 0;
  gtoTable = false;
  review = null;
  live = {hand: 0, items: []};
  sessionStats = {};
  recordedHand = 0;
  room = code;
  tableTitle = '';
  fairCheck = null;
  netNote = 'Connecting…';
  shownSeq = -1;
  seated = true;
  state = null;
  lastView = null;
  raiseTo = 0;
  foldQueued = false;
}

function guestMessage(m) {
  if (m.type === 'table') { tableTitle = String(m.name || '').slice(0, 40); render(); return; }
  if (m.type === 'chat') { const msg = readChat(m); if (msg && chatTable()) addChatLine(msg); return; }
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

// Your answer to running it twice.
async function runChoice(yes) {
  if (mode === 'guest') {
    net?.send({type: 'run_twice', yes});
    mySeat = {...mySeat, run_twice: yes};
    render();
    return;
  }
  myRunAnswer = {hand: num(state.hand_number), yes};
  render();
  const snap = await request('runTwice', yes);
  if (snap) show(snap);
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

// Ticks the turn clocks on screen, and sounds the alert when 5 seconds
// are left to act.
function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    for (const el of root.querySelectorAll('[data-clock]')) el.textContent = clockText();
    for (const el of root.querySelectorAll('[data-outclock]')) el.textContent = outClockText();
    hurryAlert();
  }, 250);
}

// Sounds at every table, bots' too, while it's this person's turn (not while
// watching).
const soundsOn = () => setup.sounds && !watching;
const myTurn = () => !!state?.legal && !state.complete;

// Game sounds (a setting apart from the alerts): the shuffle as a hand is
// dealt, chips for each bet, raise or call (a stack for an all-in), a flick
// for each board card, and the pot pushed to its winner, in that order when
// one update brings several.
let soundSeen = {hand: '', events: 0};
function gameSounds() {
  if (!state) return;
  const hand = `${session}:${num(state.hand_number)}`;
  const events = state.events || [];
  if (hand !== soundSeen.hand) {
    // A new hand (or table): the shuffle; what's already happened in it
    // stays quiet.
    soundSeen = {hand, events: events.length};
    if (num(state.hand_number) && setup.gameSounds) shuffleSound();
    return;
  }
  // Fewer events than before: a reveal step going back, nothing new.
  const fresh = events.slice(soundSeen.events);
  soundSeen.events = Math.max(soundSeen.events, events.length);
  if (!setup.gameSounds || !fresh.length) return;
  let chips = 0, cards = 0, pot = false;
  for (const e of fresh) {
    if (e.type === 'bet' || e.type === 'raise' || e.type === 'call') chips = Math.max(chips, e.all_in ? 4 : e.type === 'call' ? 1 : 2);
    else if (e.type === 'board' || e.type === 'second_board') cards += e.cards?.length || 1;
    else if (e.type === 'award') pot = true;
  }
  let at = 0;
  const later = (ms, fn) => (ms ? setTimeout(fn, ms) : fn());
  if (chips) { chipsSound(chips); at += 220; }
  if (cards) { later(at, () => cardSound(cards)); at += 120 * cards + 100; }
  if (pot) later(at, () => potSound(num(state.seats[0]?.won) > 0));
}

// A chime once when the turn comes to this person.
function turnChime() {
  if (!myTurn()) { soundTurn = ''; return; }
  const key = `${num(state.hand_number)}:${state.events?.length ?? 0}`;
  if (key === soundTurn) return;
  soundTurn = key;
  hurried = 0;
  if (soundsOn()) turnSound();
}

// The alert once, when 5 seconds are left on this person's turn clock.
function hurryAlert() {
  // Once per deadline; the deadline moves a little with each update, so only
  // a real extension (a time bank) counts as a new one.
  if ((hurried && turnEnds <= hurried + 2000) || !soundTurn || !myTurn() || !turnEnds || clockStopped) return;
  const left = turnEnds - Date.now();
  if (left > HURRY_MS || left <= 0) return;
  hurried = turnEnds;
  if (soundsOn()) hurrySound();
}

// The time bank (at a friends or club table with a turn clock): on your
// turn, a button adds what's in it to your clock; what you don't use goes
// back in, and each hand puts 5 s back, up to a minute.
function timeBankHtml() {
  if (mode !== 'guest' || watching || !turnEnds || mySeat?.time_bank_ms == null) return '';
  if (mySeat.time_bank_on) return ' <span class="pl-meta pl-bank on">· time bank on</span>';
  const secs = Math.floor(num(mySeat.time_bank_ms) / 1000);
  if (secs < 1) return ' <span class="pl-meta pl-bank">· time bank empty</span>';
  return ` <button class="btn-small pl-bank" data-act="timebank" title="Add your time bank to your clock; what you don’t use goes back">Time bank +${secs}s <kbd>T</kbd></button>`;
}

function useTimeBank() {
  if (mode === 'guest' && mySeat?.time_bank_ms > 0 && !mySeat.time_bank_on) net?.send({type: 'time_bank'});
}

function clockText() {
  if (!turnEnds) return '';
  const left = Math.max(0, Math.ceil((turnEnds - (clockStopped || Date.now())) / 1000)) + 's';
  return clockStopped ? left + ' (paused)' : left;
}

function leaveTable(note = '') {
  ladderLeave();
  wholeChips = false;
  lastSummary = null;
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
  const byCode = joinedByCode;
  joinedByCode = false;
  errView = note ? (byCode ? 'join' : view) : null;
  document.body.classList.remove('club-table');
  if (hook) hook(note);
  // Joining with a code didn't work: back to the Join tab, which says why.
  if (!hook && byCode && note && location.hash !== '#join') location.hash = 'join';
  // Redraw even when the address stays the same (a club table's onLeave
  // goes to #play, often already there).
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

// A seat's avatar: yours as picked in Player settings, a bot's main look by
// its personality id. Anyone else (the GTO bot, other people at a friends or
// club table) gets the first letter of their name.
function avatarHtml(i) {
  const id = i === 0 && !watching ? tableAvatar() : mode === 'solo' && BOT_AVATARS.has(seatId(i)) ? seatId(i) : '';
  if (id) return `<div class="pl-av"><img src="${avatarUrl(id)}" alt=""></div>`;
  const letter = [...String(state.seats[i].name || '?').trim()][0] || '?';
  return `<div class="pl-av none" aria-hidden="true">${esc(letter.toUpperCase())}</div>`;
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
    case 'small_blind': return `${who} ${v('post')} the small blind ${c(e.amount)}`;
    case 'big_blind': return `${who} ${v('post')} the big blind ${c(e.amount)}`;
    // Coming back after sitting out (#70): missed blinds, dead and live.
    case 'post': return `${who} ${v('post')} missed blinds: ${[num(e.dead) && `${c(e.dead)} dead`, num(e.live) && `${c(e.live)} live`].filter(Boolean).join(' + ')}`;
    case 'ante': return `${who} ${v('ante')} ${c(e.amount)}`;
    case 'fold': return `${who} ${v('fold')}`;
    case 'check': return `${who} ${v('check')}`;
    case 'call': return `${who} ${v('call')} ${c(e.amount)}${allIn}`;
    case 'bet': return `${who} ${v('bet')} ${c(e.to)}${allIn}`;
    case 'raise': return `${who} ${v('raise', 'raises')} to ${c(e.to)}${allIn}`;
    case 'board': return `${String(e.street)}: ${e.cards.join(' ')}`;
    case 'runs': return e.count === 2 ? 'Running it twice' : 'Running it once';
    case 'second_board': return `${tableGame.bomb ? 'Board 2' : 'Second run'}: ${e.cards.join(' ')}`;
    case 'award': return `${who} ${v('win')} ${c(e.amount)}${e.pot > 0 ? ' (side pot)' : ''}`;
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

// Whose cards are turned over at a showdown, as at a real table: first the
// last player to bet or raise on the last street with betting (or, when that
// street was checked through, the first to act on it), then anyone who wins
// something. The others muck, and their cards stay face down. Your own cards
// always show to you, and in tournament-style games (the ladder, club
// tournaments) all-in hands, turned up before the runout, stay up. Null when
// it isn't a showdown, so every card the state holds shows.
function showdownShows(s) {
  if (!s?.showdown) return null;
  let street = 0, bettor = null, betStreet = -1, actStreet = -1;
  const firstActor = [];
  for (const e of s.events) {
    if (e.type === 'board') { street += 1; continue; }
    if (e.seat == null || !['fold', 'check', 'call', 'bet', 'raise'].includes(e.type)) continue;
    firstActor[street] ??= e.seat;
    actStreet = street;
    if (e.type === 'bet' || e.type === 'raise') { bettor = e.seat; betStreet = street; }
  }
  const show = new Set();
  const first = betStreet === actStreet ? bettor : firstActor[actStreet];
  if (first != null) show.add(first);
  s.seats.forEach((x, i) => {
    if (num(x.won) > 0) show.add(i);
    if ((ladder || wholeChips) && x.all_in) show.add(i);
  });
  if (!watching) show.add(0);
  return show;
}

// ---- the hand's summary ----
//
// After a hand, a short account of what happened beside the table: who won
// each pot and with what, the hands shown down (in words, on each board
// when it ran twice), and everyone's result. On a wide screen the last
// hand's summary stays up while the next one is played, marked "Last hand";
// on a narrow one it shows under the table between hands, and during the
// next hand as one line ("Last hand 12: Ann won 15 with Pair of 8s") that
// opens to the whole summary.
let lastSummary = null; // {hand, html, line}
let lastSummaryOpen = false; // the one-line version opened, kept from hand to hand
let tableMenuOpen = false; // the table's ⋯ menu, kept open across redraws

// A pot's awards, one per winner: run twice or on two boards, someone who
// wins both halves is named once, with the whole amount.
function winners(p) {
  const out = [];
  for (const a of p.awards) {
    const w = out.find(x => x.seat === a.seat);
    if (w) w.amount = num(w.amount) + num(a.amount);
    else out.push({...a});
  }
  return out;
}
// Two boards: run twice, or a bomb pot's. A pot's winning hand is then only
// the first board's; the hands on each are listed with the showdown instead.
const twoBoards = s => s.second_board?.length === 5;

// The summary in one line: who won the (main) pot, how, and your result.
// On two boards, one player winning both "scooped" it.
function summaryLine(s) {
  const who = i => (i === 0 && !watching ? 'You' : esc(s.seats[i]?.name || `Seat ${i}`));
  const pots = (s.pots || []).filter(p => p.awards?.length);
  const contested = pots.filter(p => p.eligible.length > 1);
  let line = '';
  if (s.showdown && contested.length) {
    const p = contested[0];
    const cards = i => (s.seats[i]?.cards?.length && s.seats[i].cards.every(Boolean) ? ` ${s.seats[i].cards.map(smallCard).join('')}` : '');
    const won = winners(p);
    const names = won.map(a => `${who(a.seat)}${cards(a.seat)}`).join(' and ');
    line = `${names} ${won.length > 1 ? 'split' : twoBoards(s) ? 'scooped' : 'won'} ${c(p.amount)}`;
    if (p.winning_hand && !twoBoards(s)) line += ` with ${esc(handText(p.winning_hand) || p.winning_hand)}`;
    if (contested.length > 1) line += `, and ${contested.length - 1} side pot${contested.length > 2 ? 's' : ''}`;
  } else if (pots.length) {
    const a = pots[0].awards[0];
    line = `${who(a.seat)} won ${c(a.amount)}, uncontested`;
  }
  const me = !watching && s.seats[0] && num(s.seats[0].net);
  if (me) line += ` · you ${me > 0 ? '+' : '−'}${c(Math.abs(me))}`;
  return line;
}

const smallCard = c => `<span class="pl-sc s-${c[1]}${c[1] === 'h' || c[1] === 'd' ? ' r' : ''}">${c[0] === 'T' ? '10' : c[0]}${SUITS[c[1]]}</span>`;

function summaryBody(s) {
  const who = i => (i === 0 && !watching ? 'You' : esc(s.seats[i]?.name || `Seat ${i}`));
  const words = hand => (hand ? esc(handText(hand) || hand) : '');
  // A winner's cards, when they were shown down.
  const holeOf = i => (s.showdown && s.seats[i]?.cards?.length && s.seats[i].cards.every(Boolean) ? ` <span class="pl-sum-cards">${s.seats[i].cards.map(smallCard).join('')}</span>` : '');
  let h = `<div class="pl-sum-head"><b>Hand ${num(s.hand_number)}</b></div>`;
  // The board (each run's, when it ran twice), on its own rows.
  const [one, two] = tableGame.bomb ? ['Board 1', 'Board 2'] : ['Run 1', 'Run 2'];
  const boards = s.second_board?.length ? [[one, s.board], [two, s.second_board]] : [['Board', s.board]];
  for (const [label, cards] of boards) {
    if (cards?.length) h += `<div class="pl-sum-boardrow"><span class="pl-sum-label">${label}</span><span class="pl-sum-board">${cards.map(smallCard).join('')}</span></div>`;
  }

  // Who won what. A pot only one player could win is an uncalled bet coming
  // back, or a pot everyone else folded to.
  const pots = (s.pots || []).filter(p => p.awards?.length);
  const contested = pots.filter(p => p.eligible.length > 1);
  h += '<ul class="pl-sum-pots">';
  if (!s.showdown) {
    for (const p of pots) for (const a of p.awards) h += `<li><b>${who(a.seat)}</b> ${a.seat === 0 && !watching ? 'win' : 'wins'} ${c(a.amount)}, uncontested</li>`;
  } else {
    contested.forEach((p, k) => {
      const label = contested.length > 1 ? (k === 0 ? 'Main pot' : `Side pot ${k}`) : 'Pot';
      const won = winners(p);
      const names = won.map(a => `<b>${who(a.seat)}</b>${holeOf(a.seat)}`);
      const split = won.length > 1 ? ` split ${won.map(a => `${who(a.seat)} ${c(a.amount)}`).join(', ')}`
        : twoBoards(s) ? ` ${won[0].seat === 0 && !watching ? 'scoop' : 'scoops'} both ${tableGame.bomb ? 'boards' : 'runs'}` : '';
      const hand = p.winning_hand && !twoBoards(s) ? ` <span class="pl-sum-hand">with ${words(p.winning_hand)}</span>` : '';
      h += `<li>${label} ${c(p.amount)}: ${names.join(' and ')}${split}${hand}</li>`;
    });
    for (const p of pots.filter(x => x.eligible.length === 1)) {
      for (const a of p.awards) h += `<li class="pl-meta">${who(a.seat)} ${a.seat === 0 && !watching ? 'get' : 'gets'} ${c(a.amount)} back, uncalled</li>`;
    }
  }
  h += '</ul>';

  // The hands shown down: each player's cards and what they made, winners
  // marked. When it ran twice, what they made on each run.
  const shows = showdownShows(s);
  const inHand = x => x.cards?.length && x.cards.every(Boolean) && !x.folded && !x.empty && !x.sitting_out;
  const all = s.seats.map((x, i) => ({...x, i})).filter(inHand);
  const shown = all.filter(x => (shows ? shows.has(x.i) : x.i === 0 && !watching));
  const mucked = shows ? all.filter(x => !shows.has(x.i)) : [];
  if (shown.length) {
    const won = new Set(pots.flatMap(p => (p.eligible.length > 1 ? p.awards.map(a => a.seat) : [])));
    h += `<div class="pl-sum-label">${s.showdown ? 'Showdown' : 'Your hand'}</div><ul class="pl-sum-shown">`;
    for (const x of shown) {
      const first = handWords(x.cards, s.board);
      const second = s.second_board?.length === 5 ? handWords(x.cards, s.second_board) : null;
      const name = second && second !== first ? `${esc(first || '')} / ${esc(second)}` : esc(first || '');
      const mark = s.showdown && won.has(x.i);
      h += `<li${mark ? ' class="won"' : ''}><span class="pl-sum-who">${who(x.i)}</span><span class="pl-sum-cards">${x.cards.map(smallCard).join('')}</span>${name || mark ? `<span class="pl-sum-hand">${name}${mark ? ' <span class="pl-sum-won" title="Won">✓ won</span>' : ''}</span>` : ''}</li>`;
    }
    for (const x of mucked) h += `<li class="pl-meta"><span class="pl-sum-who">${who(x.i)}</span><span class="pl-sum-hand">mucked</span></li>`;
    h += '</ul>';
  }

  // Everyone's result, biggest win first.
  const results = s.seats.map((x, i) => ({i, net: num(x.net)})).filter(r => r.net !== 0).sort((a, b) => b.net - a.net);
  if (results.length) {
    h += `<div class="pl-sum-nets">${results.map(r => `<span class="${r.net > 0 ? 'up' : 'down'}">${who(r.i)} ${r.net > 0 ? '+' : '−'}${c(Math.abs(r.net))}</span>`).join('')}</div>`;
  }
  return h;
}

function summaryHtml() {
  const s = state;
  const done = s?.complete && num(s.hand_number) > 0;
  if (done && lastSummary?.hand !== num(s.hand_number)) lastSummary = {hand: num(s.hand_number), html: null, line: ''};
  if (done) { lastSummary.html = summaryBody(s); lastSummary.line = summaryLine(s); }
  if (!lastSummary?.html) return '';
  const label = `What happened in hand ${lastSummary.hand}`;
  if (done) return `<aside class="pl-summary now" aria-label="${label}">${lastSummary.html}</aside>`;
  // During the next hand: the whole summary beside the table (wide
  // screens), or one line that opens to it (narrow ones).
  return `<aside class="pl-summary last" aria-label="${label}">` +
    `<div class="pl-sum-full"><div class="pl-sum-label">Last hand</div>${lastSummary.html}</div>` +
    `<details class="pl-sum-compact"${lastSummaryOpen ? ' open' : ''}><summary><b>Last hand ${lastSummary.hand}:</b> ${lastSummary.line}</summary>${lastSummary.html}</details>` +
    '</aside>';
}

function renderTable() {
  const s = state, n = s.seats.length;
  const last = lastActions();
  const shows = showdownShows(s);
  let h = '<div class="pl-wrap pl-play">';
  h += '<div class="pl-bar">';
  const stakes = tableGame.bomb ? `ante ${c(s.ante ?? tableGame.bb)}` : `blinds ${c(s.small_blind ?? setup.sb)}/${c(s.big_blind ?? setup.bb)}`;
  h += ladder ? ladderBarHtml() : `<span class="pl-meta">${tableGame.name} · hand ${num(s.hand_number)} · ${stakes}</span>`;
  if (mode !== 'solo') h += netBarHtml();
  // V3 (#225): the table's settings in one ⋯ menu, and Leave beside it.
  const item = (act, label, on, title = '') =>
    `<button type="button" class="pl-menu-item" data-act="${act}"${on == null ? '' : ` aria-pressed="${on}"`}${title ? ` title="${title}"` : ''}><span>${label}</span>${on == null ? '' : `<b>${on ? 'On' : 'Off'}</b>`}</button>`;
  h += '<span class="pl-tools">';
  h += `<details class="pl-menu"${tableMenuOpen ? ' open' : ''}><summary aria-label="Table settings">⋯</summary><div class="pl-menu-list">`;
  h += item('autodeal', 'Auto-deal', autoDealOn());
  if (autoDealOn()) h += `<button type="button" class="pl-menu-item" data-act="dealdelay" title="Wait before the next hand"><span>Wait before dealing</span><b>${setup.dealSecs}s</b></button>`;
  if (!ladder && !watching) h += `<button type="button" class="pl-menu-item" data-act="runpref" title="When everyone’s all-in: ask each time (once after ${RUN_SECS} seconds), or always run it twice, or always once"><span>Run it twice</span><b>${RUN_LABELS[runPref()].replace('Run twice: ', '')}</b></button>`;
  if (reviewTable() && mode === 'solo') {
    h += item('live', 'Live feedback', !!setup.live, 'Grade each decision against the GTO bot as soon as you make it');
    h += item('review', 'Hand review', !!setup.review, 'Grade your decisions against the GTO bot after each hand');
  }
  h += item('hud', 'Stats on seats', !!setup.hud);
  h += item('stats', 'Stats table', statsOpen);
  if (!watching) h += item('sounds', 'Alerts', !!setup.sounds, 'A chime when it’s your turn, and an alert at 5 seconds left');
  h += item('gamesounds', 'Game sounds', !!setup.gameSounds, 'Chips when someone bets, cards dealt, the shuffle, and the pot pushed to the winner');
  h += '</div></details>';
  h += `<button class="pl-leave" data-act="leave">${watching ? 'Stop watching' : 'Leave'}</button></span></div>`;
  h += '<div class="pl-felt">';
  // During an all-in runout, the slots about to be dealt pulse.
  const slot = (run, i) => {
    const [r, a, b] = (peeling && s.peelNext) || [];
    return `<span class="pl-card slot${r === run && i >= a && i < b ? ' next' : ''}"></span>`;
  };
  h += `<div class="pl-center"><div class="pl-board">${[0, 1, 2, 3, 4].map(i => (s.board[i] ? cardHtml(s.board[i]) : slot(1, i))).join('')}</div>`;
  // Run twice: the second board, each pot split between the two.
  // (Mid-runout it shows empty too, while its first cards are coming.)
  if (s.second_board?.length || (peeling && s.peelNext?.[0] === 2)) h += `<div class="pl-board pl-board2" title="${tableGame.bomb ? 'Board 2' : 'The second run'}">${[0, 1, 2, 3, 4].map(i => (s.second_board[i] ? cardHtml(s.second_board[i]) : slot(2, i))).join('')}</div>`;
  h += `<div class="pl-pot">Pot ${c(s.pot)}</div></div>`;
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
      h += `<div class="pl-seat out${i === 0 ? ' hero' : ''}" style="left:${p.x}%;top:${p.y}%" data-seat="${i}">${avatarHtml(i)}<div class="pl-plate"><b>${esc(seat.name)}</b><span>${c(seat.stack)}</span></div><div class="pl-note">${why}</div></div>`;
      return;
    }
    const cls = ['pl-seat', i === 0 ? 'hero' : '', seat.folded ? 'folded' : '', i === 0 && foldQueued ? 'prefold' : '', s.to_act === i ? 'acting' : '', s.complete && num(seat.won) > 0 ? 'winner' : ''].filter(Boolean).join(' ');
    // A hand mucked at showdown stays face down (showdownShows).
    const mucked = shows && !shows.has(i) && !seat.folded;
    const shown = (!mucked && seat.cards) || (seat.folded ? null : new Array(tableGame.cards).fill(null));
    h += `<div class="${cls}" style="left:${p.x}%;top:${p.y}%" data-seat="${i}">`;
    h += avatarHtml(i);
    if (shown) h += `<div class="pl-hole n${shown.length}">${shown.map(cardHtml).join('')}</div>`;
    h += `<div class="pl-plate"><b>${esc(seat.name)}</b><span>${c(seat.stack)}</span></div>`;
    // Your hand in words ("Straight, 8 high"), from the flop on.
    if (i === 0 && !watching && !seat.folded) {
      // On a double board, what you make on each, first board first.
      const second = s.second_board?.length >= 3 ? handWords(seat.cards, s.second_board) : null;
      const words = [handWords(seat.cards, s.board), second].filter(Boolean).join(' / ');
      if (words) h +=`<div class="pl-handname">${esc(words)}</div>`;
    }
    const note = s.complete ? (num(seat.net) > 0 ? `+${c(seat.net)}` : '') : (seat.away ? 'Away' : seat.all_in ? 'All-in' : last[i] || '');
    if (note) h += `<div class="pl-note">${note}</div>`;
    if (s.to_act === i && turnEnds) h += `<div class="pl-clock" data-clock>${clockText()}</div>`;
    if (i === 0) h += liveBadgeHtml();
    if (setup.hud) h += hudHtml(seatId(i));
    if (num(seat.street_bet) > 0) h += `<div class="pl-bet">${c(seat.street_bet)}</div>`;
    if (s.button === i) h += '<div class="pl-button">D</div>';
    h += '</div>';
  });
  h += '</div>';
  h += summaryHtml();
  h += controlsHtml();
  h += sitOutHtml();
  h += chipsHtml();
  h += liveHtml();
  h += reviewHtml();
  // The hand's action, then the stats below it.
  const log = s.events.map(eventText).filter(Boolean);
  h += `<div class="pl-log" id="pl-log">${log.map(t => `<div>${esc(t)}</div>`).join('')}</div>`;
  if (statsOpen) h += statsHtml();
  h += '</div>';
  // Keep the stats table's sideways scroll across re-renders (narrow screens).
  const scrollX = root.querySelector('.pl-stats-scroll')?.scrollLeft || 0;
  const box = document.activeElement?.id === 'pl-amtbox' ? document.activeElement.value : null;
  root.innerHTML = h;
  // Someone typing an amount keeps it, and the box, through a redraw.
  const nb = box != null && root.querySelector('#pl-amtbox');
  if (nb) { nb.value = box; nb.focus(); }
  const sx = root.querySelector('.pl-stats-scroll');
  if (sx) sx.scrollLeft = scrollX;
  const lg = root.querySelector('#pl-log');
  if (lg) lg.scrollTop = lg.scrollHeight;
}

// The action bar keeps every control in a fixed slot, whatever the state:
// a status line, then a row of Fold, Check/Call and Bet/Raise, then the bet
// sizes (½ pot, ¾ pot, Pot, All-in), then the amount: a slider, and a box to
// type it (Enter bets; an amount outside the range goes to its nearest end). An action that
// isn't available leaves its slot blank, so a button never moves under the
// pointer: a click aimed at Fold can't land on Call or Raise because the
// screen changed. Between hands Next hand sits in the Raise slot.
// When a button changes what it does, it ignores taps for SLOT_GUARD_MS, so a
// tap aimed at the old button can't do the new thing. The middle place also
// waits when it first appears: your turn can arrive with Call there because
// someone just bet, under a tap you meant for Check.
const SLOT_GUARD_MS = 500;
const slotAct = {}, slotChanged = {};
function noteSlot(slot, html) {
  const a = html.match(/data-act="([^"]+)"/)?.[1] || '';
  if (a && a !== slotAct[slot] && (slotAct[slot] || slot === 'call')) slotChanged[slot] = Date.now();
  slotAct[slot] = a;
}
const slotGuard = el => {
  const slot = el.closest('.pl-act-fold, .pl-act-call, .pl-act-raise')?.className.match(/pl-act-(\w+)/)?.[1];
  return !!slot && Date.now() - (slotChanged[slot] || 0) < SLOT_GUARD_MS;
};

function controlsHtml() {
  const s = state;
  const blank = '<span class="pl-slot" aria-hidden="true"></span>';
  let status = '', fold = blank, call = blank, raise = blank, sizes = blank, amount = blank;
  const L = s.legal;
  if (peeling) {
    const run = s.peelRuns !== 2 ? '' : s.peelNext?.[0] === 2 || s.second_board?.length ? 'second run' : 'first run';
    status = `<span class="pl-result">All-in: ${run ? `dealing the ${run}…` : 'dealing the rest of the board…'}</span>`;
  } else if (s.complete) {
    const winners = s.seats.map((x, i) => ({...x, i})).filter(x => num(x.won) > 0);
    const text = winners.map(w => `${esc(w.name)} ${w.i === 0 ? 'win' : 'wins'} ${c(w.won)}`).join(', ');
    // Before the first hand of a hosted table there's no result yet.
    status = `<span class="pl-result">${num(s.hand_number) ? `${text}${s.showdown ? '' : ' (no showdown)'}` : 'Waiting for players'}</span>`;
    if (ladder?.over) {
      const o = ladderOverHtml();
      status += ' ' + o.status;
      raise = o.button;
    } else if (mode === 'guest') {
      status += ' <span class="pl-meta">· The host deals the next hand</span>';
    } else if (mode === 'host' && hostInfo.playersIn < 2) {
      status += ' <span class="pl-meta">· Dealing needs two players with chips</span>';
    } else {
      const label = num(s.hand_number) ? nextLabel() : 'Deal';
      raise = `<button class="tr-start" data-act="next"><span id="pl-next">${label}</span> <kbd>Space</kbd></button>`;
      if (autoDealOn() && num(s.hand_number)) call = `<button class="tr-btn" id="pl-pause" data-act="pause">${pauseLabel()} <kbd>P</kbd></button>`;
      // A Regulars table: rebuy when you're out, top up when you're short.
      if (regulars && mode === 'solo') {
        const mine = num(s.seats[0].stack);
        // Out of chips (#225): say so at once, with Rebuy or Leave the
        // table; who left and who sat down goes on its own line.
        const swaps = regularsNote.startsWith('You’re out') ? '' : regularsNote;
        if (!mine) {
          status = '<span class="pl-result">You’re out of chips. Rebuy to keep playing.</span>';
          raise = `<button class="tr-start" data-act="rebuy">Rebuy ${c(regulars.buyIn)}</button>`;
          call = '<button class="tr-btn" data-act="leave">Leave the table</button>';
          fold = blank;
        } else if (mine < regulars.buyIn) fold = `<button class="tr-btn" data-act="rebuy">Top up to ${c(regulars.buyIn)}</button>`;
        if (swaps) status += `<span class="pl-meta pl-swaps">${esc(swaps)}</span>`;
      }
    }
  } else if (foldQueued) {
    if (L) {
      // With the turn here, the queued fold (or check) is on its way.
      status = `${L.can_fold ? 'Folding' : 'Checking'}…`;
    } else {
      status = checkIsFree() ? 'Checking when it’s your turn, or folding to a bet' : 'Folding when it’s your turn';
      fold = '<button class="tr-btn" data-act="prefold">Undo <kbd>F</kbd></button>';
    }
  } else if (s.run_choice) {
    // Everyone left is all-in: run the rest of the board twice? Everyone
    // still in must say yes (bots go along).
    const me = s.seats[0];
    const asked = !watching && !me.folded && !me.sitting_out && !me.empty;
    const answer = mode === 'guest' ? mySeat?.run_twice : myRunAnswer?.hand === num(s.hand_number) ? myRunAnswer.yes : undefined;
    if (asked && answer == null) {
      status = `Everyone’s all-in. Run it twice? <span class="pl-meta">Once if you don’t choose in ${RUN_SECS} seconds.</span>`;
      call = '<button class="tr-btn" data-act="runonce">Run it once</button>';
      raise = '<button class="tr-btn yes" data-act="runtwice">Run it twice</button>';
    } else {
      status = asked ? `You said ${answer ? 'twice' : 'once'}; waiting for the others…` : 'The players are choosing whether to run it twice…';
    }
  } else if (!L) {
    status = `${esc(nameOf(s.to_act))} is thinking…`;
    if (canPrefold()) fold = `<button class="tr-btn no" data-act="prefold">${checkIsFree() ? 'Check/Fold' : 'Fold'} <kbd>F</kbd></button>`;
  } else {
    status = `Your turn${timeBankHtml()}`;
    // Check and Call share the middle, as at most poker sites, but not a key:
    // K checks and C calls, so a key press never does the other. A tap that
    // lands just after a bet turned Check into Call is ignored (slotGuard).
    if (L.can_fold) fold = '<button class="tr-btn no" data-act="fold">Fold <kbd>F</kbd></button>';
    if (L.can_check) call = '<button class="tr-btn" data-act="check">Check <kbd>K</kbd></button>';
    else if (L.call != null) call = `<button class="tr-btn" data-act="call">Call ${c(L.call)} <kbd>C</kbd></button>`;
    const range = L.raise || L.bet;
    if (range) {
      const min = num(range.min_to), max = num(range.max_to);
      // Pot-limit defaults to the pot, no-limit to the minimum.
      if (!raiseTo || raiseTo < min || raiseTo > max) raiseTo = tableGame.pl ? max : min;
      const word = L.raise ? 'Raise to' : 'Bet';
      raise = `<button class="tr-btn yes" data-act="${L.raise ? 'raise' : 'bet'}">${word} <b id="pl-amtv">${c(raiseTo)}</b> <kbd>R</kbd></button>`;
      sizes = `<span class="pl-sizes">${sizeButtons(min, max)}</span>`;
      amount = `<input type="range" id="pl-amt" min="${min}" max="${max}" step="1" value="${raiseTo}" aria-label="Amount">` +
        `<input type="number" class="pl-text pl-amtbox" id="pl-amtbox" inputmode="decimal" min="${amtInput(min)}" max="${amtInput(max)}" step="${amtStep()}" value="${amtInput(raiseTo)}" aria-label="Amount to ${L.raise ? 'raise to' : 'bet'}">`;
    }
  }
  noteSlot('fold', fold);
  noteSlot('call', call);
  noteSlot('raise', raise);
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
      h += `<li><span><b>${esc(r.name)}</b> asks for ${c(r.amount)} chips <span class="pl-meta">(has ${c(r.stack)})</span></span>`;
      h += `<span class="pl-chip-acts"><button class="tr-btn yes" data-approve="${r.seat}">Approve</button><button class="tr-btn" data-deny="${r.seat}">Deny</button></span></li>`;
    }
    h += '</ul>';
  }
  const people = state.seats.map((x, i) => ({...x, i})).filter(x => x.i > 0 && x.human && !x.empty);
  if (people.length) {
    h += '<div class="pl-chips-head"><b>Players</b></div><ul class="pl-chip-list">';
    for (const p of people) {
      const note = p.away ? ' · away' : p.sitting_out ? (num(p.stack) === 0 ? ' · needs chips' : ' · sitting out') : '';
      h += `<li><span>${esc(p.name)} <span class="pl-meta">${c(p.stack)} chips${note}</span></span><button class="link-btn" data-remove="${p.i}">Remove</button></li>`;
    }
    h += '</ul>';
  }
  const mine = num(state.seats[0].stack) + hostInfo.hostPendingChips;
  const room = max - mine;
  h += '<div class="pl-chips-head"><b>Your chips</b>';
  h += `<span class="pl-meta">${c(state.seats[0].stack)}${hostInfo.hostPendingChips ? ` (+${c(hostInfo.hostPendingChips)} next hand)` : ''} · stacks ${c(min)}–${c(max)} after a top-up</span></div>`;
  if (room > 0) {
    const lo = Math.max(1, min - mine);
    const v = Math.max(lo, Math.min(room, chipAsk || room));
    h += `<div class="pl-chip-ask"><input class="pl-text" type="number" id="pl-chipamt" min="${chipInput(lo)}" max="${chipInput(room)}" step="${CHIP_STEP}" value="${chipInput(v)}" aria-label="Chips to add"><button class="tr-btn" data-act="hostchips">Add chips</button></div>`;
  }
  return h + '</div>';
}

function guestChipsHtml() {
  const {min, max, requested, approved} = myChips;
  const stack = num(state.seats[0].stack) + approved;
  let h = '<div class="pl-chips"><div class="pl-chips-head"><b>Your chips</b>';
  h += `<span class="pl-meta">${c(state.seats[0].stack)}${approved ? ` (+${c(approved)} next hand)` : ''} · stacks ${c(min)}–${c(max)} after a top-up</span></div>`;
  if (requested) {
    h += `<div class="pl-chip-ask"><span>Asked the host for ${c(requested)} chips…</span><button class="link-btn" data-act="cancelchips">Cancel</button></div>`;
  } else if (stack < max) {
    const lo = Math.max(1, min - stack), hi = max - stack;
    const v = Math.max(lo, Math.min(hi, chipAsk || hi));
    h += `<div class="pl-chip-ask"><input class="pl-text" type="number" id="pl-chipamt" min="${chipInput(lo)}" max="${chipInput(hi)}" step="${CHIP_STEP}" value="${chipInput(v)}" aria-label="Chips to ask for"><button class="tr-btn yes" data-act="askchips">Ask for chips</button></div>`;
    if (stack === 0) h += '<p class="pl-meta">You’ll be dealt in once the host approves your chips.</p>';
  }
  return h + '</div>';
}

// The amount in the chips box.
function chipAmount() {
  const el = root.querySelector('#pl-chipamt');
  return el ? parseChips(el.value) || 0 : 0;
}

function netBarHtml() {
  const title = mode === 'host' ? hostTitle : tableTitle;
  let h = `<span class="pl-meta">${title ? `<b>${esc(title)}</b> · ` : ''}Table <b>${esc(room)}</b>`;
  if (mode === 'host') h += ` · ${openSeats} empty seat${openSeats === 1 ? '' : 's'}</span><button class="link-btn" data-act="copy">Copy link</button>`;
  else h += '</span>';
  if (fairCheck && mode === 'guest') {
    h += fairCheck.ok ? `<span class="cl-fair" title="Dealt from a seed every player helped make, checked by this page">Hand ${fairCheck.hand}: fair deal ✓</span>`
      : `<span class="cl-fair bad">Hand ${fairCheck.hand}: the deal didn’t check out: ${esc(fairCheck.why)}.</span>`;
  }
  if (netNote) h += `<span class="pl-meta pl-neterr">${esc(netNote)}</span>`;
  if (mode === 'host' && clockStopped) h += `<span class="pl-meta pl-neterr">${linkOk ? 'Paused: no one else is connected.' : 'Paused: can’t reach the relay.'} No one is folded or timed out meanwhile.</span>`;
  return h;
}

function render() {
  // The club list steps aside while a table is on the Play tab (style.css).
  document.body.classList.toggle('pl-seated', seated);
  syncChat();
  if (!open) return;
  // A ladder game shows on the Ladder tab as well as Bots.
  if (seated && view !== 'play' && !(ladder && view === 'ladder')) {
    // At a table, the other tabs can't start another one.
    root.hidden = view === 'clubs';
    root.innerHTML = view === 'clubs' ? '' : `<div class="pl-wrap"><section class="cl-card"><p class="pl-desc">You’re at a table${room ? ` (${esc(room)})` : ''}. Leave it to join or start another.</p><div class="pl-actions"><a class="tr-start" href="#${ladder ? 'ladder' : 'play'}">Back to the table</a></div></section></div>`;
    return;
  }
  root.hidden = false;
  if (seated && state) renderTable();
  else if (seated) root.innerHTML = `<div class="pl-wrap"><p class="pl-meta">${esc(netNote || 'Connecting…')}</p><button class="link-btn" data-act="leave">Cancel</button></div>`;
  else renderSetup();
}

// ---- stats ----

// The stats id of a seat: "you", or the bot's personality id.
const seatId = i => state.seats[i].id || (i === 0 ? 'you' : tableBots[i - 1]);

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
  ['net', 'Net', 'Chips won or lost (big blinds)', r => `${r.net > 0 ? '+' : ''}${chipText(r.net)} <small>(${signed(r.netBB, 1)} bb)</small>`, r => r.netBB],
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
  if (reviewTable() && mode === 'solo') h += reviewTotalsHtml();
  h += '<p class="pl-meta">Raw rates with the sample size in brackets. Bots are tracked by personality, so their stats follow them to new tables. Each game keeps its own stats.</p>';
  h += '</div>';
  return h;
}

function resetStats() {
  const all = setup.statsScope === 'all';
  if (!confirm(`Reset ${all ? 'all-time' : 'this session’s'} ${tableGame.name} stats for everyone?`)) return;
  if (all) { delete allStats[tableGame.id]; saveStats(); }
  else delete sessionStats[tableGame.id];
  if (reviewTable()) {
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
  if (mode !== 'solo' || !reviewTable() || !setup.review || !state?.complete) return;
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

// One graded decision, a line that opens to the bot's mix. `key` is the
// click attribute: "rev" in the hand review, "live" in live feedback.
function decisionHtml(d, i, key = 'rev') {
  const flagged = FLAGGED.includes(d.grade);
  const open = (key === 'live' ? liveOpen : reviewOpen).has(i);
  const cls = ['pl-rev-row', `g-${d.grade}`, open ? 'open' : ''].filter(Boolean).join(' ');
  let h = `<li class="${cls}"><button class="pl-rev-line" data-${key}="${i}" aria-expanded="${open}">`;
  h += `<span class="pl-rev-street">${STREET[d.street] || esc(d.street)}${d.board ? ` <span class="pl-rev-board">${esc(boardText(d.board))}</span>` : ''}</span>`;
  h += `<span class="pl-rev-act">${esc(d.action)}</span>`;
  if (flagged && d.grade !== 'deviation' && d.best) h += `<span class="pl-rev-best">best: ${esc(d.best)}</span>`;
  else if (flagged || isVariant(d)) h += `<span class="pl-rev-best">GTO: ${esc(d.main)}</span>`;
  else h += '<span class="pl-rev-best"></span>';
  const cost = d.bb_lost > 0 ? `−${bbText(d.bb_lost)} bb` : '';
  const label = isVariant(d) ? 'Fine (mixed)' : GRADE_LABEL[d.grade] || d.grade;
  // A play the bot mixes in isn't charged, but can still be worth less
  // than the best one here: shown, not counted.
  const mc = mixCost(d);
  const uncharged = mc && !mc.close ? ` <span class="pl-rev-mixcost" title="Not charged: the bot plays this too, but here it’s worth less than ${esc(mc.best)}">(−${bbText(mc.loss)} bb)</span>` : '';
  h += `<span class="pl-rev-grade">${esc(label)}${cost ? ` <b>${cost}</b>` : ''}${uncharged}</span>`;
  h += '</button>';
  if (open) {
    h += '<div class="pl-rev-more">';
    h += `<div>Pot ${bbText(d.pot)} bb${d.to_call > 0 ? `, ${bbText(d.to_call)} bb to call` : ''}</div>`;
    // The bot's plays with your hand, one row each: how often it makes
    // each, and what each is worth.
    const rows = mixRows(d.gto);
    if (rows.length) {
      const values = rows.some(r => r.ev != null);
      h += '<table class="pl-rev-mix"><thead><tr><th>Play</th><th>GTO plays it</th>';
      if (values) h += `<th>Value (bb)${d.stderr > 0 ? ` <span class="pl-meta">± ${bbText(d.stderr)}</span>` : ''}</th>`;
      h += '</tr></thead><tbody>';
      for (const r of rows) {
        const yours = isYourPlay(r, d.action) ? ' class="yours"' : '';
        h += `<tr${yours}><td>${esc(r.action)}</td><td>${r.pct == null ? '<1%' : `${r.pct}%`}</td>`;
        if (values) h += `<td>${r.ev == null ? '–' : bbText(r.ev)}</td>`;
        h += '</tr>';
      }
      h += '</tbody></table>';
    }
    if (d.note) h += `<div class="pl-meta">${esc(d.note[0].toUpperCase() + d.note.slice(1))}.</div>`;
    if (mc) {
      h += mc.close
        ? `<div class="pl-meta">About as good as ${esc(mc.best)} here: the difference (${bbText(mc.loss)} bb) is within the estimate’s error.</div>`
        : `<div class="pl-rev-mixnote">Not charged, since the bot plays it too, but here it’s worth ${bbText(mc.loss)} bb less than ${esc(mc.best)}.</div>`;
    }
    h += '</div>';
  }
  return h + '</li>';
}

// The review panel under the controls, once a hand against the GTO bot is
// over. It sits below the action bar, so the buttons never move.
function reviewHtml() {
  if (mode !== 'solo' || !reviewTable() || !setup.review || !state.complete || !review || review.hand !== num(state.hand_number)) return '';
  let h = '<div class="pl-review"><div class="pl-review-head"><b>Hand review</b>';
  if (review.pending) return h + '<span class="pl-meta">Reviewing your decisions…</span></div></div>';
  if (review.error || !review.data) return h + '<span class="pl-meta">No review for this hand.</span></div></div>';
  const r = review.data;
  if (!r.decisions.length) return h + '<span class="pl-meta">You had no decisions this hand.</span></div></div>';
  const lost = r.bb_lost > 0 ? `<span class="pl-rev-total bad">−${bbText(r.bb_lost)} bb from your decisions</span>` : '<span class="pl-rev-total">No bb lost to mistakes</span>';
  h += `${lost}<span class="pl-meta">Result ${r.result > 0 ? '+' : ''}${bbText(r.result)} bb (luck included)</span></div>`;
  h += `<ul class="pl-rev-list">${r.decisions.map((d, i) => decisionHtml(d, i)).join('')}</ul>`;
  if (r.note) h += `<p class="pl-meta">${esc(r.note[0].toUpperCase() + r.note.slice(1))}.</p>`;
  h += '<p class="pl-meta pl-rev-caveat">Graded against the GTO bot’s own strategy, which is strong but not perfect, using the range it could hold, not its actual cards. Preflop plays are compared with its mix only.</p>';
  return h + '</div>';
}

// ---- live feedback (#56) ----

// Asks the worker to grade the decision just made, with only what you could
// see then (the engine's reviewLastDecision). With an older ducy-wasm, or
// away from the Hold'em GTO bot, there's no grade and nothing shows.
function startLive(s) {
  if (mode !== 'solo' || !reviewTable() || !setup.live || !s) return;
  const hand = num(s.hand_number);
  if (live.hand !== hand) { live = {hand, items: []}; liveOpen = new Set(); }
  const item = {pending: true};
  live.items.push(item);
  const mine = session;
  call('reviewDecision').then(data => {
    if (mine !== session || live.hand !== hand) return;
    if (data) { item.data = data; delete item.pending; } else live.items = live.items.filter(x => x !== item);
    render();
  }, e => {
    console.warn(e);
    if (mine === session && live.hand === hand) { live.items = live.items.filter(x => x !== item); render(); }
  });
}

// Live feedback is on and has something for the hand on the table.
const liveShown = () => mode === 'solo' && reviewTable() && setup.live && !!state && live.hand === num(state.hand_number) && live.items.length > 0;

// This hand's graded decisions, under the action bar so the buttons never
// move. Once the hand is over, the full hand review takes over if it's on.
function liveHtml() {
  if (!liveShown() || (state.complete && setup.review)) return '';
  let h = '<div class="pl-review pl-live"><ul class="pl-rev-list">';
  live.items.forEach((x, i) => {
    if (x.pending) h += '<li class="pl-rev-row"><span class="pl-meta pl-live-wait">Grading your decision…</span></li>';
    else h += decisionHtml(x.data, i, 'live');
  });
  return h + '</ul></div>';
}

// The latest grade, by your seat: a quiet tick for a fine play, the grade
// and bb lost otherwise.
function liveBadgeHtml() {
  if (!liveShown()) return '';
  const d = live.items[live.items.length - 1].data;
  if (!d) return '';
  if (!FLAGGED.includes(d.grade)) return `<div class="pl-live-badge g-${esc(d.grade)}" title="${esc(GRADE_LABEL[d.grade] || d.grade)}">✓</div>`;
  const cost = d.bb_lost > 0 ? ` −${bbText(d.bb_lost)} bb` : '';
  return `<div class="pl-live-badge g-${esc(d.grade)}">${esc(GRADE_LABEL[d.grade] || d.grade)}${cost}</div>`;
}

// Review totals for the Stats panel.
function reviewTotalsHtml() {
  const all = setup.statsScope === 'all';
  const t = all ? allReview : sessionReview;
  let h = '<div class="pl-rev-totals"><b>GTO review</b> ';
  if (!t.hands) return h + '<span class="pl-meta">no reviewed hands yet</span></div>';
  const p = per100(t);
  h += `<span>${t.hands} hands · ${t.decisions} decisions · ${bbText(t.bbLost)} bb lost (${bbText(p)} per 100 hands)</span> `;
  // What mixed plays gave up, not counted above.
  if (t.mixLoss > 0) h += `<span class="pl-meta">Mixed plays gave up another ${bbText(t.mixLoss)} bb against the best play (not charged) · </span>`;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  h += `<span class="pl-meta">${n(t.inaccuracies, 'inaccuracy', 'inaccuracies')} · ${n(t.mistakes, 'mistake', 'mistakes')} · ${n(t.blunders, 'blunder', 'blunders')} · ${t.deviations} off-strategy preflop</span>`;
  return h + '</div>';
}

// ---- events ----

function onClick(e) {
  // Browsers play sound only after the person has interacted with the page.
  unlockSounds();
  // More options stays as it was left (it opens or closes after this click).
  const more = e.target.closest('summary[data-more]');
  if (more) { setup.moreOpen = !more.parentElement.open; saveSetup(); return; }
  const el = e.target.closest('[data-pgame],[data-count],[data-blinds],[data-buyin],[data-turn],[data-act],[data-size],[data-scope],[data-sort],[data-fgame],[data-fblinds],[data-fseats],[data-fmin],[data-fmax],[data-approve],[data-deny],[data-remove],[data-rev],[data-live]');
  if (!el) return;
  const d = el.dataset;
  if (d.rev != null) {
    const i = +d.rev;
    if (reviewOpen.has(i)) reviewOpen.delete(i); else reviewOpen.add(i);
    render();
    return;
  }
  if (d.live != null) {
    const i = +d.live;
    if (liveOpen.has(i)) liveOpen.delete(i); else liveOpen.add(i);
    render();
    return;
  }
  const f = setup.friends;
  if (d.fgame || d.fblinds || d.fseats) {
    readFriendsStep();
    // Picking a game picks its usual size (Hold'em 9, PLO 8, PLO5 and PLO6 6).
    if (d.fgame && d.fgame !== f.game) { f.game = d.fgame; f.seats = defaultSeats(f.game); }
    if (d.fseats) f.seats = +d.fseats;
    f.seats = Math.min(f.seats, maxSeats(f.game));
    // A preset keeps the buy-in in big blinds; Custom shows the two fields.
    if (d.fblinds === 'custom') f.customBlinds = true;
    else if (d.fblinds) { [f.sb, f.bb] = d.fblinds.split('/').map(Number); f.customBlinds = false; }
    fnote = '';
    saveSetup();
    render();
    return;
  }
  if (d.act === 'fnext' || d.act === 'fback') {
    fnote = d.act === 'fnext' ? readFriendsStep() : '';
    if (!fnote) fstep = Math.max(1, Math.min(3, fstep + (d.act === 'fnext' ? 1 : -1)));
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
  if (d.act === 'timebank') { useTimeBank(); return; }
  if (el.dataset.scope) { setup.statsScope = el.dataset.scope; saveSetup(); render(); }
  else if (el.dataset.sort) {
    const key = el.dataset.sort;
    // Numbers sort biggest first; the player column goes back to seat order.
    statsSort = statsSort.key === key ? {key, dir: -statsSort.dir} : {key, dir: key === 'seat' ? 1 : -1};
    render();
  }
  else if (el.dataset.act === 'hud') { setup.hud = !setup.hud; saveSetup(); render(); }
  else if (el.dataset.act === 'runpref') {
    setup.runTwice = RUN_PREFS[(RUN_PREFS.indexOf(runPref()) + 1) % RUN_PREFS.length];
    saveSetup();
    render();
    if (armRunChoice()) return;
  }
  else if (el.dataset.act === 'sounds') { setup.sounds = !setup.sounds; saveSetup(); render(); }
  else if (el.dataset.act === 'gamesounds') { setup.gameSounds = !setup.gameSounds; saveSetup(); render(); }
  else if (el.dataset.act === 'review') { setup.review = !setup.review; saveSetup(); startReview(); render(); }
  else if (el.dataset.act === 'live') { setup.live = !setup.live; saveSetup(); render(); }
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
  else if (el.dataset.act === 'sitregulars') sitRegulars();
  else if (el.dataset.act === 'rebuy') rebuy();
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
  else if (el.dataset.act === 'autodeal') { setAutoDeal(!autoDealOn()); saveSetup(); holds.delete('user'); render(); armDeal(); }
  else if (el.dataset.act === 'leave') {
    if (ladder && !ladder.over && state && !state.complete && !confirm('Leave in the middle of a hand? It folds this hand; the game picks up later with the chips you have behind.')) return;
    if (mode === 'host') forgetSavedTable();
    leaveTable();
  }
  else if (el.dataset.act === 'ladder-play') startLadderGame();
  else if (el.dataset.act === 'ladder-next') {
    // The series goes on: the next game. Otherwise back to the ladder, which
    // says how the series went.
    if (ladder?.over?.outcome === 'game') startLadderGame();
    else { leaveTable(); if (view !== 'ladder') location.hash = 'ladder'; }
  }
  else if (el.dataset.act === 'ladder-reset') {
    if (!confirm('Start the ladder over from the first rung? Your record against each bot is cleared too.')) return;
    ladderProgress = newProgress();
    saveProgress(ladderProgress);
    ladderNote = '';
    render();
  }
  else if (el.dataset.act === 'resumehost') resumeHosting();
  else if (el.dataset.act === 'forgethost') { forgetSavedTable(); render(); }
  else if (el.dataset.act === 'host') hostTable();
  else if (el.dataset.act === 'copy') copyLink();
  else if (el.dataset.act === 'prefold') togglePrefold();
  else if (el.dataset.act === 'runtwice' || el.dataset.act === 'runonce') runChoice(el.dataset.act === 'runtwice');
  else if (['fold', 'check', 'call', 'allin', 'bet', 'raise'].includes(el.dataset.act) && slotGuard(el)) return;
  else if (['fold', 'check', 'call', 'allin'].includes(el.dataset.act)) act(el.dataset.act);
  else if (el.dataset.act === 'bet' || el.dataset.act === 'raise') {
    const typed = typedBet();
    if (typed != null) raiseTo = typed;
    // Only a bet of the whole stack is "allin"; in pot-limit the top of the
    // range is usually the pot, which the engine takes as a plain bet/raise.
    act(raiseTo >= allInTo() ? 'allin' : el.dataset.act, raiseTo);
  }
}

function onInput(e) {
  if (e.target.id === 'pl-chipamt') chipAsk = parseChips(e.target.value) || 0;
  if (e.target.id === 'pl-amt') {
    raiseTo = +e.target.value;
    const v = root.querySelector('#pl-amtv');
    if (v) v.textContent = c(raiseTo);
    const b = root.querySelector('#pl-amtbox');
    if (b) b.value = amtInput(raiseTo);
  }
  // A typed amount: the slider and the button follow while it's in range.
  if (e.target.id === 'pl-amtbox') {
    const n = readAmt(e.target.value), r = betRange();
    if (r && n >= r.min && n <= r.max) {
      raiseTo = n;
      const v = root.querySelector('#pl-amtv');
      if (v) v.textContent = c(raiseTo);
      const s = root.querySelector('#pl-amt');
      if (s) s.value = raiseTo;
    }
  }
}

function onChange(e) {
  if (e.target.dataset.bot != null) { setup.bots[+e.target.dataset.bot] = e.target.value; render(); }
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

// The legal bet or raise range now, in chips (hundredths), or null.
function betRange() {
  const range = state?.legal && (state.legal.raise || state.legal.bet);
  return range ? {min: num(range.min_to), max: num(range.max_to)} : null;
}

// The typed amount, clamped to the legal range (to its nearest end when it's
// outside it), becomes the bet. Null if nothing usable was typed.
function typedBet() {
  const el = root.querySelector('#pl-amtbox'), r = betRange();
  const n = el && readAmt(el.value);
  if (!r || !Number.isFinite(n)) return null;
  return Math.max(r.min, Math.min(r.max, n));
}

function onKey(e) {
  if (open) unlockSounds();
  // Enter in the amount box bets what's typed; Escape leaves the box.
  if (open && state && e.target.id === 'pl-amtbox') {
    if (e.key === 'Enter') {
      e.preventDefault();
      const n = typedBet();
      if (n != null) { raiseTo = n; e.target.blur(); clickBet(); }
    } else if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (!open || !state || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (state.complete && (k === ' ' || k === 'enter')) { e.preventDefault(); nextHand(); return; }
  if (state.complete && k === 'p' && autoDealOn()) { hold('user', !holds.has('user')); return; }
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
  else if (k === 'k' && L.can_check) act('check');
  else if (k === 'c' && !L.can_check && L.call != null) act('call');
  else if (k === 'r' && range) clickBet();
  else if (k === 'p' && range) { raiseTo = potTo(num(range.min_to), num(range.max_to)); clickBet(); }
  else if (k === 't') useTimeBank();
}

// Bets or raises raiseTo through the Bet/Raise button, so all-in is decided there.
const clickBet = () => root.querySelector('[data-act="raise"],[data-act="bet"]')?.click();

// Draws tab `v` of the Play section (see `view`) into `el`. `shortcut` sits
// straight down heads-up against the GTO bot with a 100 big blind buy-in,
// unless a table is already in play: 'gto' for No-limit Hold'em (from
// #codedoug), 'gto-plo4' and 'gto-plo6' for Omaha (#225).
export async function openPlay(el, shortcut, v = 'play') {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    // The last hand's one-line summary stays open (or shut) from hand to hand.
    // (toggle doesn't bubble: caught on the way down.)
    root.addEventListener('toggle', e => {
      if (e.target.matches?.('.pl-sum-compact')) lastSummaryOpen = e.target.open;
      if (e.target.matches?.('.pl-menu')) tableMenuOpen = e.target.open;
    }, true);
    // The ⋯ menu closes on a click anywhere outside it.
    document.addEventListener('click', e => {
      if (!tableMenuOpen || e.target.closest?.('.pl-menu')) return;
      tableMenuOpen = false;
      root.querySelector('.pl-menu')?.removeAttribute('open');
    });
    root.addEventListener('pointerover', onPointer);
    root.addEventListener('pointerleave', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
  }
  // Coming to Start a game starts at its first step.
  if (v === 'host' && (view !== 'host' || !open)) { fstep = 1; fnote = ''; }
  // Coming to Play the Regulars: random Regulars, with choosing your own
  // folded away until you open it again (#225).
  if (v === 'play' && (view !== 'play' || !open)) setup.moreOpen = false;
  open = true;
  // A message about leaving a table stays on the tab it was for.
  if (v !== view && errView && v !== errView) { netNote = ''; errView = null; }
  view = v;
  if (document.hidden) holds.add('hidden'); else holds.delete('hidden');
  if (!me) {
    loadIdentity().then(i => { me = i; if (!seated && personalities.length) render(); })
      .catch(e => console.warn(e));
  }
  if (!personalities.length) {
    root.innerHTML = '<div class="pl-wrap"><p class="pl-meta">Loading the bots…</p></div>';
    personalities = await call('personalities');
    try { gtoAvailable = (await fetch(GTO_MANIFEST, {cache: 'no-cache'})).ok; } catch {}
    for (const plo of Object.values(GTO_PLOS)) {
      try { plo.available = await call(plo.supported) && (await fetch(plo.manifest, {cache: 'no-cache'})).ok; } catch {}
    }
  }
  if (shortcut?.startsWith('gto') && !seated) {
    setup.game = shortcut === 'gto' ? 'nlhe' : shortcut.slice(4);
    setup.count = 1;
    setup.buyIn = 100 * setup.bb;
    const bot = gtoBot();
    if (bot) { setup.bots = [bot.id]; startTable(); return; }
    setupNote = 'The GTO bot isn’t available right now.';
  }
  render();
  pace();
  armDeal();
}

export function closePlay() {
  open = false;
  syncChat();
  clearTimeout(timer);
  cancelDeal();
}

export function playOpen() {
  return open;
}
