// Clubs (#66): host a club, invite players with a link and approve them, and
// see the clubs you belong to. club.js has the rules and club-server.js runs
// the host's side; this file draws the club parts of the Play section's tabs
// (play-section.js, #138) and carries signed messages over the relay
// (play-net.js, in queue mode so join requests wait while the host is away).
//
// Views, one per tab (#209: Train · Play · Clubs):
//   'play'   Bots (Train), and the table you're at: nothing from here
//   'join'   your join requests and how they're going
//   'host'   Start a game (Play): nothing from here
//   'clubs'  Private clubs: the list of your clubs (#225; joining one is
//            Play's Enter a code, and creating one is on the club manager,
//            #393); then a club's page (the address says which, see
//            shownClub): the club you run, assistant and agent tools, or the
//            one you belong to (balance, chips, tables to sit at)
// The connections start with the page (startClubs), whichever tab is open,
// so requests arrive live (#145); onClubsChange tells the tab bar.
//
// Storage (this browser only, #61):
//   ducyClub          the club this browser hosts (one per host for now)
//   ducyClubSenders   the host's Verifier state (players' keys, last seq)
//   ducyClubs         clubs this browser has asked to join
//   ducyClubName      the display name sent with join requests

import { loadIdentity, MIN_PASSWORD, showId, signMessage, Verifier } from './identity.js';
import { clubBackupText, proveClubBackup } from './club-backup.js';
import { chipText, chipInput, parseChips, CHIP_STEP } from './chip-format.js';
import { downloadFile, notifyOn, restoreBackupFile, RESTORE_CLUB_KEY } from './player-settings.js';
import { connect, DEFAULT_RELAY, newCode, normCode, relayUrl, wsUrl } from './play-net.js';
import {
  account, approve, decline, hostReceive, inviteLink, lastEntry, MAX_CLUB_NAME, MAX_PLAYER_NAME, membersByStatus,
  newClub, newMembership, playerReceive,
} from './club.js';
import { ensureChips, issue, ledgerCsv, MAX_NOTE, reclaim, totals } from './club-chips.js';
import {
  buyInRange, cashOutEveryone, defaultSeats, defaultTableName, ensureTables, gameLabel, GAMES, MAX_TABLE_NAME, maxSeats, newTable, openTables, tableById, tablesBody,
} from './club-tables.js';
import { createClubServer } from './club-server.js';
import { MAX_HELP_REPLY, MAX_HELP_TEXT, openHelp } from './club-help.js';
import { LOBBY_MAX_AGE_MS, onlineList } from './club-lobby.js';
import { CHAT_MAX, cleanChat } from './table-chat.js';
import { ago } from './time-ago.js';
import { createOwner } from './club-owner.js';
import { accountOf, settle } from './club-agents.js';
import { bigMove, isBigMove } from './club-roles.js';
import { handRecord, replayFrames, streetStarts, summary, tableSessions, totalsByMember, STREETS } from './hand-replay.js';
import { getHand, HOST_KEEP_DAYS, listHands, PLAYER_KEEP_HANDS, prune, saveHand } from './hand-store.js';
import { getTable } from './table-store.js';
import { celebrateAtTable, joinTableVia, showFairCheck } from './play.js';
import { hostTourneysHtml, memberTourneysHtml, readPayoutForm, readTourneyForm, tourneyCallsFor } from './club-tourneys-ui.js';
import { hostPromosHtml, memberPromosHtml, promosPartHtml, readPromoForm, tableBannerText } from './club-promos-ui.js';
import { readServiceForm, servicesHtml } from './club-services-ui.js';
import { payoutShares, tourneyById } from './club-tourneys.js';
import { structureEditor } from './tourney-structure-ui.js';
import { fairPlayer } from './fair-check.js';

const fair = fairPlayer(); // this page's side of fair deals (#136)
import { newKeyPair, open as openBox, sharedKey } from './e2e.js';

const CLUB_KEY = 'ducyClub', SENDERS_KEY = 'ducyClubSenders', MEMBERSHIPS_KEY = 'ducyClubs', NAME_KEY = 'ducyClubName';

let root = null, open = false;
let view = 'clubs'; // which Play tab this draws (see above)
let started = null; // startClubs, once
const listeners = new Set(); // onClubsChange callbacks
// Clubs that approved this browser while it was looking (the Join tab says
// "You're in" for them).
const justJoined = new Set();
let me = null; // identity
let club = null; // the club this browser hosts
let verifier = null;
let hostNet = null, hostOnline = false;
let memberships = []; // clubs this browser asked to join
const playerNets = new Map(); // club code → {net, online, hostHere}
let invite = null; // an invite from the page address, not yet acted on
let note = '', copied = false;
let server = null; // runs the hosted club (club-server.js)
// An always-on club this browser owns (#93, club-owner.js): `club` is then
// its latest view from the relay, and host actions go there as commands.
let owner = null;
const isRemote = () => !!owner?.record;
// Which page this runs on: 'play', the player app (index.html), where you
// join clubs and play at their tables; or 'manage', the club manager
// (manage.html, manage.js), where you run a club or help run one. Running a
// club lives only on the manager: the player app neither hosts a club run
// in the browser nor opens an always-on club's owner connection, and links
// to the manager instead.
let mode = 'play';
export function setClubsMode(m) {
  mode = m === 'manage' ? 'manage' : 'play';
}
const managerHref = hash => `manage.html${hash ? `#${hash}` : ''}`;
const playerHref = hash => `./${hash ? `#${hash}` : ''}`;
// Invite links open the player app, even when made on the club manager.
const appBase = () => new URL('./', location.href).href;
// Why the last create failed (the relay down or full), and the name it was
// for: the form says so and offers to try again. New clubs are always on
// (#152); a club run in a browser is still opened and moved as before.
let alwaysFailed = null;
let tableForm = false; // the open New table form: true (the host's), or a club code (an assistant's)
// Tournaments (#64): the New tournament form and its blind structure
// editor, and the payouts being edited ({id, places}).
let tourneyForm = false, tEditor = null, payoutEdit = null;
const TOURNEY_KEY = 'ducyTourneyChoice';
let seatedAt = null; // the club table this browser plays at: {code, table, handlers}

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
// Ledger entries that are chips given to you (a notice, #193).
const GIVEN = ['issue', 'grant', 'transfer_in'];
// Full tables you asked to hear about (#187): "code|table" keys, kept on
// this device. A notice comes when one of them has a free seat.
const SEAT_WATCH_KEY = 'ducySeatWatch';
const seatWatch = new Set(load(SEAT_WATCH_KEY, []));
const watchKey = (code, table) => `${code}|${table}`;
function setSeatWatch(code, table, on) {
  if (on) seatWatch.add(watchKey(code, table)); else seatWatch.delete(watchKey(code, table));
  save(SEAT_WATCH_KEY, [...seatWatch]);
}
// After a tables update: tell the member about watched tables with a seat
// free now, and forget those and any that closed.
function checkSeatWatch(mem) {
  for (const key of [...seatWatch]) {
    const [code, id] = key.split('|');
    if (code !== mem.code) continue;
    const t = (mem.tables || []).find(x => x.id === id);
    if (t && t.taken >= t.seats) continue;
    setSeatWatch(code, id, false);
    if (t) notice(`${mem.name || mem.code}: a seat is free at ${t.name}.`, clubHash(mem.code));
  }
}
// When something happened (#193): relative, with the full time on hover.
const when = t => (t ? `<time datetime="${new Date(t).toISOString()}" title="${esc(new Date(t).toLocaleString())}">${ago(t)}</time>` : '');
const myName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
// The name you go by in a club you joined (#185): its own, or this browser's.
const nameIn = mem => mem?.myName || myName();

const STATUS_TEXT = {
  new: 'Sending your request…',
  pending: 'Waiting for the host to approve you',
  member: 'Member',
  declined: 'The host declined your request',
  removed: 'You were removed from this club',
  bad_invite: 'That invite link isn’t valid any more; ask the host for a new one',
  invite_only: 'This club takes requests by invite link only; ask the host for theirs',
  closed: 'The owner closed this club',
};

// ---- hosting ----

function saveClub() {
  if (isRemote()) return;
  save(CLUB_KEY, club);
  save(SENDERS_KEY, verifier.toJSON());
}

// The club's host logic, carrying its messages over this tab's relay connection.
function newServer() {
  server = createClubServer({
    identity: me, club, verifier,
    persist: saveClub,
    transport: {send: (to, data) => hostNet?.send({to, data}), ack: n => hostNet?.send({ack: n})},
    // This tab runs the club, so its host is around for help requests (#192).
    hostInTab: true,
    onChange: render,
    storeHand,
  });
}

// A host action (club-server.js), here or in an always-on club's room;
// tells the host if it can't be done. Resolves to whether it was.
async function hostAct(op, args) {
  let ok = true;
  try { await (isRemote() ? owner.run(op, args) : server.run(op, args)); } catch (e) { alert(e.message); ok = false; }
  render();
  return ok;
}

const seatedCounts = () => (isRemote() ? owner.view?.seated || {} : server?.seatedCounts() || {});
const tableRunning = id => (isRemote() ? !!owner.view?.running?.includes(id) : !!server?.running(id));
// How running tournaments are going (club-tourney-host.js).
const tourneyLive = () => (isRemote() ? owner.view?.tourneys || {} : server?.tourneyLive?.() || {});

function startHosting() {
  if (!club || hostNet || isRemote()) return;
  if (!server) newServer();
  hostNet = connect(club.code, 'host', '', {
    // Tables start once this tab is the club's host: a second tab, refused
    // by the relay, never runs (or resumes) them.
    onOpen() { hostOnline = true; server.relayOpen(); render(); },
    onMessage: m => server.message(m),
    onStatus(s) { hostOnline = !s; render(); },
    onFail(reason) { hostNet = null; hostOnline = false; server.setLink(false); note = reason; render(); },
    // Tables stop their clocks while the relay can't be reached (club-host.js).
    onHealth(ok) { server.setLink(ok); render(); },
  }, {heartbeat: true, persistent: true, retryInUse: true, inUse: 'This club is already open in another tab or window. Only one can host it: close the other one, then click Reconnect.'});
}

// A new club, always on (#93, #152): its room on the relay becomes the club.
async function createClub(name) {
  const n = String(name || '').trim();
  if (!n) { note = 'Give your club a name.'; render(); return; }
  note = 'Setting up your club on the server…';
  alwaysFailed = null;
  render();
  try {
    await owner.create(n.slice(0, MAX_CLUB_NAME));
    note = '';
    setWizard('backup', {setup: true});
  } catch (e) {
    // The relay is down or full (limits, #123).
    note = '';
    alwaysFailed = {reason: e.message, name: n};
  }
  render();
}

// Creating a club (#152, #395): a name; a backup ('backup'), then proving
// it works ('prove'); the first table ('table'); the invite link
// ('invite'). The backup and proof can be skipped ('skip' warns first),
// leaving the club temporary. The club exists from the first step, so
// closing the page mid-way comes back to the step it was at. A backup made
// later (Settings, or the Temporary banner) takes the backup and proof
// steps alone (`setup` false).
const WIZARD_KEY = 'ducyClubWizard';
const WIZARD_STEPS = ['backup', 'prove', 'skip', 'table', 'invite'];
let wizard = load(WIZARD_KEY, null); // {code, step, setup}
if (wizard && !WIZARD_STEPS.includes(wizard.step)) wizard = null; // an older step (#111)
const myClubCode = () => club?.code || owner?.record?.code || '';

function setWizard(step, {setup = wizard?.setup ?? false} = {}) {
  wizard = step ? {code: myClubCode(), step, setup} : null;
  if (wizard) save(WIZARD_KEY, wizard);
  else try { localStorage.removeItem(WIZARD_KEY); } catch {}
  render();
}

// Past the backup and proof: on to the first table when setting up, else
// back to the club.
function wizardOnward() {
  if (wizard?.setup) { setWizard('table'); return; }
  setWizard(null);
  location.hash = 'clubs/own';
}

// The New table form (#113): three choices (game, blinds, seats) as
// buttons, everything else under More options with good defaults. Native,
// so the browser checks the numbers. The last choices are remembered.
// `code`: an assistant's form for that club (sent to its host), else the
// host's. `wizard`: a step of creating a club (#111, #395), which can be skipped.
const TABLE_KEY = 'ducyTableChoice';
// In hundredths (chip-format.js): 100/200 shows as 1/2.
const BLINDS = [[100, 200], [200, 500], [500, 1000]];
const SEATS = [2, 6, 8, 9];
const SHORT = {nlhe: 'Hold’em', plo4: 'Omaha', plo5: 'Omaha 5', plo6: 'Omaha 6'};

function tableFormHtml(code = '', {wizard = false} = {}) {
  const last = load(TABLE_KEY, {});
  const game = GAMES.some(g => g.id === last.game) ? last.game : GAMES[0].id;
  const blinds = BLINDS.find(([s, b]) => s === last.sb && b === last.bb) ? `${last.sb}/${last.bb}` : last.sb ? 'other' : '100/200';
  // The game's usual size (Hold'em 9, PLO 8, PLO5 and PLO6 6), or the last one picked
  // for this game; never more than the game can deal to (PLO6: 6).
  const most = maxSeats(game);
  const wanted = Math.min(last.game === game && last.seats ? last.seats : defaultSeats(game), most);
  const seats = SEATS.includes(wanted) ? String(wanted) : 'other';
  const radio = (name, value, label, on, off = false) => `<label class="cc-btn tf-opt"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}${off ? ' disabled' : ''}>${label}</label>`;
  let h = `<form class="cl-tableform tf" data-tableform="1"${code ? ` data-code="${esc(code)}"` : ''}${wizard ? ' data-wizard="1"' : ''}>`;
  h += `<div class="pl-row"><span class="pl-label">Game</span><div class="pl-opts">${GAMES.map(g => radio('game', g.id, esc(SHORT[g.id] || g.label), g.id === game)).join('')}</div></div>`;
  h += `<div class="pl-row"><span class="pl-label">Blinds</span><div class="pl-opts">${BLINDS.map(([s, b]) => radio('blinds', `${s}/${b}`, `${chipText(s)}/${chipText(b)}`, blinds === `${s}/${b}`)).join('')}${radio('blinds', 'other', 'Other', blinds === 'other')}</div></div>`;
  h += `<div class="pl-row tf-other tf-other-blinds"><label>Small blind<input class="pl-text" name="sb" type="number" min="0.01" step="${CHIP_STEP}" value="${esc(chipInput(last.sb || 100))}"></label><label>Big blind<input class="pl-text" name="bb" type="number" min="0.01" step="${CHIP_STEP}" value="${esc(chipInput(last.bb || 200))}"></label></div>`;
  h += `<div class="pl-row"><span class="pl-label">Seats</span><div class="pl-opts">${SEATS.map(n => radio('seatsPick', n, n, seats === String(n), n > most)).join('')}${radio('seatsPick', 'other', 'Other', seats === 'other')}</div></div>`;
  h += `<div class="pl-row tf-other tf-other-seats"><label>Seats<input class="pl-text" name="seats" type="number" min="2" max="${most}" step="1" value="${esc(wanted)}"></label></div>`;
  // Sit-out limit (#70): this table's, starting from the club's default (an
  // assistant's browser doesn't have the club, so theirs starts at 10 minutes).
  const defOut = club?.sitOutMins ?? 10;
  h += '<details class="tf-more" data-keep="tf-more"><summary>More options</summary><div class="tf-fields">';
  // Left empty, the table gets the name shown ("NLH - 1/2", numbered if
  // taken); an assistant's browser doesn't have the club's tables.
  const [sb, bb] = blinds === 'other' ? [last.sb, last.bb] : blinds.split('/').map(Number);
  h += `<label>Name<input class="pl-text" name="name" maxlength="${MAX_TABLE_NAME}" placeholder="${esc(formTableName(code, game, sb, bb))}"></label>`;
  h += `<label>Min buy-in (BB)<input class="pl-text" name="minBB" type="number" required min="1" step="1" value="${esc(last.minBB || 40)}"></label>`;
  h += `<label>Max buy-in (BB)<input class="pl-text" name="maxBB" type="number" required min="1" step="1" value="${esc(last.maxBB || 100)}"></label>`;
  h += `<label>Time to act<select class="pl-text" name="turnSecs">${[15, 30, 60, 0].map(s => `<option value="${s}"${s === (last.turnSecs ?? 30) ? ' selected' : ''}>${s ? s + ' s' : 'None'}</option>`).join('')}</select></label>`;
  h += `<label>Sitting out<select class="pl-text" name="sitOutMins">${[5, 10, 15, 30, 0].map(m => `<option value="${m}"${m === defOut ? ' selected' : ''}>${m ? m + ' min' : 'No limit'}</option>`).join('')}</select></label>`;
  // The hit-and-run rule: a player who's up plays this many more hands first.
  const stay = last.stayHands ?? 0;
  h += `<label>Once up, hands before leaving<select class="pl-text" name="stayHands">${[...new Set([0, 10, 20, 30, 50, stay])].sort((a, b) => a - b).map(n => `<option value="${n}"${n === stay ? ' selected' : ''}>${n ? n + ' hands' : 'Off'}</option>`).join('')}</select></label>`;
  h += '</div></details>';
  h += '<div class="cl-formacts"><button class="btn-small primary" type="submit">Open table</button>';
  h += wizard ? '<button class="btn-small" type="button" data-cl="wiz-invite">Skip for now</button>' : '<button class="btn-small" type="button" data-cl="cancel-table">Cancel</button>';
  return h + '</div></form>';
}

const formTableName = (code, game, sb, bb) => defaultTableName(!code && club ? club : {tables: []}, game, sb, bb);

// Keeps the New table form in step with its game and blinds: picking a game
// picks its usual size, seat counts it can't deal to are greyed out, and the
// name's placeholder is the default name.
function syncTableForm(f, gameChanged) {
  const v = name => f.elements[name].value;
  const game = v('game');
  const most = maxSeats(game);
  const seats = f.elements.seats;
  seats.max = most;
  for (const r of f.querySelectorAll('[name=seatsPick]')) {
    if (r.value !== 'other') r.disabled = Number(r.value) > most;
  }
  const picked = f.querySelector('[name=seatsPick]:checked');
  if (gameChanged || picked?.disabled) {
    const n = defaultSeats(game);
    const radio = f.querySelector(`[name=seatsPick][value="${n}"]`) || f.querySelector('[name=seatsPick][value=other]');
    radio.checked = true;
    seats.value = n;
  }
  if (Number(seats.value) > most) seats.value = most;
  const blinds = v('blinds');
  const [sb, bb] = blinds === 'other' ? [parseChips(v('sb')), parseChips(v('bb'))] : blinds.split('/').map(Number);
  if (Number.isSafeInteger(sb) && Number.isSafeInteger(bb)) f.elements.name.placeholder = formTableName(f.dataset.code, game, sb, bb);
}

function submitTable(f) {
  const v = name => f.elements[name].value;
  const blinds = v('blinds');
  const [sb, bb] = blinds === 'other' ? [parseChips(v('sb')), parseChips(v('bb'))] : blinds.split('/').map(Number);
  const seats = v('seatsPick') === 'other' ? Number(v('seats')) : Number(v('seatsPick'));
  const settings = {
    name: v('name'), game: v('game'), sb, bb,
    minBB: Number(v('minBB')), maxBB: Number(v('maxBB')), seats, turnSecs: Number(v('turnSecs')),
    sitOutMins: Number(v('sitOutMins')),
    stayHands: Number(v('stayHands')),
  };
  if (blinds === 'other' && !(Number.isSafeInteger(sb) && Number.isSafeInteger(bb) && sb >= 1 && sb <= bb)) {
    // Said in the form, so what was typed stays (#186).
    let n = f.querySelector('.tf-note');
    if (!n) { n = document.createElement('p'); n.className = 'pl-desc pl-neterr tf-note'; f.querySelector('.cl-formacts').before(n); }
    n.textContent = 'Blinds are amounts like 1 or 0.25: the small blind at least 0.01 and no more than the big blind.';
    f.elements.sb.focus();
    return;
  }
  save(TABLE_KEY, {game: settings.game, sb, bb, seats, minBB: settings.minBB, maxBB: settings.maxBB, turnSecs: settings.turnSecs, stayHands: settings.stayHands});
  // An assistant's: the host opens it.
  if (f.dataset.code) {
    tableForm = false;
    adminCmd(f.dataset.code, {op: 'new_table', table: settings});
    render();
    return;
  }
  // The form stays open if the table can't be opened, so nothing is lost.
  hostAct('new_table', {table: settings}).then(ok => {
    if (!ok) return;
    tableForm = false;
    if (f.dataset.wizard) setWizard('invite');
    render();
  });
}

// The host watches a table (#73) on the #play page: a spectator's view from
// the engine (no one's cards before they're shown down), nothing to act on.
function watchTable(id) {
  const t = tableById(club, id);
  if (!t || !tableRunning(id)) return;
  const toPage = handlers => u => (u.type === 'closed' ? handlers.onFail('The table closed.') : handlers.onMessage(u));
  joinTableVia(handlers => {
    // An always-on club's table runs in its room: its view comes encrypted
    // over the owner's connection (#125).
    if (isRemote()) {
      owner.watch(id, toPage(handlers)).catch(e => handlers.onFail(e.message));
      return {send() {}, close: () => owner.unwatch()};
    }
    const stop = server.watch(id, toPage(handlers));
    return {send() {}, close: stop};
  }, {
    label: `${club.name} · ${t.name} (watching)`,
    watch: true,
    onLeave: why => { note = why || ''; location.hash = 'clubs/own'; },
  });
  location.hash = 'play';
}

// The member being offered the assistant role, while the host reads what it means (#190).
let offering = null;

// ---- help requests (#192) ----

// The club whose Ask for help form is open (a member's), and the help
// requests already shown as a notice in this page.
let helpForm = null;
const helpNoticed = new Set();
const clock = t => new Date(t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});

// A member's part: who's around, Ask for help, and their latest requests.
function memberHelpHtml(m, hostHere) {
  const staff = m.staff || [];
  let h = '<div class="cl-help">';
  h += staff.length
    ? `<span class="pl-meta">Around now: ${staff.map(x => (x.role === 'host' ? 'the host' : `${esc(x.name)} (assistant)`)).join(' · ')}</span>`
    : '<span class="pl-meta">No host or assistant is online right now: a help request waits for them.</span>';
  if (helpForm === m.code) {
    h += `<form class="cl-chipform" data-helpform="${esc(m.code)}"><input class="pl-text" name="text" maxlength="${MAX_HELP_TEXT}" required placeholder="What do you need? (e.g. Table 2 is stuck)">`;
    h += '<button class="btn-small primary" type="submit">Send</button><button class="btn-small" type="button" data-cl="help-cancel">Cancel</button></form>';
  } else h += `<button class="btn-small" data-cl="help-open" data-code="${esc(m.code)}"${hostHere ? '' : ' disabled'}>Ask for help</button>`;
  for (const x of [...(m.help || [])].reverse()) {
    h += `<span class="cl-help-mine"><span class="pl-meta">${clock(x.at)}</span> You: “${esc(x.text)}”`;
    if (x.reply) h += ` <b>· ${esc(x.by || 'Reply')}: “${esc(x.reply)}”</b>`;
    h += x.handled ? ' <span class="cl-up">handled</span>' : ' <span class="pl-meta">waiting</span>';
    h += '</span>';
  }
  return h + '</div>';
}

// ---- the lobby (club-lobby.js) ----

// Who's online and the lobby chat: `online` [{name, role, table}], `chat`
// [{name, text, at, host}]. `form` is the club code for a member's page,
// or 'host' for the club you run; `canSend` whether the club is reachable.
function lobbyHtml(online, chat, form, canSend) {
  let h = `<h2>Lobby</h2><div class="cl-side-card cl-lobby"><span class="pl-meta">Online now (${online.length})</span><ul class="cl-lobby-who">`;
  for (const x of online) {
    // "Host" needs no tag, and the host isn't waiting for a game.
    const tag = x.role === 'host' ? (x.name === 'Host' ? '' : 'host') : x.role;
    const at = x.table ? `at ${esc(x.table)}` : x.role === 'host' ? '' : 'waiting';
    h += `<li><span class="cl-lobby-dot" aria-hidden="true"></span><b>${esc(x.name)}</b>${tag ? ` <span class="pl-meta">${tag}</span>` : ''}${at ? `<span class="pl-meta cl-lobby-at">${at}</span>` : ''}</li>`;
  }
  h += '</ul>';
  h += chat.length
    ? `<ul class="cl-lobby-log">${chat.map(x => `<li><span class="pl-meta">${clock(x.at)}</span> <b${x.host ? ' class="cl-lobby-host"' : ''}>${esc(x.name)}</b> ${esc(x.text)}</li>`).join('')}</ul>`
    : '<p class="pl-meta">No one’s said anything yet. Waiting for a game? Say so here.</p>';
  h += `<form class="cl-lobby-form" data-lobbyform="${esc(form)}"><input class="pl-text" name="text" maxlength="${CHAT_MAX}" autocomplete="off" placeholder="Say something" aria-label="Lobby chat"${canSend ? '' : ' disabled'}>`;
  h += `<button class="btn-small primary" type="submit"${canSend ? '' : ' disabled title="Can’t reach the club right now"'}>Send</button></form>`;
  return h + '</div>';
}

// The lobby on the page of the club you run: its online list made here
// from who's connected (an always-on club's room says, in its view).
function hostLobbyHtml() {
  const remote = isRemote();
  const ids = new Set(remote ? owner.view?.online || [] : server?.online || []);
  const list = onlineList(club, ids, !remote && hostOnline);
  const chat = (club.lobby || []).filter(x => Date.now() - x.at < LOBBY_MAX_AGE_MS);
  return lobbyHtml(list, chat, 'host', remote ? owner.online : !!hostNet);
}

// The open help requests, for the host (`code` null) or an assistant of
// club `code`: who, when, from which table, with a reply and Mark handled.
function helpListHtml(list, code = null, dis = '') {
  if (!list?.length) return '';
  const c = code ? ` data-code="${esc(code)}"` : '';
  let h = `<div class="cl-needs cl-helpreqs"><h3>Help requests (${list.length})</h3><ul class="cl-list">`;
  for (const x of list) {
    h += `<li><span class="cl-name">${esc(x.name)}</span><span class="pl-meta">${clock(x.at)}${x.table ? ` · at ${esc(x.table)}` : ''}</span><span class="cl-help-text">“${esc(x.text)}”</span>`;
    if (x.reply) h += `<span class="pl-meta">Replied: “${esc(x.reply)}”</span>`;
    h += `<form class="cl-chipform" data-helpreply="${esc(x.id)}"${c}><input class="pl-text" name="reply" maxlength="${MAX_HELP_REPLY}" placeholder="Reply (optional)">`;
    h += `<button class="btn-small" type="submit"${dis}>Reply</button><button class="btn-small primary" type="button" data-cl="help-done" data-id="${esc(x.id)}"${c}${dis}>Mark handled</button></form></li>`;
  }
  return h + '</ul></div>';
}

// Answers help request `id`: from the host's page, or as an assistant.
function answerHelpReq(code, id, reply, handled) {
  if (code) adminCmd(code, {op: 'help_answer', id, reply, handled});
  else hostAct('help_answer', {id, reply, handled});
}

// New help requests for whoever runs a club here: a notice, once each.
function noticeHelp() {
  const lists = [];
  if (club) lists.push(openHelp(club));
  for (const m of memberships) if (m.role === 'assistant' && m.admin?.help) lists.push(m.admin.help);
  for (const x of lists.flat()) {
    if (helpNoticed.has(x.id)) continue;
    helpNoticed.add(x.id);
    notice(`${x.name} asks for help: “${x.text}”`, 'clubs');
  }
}
// The History tab's activity log, filtered to one person ('' for everyone),
// and to big chip moves only (#190).
let activityBy = '';
let activityBig = false;

// Closing a table asks on its own row (#186): the table being asked about.
let closingTable = null;

function tablesHtml() {
  const tables = openTables(club);
  const counts = seatedCounts();
  let h = '<h2>Tables</h2>';
  if (tables.length) {
    // A card per table (#225), cream while anyone's playing at it.
    h += '<ul class="cl-tables cl-tcards">';
    for (const t of tables) {
      const n = counts[t.id] || 0;
      h += `<li class="cl-tcard${n ? ' cream' : ''}"><span class="cl-tcard-text"><b class="cl-name">${esc(t.name)}</b><span class="cl-tcard-meta">${esc(gameLabel(t.game))} · ${chips(t.sb)}/${chips(t.bb)} · ${n} of ${t.seats} seats</span><span class="cl-tcard-meta">Buy-in ${t.minBB}–${t.maxBB} big blinds</span></span>`;
      if (t.status === 'closing') h += '<span class="cl-acts pl-meta">Closing after this hand…</span>';
      else if (closingTable === t.id) {
        h += `<span class="cl-confirm">Close ${esc(t.name)}? Everyone at it is cashed out at the end of the hand, back to their balance.`;
        h += `<button class="btn-small primary" data-cl="close-table-yes" data-table="${esc(t.id)}">Close it</button><button class="btn-small" data-cl="close-table-no">Keep it open</button></span>`;
      } else h += `<span class="cl-acts"><button class="btn-small" data-cl="watch" data-table="${esc(t.id)}"${tableRunning(t.id) ? '' : ' disabled'}>Watch</button><button class="btn-small" data-cl="close-table" data-table="${esc(t.id)}">Close</button></span>`;
      const seated = Object.values(club.members).filter(m => m.seat?.table === t.id);
      if (seated.length) h += `<span class="cl-tcard-meta cl-err">${seated.map(m => `${esc(m.name)} ${chips(m.seat.stack)}`).join(' · ')}</span>`;
      h += '</li>';
    }
    h += '</ul>';
  } else if (tableForm !== true) h += '<p class="pl-meta">No tables yet: open one, then send players the invite link.</p>';
  h += tableForm === true ? tableFormHtml() : '<div class="pl-actions"><button class="btn-small primary" data-cl="new-table">New table</button></div>';
  // The invite link is in Manage beside it (#225), and on Members.
  return h;
}

// The invite link with Copy and Share, on the Tables and Players tabs.
function inviteRowHtml() {
  let h = '<div class="pl-row"><span class="pl-label">Invite link</span><div class="pl-opts cl-link">';
  h += `<input class="pl-text" readonly value="${esc(link())}" id="cl-link">`;
  h += `<button class="btn-small" data-cl="copy">${copied ? 'Copied' : 'Copy'}</button>`;
  if (navigator.share) h += '<button class="btn-small" data-cl="share">Share…</button>';
  h += '<button class="link-btn" data-cl="revoke" title="Make a new link; the old one stops working">New link</button>';
  return h + '</div></div>';
}

// ---- a host's first night (#186) ----

// What this browser remembers about the club it runs: whether the invite
// link was shared, the checklist closed, the last backup.
const hostNoteKey = () => `ducyClubHost:${myClubCode()}`;
const hostNotes = () => load(hostNoteKey(), {});
const setHostNote = (k, v) => save(hostNoteKey(), {...hostNotes(), [k]: v});

// From a new club to a game: open a table, share the link, let players in,
// give them chips. Ticked off as they happen; gone once all are, or closed.
// A club never gives chips by itself (#395): how many is the host's choice,
// with each member's Give.
function checklistHtml() {
  const notes = hostNotes();
  if (notes.checklistHidden) return '';
  const members = membersByStatus(club, 'member');
  const steps = [
    ['Open a table', openTables(club).length > 0, 'tables'],
    ['Send players the invite link', !!notes.shared || members.length > 0, 'players'],
    ['Let them in as they ask', members.length > 0, 'players'],
    ['Give them chips: the Give button by each member', (club.chips?.issued || 0) > 0, 'players'],
  ];
  if (steps.every(s => s[1])) return '';
  const next = steps.findIndex(s => !s[1]);
  let h = '<div class="cl-checklist"><b>Get your first game going</b><ol>';
  steps.forEach(([text, done, tab], i) => {
    h += `<li class="${done ? 'done' : ''}">${done ? '✓ ' : ''}${esc(text)}`;
    if (i === next && dashTab !== tab) h += ` <button class="link-btn" data-cl="dash" data-tab="${tab}">Go</button>`;
    h += '</li>';
  });
  return h + '</ol><button class="link-btn" data-cl="checklist-hide">Hide this</button></div>';
}

// Until the club is backed up: a reminder, since without a backup nobody
// can run it again if this browser loses it.
// Connection states, the same words everywhere (#191): connected; connected
// but the club itself can't be reached; reconnecting; not connected (Try again).
const CONN = {on: 'Connected', unreachable: 'Club unreachable', reconnecting: 'Reconnecting…', off: 'Not connected'};

// A member's connection to a club (`n`, its playerNets entry), with what
// still holds while it's down.
function connText(n, meanwhile) {
  // Paused by ducy, or a trial that ended (#265): the relay's reason. Plans
  // and trials are the owner's business, on the club manager (#393).
  if (n?.blocked) return mode === 'play' && /trial/i.test(n.blocked) ? 'This club is closed for now.' : esc(n.blocked);
  if (n?.online && n.hostHere) return CONN.on;
  if (n?.online) return `${CONN.unreachable}. ${meanwhile}`;
  if (n) return `${CONN.reconnecting} ${meanwhile}`;
  return `${CONN.off}.`;
}

// A temporary club (#395, no backup of it proved): a banner back to the
// backup and proof steps. A club from before then has no such flag: it gets
// the older reminder, until a backup is made here or proved.
function backupNagHtml() {
  if (!isRemote()) return '';
  const plan = owner.view?.plan;
  if (plan?.temporary) {
    const until = plan.removesAt ? ` If no one uses it, it’s deleted on ${esc(new Date(plan.removesAt).toLocaleDateString())}.` : '';
    return `<p class="pl-desc pl-neterr cl-nag cl-temp"><b>Temporary club:</b> back it up and restore it to keep it.${until} <button class="btn-small primary" data-cl="backup-now">Back it up</button></p>`;
  }
  const notes = hostNotes();
  if (!plan || plan.provedAt || notes.backedUp || notes.backupNagHidden) return '';
  return '<p class="pl-desc pl-neterr cl-nag">No backup of this club has been made in this browser: if it loses the club, nobody can run it again. <button class="btn-small" data-cl="backup-now">Back it up</button> <button class="link-btn" data-cl="backup-nag-hide">I have one</button></p>';
}


// An amount for the screen: kept in hundredths, shown divided by 100.
const chips = n => chipText(n);
// An amount for an input box, or blank.
const amountValue = v => (v === '' || v == null ? '' : chipInput(v));

// The host's open chip form, under a member's row: {kind, id}, kind 'give',
// 'take' or 'grant' (a request, for another amount). One at a time.
let chipForm = null;

const FORM_TEXT = {
  give: m => ({label: `Give ${m.name}`, submit: 'Give', value: '', max: null, note: true}),
  take: m => ({label: `Take back from ${m.name} (has ${chips(m.balance)})`, submit: 'Take back', value: m.balance, max: m.balance, note: true}),
  grant: m => ({label: `Give ${m.name} (asked for ${chips(m.request?.amount)})`, submit: 'Give', value: m.request?.amount ?? '', max: null, note: false}),
  // Declining says why, if you like; the member sees it (#188).
  deny: m => ({label: `Decline ${m.name}’s request for ${chips(m.request?.amount)}`, submit: 'Decline', noAmount: true, note: true, notePlaceholder: 'Why (optional; they see it)'}),
  // Agents (#74, #76).
  agent: m => ({label: `Make ${m.name} an agent with a credit limit of`, submit: 'Offer', value: 0, max: null, note: false, min: 0}),
  limit: m => ({label: `${m.name}'s credit limit`, submit: 'Save', value: m.creditLimit || 0, max: null, note: false, min: 0}),
  settle: m => ({label: `Record a settlement from ${m.name} (credit used ${chips(accountOf(club, m.id).creditUsed)})`, submit: 'Record', value: accountOf(club, m.id).creditUsed || '', max: null, note: true}),
};

// A native form: the browser checks the amount (required, in steps of
// 0.01, at least 0.01, at most the balance when taking back) before it
// submits.
function chipFormHtml(m) {
  if (!chipForm || chipForm.id !== m.id) return '';
  const t = FORM_TEXT[chipForm.kind](m);
  let h = `<form class="cl-chipform" data-chipform="${chipForm.kind}" data-id="${esc(m.id)}">`;
  // Making an agent: what that means, before the limit (#190).
  if (chipForm.kind === 'agent') h += roleHtml('agent', null, m.name);
  h += `<label class="cl-formlabel" for="cl-amt">${esc(t.label)}</label>`;
  if (!t.noAmount) {
    h += `<input class="pl-text" id="cl-amt" name="amount" type="number" inputmode="decimal" required min="${chipInput(t.min ?? 1)}" step="${CHIP_STEP}"${t.max != null ? ` max="${chipInput(t.max)}"` : ''} value="${esc(amountValue(t.value))}" placeholder="Chips">`;
    // The usual amounts, from the open tables' buy-ins (#188).
    if (chipForm.kind === 'give' || chipForm.kind === 'grant') {
      for (const v of quickAmounts()) h += `<button type="button" class="cc-btn" data-cl="quick" data-v="${esc(chipInput(v))}">${chips(v)}</button>`;
    }
  }
  if (t.note) h += `<input class="pl-text" name="note" maxlength="${MAX_NOTE}" placeholder="${esc(t.notePlaceholder || 'Note (optional)')}">`;
  h += `<button class="btn-small primary" type="submit">${t.submit}</button><button class="btn-small" type="button" data-cl="cancel-form">Cancel</button></form>`;
  return h;
}

// Quick amounts for giving chips: the open tables' smallest and biggest
// buy-ins and twice the biggest, without repeats.
function quickAmounts() {
  const tables = openTables(club);
  if (!tables.length) return [];
  const min = Math.min(...tables.map(t => t.minBB * t.bb)), max = Math.max(...tables.map(t => t.maxBB * t.bb));
  return [...new Set([min, max, 2 * max])].filter(v => v > 0);
}

function openChipForm(kind, id) {
  chipForm = chipForm?.kind === kind && chipForm.id === id ? null : {kind, id};
  render();
  const input = root.querySelector('#cl-amt');
  if (input) { input.focus(); input.select(); }
}

function onSubmit(e) {
  // A promotion, new or changed (#278).
  const promoF = e.target.closest('form[data-promoform]');
  if (promoF) {
    e.preventDefault();
    let settings;
    try { settings = readPromoForm(promoF); } catch (err) { promoNote = err.message; render(); return; }
    const id = promoF.dataset.promoform;
    promoCmd(promoF.dataset.code, id ? 'edit_promo' : 'new_promo', id ? {id, promo: settings} : {promo: settings}).then(ok => { if (ok) { promoForm = null; promoNote = ''; render(); } });
    return;
  }
  // Asking for help, or replying to a request (#192).
  const hf = e.target.closest('form[data-helpform]');
  if (hf) {
    e.preventDefault();
    const code = hf.dataset.helpform;
    const at = seatedAt?.code === code ? memberships.find(x => x.code === code)?.tables?.find(t => t.id === seatedAt.table)?.name || '' : '';
    sendToHost(code, {type: 'help_ask', club: code, text: hf.elements.text.value, table: at});
    helpForm = null;
    render();
    return;
  }
  // A line in the lobby chat: a member's, or the host's.
  const lf = e.target.closest('form[data-lobbyform]');
  if (lf) {
    e.preventDefault();
    const text = cleanChat(lf.elements.text.value);
    if (!text) return;
    const code = lf.dataset.lobbyform;
    lf.elements.text.value = '';
    if (code === 'host') hostAct('lobby_say', {text});
    else sendToHost(code, {type: 'lobby_say', club: code, text});
    return;
  }
  // Your name in one club (#185).
  const nf = e.target.closest('form[data-nameform]');
  if (nf) { e.preventDefault(); nameForm = ''; setClubName(nf.dataset.nameform, nf.elements.name.value); return; }
  const hr = e.target.closest('form[data-helpreply]');
  if (hr) { e.preventDefault(); answerHelpReq(hr.dataset.code || null, hr.dataset.helpreply, hr.elements.reply.value, false); return; }
  const tf = e.target.closest('form[data-tableform]');
  if (tf) { e.preventDefault(); submitTable(tf); return; }
  // A new tournament (#77), or its payouts (#79).
  const tof = e.target.closest('form[data-tourneyform]');
  if (tof) {
    e.preventDefault();
    let tourney;
    try { tourney = readTourneyForm(tof, tEditor); } catch (err) { alert(err.message); return; }
    hostAct('new_tourney', {tourney}).then(ok => {
      if (!ok) return;
      const {name: _, opensAt: __, startsAt: ___, structure: ____, ...last} = tourney;
      save(TOURNEY_KEY, last);
      tourneyForm = false;
      render();
    });
    return;
  }
  const pf = e.target.closest('form[data-payoutform]');
  if (pf) {
    e.preventDefault();
    hostAct('set_payout', {id: pf.dataset.payoutform, places: readPayoutForm(pf)}).then(ok => { if (ok) { payoutEdit = null; render(); } });
    return;
  }
  const bf = e.target.closest('form[data-clform="backup"]');
  if (bf) { e.preventDefault(); submitBackup(bf); return; }
  const prf = e.target.closest('form[data-clform="prove"]');
  if (prf) { e.preventDefault(); submitProof(prf); return; }
  const sf = e.target.closest('form[data-clform="service"]');
  if (sf) {
    e.preventDefault();
    let args;
    try { args = readServiceForm(sf); } catch (err) { serviceNote = err.message; render(); return; }
    const id = sf.dataset.id;
    (id ? owner.run('service_update', {id, ...args}) : owner.run('service_add', args))
      .then(() => { serviceForm = null; serviceNote = ''; render(); })
      .catch(err => { serviceNote = err.message; render(); });
    return;
  }
  const gf = e.target.closest('form[data-agentform]');
  if (gf) {
    e.preventDefault();
    const amount = parseChips(gf.elements.amount.value);
    agentForm = null;
    agentCmd(gf.dataset.code, {op: gf.dataset.agentform, id: gf.dataset.id, amount});
    render();
    return;
  }
  const af = e.target.closest('form[data-adminform]');
  if (af) {
    e.preventDefault();
    const amount = parseChips(af.elements.amount.value);
    adminForm = null;
    adminCmd(af.dataset.code, {op: af.dataset.adminform, id: af.dataset.id, amount});
    render();
    return;
  }
  const f = e.target.closest('form[data-chipform]');
  if (!f) return;
  e.preventDefault();
  const id = f.dataset.id, kind = f.dataset.chipform;
  const amount = f.elements.amount ? parseChips(f.elements.amount.value) : 0;
  const why = f.elements.note?.value || '';
  chipForm = null;
  const op = {give: 'give', take: 'take', grant: 'grant', deny: 'deny', agent: 'offer_agent', limit: 'credit_limit', settle: 'settle'}[kind];
  if (op) hostAct(op, {id, amount, note: why});
}


function closeClub() {
  if (isRemote()) {
    // An always-on club keeps running on the server; this browser just stops
    // running it. Deleting the club itself comes later (#98).
    if (!confirm(`Stop running ${club?.name || 'this club'} from this browser? The club keeps running on the server for its members, and this browser can’t get back to it.`)) return;
    owner.forget();
    club = null;
    render();
    return;
  }
  if (Object.values(club.members).some(m => m.seat)) { alert('People are still at tables. Close the tables first.'); return; }
  if (!confirm(`Close ${club.name}? Its members and records are deleted from this browser.`)) return;
  server = null;
  hostNet?.close();
  hostNet = null;
  club = null;
  verifier = null;
  try { localStorage.removeItem(CLUB_KEY); localStorage.removeItem(SENDERS_KEY); } catch {}
  render();
}

// Moves this browser's club to the server as an always-on club (#98): same
// code, so members' links keep working, and they follow it there.
async function moveToAlwaysOn() {
  if (owner.record) { alert('This browser already runs an always-on club; one per browser for now.'); return; }
  if (Object.values(club.members).some(m => m.seat)) { alert('People are still at tables. Close the tables first, or wait until everyone has left them.'); return; }
  if (!confirm(`Move ${club.name} to ducy’s server? It then stays open with this page closed, and you run it from here as its owner. Members don’t need to do anything.`)) return;
  const data = JSON.parse(JSON.stringify(club)), senders = verifier.toJSON();
  // The relay takes the club only once no tab hosts it.
  hostNet?.close();
  hostNet = null;
  hostOnline = false;
  server = null;
  note = 'Moving your club to the server…';
  render();
  await new Promise(r => setTimeout(r, 800));
  try {
    await owner.moveHere(data, senders);
    try { localStorage.removeItem(CLUB_KEY); localStorage.removeItem(SENDERS_KEY); } catch {}
    club = owner.club;
    verifier = null;
    note = 'Your club now runs on the server: it stays open with this page closed.';
  } catch (e) {
    note = `The club didn’t move: ${e.message}`;
    startHosting();
  }
  render();
}

// Opens an always-on club this player owns, made in another browser (#98).
async function attachAlwaysOn(code) {
  code = normCode(code || '');
  if (!code) { alert('Enter the club’s code, like ABCD-EFGH.'); return; }
  if (owner.record) { alert('This browser already runs an always-on club; one per browser for now.'); return; }
  note = 'Looking for your club…';
  render();
  try { await owner.attach(code); note = ''; location.hash = 'clubs/own'; } catch (e) { note = e.message; }
  render();
}

// Deletes the always-on club: members are told, and it's gone from the server.
async function deleteAlwaysOn() {
  if (!confirm(`Delete ${club.name}? Its members, balances and records are deleted from the server for good, and members are told the club closed.`)) return;
  if (await hostAct('delete_club')) {
    owner.forget();
    club = null;
    note = 'The club was deleted.';
    render();
  }
}


function link() {
  const relay = relayUrl();
  return inviteLink(club, appBase(), relay !== wsUrl(DEFAULT_RELAY) ? relay : '', myName());
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
    if (mem.status === 'new' && !nameIn(mem)) { mem.error = 'Enter your name above and click Save to send your request.'; render(); return; }
    const key = (await entry.keys).pub;
    const body = mem.status === 'new'
      ? {type: 'join', club: mem.code, invite: mem.invite, name: nameIn(mem), key}
      : {type: 'hello', club: mem.code, name: nameIn(mem), since: lastEntry(mem), key};
    sendToHost(mem.code, body);
    // Back at a club table after the host (or this page) reconnected.
    if (seatedAt?.code === mem.code) sendToHost(mem.code, {type: 'table', club: mem.code, table: seatedAt.table, cmd: {type: 'join', name: nameIn(mem)}});
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
    const before = mem.status;
    const hadEntries = new Set((mem.entries || []).map(e => e.n));
    const hadTables = mem.tables ? new Set(mem.tables.map(t => t.id)) : null;
    if (await playerReceive(mem, msg)) {
      if (before !== 'member' && mem.status === 'member') {
        justJoined.add(mem.code);
        // Approved: say so wherever you are (#185).
        if (before) notice(`You’re in ${mem.name || mem.code}. Ask the host for chips to play.`);
      }
      // Chips given to you, and a table opening, wherever you are (#193).
      const cname = mem.name || mem.code;
      if (msg.body?.type === 'account') {
        const given = (mem.entries || []).filter(e => !hadEntries.has(e.n) && GIVEN.includes(e.kind) && Date.now() - e.at < 3600e3).reduce((n, e) => n + e.amount, 0);
        if (given) notice(`${cname}: you were given ${chips(given)} chips.`);
      }
      if (msg.body?.type === 'tables' && hadTables) {
        const opened = (mem.tables || []).filter(t => !hadTables.has(t.id));
        if (opened.length) notice(`${cname} opened ${opened.map(t => t.name).join(', ')}.`);
      }
      if (msg.body?.type === 'tables') checkSeatWatch(mem);
      // A promotion prize, or a new high hand (#267), wherever you are.
      // At the club's table, it's celebrated there instead (#278).
      if (msg.body?.type === 'promo_event' && mem.promoEvent) {
        if (seatedAt?.code === mem.code) celebrateAtTable(mem.promoEvent.text);
        else notice(`${cname}: ${mem.promoEvent.text}`, clubHash(mem.code));
        mem.promoEvent = null;
      }
      // The club moved to an always-on room (#98): greet it as the new host.
      if (msg.body?.type === 'host_moved') {
        entry.aes = null;
        entry.aesFor = '';
        entry.hostHere = true;
        saveMemberships();
        greet();
        render();
        return;
      }
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
    onOpen() { entry.online = true; entry.hostHere = true; entry.blocked = ''; mem.error = ''; greet(); render(); },
    // One message at a time, in order: a new host key must be in place
    // before the encrypted updates after it.
    onMessage(msg) { entry.inbox = entry.inbox.then(() => handle(msg)).catch(e => console.warn(e)); },
    // A status other than reconnecting is the relay's reason the club is
    // closed to members for now (#265).
    onStatus(s) { entry.online = !s; entry.blocked = s && s !== 'Reconnecting…' ? s : ''; render(); },
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
  if (invite.hostId === me.id) { note = 'That’s an invite to your own club.'; invite = null; clearInviteFromAddress(); render(); return; }
  // The first name given is this browser's; another one is for this club
  // only (#185).
  if (!myName()) { try { localStorage.setItem(NAME_KEY, n); } catch {} }
  let mem = memberships.find(m => m.code === invite.code);
  if (mem) {
    mem.invite = invite.invite;
    if (mem.status !== 'member' && mem.status !== 'pending') mem.status = 'new';
  } else {
    mem = newMembership(invite);
    memberships.push(mem);
  }
  if (n !== myName()) mem.myName = n; else delete mem.myName;
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
  // Clubs with a name of their own keep it (#185).
  for (const m of memberships) if (!m.myName) sendName(m);
  render();
}

// Tells a club's host the name you go by there: a pending request is sent
// (or re-sent) with it, and a member's name is updated.
function sendName(m) {
  m.error = '';
  const name = nameIn(m);
  sendToHost(m.code, m.status === 'new'
    ? {type: 'join', club: m.code, invite: m.invite, name}
    : {type: 'hello', club: m.code, name});
}

// Your name in one club (#185): its own, or this browser's. Saving the
// browser's name (or nothing) goes back to that.
function setClubName(code, name) {
  const m = memberships.find(x => x.code === code);
  if (!m) return;
  const n = String(name || '').trim().slice(0, MAX_PLAYER_NAME);
  if (n && n !== myName()) m.myName = n; else delete m.myName;
  saveMemberships();
  sendName(m);
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
    // An always-on club's hands are kept in its room (#125).
    const remoteHost = isRemote() && who === 'host' && code === club?.code;
    handLists.set(`${code}|${who}`, remoteHost ? await owner.run('hands', {limit: 100}) : await listHands(code, who));
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
const cardSpan = c => (c ? `<span class="cl-pc s-${c[1]}">${esc(c[0])}${SUIT[c[1]] || ''}</span>` : '<span class="cl-pc back"></span>');

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
  if (!rows.length) return h + `<p class="pl-meta">No hands yet${filter ? ' at this table' : ': they show here once hands are played at the club’s tables'}.</p></div>`;
  h += '<ul class="cl-list cl-handlist">';
  for (const r of rows.slice(0, 100)) {
    const mine = r.who !== 'host' ? r.seats[0] : null;
    h += `<li><span class="pl-meta">${new Date(r.at).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}</span>`;
    h += `<span>${esc(r.tableName)} #${r.hand}</span><span class="cl-chips">pot ${chips(r.pot)}</span>`;
    h += mine ? `<span class="${mine.net > 0 ? 'cl-up' : mine.net < 0 ? 'cl-down' : 'pl-meta'}">${mine.net > 0 ? '+' : ''}${chips(mine.net)}</span>` : `<span class="pl-meta">${esc(summary(r))}</span>`;
    // The deal's check (#136): fair, or what didn't check out.
    if (r.fair) h += r.fair.ok ? '<span class="cl-fair" title="Dealt from a seed every player helped make, checked by this page">Fair deal ✓</span>'
      : `<span class="cl-fair bad" title="${esc(r.fair.why)}">Deal didn’t check out</span>`;
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
  let h = `<details class="cl-history" data-keep="results:${names ? 'all' : 'mine'}"><summary>Results by table session</summary>`;
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

// A promotion prize's hand (#278): a Replay button for a ledger entry that
// names one. `who`: whose history to look in ('host', or your id).
function promoReplayBtn(e, code, who) {
  if (!e.hand || (e.kind !== 'promo' && e.kind !== 'promo_void')) return '';
  return ` <button class="link-btn" data-cl="promo-replay" data-code="${esc(code)}" data-who="${esc(who)}" data-hand="${esc(e.hand)}">Replay the hand</button>`;
}

// Opens the hand behind a prize: in the host's history by its id; in a
// member's own by the table and hand number (their record of the same hand
// was made in their browser, at a slightly different time).
async function openPromoReplay(code, who, handId) {
  const parts = String(handId).split(':');
  const at = Number(parts.pop()), hand = Number(parts.pop());
  parts.shift();
  const table = parts.join(':');
  let list = [];
  try {
    const remoteHost = isRemote() && who === 'host' && code === club?.code;
    list = remoteHost ? await owner.run('hands', {limit: 200}) : await listHands(code, who, 1000);
  } catch (e) { console.warn(e); }
  const rec = list.find(r => r.id === handId)
    || list.filter(r => r.table === table && r.hand === hand && Math.abs(r.at - at) < 30 * 60e3).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
  if (!rec) {
    alert(who === 'host' ? 'That hand is no longer in the club’s hand history.' : 'That hand isn’t in this browser’s hand history: it keeps the hands you played here, up to a limit.');
    return;
  }
  replay = {rec, frames: replayFrames(rec), i: 0, playing: null};
  render();
}

async function openReplay(id) {
  // One loaded from an always-on club's room is already in the list (#125).
  const listed = [...handLists.values()].flat().find(r => r.id === id);
  const rec = listed || await getHand(id);
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
  h += `<div class="cl-replay-head"><b>${esc(rec.tableName)} · hand ${rec.hand}</b><span class="pl-meta">${new Date(rec.at).toLocaleString()} · blinds ${chips(rec.sb)}/${chips(rec.bb)}</span><button class="link-btn" data-cl="replay-close">Close</button></div>`;
  h += `<div class="cl-replay-board">${[0, 1, 2, 3, 4].map(k => (f.board[k] ? cardSpan(f.board[k]) : '<span class="cl-pc slot"></span>')).join('')}<span class="cl-chips">Pot ${chips(f.pot)}</span></div>`;
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
  // A tournament's tables are table 'tourney:<id>' (#81): its chips are whole.
  const tourney = table.startsWith('tourney:') ? mem?.tourneys?.find(x => x.id === table.slice(8)) : null;
  const t = tourney || mem?.tables?.find(x => x.id === table);
  if (!mem || !t) return;
  joinTableVia(handlers => {
    seatedAt = {code, table, handlers};
    return {
      send: cmd => sendToHost(code, {type: 'table', club: code, table, cmd}),
      close: () => { if (seatedAt?.table === table) seatedAt = null; },
    };
  }, {
    label: `${mem.name} · ${t.name}`,
    whole: !!tourney,
    // The club's promotions for this table (#278), kept current as they change.
    banner: () => tableBannerText(mem.promos, {table, game: t.game, tourney: !!tourney}),
    onLeave: why => { seatedAt = null; note = why || ''; location.hash = clubHash(code); },
    // Each hand you played goes in your hand history (#71), as you saw it,
    // kept here a moment for checking its deal (#136).
    onHand: view => {
      if (view.seats[0]?.sitting_out || view.seats[0]?.empty) return;
      const rec = handRecord({club: code, table, tableName: t.name, game: t.game, view, who: me.id});
      handsSeen.set(Number(view.hand_number), {cards: view.seats[0]?.cards || [], board: view.board || [], rec});
      while (handsSeen.size > 8) handsSeen.delete(handsSeen.keys().next().value);
      storeHand(rec, {keep: keepHands()});
    },
  });
  handsSeen.clear();
  location.hash = 'play';
}
// The last few hands played at the club table, by hand number: your cards,
// the board and the stored record, for the fair-deal check.
const handsSeen = new Map();

function tableUpdate(u) {
  if (!seatedAt || !u) return;
  // A fair deal (#136): answer the host's round, or check a finished hand.
  if (u.type === 'fair') {
    const {code, table} = seatedAt;
    const seen = handsSeen.get(Number(u.hand));
    const check = fair.message(u, cmd => sendToHost(code, {type: 'table', club: code, table, cmd}), seen || {});
    if (check) {
      showFairCheck(check);
      if (seen?.rec) { seen.rec.fair = {ok: check.ok, why: check.why}; storeHand(seen.rec, {keep: keepHands()}); }
    }
    return;
  }
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
  for (const f of listeners) f();
  updateCalls();
  if (me) noticeHelp();
  if (!open || !root) return;
  const body = me ? viewHtml() : (view === 'clubs' || view === 'host' ? `<p class="pl-meta">${esc(note || 'Loading…')}</p>` : '');
  // Nothing for this tab: the play.js part of it stands alone.
  root.hidden = !body && !replay;
  if (root.hidden) { root.innerHTML = ''; return; }
  let h = '<div class="pl-wrap cl-wrap">' + body;
  if (replay) h += replayHtml();
  h += '</div>';
  // Messages arriving redraw the page; keep what the host is typing in an open form.
  const named = [...root.querySelectorAll('form[data-tourneyform], form[data-payoutform]')].map(fm => ({
    key: fm.dataset.tourneyform || fm.dataset.payoutform,
    values: Object.fromEntries([...fm.elements].filter(el => el.name).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value])),
  }));
  // And what's being typed for help, or as a reply to it (#192).
  const helpKey = fm => (fm.dataset.helpform ? `ask:${fm.dataset.helpform}` : `reply:${fm.dataset.helpreply}`);
  const helpTyped = [...root.querySelectorAll('form[data-helpform], form[data-helpreply]')].map(fm => [helpKey(fm), fm.elements[0].value, fm.contains(document.activeElement)]);
  const typing = root.querySelector('form[data-chipform]');
  const kept = typing && {key: typing.dataset.chipform + typing.dataset.id, values: [...typing.elements].map(el => el.value), focus: document.activeElement?.name};
  // Sections opened by hand (details with data-keep) stay open.
  const opened = new Set([...root.querySelectorAll('details[data-keep][open]')].map(d => d.dataset.keep));
  // And the page stays where it was scrolled to (#191).
  const y = window.scrollY;
  // A club name being typed (#185) survives the redraw.
  const nameTyping = root.querySelector('form[data-nameform] input');
  const nameKept = nameTyping && {v: nameTyping.value, focus: document.activeElement === nameTyping};
  // And a lobby chat line being typed.
  const lobbyTyping = root.querySelector('form[data-lobbyform] input');
  const lobbyKept = lobbyTyping && {v: lobbyTyping.value, focus: document.activeElement === lobbyTyping};
  // A backup's passwords, or the file chosen to prove it (#395): the form
  // itself is kept, since a chosen file can't be put back.
  const clForm = root.querySelector('form[data-clform="backup"], form[data-clform="prove"]');
  const clFocus = clForm?.contains(document.activeElement) && document.activeElement;
  root.innerHTML = h;
  const clFresh = clForm && root.querySelector(`form[data-clform="${clForm.dataset.clform}"]`);
  if (clFresh) { clFresh.replaceWith(clForm); if (clFocus) clFocus.focus({preventScroll: true}); }
  const lobbyInput = lobbyKept && root.querySelector('form[data-lobbyform] input');
  if (lobbyInput) { lobbyInput.value = lobbyKept.v; if (lobbyKept.focus) lobbyInput.focus({preventScroll: true}); }
  // The lobby chat shows its newest lines.
  for (const log of root.querySelectorAll('.cl-lobby-log')) log.scrollTop = log.scrollHeight;
  if (window.scrollY !== y) window.scrollTo(0, y);
  // Tabs that scroll sideways (a phone): the open one in view.
  for (const bar of root.querySelectorAll('.cl-dash-tabs')) {
    const on = bar.querySelector('.pl-tab.on');
    if (!on || bar.scrollWidth <= bar.clientWidth) continue;
    const over = on.getBoundingClientRect().right - bar.getBoundingClientRect().right;
    if (over > 0) bar.scrollLeft += over + 8;
  }
  const nameInput = nameKept && root.querySelector('form[data-nameform] input');
  if (nameInput) { nameInput.value = nameKept.v; if (nameKept.focus) nameInput.focus(); }
  for (const d of root.querySelectorAll('details[data-keep]')) if (opened.has(d.dataset.keep)) d.open = true;
  for (const [key, v, focused] of helpTyped) {
    const fm = [...root.querySelectorAll('form[data-helpform], form[data-helpreply]')].find(f => helpKey(f) === key);
    if (fm) { fm.elements[0].value = v; if (focused) fm.elements[0].focus(); }
  }
  for (const k of named) {
    const fm = root.querySelector(`form[data-tourneyform="${k.key}"], form[data-payoutform="${k.key}"]`);
    if (!fm) continue;
    for (const [name, v] of Object.entries(k.values)) {
      const el = fm.elements[name];
      if (el && !(el instanceof RadioNodeList)) { if (el.type === 'checkbox') el.checked = v; else el.value = v; }
    }
  }
  const form = root.querySelector('form[data-chipform]');
  if (kept && form && form.dataset.chipform + form.dataset.id === kept.key) {
    [...form.elements].forEach((el, i) => { if (kept.values[i] != null && el.tagName === 'INPUT') el.value = kept.values[i]; });
    if (kept.focus) form.elements[kept.focus]?.focus();
  }
}

// The current tab's part, or '' when it has nothing to show.
function viewHtml() {
  let msg = note ? `<p class="pl-desc pl-neterr">${esc(note)}</p>` : '';
  if (mode === 'manage') return msg + managerHtml();
  // Seated at a club table and looking elsewhere: the way back (#187).
  if (seatedAt && view !== 'play') {
    const mem = memberships.find(x => x.code === seatedAt.code);
    const t = seatedAt.table.startsWith('tourney:') ? mem?.tourneys?.find(x => x.id === seatedAt.table.slice(8)) : mem?.tables?.find(x => x.id === seatedAt.table);
    msg += `<p class="cl-seated">You’re at ${esc(t?.name || 'a table')}${mem ? ` (${esc(mem.name || mem.code)})` : ''}. <a class="btn-small primary" href="#play">Back to the table</a></p>`;
  }
  // Bots, Ladder and Start a game (Train and Play, #209) have nothing of the
  // clubs.
  if (view === 'play' || view === 'ladder' || view === 'quest' || view === 'host') return '';
  if (view === 'join') {
    const h = requestsHtml();
    return h || msg ? msg + h : '';
  }
  // Private clubs (V3, #225): the club the address names (shownClub), or
  // the list of your clubs. Setting up a club is on the club manager only.
  const own = club || isRemote();
  const at = shownClub();
  if (at === 'own' && own) return msg + runHereHtml() + footHtml();
  const mem = at && memberships.find(m => m.code === at && m.status === 'member');
  if (mem) return msg + memberHomeHtml(mem, helps(mem) ? helpHereHtml(mem) : '') + footHtml();
  return msg + clubListHtml() + footHtml();
}

// The player app's word on the club you run: running it is on the club
// manager.
function runHereHtml() {
  const name = club?.name || owner?.record?.name || 'Your club';
  let h = `<div class="cl-home-head"><h1 class="cl-home-name">${esc(name)}</h1></div>`;
  h += '<section class="cl-card cl-elsewhere"><p class="pl-desc">You run this club. Its tables, members, chips and settings are on the club manager, a page of its own.</p>';
  h += `<a class="tr-start" href="${managerHref('clubs/own')}">Open the club manager</a></section>`;
  return h;
}

// For a club you help run, on the player app: your staff tools are on the
// club manager.
function helpHereHtml(m) {
  const what = m.role === 'assistant' ? 'game assistant' : 'agent';
  return `<section class="cl-card cl-elsewhere"><p class="pl-desc">You’re a ${what} here: your tools are on the club manager.</p><a class="btn-small primary" href="${managerHref(clubHash(m.code))}">Open the club manager</a></section>`;
}

// The club manager (manage.html): the club you run, a club you help run, or
// the list of both with starting a club.
function managerHtml() {
  const own = club || isRemote();
  if (own && wizard?.code === myClubCode()) return wizardHtml();
  const at = shownClub();
  if (at === 'own' && own) return hostHtml() + footHtml();
  const helped = memberships.filter(helps);
  const mem = at && helped.find(m => m.code === at);
  if (mem) {
    let h = `<div class="cl-home-head"><h1 class="cl-home-name">${esc(mem.name || mem.code)}</h1>`;
    h += `<a class="link-btn" href="${playerHref(clubHash(mem.code))}">Play at this club ›</a></div>`;
    return h + manageHtml(mem) + footHtml();
  }
  const card = c => `<a class="cl-club cream" href="#${c.href}"><span class="cl-club-text"><span class="cl-club-name">${esc(c.name)}</span><span class="cl-club-who">${esc(c.who)}</span></span>${c.waiting ? `<span class="cl-pill hot">${c.waiting} need${c.waiting === 1 ? 's' : ''} you</span>` : ''}<span class="cl-club-go">Manage →</span></a>`;
  let h = '<div class="pl-head"><h1>Club manager</h1></div>';
  h += `<p class="pl-desc">Run your club, or help run one. Playing at clubs and joining them is in <a href="${playerHref('clubs')}">the ducy app</a>.</p>`;
  h += '<div class="cl-clubs">';
  if (own) {
    const members = club?.members ? membersByStatus(club, 'member').length : 0;
    h += card({href: 'clubs/own', name: club?.name || owner.record.name, who: `You run this club${members ? ` · ${members} member${members === 1 ? '' : 's'}` : ''}`, waiting: hostWaiting()});
  }
  for (const m of helped) h += card({href: clubHash(m.code), name: m.name || m.code, who: m.role === 'assistant' ? 'Game assistant' : 'Agent', waiting: helperWaiting(m)});
  h += '</div>';
  if (!own) h += `<div class="cl-club-acts">${createHtml()}</div>`;
  return h + footHtml();
}

// Which club the address shows (#225): 'own' for the one you run (#clubs/own,
// or one of its tabs, #clubs/players), a club code for one you're in
// (#clubs/c/CODE), or '' for the list.
function shownClub() {
  const p = location.hash.slice(1).split('/');
  if (p[0] !== 'clubs' || !p[1]) return '';
  if (p[1] === 'c') return decodeURIComponent(p[2] || '');
  return p[1] === 'own' || DASH_TABS.includes(p[1]) ? 'own' : '';
}
// The address of club `code`'s page.
const clubHash = code => (code && code === myClubCode() ? 'clubs/own' : code ? `clubs/c/${encodeURIComponent(code)}` : 'clubs');

// The name of the club showing, for the breadcrumb (play-section.js), or ''
// on the list.
export function clubCrumb() {
  if (!open || view !== 'clubs') return '';
  const at = shownClub();
  if (at === 'own') return club?.name || owner?.record?.name || '';
  const m = at && memberships.find(x => x.code === at && x.status === 'member');
  return m ? m.name || m.code : '';
}

// The list (#225): a card for each club (the ones you run or help run in
// cream), each opening its page; then where joining one is (#393).
function clubListHtml() {
  const own = club || isRemote();
  const card = c => {
    let h = `<a class="cl-club${c.cream ? ' cream' : ''}" href="${c.url || `#${c.href}`}"><span class="cl-club-text"><span class="cl-club-name">${esc(c.name)}</span><span class="cl-club-who">${esc(c.who)}</span></span>`;
    if (c.tables) h += `<span class="cl-pill">${c.tables} table${c.tables === 1 ? '' : 's'} open</span>`;
    else if (c.quiet) h += '<span class="cl-club-quiet">Quiet</span>';
    if (c.waiting) h += `<span class="cl-pill hot">${c.waiting} need${c.waiting === 1 ? 's' : ''} you</span>`;
    return h + `<span class="cl-club-go">${c.chips != null ? `Your chips ${chips(c.chips)}` : c.go || 'Open'} →</span></a>`;
  };
  let h = '<div class="pl-head"><h1>Private clubs</h1></div><div class="cl-clubs">';
  if (own) {
    const members = club ? membersByStatus(club, 'member').length : 0;
    // Running it is on the club manager.
    h += card({url: managerHref('clubs/own'), cream: true, name: club?.name || owner.record.name, who: `You run this club${club ? ` · ${members} member${members === 1 ? '' : 's'}` : ''}`, tables: club ? openTables(club).length : 0, waiting: hostWaiting(), quiet: !!club, go: 'Club manager'});
  }
  for (const m of memberships) {
    if (m.status === 'member') {
      const who = helps(m) ? (m.role === 'assistant' ? 'Game assistant' : 'Agent') : 'Member';
      h += card({href: clubHash(m.code), cream: helps(m), name: m.name || m.code, who, tables: (m.tables || []).length, waiting: helperWaiting(m), chips: m.balance || 0, quiet: true});
    } else h += card({href: 'join', name: m.name || m.code, who: STATUS_TEXT[m.status] || m.status, go: 'Your request'});
  }
  h += '</div>';
  // Joining is Play's Enter a code, or the invite link itself (#393).
  return h + '<p class="pl-desc">To join a club, enter its code on <a href="#lobby">Play</a>, or open the invite link its host sent you.</p>';
}

// What's waiting for you at the club you run: join and chip requests, and
// help requests; and at one you help run, as an assistant or agent.
function hostWaiting() {
  if (!club?.members) return 0;
  const ms = Object.values(club.members);
  return ms.filter(m => m.status === 'pending').length + ms.filter(m => m.status === 'member' && m.request && !m.agentOf).length + openHelp(club).length;
}
function helperWaiting(m) {
  let n = 0;
  if (m.status !== 'member') return 0;
  if (m.role === 'assistant' && m.admin) n += m.admin.pending.length + m.admin.members.filter(x => x.request).length + (m.admin.help?.length || 0);
  if (m.agent === 'yes' && m.agentView) n += m.agentView.recruits.length + m.agentView.players.filter(x => x.request).length;
  return n;
}

// Under the club tabs: only a warning when a local page uses the live relay
// (your player ID and the relay are in Player settings, #144).
function footHtml() {
  return relayWarningHtml();
}

// The Join tab: requests this browser sent, until they're answered (and
// "You're in" once approved while you were looking).
function requestsHtml() {
  const list = memberships.filter(m => m.status !== 'member' || justJoined.has(m.code));
  if (!list.length) return '';
  let h = '<section class="cl-card"><h2>Your requests</h2><ul class="cl-list">';
  for (const m of list) {
    const n = playerNets.get(m.code);
    const live = connText(n, 'Your request waits until it’s back.');
    const inNow = m.status === 'member';
    h += `<li><span class="cl-name">${esc(m.name || m.code)}</span><span class="cl-status cl-${esc(m.status)}">${inNow ? 'You’re in' : esc(STATUS_TEXT[m.status] || m.status)}</span>`;
    if (!inNow) h += `<span class="pl-meta cl-conn">${live}</span>`;
    h += '<span class="cl-acts">';
    if (inNow) h += '<a class="btn-small primary" href="#clubs">Open the club</a>';
    else {
      if (!n) h += `<button class="btn-small" data-cl="retry" data-code="${esc(m.code)}">Try again</button>`;
      h += `<button class="btn-small" data-cl="forget" data-code="${esc(m.code)}">Forget</button>`;
    }
    h += '</span>';
    // What happens next (#185).
    if (m.status === 'pending' || m.status === 'new') {
      h += `<span class="pl-desc cl-next">Next: the host lets you in, then gives you chips (play money) to play at the club’s tables. This page tells you as soon as you’re in${notifyOn() ? '' : '; to hear about it while you’re elsewhere, turn on notifications in Player settings'}.</span>`;
    } else if (inNow) {
      h += '<span class="pl-desc cl-next">Next: ask the host for chips on <a href="#clubs">Clubs</a>, then sit at one of the club’s tables.</span>';
    } else if (m.status === 'declined') {
      h += '<span class="pl-desc cl-next">If that’s a mistake, ask the host: they can let you in from a new invite link.</span>';
    }
    if (m.error) h += `<span class="pl-desc pl-neterr cl-err">${esc(m.error)}</span>`;
    h += '</li>';
  }
  return h + '</ul></section>';
}

// A notice at the bottom of the page, whichever page is showing, and from
// the system when notifications are on and the page isn't in front (#185).
let noticeTimer = null;
function notice(text, go = 'play') {
  if (document.hidden && notifyOn()) {
    try {
      const n = new Notification('ducy', {body: text, tag: 'ducy-club-notice'});
      n.onclick = () => { window.focus(); location.hash = go; n.close(); };
    } catch {}
  }
  let t = document.getElementById('cl-notice');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cl-notice';
    t.className = 'pt-toast';
    t.setAttribute('role', 'status');
    t.addEventListener('click', e => {
      if (e.target.closest('[data-notice=go]')) location.hash = t.dataset.go;
      if (e.target.closest('button')) t.hidden = true;
    });
    document.body.append(t);
  }
  t.dataset.go = go;
  t.innerHTML = `<span>${esc(text)}</span><button class="btn-small primary" data-notice="go">Open</button><button class="link-btn" aria-label="Dismiss">✕</button>`;
  t.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { t.hidden = true; }, 12_000);
}

// Clubs' Create a club card (#152, #209), when you don't run one: just a
// name. The club is always on; there's nothing else to choose here.
// Since V3 (#225), a card beside Join a club on the list.
function createHtml() {
  if (club || isRemote()) return '';
  let h = '<section class="cl-act-card"><span class="cl-act-title">Start a club</span><span class="cl-act-desc">Free for 14 days: 2 tables and 1 tournament a day.</span>';
  h += `<span class="cl-act-row"><input class="pl-text" id="cl-clubname" aria-label="Club name" maxlength="${MAX_CLUB_NAME}" placeholder="Club name" value="${esc(alwaysFailed?.name || '')}">`;
  h += `<button class="tr-start" data-cl="create">${alwaysFailed ? 'Try again' : 'Create a club'}</button></span>`;
  if (alwaysFailed) {
    h += `<p class="pl-desc pl-neterr">Couldn’t start it on ducy’s server: ${esc(alwaysFailed.reason)}</p>`;
    // Asking for permission (#265): ducy needs this player's ID to grant it.
    if (/permission/.test(alwaysFailed.reason) && me?.id) h += `<p class="pl-meta">Your player ID, for ducy: <code class="cl-id">${esc(me.id)}</code></p>`;
  }
  // Already have one (#191): its backup brings it back, here or on another device.
  h += '<span class="cl-act-desc cl-restore">Already run one? <label class="link-btn">Restore it from its backup<input type="file" data-clrestore accept=".json,application/json" hidden></label></span>';
  return h + '</section>';
}

// Setting up a club (#152, #395), one step at a time (see WIZARD_STEPS):
// back it up with a password, prove the file opens, open a first table,
// then the invite link. Skipping the backup warns first, and leaves the
// club temporary.
function wizardHtml() {
  const name = club?.name || owner?.record?.name || '';
  const setup = !!wizard.setup;
  const step = n => (setup ? `<span class="pl-meta">Step ${n} of 5</span>` : '');
  const err = backupNote ? `<p class="pl-desc pl-neterr">${esc(backupNote)}</p>` : '';
  let h = '<section class="cl-card cl-wizard">';
  if (wizard.step === 'skip') {
    h += `<h2>Skip the backup?</h2><p class="pl-desc pl-neterr"><b>Without a backup, your club can’t be recovered.</b> If this browser’s data is cleared, or you lose this device, nobody can run the club again: not its members, its chips or its history.</p>`;
    h += `<p class="pl-desc">Until you back it up, it’s a <b>temporary club</b>: everything works, but if no one uses it for 7 days it’s deleted.</p>`;
    return h + '<div class="pl-actions"><button class="tr-start" data-cl="wiz-back">Back up after all</button><button class="btn-small" data-cl="wiz-onward">Skip anyway</button></div></section>';
  }
  if (wizard.step === 'prove') {
    h += `${step(3)}<h2>Prove it works</h2><p class="pl-desc">Now open the file you just saved, and enter its password. This only checks it: nothing on this device changes.</p>`;
    h += '<form class="pl-idform" data-clform="prove">';
    h += '<label>Backup file<input class="pl-text" type="file" name="file" required accept=".json,application/json"></label>';
    h += '<label>Password<input class="pl-text" type="password" name="pw" required autocomplete="current-password"></label>';
    h += `<div class="pl-actions"><button class="tr-start" type="submit">Check it</button><button class="btn-small" type="button" data-cl="wiz-back">Make a new one</button><button class="btn-small" type="button" data-cl="${setup ? 'wiz-skip' : 'wiz-cancel'}">${setup ? 'Skip' : 'Cancel'}</button></div></form>`;
    return h + err + '</section>';
  }
  if (wizard.step === 'table') {
    if (provedNote) h += `<p class="pl-desc cl-proved">${provedNote}</p>`;
    h += `${step(4)}<h2>Your first table</h2><p class="pl-desc">Pick a game and blinds; the rest has good defaults.</p>`;
    return h + tableFormHtml('', {wizard: true}) + '</section>';
  }
  if (wizard.step === 'invite') {
    h += `${step(5)}<h2>Your invite link</h2><p class="pl-desc">Send it to your players. You let each one in as they ask, and give them chips.</p>`;
    h += club ? inviteRowHtml() : '<p class="pl-meta">Connecting to your club…</p>';
    return h + '<div class="pl-actions"><button class="tr-start" data-cl="wiz-done">Go to your club</button></div></section>';
  }
  h += setup ? `<h2>${esc(name)} is ready</h2>${step(2)}<h3>Back it up</h3>` : `<h2>Back up ${esc(name)}</h2>`;
  h += '<p class="pl-desc">The backup is a file, locked with a password you choose, that lets you run the club again from any browser if this one loses it. Then you open it once here, to prove it works.</p>';
  h += '<form class="pl-idform" data-clform="backup">';
  h += `<label>Password<input class="pl-text" type="password" name="pw" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
  h += `<label>Again<input class="pl-text" type="password" name="pw2" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
  h += '<p class="pl-desc">It isn’t kept anywhere, so if you forget it the file can’t be opened.</p>';
  h += `<div class="pl-actions"><button class="tr-start" type="submit">Save the backup</button><button class="btn-small" type="button" data-cl="${setup ? 'wiz-skip' : 'wiz-cancel'}">${setup ? 'Skip' : 'Cancel'}</button></div></form>`;
  return h + err + '</section>';
}
// What the table step says once the backup is proved.
let provedNote = '';

// The backup form: the file downloads, then the proof step.
async function submitBackup(f) {
  const pw = f.elements.pw.value;
  if (pw !== f.elements.pw2.value) { backupNote = 'The passwords don’t match.'; render(); return; }
  try {
    await backupClub(pw);
  } catch (e) {
    backupNote = e.message;
    render();
    return;
  }
  backupNote = '';
  setWizard('prove');
}

// The proof (#395): the chosen file, unlocked with its password the way a
// restore does (club-backup.js), must be this club's and hold the owner's
// player ID. The club's room then records it, signed by the owner, and the
// club isn't temporary any more.
async function submitProof(f) {
  const file = f.elements.file.files[0];
  const go = f.querySelector('[type=submit]');
  if (!file || go.disabled) return;
  go.disabled = true;
  go.textContent = 'Checking…';
  try {
    await proveClubBackup(await file.text(), f.elements.pw.value, {code: myClubCode(), ownerId: club?.ownerId || me.id});
    await owner.run('backup_proved');
  } catch (e) {
    go.disabled = false;
    go.textContent = 'Check it';
    backupNote = e.message;
    render();
    return;
  }
  backupNote = '';
  provedNote = '<b>Backed up ✓</b> Keep the file and the password safe: with both, anyone can run this club.';
  wizardOnward();
}
let backupNote = ''; // what went wrong with the backup or its proof
// The Settings tab's service form: null, 'new', or a service's id; and what's wrong with it.
let serviceForm = null, serviceNote = '';

// Saves the club's backup (#152): your player ID, which owns the club, locked
// with `password`, with the club's code and name (club-backup.js). Restoring
// it (Player settings) brings the ID back and reopens the club in that
// browser. It counts once proved (submitProof).
async function backupClub(password) {
  const code = myClubCode(), name = club?.name || owner?.record?.name || '';
  downloadFile(await clubBackupText(me, password, {code, name}), `ducy-club-${code}.json`);
  setHostNote('backedUp', Date.now());
}

// Which relay this page uses. A page served locally but using the site's
// relay is almost always a mistake when testing, so it says so.
function relayWarningHtml() {
  const relay = relayUrl();
  const live = relay === wsUrl(DEFAULT_RELAY);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (live && local) return `<p class="pl-desc pl-neterr">This local page is using the live relay (${esc(relay)}). To test against a local relay, open it with <code>?relay=ws://localhost:8788</code>; invite links then carry it.</p>`;
  return '';
}

// The club's plan (#265), from the relay: a free trial with its days left,
// or a club; and what it allows.
function planHtml(p) {
  if (!p?.limits) return '';
  const n = (k, one, many) => `${p.limits[k]} ${p.limits[k] === 1 ? one : many}`;
  const allows = `up to ${n('tables', 'table', 'tables')} open, ${n('tourneysPerDay', 'tournament', 'tournaments')} a day`;
  if (p.plan === 'trial' && p.expires) {
    const days = Math.ceil((p.expires - Date.now()) / 864e5);
    const left = days > 1 ? `${days} days left` : days === 1 ? 'last day' : 'ended';
    return `<p class="pl-meta cl-plan">Free trial club: ${left} · ${allows}. To keep it going after the trial, ask ducy.</p>`;
  }
  return `<p class="pl-meta cl-plan">Club plan: ${allows}. Need more? Ask ducy.</p>`;
}

function hostHtml() {
  if (!club && isRemote()) return `<section class="cl-card"><h2>${esc(owner.record.name)}</h2><p class="pl-meta">Connecting to your always-on club…</p></section>`;
  if (!club) return '';
  const pending = membersByStatus(club, 'pending');
  const members = membersByStatus(club, 'member');
  const remote = isRemote();
  const stalled = !remote && hostOnline && hostNet && !hostNet.healthy();
  const on = remote ? owner.online : hostOnline;
  // An always-on club shows nothing while connected (every club is always
  // on); only reconnecting, or a Reconnect button once another tab has it.
  const badge = remote ? (owner.online ? '' : owner.connected ? CONN.reconnecting : CONN.off)
    : hostOnline && !stalled ? CONN.on : hostNet ? CONN.reconnecting : CONN.off;
  // The club you run (V3 Club home, #225): its name on top; the tables and
  // tournaments, or the part of Manage picked; and beside them, Manage:
  // what needs you, then members, chips, history, settings and the link.
  let h = `<div class="cl-home-head"><h1 class="cl-home-name">${esc(club.name)}</h1>${badge ? `<span class="cl-badge${on ? ' on' : ''}">${badge}</span>` : ''}`;
  if (!remote && !hostNet) h += '<button class="btn-small" data-cl="reconnect">Reconnect</button>';
  if (remote && !owner.connected) h += '<button class="btn-small" data-cl="reconnect-owner">Reconnect</button>';
  h += `<span class="cl-home-chips">${members.length} member${members.length === 1 ? '' : 's'}</span></div>`;
  if (!remote && hostNet && (stalled || !hostOnline)) h += '<p class="pl-desc pl-neterr">The tables are paused until the connection is back: no one is folded or timed out meanwhile.</p>';
  if (!remote && !hostNet) h += '<p class="pl-desc pl-neterr">This tab isn’t hosting the club right now, so players can’t reach it from here, and changes made here reach them only when they next connect. If the club is open in another tab, use that one.</p>';
  if (!remote) h += `<p class="pl-meta">Runs in this tab · code ${esc(club.code)}</p>`;
  if (remote) h += planHtml(owner.view?.plan);
  h += backupNagHtml() + checklistHtml();
  const asking = members.filter(m => m.request && !m.agentOf).sort((a, b) => a.request.at - b.request.at);
  const helpReqs = openHelp(club);
  syncDash();
  h += '<div class="cl-home"><section class="cl-home-main">';
  const PARTS = {players: 'Members', accounting: 'Chips and ledger', promos: 'Promotions', history: 'History', settings: 'Settings'};
  if (PARTS[dashTab]) h += `<div class="cl-home-title"><h2>${PARTS[dashTab]}</h2><button class="link-btn" data-cl="dash" data-tab="tables">‹ Tables</button></div>`;
  if (dashTab === 'tables' || dashTab === 'tourneys') {
    h += tablesHtml();
    h += hostTourneysHtml(club, tourneyLive(), {form: tourneyForm, editor: tEditor, last: load(TOURNEY_KEY, {}), payoutEdit});
  } else if (dashTab === 'settings') h += settingsHtml();
  else if (dashTab === 'promos') h += hostPromosHtml(club, promoFor ? {} : {form: promoForm, note: promoNote});
  else if (dashTab === 'players') {
    h += helpListHtml(helpReqs);
    if (pending.length || asking.length) {
      h += `<div class="cl-needs"><h3>Needs you (${pending.length + asking.length})</h3><ul class="cl-list">`;
      // Letting someone in only lets them in: chips are the host's choice,
      // with Give (#395).
      for (const m of pending) {
        h += `<li><span class="cl-name">${esc(m.name)}</span><span class="pl-meta">asks to join · <code>${esc(showId(m.id))}</code>${m.agentOf && club.members[m.agentOf] ? ` · via ${esc(club.members[m.agentOf].name)}` : ''}</span>`;
        h += `<span class="cl-acts"><button class="btn-small primary" data-cl="approve" data-id="${esc(m.id)}">Let in</button><button class="btn-small" data-cl="decline" data-id="${esc(m.id)}">Decline</button></span></li>`;
      }
      for (const m of asking) {
        h += `<li><span class="cl-name">${esc(m.name)}</span><span class="cl-chips">asks for ${chips(m.request.amount)}</span>`;
        if (m.request.note) h += `<span class="pl-meta">“${esc(m.request.note)}”</span>`;
        h += `<span class="cl-acts"><button class="btn-small primary" data-cl="grant" data-id="${esc(m.id)}">Give ${chips(m.request.amount)}</button>`;
        h += `<button class="btn-small" data-cl="grant-other" data-id="${esc(m.id)}">Other amount</button><button class="btn-small" data-cl="deny" data-id="${esc(m.id)}">Decline</button></span>`;
        if (chipForm?.kind === 'grant' || chipForm?.kind === 'deny') h += chipFormHtml(m);
        h += '</li>';
      }
      h += '</ul></div>';
    }
    h += requestLogHtml();
    h += inviteRowHtml();
    h += `<h3>Members (${members.length})</h3>`;
    if (!members.length) h += `<p class="pl-meta cl-empty">No members yet: send someone the invite link above. <button class="btn-small primary" data-cl="copy">${copied ? 'Copied' : 'Copy the link'}</button></p>`;
    else {
      // Agents' players are listed under their agent (#75).
      const agents = members.filter(m => m.agent === 'yes');
      const order = members.filter(m => !m.agentOf || !agents.some(a => a.id === m.agentOf))
        .flatMap(m => (m.agent === 'yes' ? [m, ...members.filter(p => p.agentOf === m.id)] : [m]));
      h += '<ul class="cl-list">';
      for (const m of order) h += memberRowHtml(m, agents);
      h += '</ul>';
    }
  } else if (dashTab === 'accounting') h += accountingHtml();
  else {
    // Hand history (#71): the host's hands show no hidden cards.
    h += handsHtml(club.code, 'host', 'Hands at your tables');
    if (club.log?.length) {
      // Filtered by who did it (#190).
      const who = [...new Set(club.log.map(l => l.by).filter(Boolean))].map(id => [id, club.members[id]?.name || club.services?.[id]?.name || (id === club.hostId || id === club.ownerId ? 'You' : id)]);
      // Big chip moves stand out (#190): a full buy-in at the biggest open table or more.
      const big = bigMove(club);
      const bigCount = club.log.filter(l => isBigMove(l, big)).length;
      const shown = club.log.filter(l => (!activityBy || l.by === activityBy) && (!activityBig || isBigMove(l, big)));
      h += `<details class="cl-history" data-keep="activity"><summary>Activity (${club.log.length})${bigCount ? ` · <span class="cl-big">${bigCount} big</span>` : ''}</summary>`;
      const filters = [];
      if (who.length > 1) filters.push(`<select class="pl-text" data-activity="1" aria-label="Whose activity"><option value="">Everyone</option>${who.map(([id, n]) => `<option value="${esc(id)}"${activityBy === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`);
      if (big != null) filters.push(`<label class="pl-meta"><input type="checkbox" data-activitybig="1"${activityBig ? ' checked' : ''}> Only chip moves of ${chips(big)} or more</label>`);
      if (filters.length) h += `<div class="pl-row cl-activity-filters">${filters.join('')}</div>`;
      if (!shown.length) h += '<span class="pl-meta">Nothing matches these filters.</span>';
      h += '<ul>';
      for (const l of [...shown].reverse().slice(0, 100)) h += `<li${isBigMove(l, big) ? ' class="cl-bigmove"' : ''}><span class="pl-meta">${when(l.at)}</span> ${esc(l.text)}</li>`;
      h += '</ul></details>';
    }
  }
  h += '</section>';
  return h + manageSideHtml(pending, asking, helpReqs, members) + '</div>';
}

// Manage, beside the club you run's tables (#225): who's asking to join or
// for chips, answered right there (a reason to decline opens Members); help
// requests; then each part of running the club, and the invite link.
function manageSideHtml(pending, asking, helpReqs, members) {
  let h = '<aside class="cl-home-side"><h2>Manage</h2><div class="cl-side-card">';
  // Let in only lets them in: no chips come with it (#395).
  for (const m of pending) {
    h += `<div class="cl-side-ask"><span><b>${esc(m.name)}</b> asks to join</span><span class="cl-side-btns">`;
    h += `<button class="btn-small primary" data-cl="approve" data-id="${esc(m.id)}">Let in</button>`;
    h += `<button class="btn-small" data-cl="decline" data-id="${esc(m.id)}">No</button></span></div>`;
  }
  for (const m of asking) {
    h += `<div class="cl-side-ask"><span><b>${esc(m.name)}</b> asks for ${chips(m.request.amount)}</span><span class="cl-side-btns">`;
    h += `<button class="btn-small primary" data-cl="grant" data-id="${esc(m.id)}">Give</button><button class="btn-small" data-cl="deny-there" data-id="${esc(m.id)}">No</button></span></div>`;
  }
  const row = (t, label, value) => `<button type="button" class="cl-side-row${dashTab === t ? ' on' : ''}" data-cl="dash" data-tab="${dashTab === t ? 'tables' : t}"><span>${label}</span><b>${value} ›</b></button>`;
  if (helpReqs.length) h += row('players', 'Help requests', helpReqs.length);
  h += row('players', 'Members', members.length);
  h += row('accounting', 'Chips and ledger', '');
  const promosOn = (club.promos?.list || []).filter(p => p.status === 'running').length;
  const promosWaiting = (club.promos?.awards || []).filter(a => a.status === 'held').length;
  h += row('promos', 'Promotions', promosWaiting ? `${promosWaiting} to approve` : promosOn || '');
  h += row('history', 'History', '');
  h += row('settings', 'Settings', '');
  h += `<button type="button" class="cl-side-row" data-cl="copy"><span>Invite link</span><b>${copied ? 'Copied' : 'Copy'}</b></button>`;
  return h + '</div><span class="pl-meta">Only you and your game assistants see Manage.</span>' + hostLobbyHtml() + '</aside>';
}

// The club page's tab (#152): 'tables', 'players', 'accounting', 'history' or 'settings'.
let dashTab = 'tables';
const DASH_TABS = ['tables', 'tourneys', 'players', 'accounting', 'promos', 'history', 'settings'];
// The promotion form open (#278): 'new', 'new-bonus' or a promotion's id; and what's wrong with it.
let promoForm = null, promoNote = '';
// Whose promotions the form is for: '' the club you run, or the code of a
// club where you're an assistant (#274).
let promoFor = '';
// A promotion action: run here for the club you run, or sent to the host
// of a club where you're an assistant (its result comes back as the
// assistant view, or a note). Resolves to whether it went.
function promoCmd(code, op, args) {
  if (!code) return hostAct(op, args);
  adminCmd(code, {op, ...args});
  render();
  return Promise.resolve(true);
}
// The tab is remembered per club, and the address says it (#clubs/players), so
// it can be linked to (#193).
let dashFor = '';
function setDash(t) {
  if (!DASH_TABS.includes(t)) return;
  dashTab = t;
  const code = myClubCode();
  if (code) { dashFor = code; try { localStorage.setItem(`ducyClubTab:${code}`, t); } catch {} }
  if (open && view === 'clubs' && location.hash.startsWith('#clubs')) history.replaceState(null, '', `${location.pathname}${location.search}#clubs/${t}`);
}
// The club being shown changed (or the page opened): its remembered tab,
// unless the address names one.
function syncDash() {
  const code = myClubCode();
  const fromHash = location.hash.startsWith('#clubs/') ? location.hash.slice(7) : '';
  if (DASH_TABS.includes(fromHash) && fromHash !== dashTab) { setDash(fromHash); return; }
  if (!code || code === dashFor) return;
  dashFor = code;
  let t = '';
  try { t = localStorage.getItem(`ducyClubTab:${code}`) || ''; } catch {}
  dashTab = DASH_TABS.includes(t) ? t : 'tables';
}

// The Accounting tab: where the club's chips are, each member's balance and
// results, and every chip movement (the ledger).
function accountingHtml() {
  const t = totals(club);
  const names = Object.fromEntries(Object.values(club.members).map(m => [m.id, m.name]));
  const tableNames = Object.fromEntries((club.tables || []).map(x => [x.id, x.name]));
  const results = totalsByMember(tableSessions(club.chips.ledger));
  const signed = n => `<span class="${n > 0 ? 'cl-up' : n < 0 ? 'cl-down' : ''}">${n > 0 ? '+' : ''}${chips(n)}</span>`;
  let h = '<h3>Chips</h3><table class="cl-acct"><tbody>';
  h += `<tr><th>Given out</th><td>${chips(t.issued)}</td></tr>`;
  h += `<tr><th>Taken back</th><td>${chips(t.reclaimed)}</td></tr>`;
  h += `<tr class="cl-acct-sum"><th>In the club</th><td>${chips(t.issued - t.reclaimed)}</td></tr>`;
  h += `<tr><th>In balances</th><td>${chips(t.balances)}</td></tr>`;
  h += `<tr><th>On tables</th><td>${chips(t.onTables)}</td></tr>`;
  h += '</tbody></table>';
  h += t.conserved ? '<p class="pl-meta">Adds up: balances and tables hold every chip in the club.</p>'
    : '<p class="pl-desc pl-neterr">Doesn’t add up: balances and tables don’t hold every chip in the club.</p>';
  const members = membersByStatus(club, 'member').sort((a, b) => a.name.localeCompare(b.name));
  if (members.length) {
    h += '<h3>Members</h3><table class="cl-acct"><thead><tr><th>Member</th><th>Balance</th><th>On a table</th><th>Results</th></tr></thead><tbody>';
    for (const m of members) h += `<tr><th>${esc(m.name)}</th><td>${chips(m.balance)}</td><td>${m.seat ? chips(m.seat.stack) : '–'}</td><td>${signed(results[m.id] || 0)}</td></tr>`;
    h += '</tbody></table><p class="pl-meta">Results: what each member won or lost over the table sessions they finished.</p>';
  }
  h += resultsHtml(club.chips.ledger, names, tableNames);
  const ledger = club.chips.ledger;
  if (ledger.length) {
    // Filtered by member, kind and table, and exported as CSV (#188).
    const shown = ledger.filter(e => (!ledgerFilter.member || e.member === ledgerFilter.member)
      && (!ledgerFilter.kind || e.kind === ledgerFilter.kind) && (!ledgerFilter.table || e.table === ledgerFilter.table));
    const sel = (key, all, opts) => `<select class="pl-text" data-lf="${key}"><option value="">${all}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${ledgerFilter[key] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const kinds = [...new Set(ledger.map(e => e.kind))].map(k => [k, KIND_TEXT[k] || k]);
    const people = [...new Set(ledger.map(e => e.member))].map(id => [id, names[id] || id]).sort((a, b) => a[1].localeCompare(b[1]));
    const tables = [...new Set(ledger.filter(e => e.table).map(e => e.table))].map(id => [id, tableNames[id] || id]);
    h += `<details class="cl-history" data-keep="ledger"><summary>Ledger (${ledger.length})</summary>`;
    h += `<div class="pl-row cl-ledger-filters">${sel('member', 'Everyone', people)}${sel('kind', 'Everything', kinds)}${tables.length ? sel('table', 'Every table', tables) : ''}`;
    h += `<button class="btn-small" data-cl="ledger-csv">Export CSV${shown.length < ledger.length ? ` (${shown.length})` : ''}</button></div><ul>`;
    for (const e of [...shown].reverse().slice(0, 200)) {
      const sign = ['reclaim', 'buy_in', 'top_up', 'transfer_out', 'tourney_buyin', 'promo_void'].includes(e.kind) ? '−' : '+';
      h += `<li><span class="pl-meta">${when(e.at)}</span> ${esc(names[e.member] || e.member)} · ${esc(KIND_TEXT[e.kind] || e.kind)}${e.table && tableNames[e.table] ? ` (${esc(tableNames[e.table])})` : ''} <strong>${sign}${chips(e.amount)}</strong>${e.note ? ` <span class="pl-meta">“${esc(e.note)}”</span>` : ''} <span class="pl-meta">→ ${chips(e.balance)}</span>${promoReplayBtn(e, club.code, 'host')}</li>`;
    }
    h += '</ul>';
    if (shown.length > 200) h += `<p class="pl-meta">The newest 200 of ${shown.length}; Export CSV has them all.</p>`;
    if (!shown.length) h += '<p class="pl-meta">Nothing matches.</p>';
    h += '</details>';
  }
  return h;
}

// The Accounting tab's ledger filters (#188): '' for all.
let ledgerFilter = {member: '', kind: '', table: ''};

function exportLedger() {
  const names = Object.fromEntries(Object.values(club.members).map(m => [m.id, m.name]));
  const tableNames = Object.fromEntries((club.tables || []).map(x => [x.id, x.name]));
  const shown = club.chips.ledger.filter(e => (!ledgerFilter.member || e.member === ledgerFilter.member)
    && (!ledgerFilter.kind || e.kind === ledgerFilter.kind) && (!ledgerFilter.table || e.table === ledgerFilter.table));
  downloadFile(ledgerCsv(shown, names, tableNames, KIND_TEXT), `ducy-ledger-${myClubCode()}.csv`, 'text/csv');
}

// Chip requests answered lately (#188), newest first, under Needs you.
function requestLogHtml() {
  const log = club.requestLog || [];
  if (!log.length) return '';
  const name = id => club.members[id]?.name || id;
  let h = `<details class="cl-history" data-keep="reqlog"><summary>Answered requests (${log.length})</summary><ul>`;
  for (const r of [...log].reverse().slice(0, 50)) {
    const what = r.outcome === 'granted'
      ? `asked for ${chips(r.asked)}, given ${chips(r.given)}`
      : `asked for ${chips(r.asked)}, declined${r.note ? ` (“${esc(r.note)}”)` : ''}`;
    h += `<li><span class="pl-meta">${when(r.at)}</span> ${esc(name(r.member))}: ${what}${r.by ? ` <span class="pl-meta">by ${esc(name(r.by))}</span>` : ''}</li>`;
  }
  return h + '</ul></details>';
}

// A ⋯ menu (#144): items [action, label, title?, data-id?], each a button
// handled like any other data-cl click.
// `attrs`: more attributes for every item (an assistant's: the club's code).
function menuHtml(label, items, id = '', extra = '', attrs = '') {
  let h = `<details class="cl-menu"><summary class="btn-small" aria-label="${esc(label)}" title="${esc(label)}">⋯</summary><div class="cl-menu-items">`;
  for (const [act, text, title = ''] of items) h += `<button class="cl-menu-item" data-cl="${act}"${id ? ` data-id="${esc(id)}"` : ''}${attrs}${title ? ` title="${esc(title)}"` : ''}>${text}</button>`;
  return h + extra + '</div></details>';
}

// The Settings tab (#152): the rules, with good defaults; a backup; where the
// club runs; and deleting it.
function settingsHtml() {
  const remote = isRemote();
  let h = '<div class="pl-row"><span class="pl-label">Rathole</span><div class="pl-opts">';
  h += [0, 1, 2, 4, 8, 24].map(n => `<button class="cc-btn${club.ratholeHours === n ? ' on' : ''}" data-cl="rathole" data-hours="${n}">${n ? n + ' h' : 'Off'}</button>`).join('');
  h += '</div><span class="pl-desc">A player who leaves a table must come back to it with at least what they left with, for this long.</span></div>';
  h += '<div class="pl-row"><span class="pl-label">Sit-out limit</span><div class="pl-opts">';
  h += [5, 10, 15, 30, 0].map(m => `<button class="cc-btn${(club.sitOutMins ?? 10) === m ? ' on' : ''}" data-cl="sitout-mins" data-mins="${m}">${m ? m + ' min' : 'None'}</button>`).join('');
  h += '</div><span class="pl-desc">The default for new tables: someone sitting out longer gives up their seat, and their chips go back to their balance.</span></div>';
  // Asking to join with the club code alone (#393): off by default, so only
  // the invite link gets a request in. Play's Enter a code finds always-on
  // clubs only (the relay's lookup).
  if (remote) {
    h += '<div class="pl-row"><span class="pl-label">Join by code</span><div class="pl-opts">';
    h += [[false, 'Off'], [true, 'On']].map(([on, text]) => `<button class="cc-btn${(club.codeJoin === true) === on ? ' on' : ''}" data-cl="code-join" data-on="${on ? 1 : 0}">${text}</button>`).join('');
    h += `</div><span class="pl-desc">Let people ask to join with the club code, ${esc(club.code)}, as well as the invite link. You still let everyone in.</span></div>`;
  }
  h += `<div class="pl-row"><span class="pl-label">Keep hands</span><div class="pl-opts">${[1, 7, 30].map(d => `<button class="cc-btn${(club.keepDays ?? HOST_KEEP_DAYS) === d ? ' on' : ''}" data-cl="keep-days" data-days="${d}">${d} day${d > 1 ? 's' : ''}</button>`).join('')}</div><span class="pl-desc">How long the hands at your tables are kept for the history.</span></div>`;
  // Outside servers that give chips (club-services.js): an always-on club's room answers them.
  if (remote) h += servicesHtml(club, {form: serviceForm, note: serviceNote});
  h += '<h3>Backup</h3>';
  if (remote) {
    h += '<p class="pl-desc">A file, locked with a password, that lets you run the club again from any browser if this one loses it.</p>';
    // A backup counts once proved (#395), on any device: the relay keeps when.
    const last = hostNotes().backedUp, plan = owner.view?.plan;
    if (plan?.temporary) h += '<p class="pl-meta pl-neterr">Temporary club: no backup of it has been proved yet.</p>';
    else if (plan?.provedAt) h += `<p class="pl-meta">Backed up ✓ Last proved ${esc(new Date(plan.provedAt).toLocaleString())}.</p>`;
    if (last) h += `<p class="pl-meta">Last backup made from this browser ${esc(new Date(last).toLocaleString())}.</p>`;
    h += '<div class="pl-actions"><button class="btn-small" data-cl="backup">Back up the club</button></div>';
    // Moving devices (#191): the backup is the way.
    h += '<p class="pl-desc"><b>Running it from another device too</b> (your phone, say): back it up here, then on that device open the club manager and, under Start a club, choose “Restore it from its backup”. The backup also brings your player ID, so that device is you. One device at a time runs the club: the other shows Reconnect.</p>';
  } else h += '<p class="pl-desc">A club run in this tab is kept in this browser only. Move it to always on to back it up.</p>';
  h += `<h3>Delete</h3><div class="pl-actions">${remote ?'<button class="btn-small" data-cl="delete-always">Delete club</button><button class="link-btn" data-cl="close">Stop running it from this browser</button>' :'<button class="btn-small" data-cl="move-always" title="Run it on ducy’s server, so it stays open with this page closed">Move to always on</button><button class="btn-small" data-cl="close">Delete club</button>'}</div>`;
  return h;
}

// One member on the host's dashboard: balance, chips on a table, and what the
// host can do. An agent shows their account and credit (#75, #76); a player
// under an agent is indented, and any non-agent can be assigned to an agent.
function memberRowHtml(m, agents) {
  const under = m.agentOf && club.members[m.agentOf];
  let h = `<li class="${under ? 'cl-under' : ''}"><span class="cl-name">${esc(m.name)}</span><code>${esc(showId(m.id))}</code><span class="cl-chips" title="Club balance">${chips(m.balance)} chips</span>`;
  if (m.seat) h += `<span class="pl-meta">${chips(m.seat.stack)} on a table</span>`;
  if (m.agent === 'yes') {
    const a = accountOf(club, m.id);
    h += `<span class="pl-meta">agent · account ${chips(a.total)} · credit used ${chips(a.creditUsed)}/${chips(a.limit)}</span>`;
  }
  if (m.role === 'assistant') h += '<span class="pl-meta">assistant</span>';
  else if (m.role === 'offered') h += '<span class="pl-meta">offered assistant</span>';
  if (m.agent === 'offered') h += '<span class="pl-meta">offered agent</span>';
  // Giving and taking chips stay in view; the rest is in the row's menu (#143).
  h += `<span class="cl-acts"><button class="btn-small" data-cl="give" data-id="${esc(m.id)}">Give</button>`;
  h += `<button class="btn-small" data-cl="take" data-id="${esc(m.id)}"${m.balance > 0 ? '' : ' disabled'}>Take back</button>`;
  const items = [];
  if (m.role === 'assistant') items.push(['revoke-role', 'Stop being an assistant']);
  else if (m.role === 'offered') items.push(['revoke-role', 'Withdraw the assistant offer']);
  else items.push(['offer-role', 'Make assistant', `Let ${m.name} help run the club`]);
  if (m.agent === 'yes') items.push(['settle', 'Record a settlement'], ['limit', 'Credit limit'], ['revoke-agent', 'Stop being an agent']);
  else if (m.agent === 'offered') items.push(['revoke-agent', 'Withdraw the agent offer']);
  else if (!m.agentOf) items.push(['make-agent', 'Make agent', `Let ${m.name} bring in and back players`]);
  items.push(['remove', 'Remove from the club']);
  // Their agent is picked in the menu too (#193): the row fits a phone.
  const picker = !m.agent && agents.length
    ? `<label class="cl-menu-item cl-assign">Agent <select class="pl-text" data-assign="${esc(m.id)}"><option value="">none</option>${agents.map(a => `<option value="${esc(a.id)}"${m.agentOf === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`
    : '';
  h += menuHtml(`More for ${m.name}`, items, m.id, picker) + '</span>';
  if (chipForm && chipForm.kind !== 'grant' && chipForm.kind !== 'deny') h += chipFormHtml(m);
  // Making an assistant: what they'll be able to do, then Offer (#190).
  if (offering === m.id) {
    h += `<div class="cl-offer-confirm">${roleHtml('assistant', null, m.name)}`;
    h += `<span><button class="btn-small primary" data-cl="offer-role-yes" data-id="${esc(m.id)}">Offer it</button> <button class="btn-small" data-cl="offer-role-no">Cancel</button></span></div>`;
  }
  return h + '</li>';
}

// The clubs you're in: on Clubs ('play' here) your balance, chips and
// tables; and, picked at the top of Clubs ('clubs'), the ones you help run.
const helps = m => m.status === 'member' && (m.role === 'assistant' || m.agent === 'yes');

// The name you go by in a club (#185), with a way to change it for that
// club only. `nameForm`: the club whose name is being edited.
let nameForm = '';
function clubNameHtml(m) {
  const code = esc(m.code);
  if (nameForm !== m.code) {
    return `<p class="pl-meta cl-myname">You’re <b>${esc(nameIn(m))}</b> in this club${m.myName ? '' : ' (your name in Player settings)'}. <button class="link-btn" data-cl="myname" data-code="${code}">Change</button></p>`;
  }
  let h = `<form class="pl-row cl-myname" data-nameform="${code}"><label class="pl-label" for="cl-myname-${code}">Your name in ${esc(m.name || m.code)}</label>`;
  h += `<input class="pl-text" id="cl-myname-${code}" name="name" maxlength="${MAX_PLAYER_NAME}" value="${esc(nameIn(m))}" placeholder="${esc(myName())}">`;
  h += '<button class="btn-small primary" type="submit">Save</button><button class="btn-small" type="button" data-cl="myname-cancel">Cancel</button></form>';
  if (m.myName) h += `<p class="pl-meta">Leave it as ${esc(myName() || 'empty')} to use your name in Player settings here too.</p>`;
  return h;
}

// A club you help run: Manage, with the game assistant's or agent's tools.
function manageHtml(m) {
  const hostHere = !!playerNets.get(m.code)?.hostHere;
  let h = `<section class="cl-card cl-manage"><div class="cl-title"><h2>Manage</h2><span class="cl-status cl-member">${m.role === 'assistant' ? 'Game assistant' : 'Agent'}</span></div>`;
  if (m.role === 'assistant') h += adminHtml(m, hostHere);
  if (m.agent === 'yes') h += agentHtml(m, hostHere);
  return h + '</section>';
}

// A club's page for its member (V3 Club home, #225): the club's name and
// your chips on top (then Manage, `manage`, for one you help run); its
// tables and tournaments, or your chips or hands when picked; and beside
// them, You here: asking for chips, your history, help and your name.
function memberHomeHtml(m, manage = '') {
  const n = playerNets.get(m.code);
  const hostHere = !!n?.hostHere, online = !!n?.online;
  const code = esc(m.code);
  const mismatch = m.entries?.length && m.ledgerOk === false;
  let h = `<div class="cl-home-head"><h1 class="cl-home-name">${esc(m.name || m.code)}</h1>`;
  h += `<span class="cl-home-chips"${m.entries?.length && !mismatch ? ' title="Your copy of the ledger adds up to this balance"' : ''}>Your chips ${chips(m.balance)}</span></div>`;
  if (!(n?.online && n.hostHere)) h += `<p class="pl-meta cl-conn">${connText(n, 'Your seat and chips are kept.')}${n ? '' : ` <button class="btn-small" data-cl="retry" data-code="${code}">Try again</button>`}</p>`;
  if (m.error) h += `<p class="pl-desc pl-neterr cl-err">${esc(m.error)}</p>`;
  // No backup of the club proved yet (#395): it may not last.
  if (m.temporary) h += '<p class="pl-meta cl-temp">Temporary club: its owner hasn’t backed it up yet. If no one uses it for 7 days, it’s deleted.</p>';
  if (mismatch) h += '<p class="pl-desc pl-neterr">Your copy of the ledger doesn’t add up to the balance the host reports.</p>';
  if (m.role === 'offered') {
    h += `<div class="cl-account cl-offer"><span>The host asked you to be a <b>game assistant</b>.</span>${roleHtml('assistant')}`;
    h += `<span><button class="btn-small primary" data-cl="role-yes" data-code="${code}">Accept</button> <button class="btn-small" data-cl="role-no" data-code="${code}">No thanks</button></span></div>`;
  }
  if (m.agent === 'offered') {
    h += `<div class="cl-account cl-offer"><span>The host asked you to be an <b>agent</b>.</span>${roleHtml('agent', m.creditLimit || 0)}`;
    h += `<span><button class="btn-small primary" data-cl="agent-yes" data-code="${code}">Accept</button> <button class="btn-small" data-cl="agent-no" data-code="${code}">No thanks</button></span></div>`;
  }
  h += manage;
  const tab = memberTab(m.code);
  h += '<div class="cl-home"><section class="cl-home-main">';
  if (tab === 'chips' || tab === 'history') {
    h += `<div class="cl-home-title"><h2>${tab === 'chips' ? 'Your chips' : 'Your hands'}</h2><button class="link-btn" data-cl="mtab" data-code="${code}" data-tab="tables">‹ Tables</button></div>`;
    if (tab === 'chips') {
      if (m.entries?.length) {
        h += '<ul class="cl-ledger">';
        for (const e of [...m.entries].reverse().slice(0, 50)) {
          const sign = ['reclaim', 'buy_in', 'top_up', 'transfer_out', 'tourney_buyin', 'promo_void'].includes(e.kind) ? '−' : '+';
          h += `<li><span class="pl-meta">${when(e.at)}</span> ${esc(KIND_TEXT[e.kind] || e.kind)} <strong>${sign}${chips(e.amount)}</strong>${e.note ? ` <span class="pl-meta">“${esc(e.note)}”</span>` : ''} <span class="pl-meta">→ ${chips(e.balance)}</span>${promoReplayBtn(e, code, me.id)}</li>`;
        }
        h += '</ul>';
      } else h += '<p class="pl-meta">No chips in or out yet.</p>';
    } else {
      h += handsHtml(m.code, me.id, 'Your hands');
      const tableNames = Object.fromEntries((m.tables || []).map(t => [t.id, t.name]));
      h += resultsHtml(m.entries || [], null, tableNames);
    }
  } else {
    h += '<h2>Tables</h2>' + memberTablesHtml(m, hostHere);
    const tours = memberTourneysHtml(m, me.id, {hostHere, playing: seatedAt?.code === m.code && seatedAt.table.startsWith('tourney:') ? seatedAt.table.slice(8) : null});
    if (tours) h += '<h2>Tournaments</h2>' + tours;
    const promos = memberPromosHtml(m.promos);
    if (promos) h += '<h2>Promotions</h2>' + promos;
  }
  h += '</section><aside class="cl-home-side"><h2>You here</h2><div class="cl-side-card">';
  // New and without chips: the first step, with the biggest buy-in at the
  // club's tables to ask for (#185).
  const fresh = !m.request && !m.balance && !m.entries?.length;
  const suggest = fresh ? Math.max(0, ...(m.tables || []).map(t => t.max || 0)) : 0;
  if (fresh) h += `<p class="cl-next"><b>You’re in.</b> Ask the host for chips (play money) to play${suggest ? `: ${chips(suggest)} covers the biggest buy-in here` : ''}.</p>`;
  if (m.request) {
    h += `<p class="cl-side-note">You asked for ${chips(m.request.amount)}${m.request.note ? ` (“${esc(m.request.note)}”)` : ''}; waiting for the host. `;
    h += `<button class="btn-small" data-cl="cancel-ask" data-code="${code}"${online ? '' : ' disabled title="Can’t reach the club right now"'}>Cancel</button></p>`;
  } else {
    if (m.cancelQueued) h += '<p class="cl-side-note">You cancelled your request. The host will see that when they’re back.</p>';
    // How your last request went, for a week (#188).
    const a = m.answer;
    if (a && Date.now() - a.at < 7 * 24 * 3600e3) {
      h += a.outcome === 'granted'
        ? `<p class="cl-side-note cl-answer">You asked for ${chips(a.asked)} and were given ${chips(a.given)} (${when(a.at)}).</p>`
        : `<p class="cl-side-note cl-answer">Your request for ${chips(a.asked)} was declined${a.note ? `: “${esc(a.note)}”` : ''} (${when(a.at)}).</p>`;
    }
    h += `<div class="cl-ask"><input class="pl-text" type="number" min="0.01" step="${CHIP_STEP}" placeholder="Chips" aria-label="Chips to ask for" data-ask-amt="${code}"${suggest ? ` value="${esc(chipInput(suggest))}"` : ''}>`;
    h += `<input class="pl-text" maxlength="${MAX_NOTE}" placeholder="Note (optional)" aria-label="Note" data-ask-note="${code}">`;
    h += `<button class="btn-small primary" data-cl="ask" data-code="${code}"${hostHere ? '' : ' disabled title="Can’t reach the club right now"'}>Ask for chips</button></div>`;
  }
  const row = (t, label, value) => `<button type="button" class="cl-side-row${tab === t ? ' on' : ''}" data-cl="mtab" data-code="${code}" data-tab="${tab === t ? 'tables' : t}"><span>${label}</span><b>${value} ›</b></button>`;
  h += row('chips', 'Chips history', m.entries?.length || 0);
  h += row('history', 'Your hands', '');
  h += '</div>';
  h += memberHelpHtml(m, hostHere);
  if (m.lobby) h += lobbyHtml(m.lobby.online, m.lobby.chat, m.code, hostHere);
  h += clubNameHtml(m);
  h += `<button class="link-btn cl-forget" data-cl="forget" data-code="${code}">Forget this club</button>`;
  return h + '</aside></div>';
}

const KIND_TEXT = {issue: 'Given by the host', grant: 'Request granted', reclaim: 'Taken back by the host', buy_in: 'Bought in', top_up: 'Topped up', top_up_refund: 'Top-up handed back (over the table maximum)', cash_out: 'Cashed out', transfer_in: 'Received chips', transfer_out: 'Gave chips', settle: 'Settlement recorded', tourney_buyin: 'Tournament buy-in', tourney_refund: 'Tournament buy-in refunded', tourney_prize: 'Tournament prize', promo: 'Promotion prize', promo_void: 'Promotion prize voided'};

// What a member's club page shows in its main column (#193, #225): the
// tables and tournaments, or your chips history or hands. Remembered per club.
const MEMBER_TABS = ['tables', 'chips', 'history'];
function memberTab(code) {
  let t = '';
  try { t = localStorage.getItem(`ducyMemberTab:${code}`) || ''; } catch {}
  return MEMBER_TABS.includes(t) ? t : 'tables';
}
function setMemberTab(code, t) {
  if (!MEMBER_TABS.includes(t)) return;
  try { localStorage.setItem(`ducyMemberTab:${code}`, t); } catch {}
}

// A member's Tables tab: their last session while it's recent (#187), and
// the open tables with Sit, or why not.
function memberTablesHtml(m, hostHere) {
  let h = '';
  const last = tableSessions(m.entries || []).find(s => !s.open);
  if (last && Date.now() - last.end < 24 * 3600e3) {
    const where = (m.tables || []).find(t => t.id === last.table)?.name || 'a table';
    const net = last.net > 0 ? `+${chips(last.net)}` : chips(last.net);
    h += `<p class="pl-desc cl-last">Last session at ${esc(where)}: in ${chips(last.put)}, out ${chips(last.took)} → <b class="${last.net > 0 ? 'cl-up' : last.net < 0 ? 'cl-down' : ''}">${net}</b></p>`;
  }
  if (!m.tables?.length) return h + `<p class="pl-meta cl-empty">No tables open right now. <button class="btn-small" data-cl="help-open" data-code="${esc(m.code)}"${hostHere ? '' : ' disabled'}>Ask for one</button></p>`;
  // A card per table (V3 Club home, #225): cream when there's a seat for you.
  h += '<ul class="cl-tables cl-tcards">';
  for (const t of m.tables) {
    const here = seatedAt?.code === m.code && seatedAt.table === t.id;
    // The buy-in you'd need here, the rathole rule included (#187).
    const r = buyInRange(t, m.entries || [], m.rathole || 0);
    const free = t.seats - t.taken;
    // Why you can't sit, when you can't (#187).
    const atOther = seatedAt && !here ? (seatedAt.code === m.code ? (m.tables.find(x => x.id === seatedAt.table)?.name || 'another table') : 'another club’s table') : '';
    const why = !hostHere ? 'Can’t reach the club right now' : atOther ? `You’re at ${atOther}: leave it first` : free <= 0 ? 'Full' : '';
    h += `<li class="cl-tcard${here || !why ? ' cream' : ''}"><span class="cl-tcard-text"><b class="cl-name">${esc(t.name)}</b>`;
    h += `<span class="cl-tcard-meta">${esc(gameLabel(t.game))} · ${chips(t.sb)}/${chips(t.bb)} · ${t.taken} of ${t.seats} seats · ${free > 0 ? `${free} open` : 'full'}</span>`;
    h += `<span class="cl-tcard-meta">Buy-in ${chips(r.min)}–${chips(r.max)}</span></span>`;
    if (r.rathole && r.rathole > t.min) h += `<span class="pl-meta cl-why">You left this table with ${chips(r.rathole)} less than ${m.rathole} h ago, so you buy back in with at least that.</span>`;
    // The hit-and-run rule, before you sit.
    if (t.stayHands > 0) h += `<span class="pl-meta cl-why">Once you’re up here, you play ${t.stayHands} more hands before you can leave.</span>`;
    if (here) h += '<button class="btn-small primary" data-cl="to-table">Back to the table</button>';
    else {
      if (free > 0 || why !== 'Full') h += `<button class="btn-small primary" data-cl="sit" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${why ? ` disabled title="${esc(why)}"` : ''}>Sit down</button>`;
      if (why && why !== 'Full') h += `<span class="pl-meta cl-why">${esc(why)}</span>`;
      // Full: no need to keep checking (#187).
      if (t.taken >= t.seats) {
        const k = `data-code="${esc(m.code)}" data-table="${esc(t.id)}"`;
        h += seatWatch.has(watchKey(m.code, t.id))
          ? `<span class="pl-meta cl-why">This page tells you when a seat is free${notifyOn() ? '' : ' (to hear about it while you’re in another tab, turn on notifications in Player settings)'}. <button class="link-btn" data-cl="seat-unwatch" ${k}>Stop</button></span>`
          : `<button class="btn-small" data-cl="seat-watch" ${k}>Tell me when a seat is free</button>`;
      }
    }
    h += '</li>';
  }
  return h + '</ul>';
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
  h += `<input class="pl-text" id="cl-gamt" name="amount" type="number" inputmode="decimal" required min="0.01" step="${CHIP_STEP}"${kind === 'take' ? ` max="${chipInput(x.balance)}"` : ''} value="${esc(amountValue(value))}" placeholder="Chips">`;
  h += `<button class="btn-small primary" type="submit">${kind === 'take' ? 'Take back' : 'Give'}</button><button class="btn-small" type="button" data-cl="cancel-gform">Cancel</button></form>`;
  return h;
}

// The agent's link: like the club's, with their own invite token, so the
// people who use it are their players.
function agentLink(m) {
  const u = new URL(appBase());
  u.search = '';
  u.searchParams.set('club', m.code);
  u.searchParams.set('invite', m.agentView.invite);
  u.searchParams.set('host', m.hostId);
  // What the link opens on says which club, and that it's from you (#185).
  if (m.name) u.searchParams.set('name', m.name);
  if (nameIn(m)) u.searchParams.set('by', nameIn(m));
  const relay = relayUrl();
  if (relay !== wsUrl(DEFAULT_RELAY)) u.searchParams.set('relay', relay);
  u.hash = 'join';
  return u.toString();
}

function agentHtml(m, hostHere) {
  const a = m.agentView;
  let h = '<div class="cl-account cl-admin"><b>Agent tools</b>';
  if (!hostHere) h += `<span class="pl-meta">${UNREACHABLE}</span>`;
  if (m.adminNote) h += `<span class="pl-neterr">${esc(m.adminNote)}</span>`;
  if (!a) return h + '<span class="pl-meta">Loading…</span></div>';
  const dis = hostHere ? '' : ' disabled';
  h += `<span>Your account: <b class="cl-chips">${chips(a.total)}</b> <span class="pl-meta">(your balance ${chips(a.own)} + your players’ ${chips(a.shares)})</span></span>`;
  h += `<span class="${a.creditUsed ? 'cl-down' : 'pl-meta'}">Credit used ${chips(a.creditUsed)} of ${chips(a.limit)} · you can still give out ${chips(Math.max(0, a.room))}</span>`;
  // Close to the limit: say so before a grant fails (#190).
  if (a.limit && a.creditUsed >= 0.8 * a.limit) h += `<span class="pl-neterr">You’ve used ${Math.round((100 * a.creditUsed) / a.limit)}% of your credit: settle with the host, or take chips back from your players, to give out more.</span>`;
  if (a.settlements?.length) {
    h += `<details class="cl-history" data-keep="settle:${esc(m.code)}"><summary>Settlements recorded (${a.settlements.length})</summary><ul>`;
    for (const s of [...a.settlements].reverse()) h += `<li><span class="pl-meta">${when(s.at)}</span> ${chips(s.amount)}${s.note && s.note !== 'Settlement' ? ` <span class="pl-meta">“${esc(s.note)}”</span>` : ''}</li>`;
    h += '</ul></details>';
  }
  h += `<div class="pl-row"><span class="pl-label">Your link</span><div class="pl-opts cl-link"><input class="pl-text" readonly value="${esc(agentLink(m))}" data-aglink="${esc(m.code)}"><button class="btn-small" data-cl="ag-copy" data-code="${esc(m.code)}">Copy</button></div></div>`;
  const btn = (act, x, label, extra = '') => `<button class="btn-small${extra}" data-cl="${act}" data-code="${esc(m.code)}" data-id="${esc(x.id)}"${dis}>${label}</button>`;
  if (a.recruits.length) {
    h += `<span class="pl-meta">Asking to join through you (${a.recruits.length})</span><ul class="cl-list">`;
    for (const x of a.recruits) h += `<li><span class="cl-name">${esc(x.name)}</span><code>${esc(showId(x.id))}</code><span class="cl-acts">${btn('ag-approve', x, 'Approve', ' primary')}${btn('ag-decline', x, 'Decline')}</span></li>`;
    h += '</ul>';
  }
  h += `<span class="pl-meta">Your players (${a.players.length})</span>`;
  if (!a.players.length) h += '<span class="pl-meta">No players yet. Send someone your link.</span>';
  else {
    h += '<ul class="cl-list">';
    for (const x of a.players) {
      h += `<li><span class="cl-name">${esc(x.name)}</span><span class="cl-chips">${chips(x.balance)} chips</span>${x.seated ? '<span class="pl-meta">at a table</span>' : ''}`;
      // How they've done at the tables (#190).
      if (x.result) h += `<span class="${x.result > 0 ? 'cl-up' : 'cl-down'}" title="Won or lost over finished table sessions">${x.result > 0 ? '+' : ''}${chips(x.result)} at the tables</span>`;
      if (x.request) h += `<span class="pl-meta">asks for ${chips(x.request.amount)}</span>`;
      h += '<span class="cl-acts">';
      h += x.request ? `${btn('ag-grant', x, 'Give', ' primary')}${btn('ag-deny', x, 'Decline')}` : btn('ag-give', x, 'Give');
      h += `${btn('ag-take', x, 'Take back')}</span>${agentFormHtml(m.code, x)}</li>`;
    }
    h += '</ul>';
  }
  return h + '</div>';
}

// The tools when the club can't be reached (#190): with always-on clubs,
// that's the connection, not the host being away.
const UNREACHABLE = 'Can’t reach the club right now: these work again once it’s back.';

// What each role may and may not do (#190), for the offer and for the host
// making it.
const ROLE_TEXT = {
  assistant: {
    name: 'game assistant',
    can: ['let players in or decline them', 'give chips from your own balance, and answer chip requests', 'open and close tables', 'set up and run promotions, and pay or void their prizes', 'remove members (not other assistants)'],
    cannot: ['create chips: what you give comes out of your balance (promotion prizes are the club’s)', 'change the club’s settings, backups or roles'],
    note: 'The host sees everything you do in their activity log.',
    hostNote: 'You’ll see everything they do in the History tab’s activity log.',
  },
  agent: {
    name: 'agent',
    can: ['bring in your own players with your own invite link', 'give your players chips from your balance, on credit up to your limit', 'take chips back from them and answer their requests'],
    cannot: ['create chips, or act for members who aren’t your players'],
    note: 'Credit you use is settled with the host outside ducy; they record each settlement.',
    hostNote: 'They settle the credit they use with you outside ducy; you record each settlement.',
  },
};

// The role explained to the member offered it, or, given their `name`, to
// the host offering it (in the third person).
function roleHtml(kind, limit = null, name = '') {
  const r = ROLE_TEXT[kind];
  const them = t => (name ? t.replace(/\byour\b/g, 'their').replace(/\byou\b/g, 'they') : t);
  let h = `<div class="cl-role"><span>As ${kind === 'agent' ? 'an' : 'a'} <b>${r.name}</b>${limit != null ? ` (credit limit ${chips(limit)})` : ''}, ${name ? esc(name) : 'you'} can:</span><ul>`;
  h += r.can.map(t => `<li>${esc(them(t))}</li>`).join('') + `</ul><span>${name ? 'They' : 'You'} can’t:</span><ul>`;
  h += r.cannot.map(t => `<li>${esc(them(t))}</li>`).join('') + '</ul>';
  return h + `<span class="pl-meta">${esc(name ? r.hostNote : r.note)}</span></div>`;
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
  h += `<input class="pl-text" id="cl-aamt" name="amount" type="number" inputmode="decimal" required min="0.01" step="${CHIP_STEP}" value="${grant ? esc(amountValue(x.request?.amount)) : ''}" placeholder="Chips">`;
  h += '<button class="btn-small primary" type="submit">Give</button><button class="btn-small" type="button" data-cl="cancel-aform">Cancel</button></form>';
  return h;
}

// An assistant's tools (#190): the host's dashboard, with the tabs and
// actions an assistant has. Tables, Players and Promotions (#274), laid out
// as the host's; Tournaments, Accounting, History and Settings stay the
// host's. The tab is remembered per club, as the host's is.
const ADMIN_TABS = ['tables', 'players', 'promos'];
function adminTab(code) {
  let t = '';
  try { t = localStorage.getItem(`ducyClubTab:${code}`) || ''; } catch {}
  return ADMIN_TABS.includes(t) ? t : 'players';
}
function setAdminTab(code, t) {
  if (!ADMIN_TABS.includes(t)) return;
  try { localStorage.setItem(`ducyClubTab:${code}`, t); } catch {}
}

function adminHtml(m, hostHere) {
  const a = m.admin;
  let h = '<div class="cl-admin">';
  if (!hostHere) h += `<p class="pl-meta">${UNREACHABLE}</p>`;
  if (m.adminNote) h += `<p class="pl-desc pl-neterr">${esc(m.adminNote)}</p>`;
  if (!a) return h + '<p class="pl-meta">Loading…</p></div>';
  const dis = hostHere ? '' : ' disabled';
  const code = esc(m.code);
  const btn = (act, x, label, extra = '') => `<button class="btn-small${extra}" data-cl="${act}" data-code="${code}" data-id="${esc(x.id)}"${dis}>${label}</button>`;
  const asking = a.members.filter(x => x.request).sort((x, y) => (x.request.at || 0) - (y.request.at || 0));
  const waiting = a.pending.length + asking.length + (a.help?.length || 0);
  const open = a.tables.filter(t => t.status !== 'closed');
  const closed = a.tables.filter(t => t.status === 'closed');
  const tab = adminTab(m.code);
  const sub = (id, label) => `<button class="pl-tab${tab === id ? ' on' : ''}" role="tab" aria-selected="${tab === id}" data-cl="atab" data-code="${code}" data-tab="${id}">${label}</button>`;
  const players = `Players${waiting ? ` <span class="pt-badge" aria-label="${waiting} waiting for you">${waiting}</span>` : ''}`;
  const toPay = (a.promos?.awards || []).filter(w => w.status === 'held').length;
  const promos = `Promotions${toPay ? ` <span class="pt-badge" aria-label="${toPay} to pay">${toPay}</span>` : ''}`;
  h += `<div class="pl-tabs cl-dash-tabs" role="tablist">${sub('tables', `Tables (${open.length})`)}${sub('players', players)}${sub('promos', promos)}</div>`;
  if (tab === 'promos') {
    const mine = promoFor === m.code;
    return h + promosPartHtml(a.promos, {form: mine ? promoForm : null, note: mine ? promoNote : '', code: m.code, disabled: !hostHere}) + '</div>';
  }
  if (tab === 'tables') {
    h += `<h3>Tables${open.length ? ` (${open.length})` : ''}</h3>`;
    if (open.length || closed.length) {
      h += '<ul class="cl-list">';
      for (const t of open) {
        h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameLabel(t.game))} · ${chips(t.sb)}/${chips(t.bb)} · buy-in ${t.minBB}–${t.maxBB} BB · ${t.taken}/${t.seats} seated${t.status === 'closing' ? ' · closing' : ''}</span>`;
        if (t.status === 'open') h += `<span class="cl-acts"><button class="btn-small" data-cl="a-close-table" data-code="${code}" data-table="${esc(t.id)}"${dis}>Close</button></span>`;
        h += '</li>';
      }
      for (const t of closed) h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">closed</span><span class="cl-acts"><button class="btn-small" data-cl="a-hide-table" data-code="${code}" data-table="${esc(t.id)}"${dis}>Remove</button></span></li>`;
      h += '</ul>';
    } else h += '<p class="pl-meta cl-empty">No tables open.</p>';
    h += tableForm === m.code ? tableFormHtml(m.code) : `<div class="pl-actions"><button class="btn-small primary" data-cl="a-new-table" data-code="${code}"${dis}>New table</button></div>`;
    return h + '</div>';
  }
  h += helpListHtml(a.help, m.code, dis);
  if (a.pending.length || asking.length) {
    h += `<div class="cl-needs"><h3>Needs you (${a.pending.length + asking.length})</h3><ul class="cl-list">`;
    for (const x of a.pending) {
      h += `<li><span class="cl-name">${esc(x.name)}</span><span class="pl-meta">asks to join · <code>${esc(showId(x.id))}</code></span>`;
      h += `<span class="cl-acts">${btn('a-approve', x, 'Approve', ' primary')}${btn('a-decline', x, 'Decline')}</span></li>`;
    }
    for (const x of asking) {
      h += `<li><span class="cl-name">${esc(x.name)}</span><span class="cl-chips">asks for ${chips(x.request.amount)}</span>`;
      if (x.request.note) h += `<span class="pl-meta">“${esc(x.request.note)}”</span>`;
      h += `<span class="cl-acts">${btn('a-grant', x, 'Give from yours', ' primary')}${btn('a-deny', x, 'Decline')}</span>${adminFormHtml(m.code, x)}</li>`;
    }
    h += '</ul></div>';
  }
  h += `<h3>Members (${a.members.length})</h3><ul class="cl-list">`;
  for (const x of a.members) {
    h += `<li><span class="cl-name">${esc(x.name)}${x.id === me?.id ? ' (you)' : ''}</span><code>${esc(showId(x.id))}</code><span class="cl-chips" title="Club balance">${chips(x.balance)} chips</span>`;
    if (x.seated) h += '<span class="pl-meta">at a table</span>';
    if (x.assistant) h += '<span class="pl-meta">assistant</span>';
    // As on the host's rows: Give in view, the rest in the row's menu.
    if (x.id !== me?.id) {
      h += `<span class="cl-acts">${btn('a-give', x, 'Give')}`;
      if (!x.assistant && hostHere) h += menuHtml(`More for ${x.name}`, [['a-remove', 'Remove from the club']], x.id, '', ` data-code="${code}"`);
      h += '</span>';
    }
    if (!x.request) h += adminFormHtml(m.code, x);
    h += '</li>';
  }
  h += '</ul>';
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
  // The blind structure editor in the New tournament form redraws itself.
  const ed = tourneyForm && e.target.closest('[data-tseditor]');
  if (ed && tEditor.click(e)) { ed.innerHTML = tEditor.html(); return; }
  const b = e.target.closest('[data-cl]');
  if (!b) return;
  const act = b.dataset.cl;
  if (act === 'create') createClub(root.querySelector('#cl-clubname')?.value);
  else if (act === 'mtab') { setMemberTab(b.dataset.code, b.dataset.tab); render(); }
  else if (act === 'dash') { setDash(b.dataset.tab); render(); }
  // High Hand promotions (#278), the host's or (data-code) an assistant's (#274).
  else if (act === 'promo-new') { promoForm = 'new'; promoFor = b.dataset.code || ''; promoNote = ''; render(); }
  else if (act === 'promo-edit') { promoForm = b.dataset.id; promoFor = b.dataset.code || ''; promoNote = ''; render(); }
  else if (act === 'promo-cancel') { promoForm = null; promoNote = ''; render(); }
  else if (act === 'promo-status') {
    if (b.dataset.status === 'ended' && !confirm('End this promotion? A period under way pays out as usual at its end.')) return;
    promoCmd(b.dataset.code, 'promo_status', {id: b.dataset.id, status: b.dataset.status});
  } else if (act === 'promo-approve') promoCmd(b.dataset.code, 'approve_award', {id: b.dataset.id});
  else if (act === 'promo-void') {
    const why = prompt('Void this prize? Its chips are taken back from the member’s balance. Why (shown in their ledger)?', '');
    if (why === null) return;
    promoCmd(b.dataset.code, 'void_award', {id: b.dataset.id, why});
  }
  else if (act === 'atab') { setAdminTab(b.dataset.code, b.dataset.tab); render(); }
  // A new backup takes the backup and proof steps (#395).
  else if (act === 'backup' || act === 'backup-now') { backupNote = ''; setWizard('backup', {setup: false}); root.querySelector('form[data-clform=backup] [name=pw]')?.focus(); }
  else if (act === 'service-add' || act === 'service-edit') {
    serviceForm = act === 'service-add' ? 'new' : b.dataset.id;
    serviceNote = '';
    render();
    root.querySelector('form[data-clform=service] input')?.focus();
  } else if (act === 'service-cancel') { serviceForm = null; serviceNote = ''; render(); }
  else if (act === 'service-revoke') {
    const s = club.services?.[b.dataset.id];
    if (confirm(`Revoke ${s?.name || 'this service'}? Its key stops working at once; adding it again takes its service line.`)) hostAct('service_revoke', {id: b.dataset.id});
  }
  // Setting up a club: Skip asks once more, warning it can't be recovered.
  else if (act === 'wiz-skip') { backupNote = ''; setWizard('skip'); }
  else if (act === 'wiz-back') { backupNote = ''; setWizard('backup'); }
  else if (act === 'wiz-onward') { provedNote = ''; wizardOnward(); }
  else if (act === 'wiz-invite') setWizard('invite');
  else if (act === 'wiz-cancel') { backupNote = ''; setWizard(null); }
  else if (act === 'wiz-done') { setWizard(null); setDash('tables'); location.hash = 'clubs/own'; }
  else if (act === 'share') { setHostNote('shared', true); navigator.share?.({title: club?.name || 'ducy club', text: `Join ${club?.name || 'my club'} on ducy`, url: link()}).catch(() => {}); render(); }
  else if (act === 'approve') hostAct('approve', {id: b.dataset.id});
  else if (act === 'checklist-hide') { setHostNote('checklistHidden', true); render(); }
  else if (act === 'backup-nag-hide') { setHostNote('backupNagHidden', true); render(); }
  else if (act === 'close-table-yes') { closingTable = null; hostAct('close_table', {table: b.dataset.table}); render(); }
  else if (act === 'close-table-no') { closingTable = null; render(); }
  else if (act === 'decline') hostAct('decline', {id: b.dataset.id});
  else if (act === 'remove') { if (confirm('Remove this member from the club?')) hostAct('remove', {id: b.dataset.id}); }
  else if (act === 'revoke') { if (confirm('Make a new invite link? The current link stops working for anyone who hasn’t used it yet.')) hostAct('revoke_invite'); }
  else if (act === 'copy') {
    try { await navigator.clipboard.writeText(link()); } catch { root.querySelector('#cl-link')?.select(); }
    copied = true;
    setHostNote('shared', true);
    render();
    setTimeout(() => { copied = false; render(); }, 1500);
  } else if (act === 'close') closeClub();
  else if (act === 'move-always') moveToAlwaysOn();
  else if (act === 'delete-always') deleteAlwaysOn();
  else if (act === 'attach') attachAlwaysOn(root.querySelector('#cl-attach')?.value);
  else if (act === 'forget') leaveMembership(b.dataset.code);
  else if (act === 'setname') setName(root.querySelector('#cl-myname')?.value);
  else if (act === 'reconnect') { note = ''; startHosting(); render(); }
  else if (act === 'reconnect-owner') { note = ''; owner.start(); render(); }
  else if (act === 'retry') { const m = memberships.find(x => x.code === b.dataset.code); if (m) { m.error = ''; connectMembership(m); render(); } }
  else if (act === 'give') openChipForm('give', b.dataset.id);
  else if (act === 'take') openChipForm('take', b.dataset.id);
  else if (act === 'grant-other') openChipForm('grant', b.dataset.id);
  else if (act === 'cancel-form') { chipForm = null; render(); }
  else if (act === 'grant') { chipForm = null; hostAct('grant', {id: b.dataset.id}); }
  else if (act === 'deny') openChipForm('deny', b.dataset.id);
  // From Manage (#225): declining, with an optional reason, is on Members.
  else if (act === 'deny-there') { setDash('players'); openChipForm('deny', b.dataset.id); }
  else if (act === 'ledger-csv') exportLedger();
  else if (act === 'quick') { const f = b.closest('form'); if (f?.elements.amount) f.elements.amount.value = b.dataset.v; }
  else if (act === 'rathole') hostAct('settings', {ratholeHours: Number(b.dataset.hours)});
  else if (act === 'sitout-mins') hostAct('settings', {sitOutMins: Number(b.dataset.mins)});
  else if (act === 'code-join') hostAct('settings', {codeJoin: b.dataset.on === '1'});
  else if (act === 'new-table') { tableForm = true; render(); root.querySelector('form[data-tableform] [name=name]')?.focus(); }
  else if (act === 'cancel-table') { tableForm = false; render(); }
  // The host: agents.
  else if (act === 'make-agent') openChipForm('agent', b.dataset.id);
  else if (act === 'limit') openChipForm('limit', b.dataset.id);
  else if (act === 'settle') openChipForm('settle', b.dataset.id);
  else if (act === 'revoke-agent') hostAct('revoke_agent', {id: b.dataset.id});
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
  // Offering a role shows what it means first (#190).
  // Help requests (#192).
  else if (act === 'help-open') { helpForm = b.dataset.code; render(); root.querySelector(`form[data-helpform] [name=text]`)?.focus(); }
  else if (act === 'help-cancel') { helpForm = null; render(); }
  else if (act === 'myname') { nameForm = b.dataset.code; render(); root.querySelector('form[data-nameform] input')?.focus(); }
  else if (act === 'myname-cancel') { nameForm = ''; render(); }
  else if (act === 'help-done') answerHelpReq(b.dataset.code || null, b.dataset.id, b.closest('form')?.elements.reply?.value || '', true);
  else if (act === 'offer-role') { offering = offering === b.dataset.id ? null : b.dataset.id; render(); }
  else if (act === 'offer-role-yes') { offering = null; hostAct('offer_assistant', {id: b.dataset.id}); }
  else if (act === 'offer-role-no') { offering = null; render(); }
  else if (act === 'revoke-role') hostAct('revoke_role', {id: b.dataset.id});
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
  else if (act === 'close-table') { closingTable = b.dataset.table; render(); }
  else if (act === 'watch') watchTable(b.dataset.table);
  // Hand history and the replayer.
  else if (act === 'hands') toggleHistory(b.dataset.code, b.dataset.who);
  else if (act === 'replay') openReplay(b.dataset.id);
  else if (act === 'promo-replay') openPromoReplay(b.dataset.code, b.dataset.who, b.dataset.hand);
  else if (act === 'replay-to') stepReplay(Number(b.dataset.i));
  else if (act === 'replay-play') toggleReplayPlay();
  else if (act === 'replay-close') closeReplay();
  else if (act === 'keep-days') { hostAct('settings', {keepDays: Number(b.dataset.days)}); prune(club.code, 'host', {days: club.keepDays}).then(() => loadHands(club.code, 'host')); render(); }
  else if (act === 'keep-hands') { try { localStorage.setItem(KEEP_KEY, b.dataset.n); } catch {} for (const m of memberships) prune(m.code, me.id, {keep: keepHands()}); render(); }
  else if (act === 'sit') sitAt(b.dataset.code, b.dataset.table);
  // Tournaments: the host's.
  else if (act === 'new-tourney') {
    const last = load(TOURNEY_KEY, {});
    tEditor = structureEditor({stack: last.stack || 10000, tableSize: last.tableSize || 9});
    tourneyForm = true;
    render();
    root.querySelector('form[data-tourneyform] [name=name]')?.focus();
  } else if (act === 'cancel-tourney-form') { tourneyForm = false; render(); }
  else if (act === 'cancel-tourney') { if (confirm('Cancel this tournament? Every buy-in goes back to the players.')) hostAct('cancel_tourney', {id: b.dataset.id}); }
  else if (act === 'payout-edit') { const t = tourneyById(club, b.dataset.id); payoutEdit = t ? {id: t.id, places: payoutShares(t).slice()} : null; render(); }
  else if (act === 'payout-cancel') { payoutEdit = null; render(); }
  else if (act === 'payout-default') { payoutEdit = null; hostAct('set_payout', {id: b.dataset.id, places: null}); }
  else if (act === 'payout-add' || act === 'payout-remove') {
    const fm = root.querySelector(`form[data-payoutform="${b.dataset.id}"]`);
    if (!payoutEdit || !fm) return;
    payoutEdit.places = readPayoutForm(fm);
    if (act === 'payout-add') payoutEdit.places.push(Math.max(1, Math.round((payoutEdit.places.at(-1) || 1000) / 2)));
    else if (payoutEdit.places.length > 1) payoutEdit.places.splice(Number(b.dataset.i), 1);
    render();
  }
  // Tournaments: a member's.
  else if (['t-register', 't-unregister', 't-enter'].includes(act)) {
    const mem = memberships.find(m => m.code === b.dataset.code);
    if (mem) mem.tourneyError = null;
    sendToHost(b.dataset.code, {type: 'tourney', club: b.dataset.code, tourney: b.dataset.tourney, op: act.slice(2)});
  } else if (act === 't-play') sitAt(b.dataset.code, `tourney:${b.dataset.tourney}`);
  else if (act === 'to-table') location.hash = 'play';
  else if (act === 'seat-watch' || act === 'seat-unwatch') {
    setSeatWatch(b.dataset.code, b.dataset.table, act === 'seat-watch');
    render();
  }
  else if (act === 'ask') {
    const code = b.dataset.code;
    const amount = parseChips(root.querySelector(`[data-ask-amt="${code}"]`)?.value);
    const why = root.querySelector(`[data-ask-note="${code}"]`)?.value || '';
    if (!Number.isSafeInteger(amount) || amount <= 0) { alert('Enter an amount above 0, like 50 or 12.50.'); return; }
    sendToHost(code, {type: 'chip_request', club: code, amount, note: why});
  } else if (act === 'cancel-ask') {
    const code = b.dataset.code;
    sendToHost(code, {type: 'cancel_request', club: code});
    // The host is away: the relay holds the cancel for them (#188), so the
    // request is gone from here now, and comes back only if they still
    // have it.
    const mem = memberships.find(x => x.code === code);
    if (mem && !playerNets.get(code)?.hostHere) {
      mem.request = null;
      mem.cancelQueued = true;
      saveMemberships();
      render();
    }
  }
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
  if (e.target.dataset?.activity) { activityBy = e.target.value; render(); return; }
  if (e.target.dataset?.activitybig) { activityBig = e.target.checked; render(); return; }
  const pid = e.target.dataset?.assign;
  if (pid != null) {
    hostAct('assign_agent', {id: pid, agent: e.target.value || null});
    render();
    return;
  }
  // The ledger's filters (#188).
  const lf = e.target.dataset?.lf;
  if (lf) { ledgerFilter[lf] = e.target.value; render(); return; }
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
  owner?.stop();
  for (const n of playerNets.values()) n.net?.close();
  playerNets.clear();
}

function reconnectAll() {
  if (!me) return;
  // The club you run, on the club manager only; there, too, the clubs you
  // help run (their staff views come over your member connection).
  if (mode === 'manage') {
    startHosting();
    owner?.start();
  }
  for (const m of memberships) if (mode === 'play' || helps(m)) connectMembership(m);
  render();
}

// Another tab of this browser changed the club or the memberships (only one
// tab can host, but any tab can show the club): show what it saved.
function onStorage(e) {
  if (e.key === CLUB_KEY) {
    const fresh = load(CLUB_KEY, null);
    if (server && fresh?.code === club?.code) {
      // The same club, changed in another tab: update it in place, so this
      // tab's server (which holds these objects) carries on with it.
      for (const k of Object.keys(club)) delete club[k];
      Object.assign(club, fresh);
      verifier.senders = new Verifier(load(SENDERS_KEY, {})).senders;
    } else {
      club = fresh;
      verifier = new Verifier(load(SENDERS_KEY, {}));
      server = null;
    }
    if (!club) { hostNet?.close(); hostNet = null; hostOnline = false; }
  } else if (e.key === MEMBERSHIPS_KEY) {
    const saved = load(MEMBERSHIPS_KEY, []);
    // Keep this tab's connection state; take the other tab's data.
    memberships = saved.map(s => Object.assign(memberships.find(m => m.code === s.code) || {}, s));
  } else return;
  render();
}

// Whether this browser has anything to do with clubs: a club it runs, an
// always-on one it owns, or clubs it joined (read straight from storage).
export function hasClubs() {
  return !!(load(CLUB_KEY, null) || load('ducyClubRemote', null) || load(MEMBERSHIPS_KEY, []).length);
}

// The same, also finding an always-on club whose record only IndexedDB
// kept (club-owner.js: a browser that crashed can lose recent localStorage).
export async function anyClubs() {
  if (hasClubs()) return true;
  return !!(await getTable('owner', 'club').catch(() => null))?.code;
}

// Loads the clubs and connects: the hosted club, an always-on club's room,
// and each club joined. From the page's start when this browser has clubs,
// so requests and tables arrive whichever tab is showing (#145), or when a
// Play tab first opens. Resolves once connected (or it can't be).
export function startClubs() {
  return (started ||= (async () => {
    window.addEventListener('pagehide', disconnectAll);
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', e => { if (e.persisted) reconnectAll(); });
    // Back online after sleep or a network change: reconnect what dropped.
    window.addEventListener('online', () => reconnectAll());
    club = load(CLUB_KEY, null);
    if (club) { ensureChips(club); ensureTables(club); }
    verifier = new Verifier(load(SENDERS_KEY, {}));
    memberships = load(MEMBERSHIPS_KEY, []);
    try {
      me = await loadIdentity();
    } catch (e) {
      console.warn(e);
      note = 'This browser can’t keep a player ID (private mode or storage blocked), so it can’t use clubs.';
      render();
      return;
    }
    // Tournament calls and countdowns move with the clock (#189).
    setInterval(() => {
      updateCalls();
      const live = memberships.some(m => (m.tourneys || []).some(t => t.status === 'scheduled' || t.status === 'running'));
      if (open && live) render();
    }, 30_000);
    owner = createOwner({
      identity: me,
      onChange: () => { if (isRemote()) club = owner.club; render(); },
      onNote: t => { note = t; render(); },
    });
    // Finds the always-on club's record, from IndexedDB if need be, and
    // (on the club manager) connects to it.
    if (mode === 'manage') await owner.start();
    // A club backup was just restored (Player settings): reopen its club,
    // on the club manager.
    const restored = mode === 'manage' && load(RESTORE_CLUB_KEY, null);
    if (restored) {
      try { localStorage.removeItem(RESTORE_CLUB_KEY); } catch {}
      if (!isRemote() && !club && restored.code) await attachAlwaysOn(restored.code);
    }
    reconnectAll();
  })());
}

// Draws tab `v` of the Play section (see the views above) into `el`.
export async function openClubs(el, v = 'clubs') {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('change', onFilter);
    // Restore a club from its backup file (#191).
    root.addEventListener('change', e => {
      const f = e.target.dataset?.clrestore != null && e.target.files?.[0];
      if (f) { e.target.value = ''; restoreBackupFile(f); }
    });
    // The promotion form (#278): its kind redraws it; a session shows its days and hours.
    root.addEventListener('change', e => {
      const pf = e.target.closest('form[data-promoform]');
      if (!pf) return;
      if (e.target.dataset.promokind) { promoForm = e.target.value === 'bonus' ? 'new-bonus' : 'new'; promoFor = pf.dataset.code || ''; render(); }
      if (e.target.dataset.promoevery) pf.querySelector('.cl-promo-session').hidden = e.target.value !== 'session';
    });
    root.addEventListener('change', e => {
      const f = e.target.closest('form[data-tableform]');
      if (f && ['game', 'blinds', 'sb', 'bb'].includes(e.target.name)) syncTableForm(f, e.target.name === 'game');
      // The New tournament form: a game's usual table size, and no more than it deals to.
      const tf = e.target.closest('form[data-tourneyform]');
      if (tf && e.target.name === 'game') {
        const size = tf.elements.tableSize;
        size.max = maxSeats(e.target.value);
        size.value = defaultSeats(e.target.value);
      }
    });
    // The blind structure editor's fields, and the starting stack it follows.
    root.addEventListener('change', e => {
      if (!tourneyForm || !tEditor) return;
      const ed = root.querySelector('[data-tseditor]');
      if (e.target.dataset.tstack) { const n = Number(e.target.value); if (Number.isSafeInteger(n) && n >= 20) { tEditor.setStack(n); if (ed) ed.innerHTML = tEditor.html(); } return; }
      if (e.target.closest('[data-tseditor]') && tEditor.input(e) && ed) ed.innerHTML = tEditor.html();
    });
    document.addEventListener('keydown', onDocKey);
    // A ⋯ menu closes when you click anywhere else.
    document.addEventListener('click', e => {
      for (const d of document.querySelectorAll('details.cl-menu[open]')) if (!d.contains(e.target)) d.open = false;
    });
  }
  if (v !== 'join') justJoined.clear();
  view = v;
  open = true;
  render();
  await startClubs();
  render();
}

// Opens My clubs on the Players tab, where requests are answered (from a
// notification, play-section.js).
export function showClubPlayers() {
  // The club you run, else the first you help run with something waiting.
  const helped = memberships.find(m => helps(m) && helperWaiting(m));
  // On the player app, they're answered on the club manager.
  if (mode === 'play') {
    location.href = managerHref(club || isRemote() ? 'clubs/players' : helped ? clubHash(helped.code) : 'clubs');
    return;
  }
  if (!club && !isRemote() && helped) { location.hash = clubHash(helped.code); return; }
  setDash('players');
  location.hash = 'clubs/players';
  render();
}

// Leaving the tab keeps the connections open, so a host's club stays
// reachable, and requests keep arriving, while the page is open.
export function closeClubs() {
  open = false;
  if (root) root.hidden = true;
}

// ---- tournaments calling you (#189) ----
//
// A tournament you're in that has started while you aren't at its table
// (you're being blinded off), or one you registered for that starts within
// TOURNEY_SOON_MS, gets a bar at the bottom of every page with the way to
// your seat, and a system notification (once) when notifications are on and
// the page isn't in front.

const TOURNEY_SOON_MS = 5 * 60_000;
const callsNotified = new Set(); // calls a notification went out for
const callsDismissed = new Set(); // calls closed with ✕

function tourneyCalls(now = Date.now()) {
  if (!me) return [];
  return tourneyCallsFor(memberships, me.id, seatedAt, TOURNEY_SOON_MS, now).filter(c => !callsDismissed.has(c.key));
}

function callText(c, now = Date.now()) {
  if (c.kind === 'started') return `${c.t.name} (${c.mem.name || c.mem.code}) has started: you’re being blinded until you sit down.`;
  const mins = Math.max(1, Math.round((c.t.startsAt - now) / 60_000));
  return `${c.t.name} (${c.mem.name || c.mem.code}) starts in ${mins} min.`;
}

function updateCalls() {
  const calls = tourneyCalls();
  for (const c of calls) {
    if (callsNotified.has(c.key)) continue;
    callsNotified.add(c.key);
    if (!document.hidden || !notifyOn()) continue;
    try {
      const n = new Notification('ducy', {body: callText(c), tag: `ducy-tourney-${c.key}`});
      n.onclick = () => { window.focus(); answerCall(c); n.close(); };
    } catch {}
  }
  let bar = document.getElementById('cl-callbar');
  if (!calls.length) {
    if (bar) bar.hidden = true;
    document.body.classList.remove('has-callbar');
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'cl-callbar';
    bar.className = 'pt-toast cl-callbar';
    bar.setAttribute('role', 'status');
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-call]');
      if (!b) return;
      const c = tourneyCalls().find(x => x.key === b.dataset.key);
      if (!c) return;
      if (b.dataset.call === 'dismiss') callsDismissed.add(c.key);
      else answerCall(c);
      updateCalls();
    });
    document.body.append(bar);
  }
  // One call at a time: a started one first.
  const c = calls.find(x => x.kind === 'started') || calls[0];
  const more = calls.length > 1 ? ` <span class="pl-meta">(+${calls.length - 1} more)</span>` : '';
  const go = c.kind === 'started' ? 'Take your seat' : 'See it';
  bar.innerHTML = `<span>${esc(callText(c))}${more}</span><button class="btn-small primary" data-call="go" data-key="${esc(c.key)}">${go}</button><button class="link-btn" data-call="dismiss" data-key="${esc(c.key)}" aria-label="Dismiss">✕</button>`;
  bar.hidden = false;
  document.body.classList.add('has-callbar');
}

// To your seat, or to the club's tournaments.
function answerCall(c) {
  if (c.kind === 'started' && !seatedAt) { sitAt(c.mem.code, `tourney:${c.t.id}`); return; }
  // The club's Tournaments tab (#193), on Clubs (#209).
  setMemberTab(c.mem.code, 'tables');
  location.hash = clubHash(c.mem.code);
  render();
}

// Called after anything changes, whichever tab is showing (the tab badges).
export function onClubsChange(f) {
  listeners.add(f);
}

// Whether the My clubs tab has anything: a club this browser runs, or one
// it helps run as an assistant or agent.
export function managesClub() {
  if (club || isRemote() || load('ducyClubRemote', null)) return true;
  return (started ? memberships : load(MEMBERSHIPS_KEY, [])).some(helps);
}

// How many things are waiting for this browser to act on (My clubs' badge):
// join and chip requests at the club it runs, and those an assistant or
// agent can answer.
export function needsYou() {
  return memberships.reduce((n, m) => n + helperWaiting(m), hostWaiting());
}

// Open tables with a free seat across the clubs this browser is in (the
// Play tab's dot when one opens).
export function openSeats() {
  return memberships.filter(m => m.status === 'member')
    .reduce((n, m) => n + (m.tables || []).filter(t => t.taken < t.seats).length, 0);
}

// Where Play's Enter a code (#393) goes for club code `code` (as normCode
// gives it), without asking the relay: the club you run is on the club
// manager, one you're in opens its page, and a request you sent shows on
// Join. '' when it isn't one of yours.
export function clubPage(code) {
  const own = started ? myClubCode() : load(CLUB_KEY, null)?.code || load('ducyClubRemote', null)?.code || '';
  if (code && code === own) return managerHref('clubs/own');
  const m = (started ? memberships : load(MEMBERSHIPS_KEY, [])).find(x => x.code === code);
  if (m?.status === 'member') return `#clubs/c/${encodeURIComponent(code)}`;
  if (m?.status === 'new' || m?.status === 'pending') return '#join';
  return '';
}

// Asks to join the club in invite `inv` (from an invite link, or by the
// club's code with no invite token, #393), as `name`.
export async function joinClub(inv, name) {
  await startClubs();
  if (!me) return;
  invite = inv;
  joinFromInvite(name);
}

// The name this browser joins clubs as, and changing it (Player settings,
// #144): each club's host is told.
export const memberName = () => myName();
export function renameMember(n) {
  if (!started) { try { localStorage.setItem(NAME_KEY, String(n || '').trim().slice(0, MAX_PLAYER_NAME)); } catch {} return; }
  setName(n);
}

// How many of your hands to keep in each club (Player settings).
export { keepHands };
export function setKeepHands(n) {
  try { localStorage.setItem(KEEP_KEY, String(n)); } catch {}
  for (const m of memberships) prune(m.code, me?.id, {keep: keepHands()});
  render();
}
