// Clubs (#66): host a club, invite players with a link and approve them, and
// see the clubs you belong to. club.js has the rules and club-server.js runs
// the host's side; this file draws the club parts of the Play section's tabs
// (play-section.js, #138) and carries signed messages over the relay
// (play-net.js, in queue mode so join requests wait while the host is away).
//
// Views, one per tab (#209: Train · Play · Clubs):
//   'play'   Bots (Train), and the table you're at: nothing from here
//   'join'   your join requests and how they're going
//   'clubs'  a club's page (the address says which, see shownClub): the
//            club you run, agent tools, or the one you belong to (balance,
//            chips, tables to sit at). Your clubs are listed on the front
//            page (yourClubs, #611), joining one is its Enter a code (#393),
//            and #clubs naming none of yours goes there.
// The connections start with the page (startClubs), whichever tab is open,
// so requests arrive live (#145); onClubsChange tells the tab bar.
//
// Storage (this browser only, #61):
//   ducyClub          the club this browser hosts (one per host for now)
//   ducyClubSenders   the host's Verifier state (players' keys, last seq)
//   ducyClubs         clubs this browser has asked to join
//   ducyClubName      the display name sent with join requests

import { isBackedUp, keepStorage, loadIdentity, markBackedUp, MIN_NEW_PASSWORD, safariMayClear, showId, signMessage, Verifier } from './identity.js';
import { clubBackupText, proveClubBackup } from './club-backup.js';
import { chipText, chipInput, parseChips, CHIP_STEP } from './chip-format.js';
import { BACKUP_SAVED, backupFormHtml, downloadFile, notifyOn, restoreBackupFile, RESTORE_CLUB_KEY, saveBackup } from './player-settings.js';
import { connect, DEFAULT_RELAY, newCode, normCode, relayUrl, wsUrl } from './play-net.js';
import {
  account, approve, decline, hostReceive, inviteLink, lastEntry, MAX_CLUB_NAME, MAX_PLAYER_NAME, membersByStatus,
  newClub, newMembership, playerReceive,
} from './club.js';
import { ensureChips, ledgerCsv, MAX_NOTE, totals, VAULT_WAITS, whereChips } from './club-chips.js';
import {
  buyInRange, defaultSeats, defaultTableName, ensureTables, gameLabel, GAMES, MAX_TABLE_NAME, maxSeats, newTable, openTables, tableById, tablesBody,
} from './club-tables.js';
import { feeds, isMain } from './club-groups.js';
import { gameKey, listOf } from './club-lists.js';
import { stakesBand } from '../wasm/ducy_wasm.js';
import { MAX_HELP_REPLY, MAX_HELP_TEXT, openHelp } from './club-help.js';
import { LOBBY_MAX_AGE_MS, onlineList } from './club-lobby.js';
import { CHAT_MAX, cleanChat } from './table-chat.js';
import { ago } from './time-ago.js';
import { createOwner } from './club-owner.js';
import * as pk from './passkey.js';
import { CHIP_OPS, VAULT_OPS } from './chip-moves.js';
import { accountOf, contributions, playersOf } from './club-agents.js';
import { chargeFieldsHtml, chargeOn, chargeText, clubChargeHtml, contributionsHtml, readCharge, syncChargeFields } from './club-rake.js';
import { entriesOf, ledgerOf, ledgerView, settleRows } from './club-money.js';
import { bigMove, isBigMove } from './club-log.js';
import { handRecord, summary, tableSessions, totalsByMember } from './hand-replay.js';
import { Replayer } from './replayer.js';
import { getHand, HOST_KEEP_DAYS, listHands, PLAYER_KEEP_HANDS, prune, saveHand } from './hand-store.js';
import { getTable } from './table-store.js';
import { celebrateAtTable, joinTableVia, tableChanged } from './play.js';
import { draftKey, draftLast, draftSettings, hostTourneysHtml, memberTourneysHtml, newDraft, readStep, tourneyCallsFor, tourneyDraft } from './club-tourneys-ui.js';
import { checkStructure } from './tourney-structure.js';
import { hostPromosHtml, memberPromosHtml, readPromoForm, tableBannerText } from './club-promos-ui.js';
import { readServiceForm, servicesHtml } from './club-services-ui.js';
import { payoutTableById, tourneyById } from './club-tourneys.js';
import { addPlace, addRow, cleanRows, draftOf, readRows, removeRow } from './payout-table-ui.js';
import { structureEditor } from './tourney-structure-ui.js';
import { fairPlayer } from './fair-check.js';
import { demo, showDemoList } from './demo.js';
import { clubUrl, playerUrl, siteOf } from './sites.js';
import { isOff, OFF } from './club-beta.js';
import { grantToken as grantOf, managerPage, navOf, pageHash, pageOff, pageTitle, shownNav } from './club-nav.js';
import { pickHtml, readPick, syncPicks } from './amount-picks.js';
import { durationText, FILTERS, lastActive, memberFilter, overviewNumbers, pageOf, SORTS, sortMembers, tableSummaries, todaysTourneys } from './club-overview.js';
import { clearableKeys, floatOf, managerNotices, raiseTo } from './club-notices.js';
import { ownerScheduledHtml, readSchedForm, upcomingHtml } from './club-scheduled-ui.js';
import { entryTitle, fairPlayNotices, flagText, flowText, handFlagsText, handsText } from './club-fair-play.js';
import { watchLocation } from './table-location.js';
import { chipLines, leftSummary } from './club-member-view.js';
import { creditRow } from './club-credit.js';
import { changedSince, formatInfo, isEmpty, MAX_EVENT_TEXT, MAX_INFO_TEXT, nextEvent, sectionName, SECTIONS } from './club-info.js';

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
// The club this browser runs: an always-on club's latest view (see owner
// below), or a club kept in this browser from before clubs ran on ducy's
// server, which no longer runs here: it can only move there (#580).
let club = null;
let verifier = null;
let memberships = []; // clubs this browser asked to join
const playerNets = new Map(); // club code → {net, online, hostHere}
let invite = null; // an invite from the page address, not yet acted on
let note = '', copied = false;
// An always-on club this browser owns (#93, club-owner.js): `club` is then
// its latest view from the relay, and host actions go there as commands.
let owner = null;
const isRemote = () => !!owner?.record;
const own = () => owner;
// A manager page's address.
const ph = (page, member = '', list = {}) => pageHash(page, member, '', list);
// Which page this runs on: 'play', the player app (index.html), where you
// join clubs and play at their tables; or 'manage', the club manager
// (manage.html, manage.js), where you run a club. Running a
// club lives only on the manager: the player app neither hosts a club run
// in the browser nor opens an always-on club's owner connection, and links
// to the manager instead.
let mode = 'play';
export function setClubsMode(m) {
  mode = m === 'manage' ? 'manage' : 'play';
}
// The club manager is a site of its own, club.ducy.cards, and the player
// app is ducy.cards (#637, sites.js); on a local page, manage.html and
// index.html side by side. A demo club stays on its one site: on the club
// site its players' pages are app.html (build-club.sh).
const managerHref = hash => clubUrl(hash);
const playerBase = () => (demo && siteOf(location.hostname) === 'club' ? 'app.html' : playerUrl(''));
const playerHref = hash => `${playerBase()}${hash ? `#${hash}` : ''}`;
// Invite links open the player app, even when made on the club manager.
const appBase = () => new URL(playerBase(), location.href).href;
// Why the last create failed (the relay down or full), and the name it was
// for: the form says so and offers to try again. Clubs are always on
// (#152): none runs in a browser tab (#580).
let alwaysFailed = null;
let tableForm = false; // the New table form is open
let schedForm = null; // the Schedule a game form: {id, note} (#599)
// Tournaments (#64): the New tournament wizard (#477: {step, d, editor,
// edit, note}, club-tourneys-ui.js wizardHtml), the payout table being made
// or edited in it (#424: {id ('new' for a new one), name, draft},
// payout-table-ui.js), kept as it's typed, and a series question open on
// the Tournaments page ({id, act}).
let tourneyForm = null, payTable = null, tAsk = null;
// A running tournament's payouts being changed, until it's confirmed
// (#544): {id, table}.
let payAsk = null;
const syncPayTable = fm => { if (payTable) { payTable.name = fm.elements.name.value; payTable.draft = readRows(fm, payTable.draft); } };
const TOURNEY_KEY = 'ducyTourneyChoice';
let seatedAt = null; // the club table this browser plays at: {code, table, handlers}

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
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
  pending: 'Waiting for the manager to let you in',
  member: 'Member',
  declined: 'The manager declined your request',
  removed: 'You were removed from this club',
  bad_invite: 'That invite link isn’t valid any more; ask the manager for a new one',
  invite_only: 'This club takes requests by invite link only; ask the manager for theirs',
  closed: 'The owner closed this club',
};

// ---- hosting ----

function saveClub() {
  if (isRemote()) return;
  save(CLUB_KEY, club);
  save(SENDERS_KEY, verifier.toJSON());
}

// The control an action came from (#544): the button clicked, the form
// sent or the select changed, and when. Its busy state, Saved ✓ and any
// error show beside it, across redraws.
let actor = null, actorAt = 0;
// Controls whose action the server is answering (by ctlKey), the last one
// saved ({key, at}), and the last action that failed ({key, text}).
const busy = new Set();
let saved = null, failed = null;
const SAVED_MS = 3000;

// A control's key, the same for it after a redraw: its form's data, its
// tag, name and data, and whether it's in the notifications (the Overview
// lists the same ones). A confirm's yes (data-sure) is its button's.
function ctlKey(el) {
  if (!el?.tagName) return '';
  const data = x => Object.entries(x.dataset).filter(([k]) => k !== 'sure').map(([k, v]) => `${k}=${v}`).join('&');
  const f = el.tagName === 'FORM' ? null : el.form || el.closest('form');
  const keep = el.tagName === 'SUMMARY' ? el.parentElement?.dataset.keep || '' : '';
  return `${el.closest('.mg-notes') ? 'notes>' : ''}${f ? `${data(f)}>` : ''}${el.tagName}|${el.name || ''}|${el.type === 'submit' ? 'submit' : ''}|${keep}|${data(el)}`;
}
const byKey = key => (key && root ? [...root.querySelectorAll('button, select, input, textarea, summary, a, form')].find(el => ctlKey(el) === key) : null);

// What went wrong, beside control `el` (or its key); the top of the page
// when there's none.
function failAt(el, text) {
  const key = typeof el === 'string' ? el : ctlKey(el);
  failed = key ? {key, text} : null;
  if (!key) note = text;
  render();
}

// A button that asks first (#544): data-ask is the question, data-yes the
// answer that does it ("Remove Ann? Remove · Keep"), asked in its place.
// `asking`: the one asking, by ctlKey.
let asking = '';
function askInPlace() {
  const el = asking && byKey(asking);
  if (!el) { asking = ''; return; }
  const box = document.createElement('span');
  box.className = 'cl-confirm';
  box.append(el.dataset.ask);
  const yes = el.cloneNode(false);
  yes.dataset.sure = '1';
  yes.className = 'btn-small primary';
  yes.textContent = el.dataset.yes || el.textContent;
  const no = document.createElement('button');
  no.className = 'btn-small';
  no.type = 'button';
  no.dataset.cl = 'ask-no';
  no.textContent = 'Keep';
  box.append(yes, no);
  el.replaceWith(box);
}

// After a redraw: a question asked in place, busy controls disabled with
// "…", Saved ✓ beside the last saved, and the error beside the control it
// came from.
function markControls() {
  askInPlace();
  for (const key of busy) {
    const el = byKey(key);
    const btn = el?.tagName === 'FORM' ? el.querySelector('[type=submit]') : el;
    if (!btn) continue;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (btn.tagName === 'BUTTON' && !btn.textContent.endsWith('…')) btn.textContent += '…';
  }
  const span = (cls, text, role) => {
    const p = document.createElement('span');
    p.className = cls;
    p.setAttribute('role', role);
    p.textContent = text;
    return p;
  };
  // Saved ✓ right beside the button.
  const s = saved && Date.now() - saved.at < SAVED_MS && byKey(saved.key);
  if (s) s.after(span('pl-meta cl-saved', 'Saved ✓', 'status'));
  // An error under the row of buttons (or the form) the control is in.
  if (failed) {
    const el = byKey(failed.key);
    const at = el && ((el.closest('details.cl-menu') || el).closest('.cl-acts, .mg-note-acts, .pl-actions, .cl-formacts, form') || el);
    if (at) { at.after(span('pl-desc pl-neterr cl-acterr', failed.text, 'alert')); failed.shown = true; }
    // Its control gone before it could say: the top of the page. Gone
    // since (another page): it's over.
    else { if (!failed.shown) note = failed.text; failed = null; }
  }
}

// A host action (club-server.js), in the always-on club's room. The
// control it came from is busy until it's answered, then says Saved ✓ (a
// Save) or what went wrong. Resolves to whether it was done.
async function hostAct(op, args) {
  const from = Date.now() - actorAt < 1000 ? actor : null;
  actor = null;
  const key = ctlKey(from);
  const saves = from?.type === 'submit' && from.textContent.trim() === 'Save';
  failed = null;
  if (key) { busy.add(key); render(); }
  let ok = true;
  // Moving chips needs a recent passkey unlock (#575).
  const no = isRemote() && CHIP_OPS.has(op) ? await freshPass() : '';
  if (no) { busy.delete(key); failAt(key, no); return false; }
  try {
    if (!isRemote()) throw new Error('Move the club to ducy’s server first.');
    await own().run(op, args);
  } catch (e) { ok = false; failAt(key, e.message); }
  busy.delete(key);
  if (ok && saves) { saved = {key, at: Date.now()}; setTimeout(render, SAVED_MS); }
  render();
  return ok;
}

const seatedCounts = () => (isRemote() ? own().view?.seated || {} : {});
const tableRunning = id => isRemote() && !!own().view?.running?.includes(id);
// How running tournaments are going (club-tourney-host.js).
const tourneyLive = () => (isRemote() ? own().view?.tourneys || {} : {});

// The club's money runs in ducy's engine (club-money.js, #454), so this
// page loads it before the club it runs starts.
let pageEngine = null;
const loadEngine = () => (pageEngine ||= import('../wasm/ducy_wasm.js').then(w => w.default({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)})));

// The grant link's token this page was opened with (#636), or ''.
const grantToken = () => grantOf(location.hash);

// A new club, always on (#93, #152): its room on the relay becomes the club.
async function createClub(name) {
  const n = String(name || '').trim();
  if (!n) { note = 'Give your club a name.'; render(); return; }
  // Not without the passkey (#575): made or used first, then this again.
  if (!demo && !pk.session(me.id)) {
    pendingCreate = n;
    await refreshPass();
    if (pass.state !== 'open' && pass.state !== 'unknown') return;
    pendingCreate = null;
  }
  note = 'Setting up your club on the server…';
  alwaysFailed = null;
  render();
  try {
    // With the grant's token from the link (#636); a demo needs none.
    await owner.create(n.slice(0, MAX_CLUB_NAME), grantToken());
    note = '';
    // The link is used up: off the address.
    if (grantToken()) history.replaceState(null, '', `${location.pathname}${location.search}#clubs`);
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
  location.hash = 'clubs/overview';
}

// The New table form (#113, #476): three choices (game, blinds, seats) as
// buttons, everything else under More options with good defaults. Blinds
// are quick picks, or Other with any small and big blind typed, and an
// ante is typed under More options (#655); the rest is picked from lists.
// The last choices are remembered, except Call time, which starts at the
// club's (Rules). `wizard`: a step of creating a club (#111, #395), which
// can be skipped.
const TABLE_KEY = 'ducyTableChoice';
// In hundredths (chip-format.js): 100/200 shows as 1/2.
const BLINDS = [[100, 200], [200, 500], [500, 1000]];
const SEATS = [2, 6, 8, 9];
const MIN_BBS = [20, 30, 40, 50, 100];
const MAX_BBS = [50, 100, 150, 200, 250, 300];
const TURN_SECS = [15, 30, 60, 0];
const SIT_OUT_MINS = [5, 10, 15, 30, 0];
const CALL_TIMES = [0, 10, 20, 30, 50];
const SHORT = {nlhe: 'Hold’em', plo4: 'Omaha', plo5: 'Omaha 5', plo6: 'Omaha 6'};
const blindsText = ([s, b]) => `${chipText(s)}/${chipText(b)}`;
const options = (list, on, text) => list.map(x => `<option value="${x}"${x === on ? ' selected' : ''}>${esc(text(x))}</option>`).join('');
const nearest = (list, v) => (list.includes(v) ? v : list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)));

// The seat buttons for `game`: only sizes it can deal to, and under Other
// the rest of them (#476).
function seatsHtml(game, wanted) {
  const most = maxSeats(game);
  const sizes = SEATS.filter(n => n <= most);
  const others = Array.from({length: most - 1}, (_, i) => i + 2).filter(n => !sizes.includes(n));
  const pick = sizes.includes(wanted) ? String(wanted) : others.includes(wanted) ? 'other' : String(Math.min(defaultSeats(game), most));
  let h = sizes.map(n => tfRadio('seatsPick', n, n, pick === String(n))).join('');
  if (others.length) h += tfRadio('seatsPick', 'other', 'Other', pick === 'other') + `<select class="pl-text tf-other tf-other-seats" name="seats" aria-label="Seats">${options(others, wanted, String)}</select>`;
  return h;
}

const tfRadio = (name, value, label, on) => `<label class="cc-btn tf-opt"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}>${label}</label>`;

// `offer`: the same settings for a game to offer (the club's menu), not a
// table to open now.
function tableFormHtml({wizard = false, offer = false} = {}) {
  const last = load(TABLE_KEY, {});
  const game = GAMES.some(g => g.id === last.game) ? last.game : GAMES[0].id;
  const own = Number.isSafeInteger(last.sb) && Number.isSafeInteger(last.bb) && last.sb > 0 && last.bb >= last.sb;
  const lastBlinds = own ? [last.sb, last.bb] : BLINDS[0];
  const pick = BLINDS.find(([s, b]) => s === lastBlinds[0] && b === lastBlinds[1]);
  const blinds = pick ? pick.join('/') : 'other';
  const ante = Number.isSafeInteger(last.ante) && last.ante > 0 && last.ante <= lastBlinds[1] ? last.ante : 0;
  const amt = (name, label, hint, v) => `<input class="pl-text tf-amt" name="${name}" type="number" inputmode="decimal" min="0" step="${CHIP_STEP}" aria-label="${label}" placeholder="${hint}" value="${v ? esc(chipInput(v)) : ''}">`;
  // The game's usual size (Hold'em 9, PLO 8, PLO5 and PLO6 6), or the last one picked
  // for this game; never more than the game can deal to (PLO6: 6).
  const wanted = Math.min(last.game === game && last.seats ? last.seats : defaultSeats(game), maxSeats(game));
  let h = `<form class="cl-tableform tf" data-tableform="1"${wizard ? ' data-wizard="1"' : ''}${offer ? ' data-offer="1"' : ''}>`;
  h += `<div class="pl-row"><span class="pl-label">Game</span><div class="pl-opts">${GAMES.map(g => tfRadio('game', g.id, esc(SHORT[g.id] || g.label), g.id === game)).join('')}</div></div>`;
  h += `<div class="pl-row"><span class="pl-label">Blinds</span><div class="pl-opts">${BLINDS.map(x => tfRadio('blinds', x.join('/'), blindsText(x), blinds === x.join('/'))).join('')}${tfRadio('blinds', 'other', 'Other', blinds === 'other')}`;
  // Other: any blinds, typed (#655).
  h += `<span class="tf-other tf-other-blinds">${amt('sb', 'Small blind', 'SB', lastBlinds[0])}<span aria-hidden="true">/</span>${amt('bb', 'Big blind', 'BB', lastBlinds[1])}</span></div></div>`;
  h += `<div class="pl-row"><span class="pl-label">Seats</span><div class="pl-opts tf-seats">${seatsHtml(game, wanted)}</div></div>`;
  h += '<details class="tf-more" data-keep="tf-more"><summary>More options</summary><div class="tf-fields">';
  // Left empty, the table gets the name shown ("NLH - 1/2", numbered if
  // taken).
  h += `<label>Name<input class="pl-text" name="name" maxlength="${MAX_TABLE_NAME}" placeholder="${esc(formTableName(game, ...lastBlinds, ante))}"></label>`;
  // Posted by everyone every hand; none when left empty.
  h += `<label>Ante${amt('ante', 'Ante', '0', ante)}</label>`;
  h += `<label>Min buy-in<select class="pl-text" name="minBB">${options(MIN_BBS, nearest(MIN_BBS, last.minBB || 40), n => `${n} BB`)}</select></label>`;
  h += `<label>Max buy-in<select class="pl-text" name="maxBB">${options(MAX_BBS, nearest(MAX_BBS, last.maxBB || 100), n => `${n} BB`)}</select></label>`;
  h += `<label>Time to act<select class="pl-text" name="turnSecs">${options(TURN_SECS, last.turnSecs ?? 30, s => (s ? `${s} s` : 'None'))}</select></label>`;
  // Sit-out limit (#70) and Call time (#476): the club's, unless this table sets its own.
  h += `<label>Sitting out<select class="pl-text" name="sitOutMins">${options(SIT_OUT_MINS, club?.sitOutMins ?? 10, m => (m ? `${m} min` : 'No limit'))}</select></label>`;
  const call = nearest(CALL_TIMES, club?.stayHands ?? 0);
  h += `<label>Call time<select class="pl-text" name="stayHands">${options(CALL_TIMES, call, n => (n ? `${n} hands` : 'Off'))}</select></label>`;
  // Rake or time (#449).
  // The club's default (Rules), unless this table sets its own.
  if (chargeOn(club)) h += chargeFieldsHtml(club?.charge);
  h += '</div></details>';
  h += `<div class="cl-formacts"><button class="btn-small primary" type="submit">${offer ? 'Offer' : 'Open table'}</button>`;
  h += wizard ? '<button class="btn-small" type="button" data-cl="wiz-invite">Skip for now</button>' : '<button class="btn-small" type="button" data-cl="cancel-table">Cancel</button>';
  return h + '</div></form>';
}

// ---- the New tournament wizard (#477) ----

// Choices in the wizard that change what its step shows.
// A preset or Other (#544) too: Other's box shows, and a stack picked sets the blinds'.
const WIZARD_CHOICES = new Set(['game', 'preset', 'when', 'end', 'payoutTable', 'buyInPick', 'rakePick', 'stackPick', 'minPlayersPick', 'maxPlayersPick']);

// Opens the wizard on draft `d`: a new tournament, or `edit` ({id, series,
// startsAt}: changing a tournament, the whole series too with `series`;
// {sid}: a series none of which is waiting to start) with its `structure`.
function openWizard(d, edit = null, structure = null) {
  const editor = structureEditor({stack: d.stack, tableSize: d.tableSize, preset: d.preset === 'custom' ? 'regular' : d.preset, steps: structure, presets: false});
  // `start`: the draft as it opened, so ✕ asks before throwing away anything entered (#544).
  tourneyForm = {step: 1, d, edit, note: '', editor, start: draftKey(d, editor.steps())};
  payTable = null;
  tAsk = null;
  render();
}

// The blind structure follows the preset picked, at the starting stack.
function syncWizardBlinds(w) {
  if (w.d.preset !== 'custom' && w.editor.preset() !== w.d.preset) w.editor.setPreset(w.d.preset);
  w.editor.setStack(w.d.stack);
}

// Next: the step read and checked, then the next one; after Review, the
// tournament made or changed.
function wizardNext(f) {
  const w = tourneyForm;
  if (!w) return;
  w.note = readStep(f, w.d, w.step, {edit: w.edit, structureErrors: w.d.preset === 'custom' ? checkStructure(w.editor.steps()) : []});
  if (w.step === 2) syncWizardBlinds(w);
  if (w.note) { render(); return; }
  if (w.step < 5) { w.step++; payTable = null; render(); return; }
  const s = draftSettings(w.d, w.editor.steps(), {repeat: !w.edit || !!w.edit.series});
  const done = !w.edit ? hostAct('new_tourney', {tourney: s})
    : w.edit.sid ? hostAct('edit_series', {id: w.edit.sid, tourney: s})
      : hostAct('edit_tourney', {id: w.edit.id, tourney: s, series: !!w.edit.series});
  done.then(ok => {
    if (!ok) return;
    if (!w.edit) save(TOURNEY_KEY, draftLast(w.d));
    tourneyForm = null;
    render();
  });
}

// Why the club's rake (Rules, #449) wasn't saved, or ''.
let chargeNote = '';

const formTableName = (game, sb, bb, ante = 0) => defaultTableName(club || {tables: []}, game, sb, bb, ante);

// The blinds the form has picked, [sb, bb], in hundredths: a quick pick, or
// Other's as typed (NaN for what isn't an amount).
const formBlinds = f => (f.elements.blinds.value === 'other' ? [parseChips(f.elements.sb.value), parseChips(f.elements.bb.value)] : f.elements.blinds.value.split('/').map(Number));
// Its ante: none when left empty.
const formAnte = f => (f.elements.ante.value.trim() === '' ? 0 : parseChips(f.elements.ante.value));

// Keeps the New table form in step with its game and blinds: picking a game
// picks its usual size, and shows only the sizes it can deal to; the
// name's placeholder is the default name. The blinds and ante stay as they
// are (#655).
function syncTableForm(f, gameChanged) {
  const game = f.elements.game.value;
  if (gameChanged) f.querySelector('.tf-seats').innerHTML = seatsHtml(game, defaultSeats(game));
  const [sb, bb] = formBlinds(f), ante = formAnte(f);
  if (sb > 0 && bb > 0) f.elements.name.placeholder = formTableName(game, sb, bb, ante > 0 ? ante : 0);
  syncChargeFields(f);
}

// What the New table form had picked and typed, to put back after a redraw
// (#655): messages arriving redraw the page, and the form is drawn afresh
// from the last table opened.
const tableFormValues = f => [...f.elements].filter(el => el.name && (el.type !== 'radio' || el.checked)).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]);
function restoreTableForm(f, values) {
  const v = new Map(values);
  const game = v.get('game');
  if (game && game !== f.elements.game.value) f.elements.game.value = game;
  const seats = v.get('seatsPick') === 'other' ? Number(v.get('seats')) : Number(v.get('seatsPick'));
  if (seats) f.querySelector('.tf-seats').innerHTML = seatsHtml(f.elements.game.value, seats);
  for (const [name, x] of values) {
    const el = f.elements[name];
    if (!el || ['game', 'seatsPick', 'seats'].includes(name)) continue;
    if (el.type === 'checkbox') el.checked = x;
    else el.value = x;
  }
  syncTableForm(f, false);
}

function submitTable(f) {
  const v = name => f.elements[name].value;
  const [sb, bb] = formBlinds(f);
  const ante = formAnte(f);
  const seats = v('seatsPick') === 'other' ? Number(v('seats')) : Number(v('seatsPick'));
  const settings = {
    name: v('name'), game: v('game'), sb, bb, ante,
    minBB: Number(v('minBB')), maxBB: Number(v('maxBB')), seats, turnSecs: Number(v('turnSecs')),
    sitOutMins: Number(v('sitOutMins')),
    stayHands: Number(v('stayHands')),
  };
  // Rake or time (#449): the table's own, as the fields say.
  const charge = f.elements.house ? readCharge(f) : null;
  if (charge?.charge !== undefined) settings.charge = charge.charge;
  // What isn't an amount at all is said here; the rest, the club's rules say (#655).
  const [why, at] = !(sb > 0 && bb > 0) ? ['The small and big blind are amounts above 0, to the cent.', sb > 0 ? 'bb' : 'sb']
    : !(ante >= 0) ? ['The ante is an amount of 0 or more, to the cent.', 'ante']
      : settings.maxBB < settings.minBB ? ['The maximum buy-in is at least the minimum.', 'maxBB']
        : charge?.error ? [charge.error, 'house'] : [];
  if (why) {
    // Said in the form, so what was picked stays (#186).
    let n = f.querySelector('.tf-note');
    if (!n) { n = document.createElement('p'); n.className = 'pl-desc pl-neterr tf-note'; f.querySelector('.cl-formacts').before(n); }
    n.textContent = why;
    if (at === 'ante') f.querySelector('.tf-more').open = true;
    f.elements[at].focus();
    return;
  }
  save(TABLE_KEY, {game: settings.game, sb, bb, ante, seats, minBB: settings.minBB, maxBB: settings.maxBB, turnSecs: settings.turnSecs});
  // The form stays open if the table can't be opened, so nothing is lost.
  // Offered, it goes on the club's menu instead.
  hostAct(f.dataset.offer ? 'offer_game' : 'new_table', {table: settings}).then(ok => {
    if (!ok) return;
    tableForm = false;
    if (f.dataset.wizard) setWizard('invite');
    render();
  });
}

// The host watches a table (#73) on the #play page: a spectator's view from
// the engine (no one's cards before they're shown down), nothing to act on.
// On the club manager, the table view opens inside it (manage.js): set
// before the table, so play.js has somewhere to draw it.
let showTable = null;
export function setShowTable(fn) { showTable = fn; }

function watchTable(id) {
  const t = tableById(club, id);
  if (!t || !tableRunning(id)) return;
  showTable?.();
  // Back to Tables afterwards.
  const back = ph('cash');
  const ctl = own();
  const act = hostAct;
  // Who sits where, from the club's updates, for Remove from table (#414).
  let seats = {players: [], view: null};
  const toPage = handlers => u => {
    if (u.type === 'closed') return handlers.onFail('The table closed.');
    if (u.type === 'state') seats = {players: u.players || [], view: u.view};
    handlers.onMessage(u);
  };
  const members = club.members;
  // Seating and moves are the waitlist's and must move's, never the
  // manager's (#518): a player can be removed, no more.
  const seatTools = {
    rows: () => seats.players.map(p => ({
      key: p.id, name: members[p.id]?.name || '', stack: seats.view?.seats?.[p.seat]?.stack ?? 0,
      note: p.removing ? 'Leaving after this hand' : p.moving ? `Moving to ${tableById(club, p.moving)?.name || 'another table'}` : '',
      buttons: p.removing ? [['keep', 'Undo']] : [],
      items: p.removing ? [] : [['after', 'Remove from table']],
    })),
    run: (pid, tool) => act(tool === 'keep' ? 'keep_player' : 'remove_player', {table: id, id: pid}),
  };
  joinTableVia(handlers => {
    // An always-on club's table runs in its room: its view comes encrypted
    // over the owner's (or a manager's) connection (#125).
    ctl.watch(id, toPage(handlers)).catch(e => handlers.onFail(e.message));
    return {send() {}, close: () => ctl.unwatch()};
  }, {
    label: `${club.name} · ${t.name} (watching)`,
    watch: true,
    seatTools,
    onLeave: why => { note = why || ''; location.hash = back; },
  });
  location.hash = 'play';
}

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
    ? '<span class="pl-meta">Around now: the manager</span>'
    : '<span class="pl-meta">No manager is online right now: a help request waits for them.</span>';
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
// `who` false: the last few lines and how many are online, without the
// list (the manager's Overview, #516).
function lobbyHtml(online, chat, form, canSend, who = true) {
  if (!who) {
    let h = `<div class="mg-lobby"><div class="mg-sec-head"><h2>Lobby</h2><span class="pl-meta">${online.length} online</span></div><div class="cl-side-card cl-lobby">`;
    if (chat.length) h += `<ul class="cl-lobby-log">${chat.slice(-3).map(x => `<li><span class="pl-meta">${clock(x.at)}</span> <b${x.host ? ' class="cl-lobby-host"' : ''}>${esc(x.name)}</b> ${esc(x.text)}</li>`).join('')}</ul>`;
    h += `<form class="cl-lobby-form" data-lobbyform="${esc(form)}"><input class="pl-text" name="text" maxlength="${CHAT_MAX}" autocomplete="off" placeholder="Say something" aria-label="Lobby chat"${canSend ? '' : ' disabled'}>`;
    return h + `<button class="btn-small primary" type="submit"${canSend ? '' : ' disabled'}>Send</button></form></div></div>`;
  }
  let h = `<h2>Lobby</h2><div class="cl-side-card cl-lobby"><span class="pl-meta">Online now (${online.length})</span><ul class="cl-lobby-who">`;
  for (const x of online) {
    // "Host" needs no tag, and the host isn't waiting for a game.
    const tag = x.role === 'host' && x.name !== 'Manager' ? 'manager' : '';
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
// from who's connected (the club's room says, in its view).
function hostLobbyHtml() {
  const remote = isRemote();
  const list = onlineList(club, new Set(remote ? own().view?.online || [] : []), false);
  const chat = (club.lobby || []).filter(x => Date.now() - x.at < LOBBY_MAX_AGE_MS);
  return lobbyHtml(list, chat, 'host', remote && own().online, false);
}

// The open help requests, for the host: who, when, from which table, with
// a reply and Done.
function helpListHtml(list, dis = '') {
  if (!list?.length) return '';
  let h = `<div class="cl-needs cl-helpreqs"><h3>Help requests (${list.length})</h3><ul class="cl-list">`;
  for (const x of list) {
    h += `<li><span class="cl-name">${esc(x.name)}</span><span class="pl-meta">${clock(x.at)}${x.table ? ` · at ${esc(x.table)}` : ''}</span><span class="cl-help-text">“${esc(x.text)}”</span>`;
    if (x.reply) h += `<span class="pl-meta">Replied: “${esc(x.reply)}”</span>`;
    h += `<form class="cl-chipform" data-helpreply="${esc(x.id)}"><input class="pl-text" name="reply" maxlength="${MAX_HELP_REPLY}" placeholder="Reply (optional)">`;
    h += `<button class="btn-small" type="submit"${dis}>Reply</button><button class="btn-small primary" type="button" data-cl="help-done" data-id="${esc(x.id)}"${dis}>Done</button></form></li>`;
  }
  return h + '</ul></div>';
}

// Answers help request `id`.
function answerHelpReq(id, reply, handled) {
  hostAct('help_answer', {id, reply, handled});
}

// New help requests for whoever runs a club here: a notice, once each.
function noticeHelp() {
  const lists = [];
  // The manager's notifications show the club's own (#398).
  if (club && mode !== 'manage') lists.push(openHelp(club));
  for (const x of lists.flat()) {
    if (helpNoticed.has(x.id)) continue;
    helpNoticed.add(x.id);
    notice(`${x.name} asks for help: “${x.text}”`, 'clubs/own');
  }
}
// The History tab's activity log, filtered to one person ('' for everyone),
// and to big chip moves only (#190).
let activityBy = '';
let activityBig = false;

// Closing a table asks on its own row (#186): the table being asked about.
let closingTable = null;
// ---- the Tables page (#518) ----
//
// The board: a row per game (type, stakes and seats) with its tables, who's
// seated and how many wait on its list; each row opens to show its tables.
// A game opened: its must-move chain, its list in order (Remove for a
// no-show), and a card per table. Seating, moves and balancing are never
// the manager's: the list and must move do them (club-lists.js,
// club-groups.js).
let seatFilter = 0; // seats to show (2, 6, 9…), or 0 for every game
let stakesFilter = ''; // stakes to show ('micro' … 'high'), or '' for all

// Stakes bands, low to high (ducy-club's Stakes, by the big blind).
const STAKES = ['micro', 'low', 'medium', 'high'];
const STAKES_NAME = {micro: 'Micro', low: 'Low', medium: 'Medium', high: 'High'};

// Filter chips for stakes `bands` (those any table has), with `on` picked;
// none when there's only one band. `code`: a member's club (their Tables
// tab), else the manager's board.
function stakesFilterHtml(bands, on, code = '') {
  if (bands.length < 2) return '';
  const k = code ? ` data-code="${esc(code)}"` : '';
  let h = '<div class="mg-filters" role="group" aria-label="Stakes">';
  for (const s of ['', ...bands]) {
    const pressed = on === s;
    h += `<button class="cc-btn${pressed ? ' on' : ''}" data-cl="stakes-filter" data-s="${s}"${k} aria-pressed="${pressed}">${s ? STAKES_NAME[s] : 'All'}</button>`;
  }
  return h + '</div>';
}
let boardSort = ''; // 'game' or 'stakes'; '' puts games with a list first
const openRows = new Set(); // games opened on the board, by key
let openGame = ''; // the game opened, by key
let mustMoveForm = ''; // the game whose Must move dialog is open

// The club's games: [{key, t (its first table), tables, group}], tables in
// their must-move order, else as they were made.
function gamesOf(tables) {
  const by = new Map();
  for (const t of tables) {
    const k = gameKey(t);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  const offered = key => (club.menu || []).some(x => x.key === key);
  const games = [...by].map(([key, ts]) => {
    const g = (club.groups || []).find(x => ts.some(t => x.tables.includes(t.id))) || null;
    const place = t => (g ? (g.tables.indexOf(t.id) + 1 || 99) : 0);
    ts.sort((a, b) => place(a) - place(b) || (a.createdAt || 0) - (b.createdAt || 0));
    return {key, t: ts[0], tables: ts, group: g, offered: offered(key)};
  });
  // Games on the club's menu that aren't running: players sign up for them.
  for (const m of club.menu || []) if (!by.has(m.key)) games.push({key: m.key, t: m, tables: [], group: null, offered: true});
  return games;
}

// A game's must-move chain by table name: "C → B → A", "C → A or B".
function chainText(g) {
  const name = id => tableById(club, id)?.name || '';
  const m = Math.min(g.mains ?? 1, g.tables.length);
  const mains = g.tables.slice(0, m).map(name).join(' or ');
  return [...g.tables.slice(m).map(name).reverse(), mains].join(' → ');
}

// A table's tag in its game: Main, or Must move → the tables it feeds.
function tableTag(g, tid) {
  if (!g) return '';
  const i = g.tables.indexOf(tid);
  if (i < 0) return '';
  if (isMain(g, i)) return '<span class="mg-tag main">Main</span>';
  return `<span class="mg-tag mm">Must move → ${esc(feeds(g, i).map(x => tableById(club, x)?.name || '').join(' or '))}</span>`;
}

// A table's stakes: "1/2", or "1/2, ante 1" (#655).
const blindsOf = t => `${chips(t.sb)}/${chips(t.bb)}${t.ante > 0 ? `, ante ${chips(t.ante)}` : ''}`;
const gameTitle = t => `${gameLabel(t.game)} ${blindsOf(t)}`;

// A button that can't be used now, saying why beside it (#544).
const offBtn = (btn, why) => `<span class="cl-off">${btn.replace('<button ', '<button disabled ')}<span class="pl-meta">${esc(why)}</span></span>`;
// Watch table `id`, or why not.
function watchBtn(id, cls = 'btn-small') {
  const btn = `<button class="${cls}" data-cl="watch" data-table="${esc(id)}">Watch</button>`;
  return !id ? offBtn(btn, 'No table') : tableRunning(id) ? btn : offBtn(btn, 'Not running');
}

function cashHtml() {
  const tables = openTables(club);
  const counts = seatedCounts();
  const games = gamesOf(tables);
  if (openGame) {
    const g = games.find(x => x.key === openGame);
    if (g) return gameHtml(g, counts);
    openGame = '';
  }
  // New table, or Offer a game: on the club's menu, so players can sign up
  // for it before any table of it runs.
  let h = tableForm ? tableFormHtml({offer: tableForm === 'offer'})
    : '<div class="pl-actions"><button class="btn-small primary" data-cl="new-table">New table</button><button class="btn-small" data-cl="offer-game">Offer a game</button></div>';
  // Scheduled games (#599), of any game the club offers or deals.
  h += ownerScheduledHtml(club, {games: games.map(g => ({key: g.key, label: `${gameTitle(g.t)} · ${seatsName(g.t.seats)}`, seats: g.t.seats})), form: schedForm, name: id => club.members[id]?.name || 'Someone'});
  if (!games.length) return h + (tableForm ? '' : '<p class="pl-meta cl-empty">No tables open.</p>');
  const waiting = g => listOf(club, g.key).length;
  // Filter by seats, when there's more than one size.
  const sizes = [...new Set(games.map(g => g.t.seats))].sort((a, b) => a - b);
  if (!sizes.includes(seatFilter)) seatFilter = 0;
  let filters = '';
  if (sizes.length > 1) {
    filters += '<div class="mg-filters" role="group" aria-label="Seats">';
    for (const n of [0, ...sizes]) {
      const on = seatFilter === n;
      filters += `<button class="cc-btn${on ? ' on' : ''}" data-cl="seat-filter" data-n="${n}" aria-pressed="${on}">${n ? seatsName(n) : 'All'}</button>`;
    }
    filters += '</div>';
  }
  // And by stakes (micro, low, medium, high), when there's more than one;
  // both on one line.
  const bands = STAKES.filter(s => games.some(g => stakesBand(g.t.bb) === s));
  if (!bands.includes(stakesFilter)) stakesFilter = '';
  filters += stakesFilterHtml(bands, stakesFilter);
  if (filters) h += `<div class="mg-filterbar">${filters}</div>`;
  const shown = games.filter(g => (!seatFilter || g.t.seats === seatFilter) && (!stakesFilter || stakesBand(g.t.bb) === stakesFilter));
  const byGame = (a, b) => gameLabel(a.t.game).localeCompare(gameLabel(b.t.game)) || a.t.bb - b.t.bb || a.t.seats - b.t.seats;
  shown.sort(boardSort === 'stakes' ? (a, b) => a.t.bb - b.t.bb || byGame(a, b)
    : boardSort === 'game' ? byGame : (a, b) => (waiting(b) > 0) - (waiting(a) > 0) || byGame(a, b));
  const sortBtn = (k, label) => `<button class="mg-sort${boardSort === k ? ' on' : ''}" data-cl="board-sort" data-k="${k}" aria-pressed="${boardSort === k}">${label}</button>`;
  h += '<div class="mg-board" role="table" aria-label="Games">';
  h += `<div class="mg-brow mg-bhead" role="row"><span role="columnheader">${sortBtn('game', 'Game')}</span><span role="columnheader">${sortBtn('stakes', 'Stakes')}</span><span role="columnheader">Seats</span><span role="columnheader">Tables</span><span role="columnheader">Seated</span><span role="columnheader">Waitlist</span><span role="columnheader"><span class="v3-sr">Actions</span></span></div>`;
  for (const g of shown) {
    const open = openRows.has(g.key);
    const seated = g.tables.reduce((n, t) => n + (counts[t.id] || 0), 0);
    const seats = g.tables.reduce((n, t) => n + t.seats, 0);
    const w = waiting(g);
    h += `<div class="mg-brow${w ? ' waiting' : ''}" role="row">`;
    // The chevron shows its tables here; the name opens the game (#544).
    h += `<span role="cell" class="mg-bgame"><span class="mg-bname"><button class="mg-chevbtn" data-cl="board-row" data-key="${esc(g.key)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} tables"${g.tables.length ? '' : ' disabled'}><span class="mg-chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button>`;
    h += `<button class="mg-toggle" data-cl="game-open" data-key="${esc(g.key)}">${esc(gameLabel(g.t.game))}</button></span>`;
    if (g.group) h += `<span class="mg-chain">Must move ${esc(chainText(g.group))}</span>`;
    // On the menu, no table running: its list is who's interested.
    if (!g.tables.length) h += '<span class="mg-chain">Offered · not running</span>';
    h += '</span>';
    h += `<span role="cell" class="mg-num" data-label="Stakes">${blindsOf(g.t)}</span><span role="cell" data-label="Seats">${seatsName(g.t.seats)}</span>`;
    h += `<span role="cell" class="mg-num" data-label="Tables">${g.tables.length}</span><span role="cell" class="mg-num" data-label="Seated">${seated} / ${seats}</span>`;
    h += `<span role="cell" class="mg-num mg-wait" data-label="Waitlist">${w}</span>`;
    h += `<span role="cell" class="mg-bacts"><button class="btn-small${w ? ' primary' : ''}" data-cl="game-open-table" data-key="${esc(g.key)}">Open table</button>`;
    if (g.offered) h += `<button class="btn-small" data-cl="offer-remove" data-key="${esc(g.key)}" data-ask="Stop offering ${esc(gameTitle(g.t))}?" data-yes="Stop">Stop offering</button>`;
    h += '</span></div>';
    if (!open) continue;
    for (const t of g.tables) {
      const n = counts[t.id] || 0;
      h += `<div class="mg-brow mg-bsub" role="row"><span role="cell" class="mg-bgame"><b>${esc(t.name)}</b> ${tableTag(g.group, t.id)}${t.status === 'closing' ? ' <span class="pl-meta">Closing</span>' : ''}</span>`;
      h += `<span role="cell" class="pl-meta">${chips(t.minBB * t.bb)}–${chips(t.maxBB * t.bb)}${chargeText(t) ? ` · <span class="cl-charge">${esc(chargeText(t))}</span>` : ''}</span><span role="cell"></span><span role="cell"></span>`;
      h += `<span role="cell" class="mg-num" data-label="Seated">${n} of ${t.seats}</span><span role="cell"></span>`;
      h += `<span role="cell" class="mg-bacts">${watchBtn(t.id)}</span></div>`;
    }
  }
  return h + '</div>';
}

// A game opened (#518): its must-move chain with Edit (the dialog), its list
// in order with Remove, and a card per table: Main or Must move, its players
// (a must-move table's in move order), Watch, and Close in its ⋯.
function gameHtml(g, counts) {
  const {t, group} = g;
  const list = listOf(club, g.key);
  const seated = g.tables.reduce((n, x) => n + (counts[x.id] || 0), 0);
  const seats = g.tables.reduce((n, x) => n + x.seats, 0);
  let h = '<button class="link-btn mg-back" data-cl="game-close">‹ Tables</button>';
  h += `<div class="mg-head mg-ghead"><h1 class="mg-h">${esc(gameTitle(t))} · ${seatsName(t.seats)}</h1><span class="pl-meta">${seated} / ${seats} seated · ${list.length} waiting</span>`;
  h += `<button class="btn-small primary" data-cl="game-open-table" data-key="${esc(g.key)}">Open table</button></div>`;
  // Must move needs two tables to move between (#544).
  if (mustMoveForm === g.key) h += mustMoveFormHtml(g);
  else if (group || g.tables.length >= 2) {
    h += '<div class="mg-chainrow">';
    h += group ? `<span class="pl-meta">Must move</span> <b class="mg-chain">${esc(chainText(group))}</b>` : '<span class="pl-meta">Must move off</span>';
    if (g.tables.length >= 2) h += `<button class="btn-small" data-cl="mm-edit" data-key="${esc(g.key)}">Edit</button>`;
    h += '</div>';
  }
  h += '<div class="mg-game">';
  h += '<section class="mg-wl"><h3>Waitlist</h3>';
  if (!list.length) h += '<p class="pl-meta">No one waiting.</p>';
  else {
    h += '<ol class="mg-wlist">';
    for (const e of list) {
      const name = club.members[e.member]?.name || 'Someone';
      const state = e.offer ? `Seat at ${esc(tableById(club, e.offer.table)?.name || 'a table')}` : e.missed ? 'Missed their seat' : clock(e.at);
      h += `<li class="${e.missed ? 'missed' : ''}"><span><b>${esc(name)}</b> <span class="pl-meta">${state}</span></span><button class="btn-small" data-cl="list-remove" data-key="${esc(g.key)}" data-id="${esc(e.member)}" aria-label="Remove ${esc(name)}" data-ask="Remove ${esc(name)}?" data-yes="Remove">Remove</button></li>`;
    }
    h += '</ol>';
  }
  h += '</section><ul class="cl-tables cl-tcards mg-gtables">';
  for (const x of g.tables) {
    const n = counts[x.id] || 0;
    const i = group ? group.tables.indexOf(x.id) : -1;
    const mm = group && i >= 0 && !isMain(group, i);
    h += `<li class="cl-tcard${n ? ' cream' : ''}"><span class="cl-tcard-text"><b class="cl-name">${esc(x.name)}</b> ${tableTag(group, x.id)}<span class="cl-tcard-meta">${n} of ${x.seats}${mm ? ' · in move order' : ''}</span>${chargeText(x) ? `<span class="cl-tcard-meta cl-charge">${esc(chargeText(x))}</span>` : ''}`;
    h += tableStatusHtml(x) + '</span>';
    if (x.status === 'closing') h += '<span class="cl-acts pl-meta">Closing after this hand…</span>';
    else if (closingTable === x.id) {
      h += `<span class="cl-confirm">Close ${esc(x.name)}?`;
      h += `<button class="btn-small primary" data-cl="close-table-yes" data-table="${esc(x.id)}">Close</button><button class="btn-small" data-cl="close-table-no">Keep open</button></span>`;
    } else {
      h += `<span class="cl-acts">${watchBtn(x.id)}`;
      h += menuHtml(`More for ${x.name}`, [['close-table', 'Close table']], '', '', ` data-table="${esc(x.id)}"`) + '</span>';
    }
    // Who's at it: a must-move table's in move order, the rest by seat.
    let at = Object.values(club.members).filter(m => m.seat?.table === x.id);
    if (mm) at.sort((a, b) => (a.seat.satAt ?? Infinity) - (b.seat.satAt ?? Infinity) || (a.id < b.id ? -1 : 1));
    h += seatedHtml(x.id, at.map(m => ({id: m.id, name: m.name, stack: m.seat.stack, removing: !!m.seat.removing, moving: m.seat.moving?.to || ''})), '', g.tables, mm);
    h += '</li>';
  }
  return h + '</ul></div>';
}

// A game's Must move dialog (#518): on or off; how many main tables (only
// more: a main table never goes back to must move); and whether must-move
// tables open, and become main tables, by themselves.
function mustMoveFormHtml(g) {
  const gr = g.group;
  const on = !!gr;
  const mains = gr?.mains ?? 1;
  const k = `data-key="${esc(g.key)}"`;
  let h = `<form class="cl-mmform" data-mmform="1" ${k}><h3>Must move</h3>`;
  h += `<label class="cl-check"><input type="checkbox" name="on"${on ? ' checked' : ''}> On</label>`;
  h += '<div class="cl-mm-more">';
  h += `<label>Main tables<select class="pl-text" name="mains">${g.tables.map((_, i) => i + 1).filter(n => n >= (on ? mains : 1)).map(n => `<option value="${n}"${n === mains ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`;
  h += `<label class="cl-check"><input type="checkbox" name="autoOpen"${gr?.autoOpen ? ' checked' : ''}> Open must-move tables automatically</label>`;
  h += `<label>Players to start<select class="pl-text" name="min">${Array.from({length: g.t.seats - 1}, (_, i) => i + 2).map(n => `<option value="${n}"${n === (gr?.min || g.t.seats) ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`;
  h += `<label class="cl-check"><input type="checkbox" name="autoMain"${gr?.autoMain ? ' checked' : ''}> Make them main tables automatically</label>`;
  h += '</div>';
  return h + `<div class="cl-formacts"><button class="btn-small primary" type="submit">Save</button><button class="btn-small" type="button" data-cl="mm-cancel">Cancel</button></div></form>`;
}

// A table's line under its name: its buy-in, and whether it's dealing and
// for how long (club-overview.js, #398).
function tableStatusHtml(t) {
  const [s] = tableSummaries({...club, tables: [t]}, {}, Date.now());
  const deal = s.dealing ? `<span class="mg-dealing">Dealing ${durationText(s.ms)}</span>` : '<span class="mg-idle">Not dealing</span>';
  return `<span class="cl-tcard-meta">Buy-in ${chips(t.minBB * t.bb)}–${chips(t.maxBB * t.bb)} · ${deal}</span>`;
}

// Who's at table `tid` ([{id, name, stack, removing, moving}]), a must-move
// table's numbered in move order (`ordered`). Tapping a name opens Remove
// (#414: after this hand, "Leaving after this hand" with Undo meanwhile) and
// View member. Moving players is never the manager's (#518): someone on
// their way shows where to. `tables`: the game's tables, for their names.
function seatedHtml(tid, players, dis = '', tables = [], ordered = false) {
  if (!players.length) return '';
  const at = ` data-table="${esc(tid)}"`;
  let h = `<${ordered ? 'ol' : 'ul'} class="cl-at-table${ordered ? ' ordered' : ''}">`;
  for (const p of players) {
    h += '<li>';
    if (dis || p.removing || p.moving) h += `<span>${esc(p.name)} ${chips(p.stack)}</span>`;
    else {
      h += `<details class="cl-menu cl-namemenu" data-keep="name:${esc(tid)}:${esc(p.id)}"><summary>${esc(p.name)} <span class="cl-stack">${chips(p.stack)}</span></summary><div class="cl-menu-items">`;
      h += `<button class="cl-menu-item" data-cl="seat-remove" data-id="${esc(p.id)}"${at}>Remove</button>`;
      h += `<a class="cl-menu-item" href="#${ph('member', p.id)}">View member</a></div></details>`;
    }
    if (p.removing) {
      h += '<span class="pl-meta">Leaving after this hand</span>';
      h += `<button class="link-btn" data-cl="seat-keep" data-id="${esc(p.id)}"${at}${dis}>Undo</button>`;
    } else if (p.moving) h += `<span class="pl-meta">Moving to ${esc(tables.find(x => x.id === p.moving)?.name || 'another table')}</span>`;
    h += '</li>';
  }
  return h + `</${ordered ? 'ol' : 'ul'}>`;
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
const hostNoteKey = () => `ducyClubHost:${club?.code || myClubCode()}`;
const hostNotes = () => load(hostNoteKey(), {});
const setHostNote = (k, v) => save(hostNoteKey(), {...hostNotes(), [k]: v});

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
  // A demo club (#406) is never kept: its backup means nothing.
  if (!isRemote() || demo) return '';
  const plan = own().view?.plan;
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
  // What they owe, paid outside ducy (#633): no chips move.
  paid: m => ({label: `Payment from ${m.name} (owes ${chips(-m.balance)})`, submit: 'Record', value: -m.balance, max: -m.balance, note: true}),
  grant: m => ({label: `Give ${m.name} (asked for ${chips(m.request?.amount)})`, submit: 'Give', value: m.request?.amount ?? '', max: null, note: false}),
  // Declining says why, if you like; the member sees it (#188).
  deny: m => ({label: `Decline ${m.name}’s request for ${chips(m.request?.amount)}`, submit: 'Decline', noAmount: true, note: true, notePlaceholder: 'Why (optional; they see it)'}),
  // Agents (#74, #76): their credit limit is their member one (#445).
  agent: () => ({submit: 'Offer', noAmount: true, note: false}),
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
  if (t.label) h += `<label class="cl-formlabel" for="cl-amt">${esc(t.label)}</label>`;
  // What the float holds to give from (#589).
  if ((chipForm.kind === 'give' || chipForm.kind === 'grant') && isRemote()) h += `<span class="pl-meta cl-float-left">Float ${chips(floatOf(club).float)}</span>`;
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

const onClick = e => onClickIn(e);
const onSubmit = e => onSubmitIn(e);
const onFilter = e => onFilterIn(e);

function onSubmitIn(e) {
  // The club's rake or time for new tables (#449), on Rules.
  const chargeF = e.target.closest('form[data-chargeform]');
  if (chargeF) {
    e.preventDefault();
    const r = readCharge(chargeF);
    chargeNote = r.error || '';
    if (r.error) { render(); return; }
    hostAct('settings', {charge: r.charge}).then(() => render());
    return;
  }
  // A promotion, new or changed (#278).
  const promoF = e.target.closest('form[data-promoform]');
  if (promoF) {
    e.preventDefault();
    let settings;
    try { settings = readPromoForm(promoF); } catch (err) { promoNote = err.message; render(); return; }
    const id = promoF.dataset.promoform;
    hostAct(id ? 'edit_promo' : 'new_promo', id ? {id, promo: settings} : {promo: settings}).then(ok => { if (ok) { promoForm = null; promoNote = ''; render(); } });
    return;
  }
  // Voiding a prize, with why (#544).
  const vf = e.target.closest('form[data-voidform]');
  if (vf) {
    e.preventDefault();
    hostAct('void_award', {id: vf.dataset.voidform, why: vf.elements.why.value}).then(ok => { if (ok) { voiding = ''; render(); } });
    return;
  }
  // Letting someone in as a Cash or Credit player (#621).
  const lif = e.target.closest('form[data-letin]');
  if (lif) {
    e.preventDefault();
    const kind = lif.elements.kind?.value === 'credit' ? 'credit' : 'cash';
    const credit = kind === 'credit' ? parseChips(lif.elements.credit.value) : 0;
    if (kind === 'credit' && !(credit > 0)) { lif.elements.credit.focus(); failAt(lif.querySelector('[type=submit]'), 'Give a Credit player a credit line.'); return; }
    const [who, a, b] = lif.dataset.letin.split('|');
    const args = kind === 'credit' ? {kind, credit} : {kind};
    letIn = '';
    if (who === 'o') hostAct('approve', {id: a, ...args});
    else agentCmd(a, {op: 'approve', id: b, ...args});
    render();
    return;
  }
  // A line in a member's thread (#621): theirs (m|code), the owner's reply
  // (o|id), or their agent's (a|code|id).
  const thf = e.target.closest('form[data-threadform]');
  if (thf) {
    e.preventDefault();
    const text = thf.elements.text.value.trim();
    if (!text) return;
    const [who, a, b] = thf.dataset.threadform.split('|');
    thf.elements.text.value = '';
    if (who === 'm') sendToHost(a, {type: 'note', club: a, text});
    else if (who === 'o') hostAct('note_reply', {id: a, text});
    else if (who === 'a') agentCmd(a, {op: 'reply', id: b, text});
    if (noteForm) { noteForm = ''; render(); }
    return;
  }
  // A notification's form (#398): another amount, a reply, a new credit limit.
  const notef = e.target.closest('form[data-noteform]');
  if (notef) {
    e.preventDefault();
    const kind = notef.dataset.noteform, id = notef.dataset.id;
    const done = ok => { if (ok) { noteForm = ''; render(); } };
    if (kind === 'reply') { answerHelpReq(id, notef.elements.reply.value, true); done(true); return; }
    hostAct(kind === 'raise' ? 'raise_credit' : 'grant', {id, amount: parseChips(notef.elements.amount.value)}).then(done);
    return;
  }
  // The float's size (#589).
  const ff = e.target.closest('form[data-floatform]');
  if (ff) { e.preventDefault(); hostAct('float_size', {amount: parseChips(ff.elements.amount.value)}); return; }
  // A member's vault (#579): putting chips in, or taking them out.
  const vf2 = e.target.closest('form[data-vaultform]');
  if (vf2) { e.preventDefault(); vaultAct(vf2, vf2.dataset.vaultform, {amount: parseChips(vf2.elements.amount.value)}); return; }
  // Club info (#398).
  const inf = e.target.closest('form[data-infoform]');
  if (inf) { e.preventDefault(); hostAct('set_info', {info: readInfoForm(inf)}); return; }
  // A member's credit limit (#404).
  const cf = e.target.closest('form[data-creditform]');
  if (cf) { e.preventDefault(); hostAct('set_credit', {id: cf.dataset.id, amount: readPick(cf.elements, 'amount', parseChips)}); return; }
  // Sitting down with a buy-in (#404).
  const sf2 = e.target.closest('form[data-sitform]');
  if (sf2) {
    e.preventDefault();
    sitForm = '';
    sitAmount = 0;
    sitAt(sf2.dataset.code, sf2.dataset.table, sf2.elements.amount ? parseChips(sf2.elements.amount.value) || 0 : 0);
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
  if (hr) { e.preventDefault(); answerHelpReq(hr.dataset.helpreply, hr.elements.reply.value, false); return; }
  const tf = e.target.closest('form[data-tableform]');
  if (tf) { e.preventDefault(); submitTable(tf); return; }
  // Schedule a game, or change one (#599).
  const schedF = e.target.closest('form[data-schedform]');
  if (schedF) {
    e.preventDefault();
    const {spec, note} = readSchedForm(schedF);
    const id = schedF.dataset.schedform;
    if (note) { schedForm = {...schedForm, note}; render(); return; }
    hostAct(id ? 'edit_scheduled' : 'schedule_game', id ? {id, game: spec} : {game: spec}).then(ok => { if (ok) { schedForm = null; render(); } });
    return;
  }
  // A game's Must move (#518).
  const mf = e.target.closest('form[data-mmform]');
  if (mf) {
    e.preventDefault();
    const el = mf.elements;
    hostAct('set_must_move', {key: mf.dataset.key, on: el.on.checked, mains: Number(el.mains.value), autoOpen: el.autoOpen.checked, autoMain: el.autoMain.checked, min: Number(el.min.value)})
      .then(ok => { if (ok) { mustMoveForm = ''; render(); } });
    return;
  }
  // A step of the New tournament wizard (#77, #477), or a club payout table
  // made or changed in it (#424).
  const tof = e.target.closest('form[data-tourneyform]');
  if (tof) { e.preventDefault(); wizardNext(tof); return; }
  const pf = e.target.closest('form[data-paytable]');
  if (pf) {
    e.preventDefault();
    if (!payTable) return;
    syncPayTable(pf);
    let table;
    try { table = {name: payTable.name, rows: cleanRows(payTable.draft)}; } catch (err) { failAt(e.submitter || pf.querySelector('[type=submit]'), err.message); return; }
    const id = pf.dataset.paytable;
    hostAct(id === 'new' ? 'add_payout_table' : 'edit_payout_table', id === 'new' ? {table} : {id, table}).then(ok => {
      if (!ok) return;
      payTable = null;
      // A new one is the wizard's pick.
      if (tourneyForm && id === 'new') tourneyForm.pick = String(table.name).split(/\s+/).filter(Boolean).join(' ').toLowerCase();
      render();
    });
    return;
  }
  const bf = e.target.closest('form[data-clform="backup"]');
  if (bf) { e.preventDefault(); submitBackup(bf); return; }
  const prf = e.target.closest('form[data-clform="prove"]');
  if (prf) { e.preventDefault(); submitProof(prf); return; }
  // A member's Back up card (#562): Player settings' backup.
  const mbf = e.target.closest('form[data-clform="member-backup"]');
  if (mbf) {
    e.preventDefault();
    saveBackup(me, mbf).then(() => { memberBackup = {saved: true}; render(); }, err => { memberBackup = {form: true, note: err.message}; render(); });
    return;
  }
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
    agentCmd(gf.dataset.code, {op: gf.dataset.agentform, id: gf.dataset.id, amount, note: gf.elements.note?.value || ''});
    render();
    return;
  }
  const f = e.target.closest('form[data-chipform]');
  if (!f) return;
  e.preventDefault();
  const id = f.dataset.id, kind = f.dataset.chipform;
  const amount = f.elements.amount ? parseChips(f.elements.amount.value) : 0;
  const why = f.elements.note?.value || '';
  const op = {give: 'give', take: 'take', paid: 'record_payment', grant: 'grant', deny: 'deny', agent: 'offer_agent'}[kind];
  // The form stays, busy, until it's done; refused, it says why (#544).
  if (op) hostAct(op, {id, amount, note: why}).then(ok => { if (ok && chipForm?.kind === kind && chipForm.id === id) { chipForm = null; render(); } });
}


// `b`: the button, where a reason it can't be done shows.
function closeClub(b) {
  if (isRemote()) {
    // An always-on club keeps running on the server; this browser just stops
    // running it. Deleting the club itself comes later (#98).
    if (!confirm(`Stop running ${club?.name || 'this club'} from this browser? The club keeps running on the server for its members, and this browser can’t get back to it.`)) return;
    owner.forget();
    club = null;
    render();
    return;
  }
  if (!confirm(`Close ${club.name}? Its members and records are deleted from this browser.`)) return;
  club = null;
  verifier = null;
  try { localStorage.removeItem(CLUB_KEY); localStorage.removeItem(SENDERS_KEY); } catch {}
  render();
}

// Opens an always-on club this player owns, made in another browser (#98).
async function attachAlwaysOn(code) {
  code = normCode(code || '');
  if (!code) { note = 'Enter the club’s code, like ABCD-EFGH.'; render(); return; }
  if (owner.record) { note = 'This browser already runs an always-on club; one per browser for now.'; render(); return; }
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
  // A manager's view of the whole club (#417) is live only.
  save(MEMBERSHIPS_KEY, memberships.map(({mgr: _, ctl: __, mgrResult: ___, ...m}) => m));
}

function connectMembership(mem) {
  if (playerNets.has(mem.code)) return;
  // keys: this connection's key pair for encrypted table updates (e2e.js);
  // aes: the key shared with the host, for the host key in aesFor.
  const entry = {net: null, online: false, hostHere: false, sends: Promise.resolve(), inbox: Promise.resolve(), keys: newKeyPair(), aes: null, aesFor: '', unlocked: false};
  playerNets.set(mem.code, entry);
  // Once the connection is unlocked with the player's passkey (#575): a
  // demo's needs none.
  entry.greet = () => greet();
  const greet = async () => {
    // Never ask to join without a name: the host would see a nameless player.
    if (mem.status === 'new' && !nameIn(mem)) { mem.error = 'Enter your name above and click Save to send your request.'; render(); return; }
    const key = (await entry.keys).pub;
    const body = mem.status === 'new'
      ? {type: 'join', club: mem.code, invite: mem.invite, name: nameIn(mem), intro: mem.intro || '', key}
      : {type: 'hello', club: mem.code, name: nameIn(mem), since: lastEntry(mem), ledger: 'links', key};
    sendToHost(mem.code, body);
    // Back at a club table after the host (or this page) reconnected.
    if (seatedAt?.code === mem.code) {
      sendToHost(mem.code, {type: 'table', club: mem.code, table: seatedAt.table, cmd: {type: 'join', name: nameIn(mem)}});
      tableLocation?.again();
    }
  };
  const handle = async msg => {
    if (msg?.type === 'host_away' || msg?.type === 'host_gone') {
      entry.hostHere = false;
      if (seatedAt?.code === mem.code) seatedAt.handlers.onMessage({type: 'host_gone'});
      render();
      return;
    }
    if (msg?.type === 'host_back') { entry.hostHere = true; if (entry.unlocked || demo) greet(); render(); return; }
    if (msg?.type === 'queue_full') return;
    // The passkey unlock (#575): unlocked, refused, or chips need a fresh one.
    if (passMessage(entry, msg)) return;
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
    const hadLedger = mem.ledger;
    const hadTables = mem.tables ? new Set(mem.tables.map(t => t.id)) : null;
    if (await playerReceive(mem, msg)) {
      // In a club, maybe with chips: ask the browser to keep this player ID (#562).
      if (mem.status === 'member') keepStorage();
      // The request reached the club, with who you are (#621).
      if (mem.status !== 'new') delete mem.intro;
      if (before !== 'member' && mem.status === 'member') {
        justJoined.add(mem.code);
        // Approved: say so wherever you are (#185).
        // Let in with a credit line (#633): nothing to ask for.
        if (before) notice(msg.body?.credit > 0 ? `You’re in ${mem.name || mem.code}.` : `You’re in ${mem.name || mem.code}. Ask the manager for chips to play.`);
        // Let in at once (#631): on to the club's page.
        if (before === 'new' && location.hash === '#join') location.hash = clubHash(mem.code);
      }
      // Chips given to you, and a table opening, wherever you are (#193).
      const cname = mem.name || mem.code;
      if (msg.body?.type === 'account') {
        // A copy that just started again (club.js) has nothing new in it.
        const fresh = mem.ledger === hadLedger ? (mem.entries || []).filter(e => !hadEntries.has(e.n) && Date.now() - e.at < 3600e3) : [];
        const given = fresh.filter(e => e.kind === 'give').reduce((n, e) => n + e.amount, 0);
        if (given) notice(`${cname}: you were given ${chips(given)} chips.`);
        // Standing up (#404): "You left Main", the result and the balance after.
        const out = fresh.findLast(e => e.kind === 'cash_out' && !e.player);
        if (out && hadEntries.size && Date.now() - out.at < 120e3) leftPanels.set(mem.code, out.n);
        // The table's Add chips panel shows what's available now.
        if (seatedAt?.code === mem.code) tableChanged();
      }
      if (msg.body?.type === 'tables' && hadTables) {
        const opened = (mem.tables || []).filter(t => !hadTables.has(t.id));
        if (opened.length) notice(`${cname} opened ${opened.map(t => t.name).join(', ')}.`);
      }
      if (msg.body?.type === 'tables') checkSeatWatch(mem);
      // Grouped tables (#501): asked about a new table, the table it opened
      // for you (Sit down, there), or why it didn't open.
      if (msg.body?.type === 'group' && mem.groupEvent) {
        const ev = mem.groupEvent;
        mem.groupEvent = null;
        if (ev.kind === 'ask') notice(`${cname}: We’re starting a new table. Join?`, clubHash(mem.code));
        else if (ev.kind === 'open' && ev.table) {
          notice(`${cname}: ${ev.name} is open.`, clubHash(mem.code));
          sitForm = `${mem.code}|${ev.table}`;
          sitAmount = 0;
        } else if (ev.reason) notice(`${cname}: ${ev.reason}`, clubHash(mem.code));
      }
      // A waitlist (#518): a seat offered you, an offer missed, off a list,
      // or why not; wherever you are.
      if (msg.body?.type === 'list' && mem.listEvent) {
        const ev = mem.listEvent;
        mem.listEvent = null;
        if (ev.kind === 'offer') notice(`${cname}: a seat at ${ev.name} is yours for a minute.`, clubHash(mem.code));
        else if (ev.kind === 'missed') notice(`${cname}: you missed your seat. You keep your place for 10 minutes.`, clubHash(mem.code));
        else if (ev.kind === 'refused' && ev.reason) notice(`${cname}: ${ev.reason}`, clubHash(mem.code));
      }
      // A scheduled game's news (#599), wherever you are; at the start, your
      // seat's buy-in.
      if (msg.body?.type === 'sched' && mem.schedEvent) {
        const ev = mem.schedEvent;
        mem.schedEvent = null;
        const say = {
          confirmed: ev.place ? `you’re #${ev.place} on the waitlist for ${ev.name}.` : `you’re signed up for ${ev.name}.`,
          seat: `you got a seat in ${ev.name}.`, checkin: `check-in is open for ${ev.name}.`,
          start: `${ev.name} is starting. Take your seat at ${ev.tableName}.`, short: `${ev.name}: too few checked in. Waiting on the owner.`,
          edited: `${ev.name} was changed.`, cancelled: `${ev.name} was cancelled.`, waitlist: `${ev.name} is full. You’re on its waitlist.`,
          refused: ev.reason,
        }[ev.kind];
        if (say) notice(`${cname}: ${say}`, clubHash(mem.code));
        if (ev.kind === 'start' && ev.table && !(seatedAt?.code === mem.code)) { sitForm = `${mem.code}|${ev.table}`; sitAmount = 0; }
      }
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
    // Proven (the relay asked this page to sign for the player's ID, #577);
    // then the unlock, then the greeting.
    onOpen() { entry.online = true; entry.hostHere = true; entry.blocked = ''; mem.error = ''; if (demo) greet(); else sendUnlock(entry); render(); },
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
      mem.error = /No table/.test(reason) ? 'The club isn’t reachable, and this relay can’t hold your request. Try again later.' : reason;
      render();
    },
  }, {queue: true, persistent: true, prove: proveFor(mem.code)});
}

// ---- passkeys (#575) and proving the player's ID (#577) ----

// Signs the relay's challenge for room `code` with the player's key.
const proveFor = code => challenge => signMessage(me, {type: 'prove', room: code, challenge});

// Where this player is with their passkey: 'open' (unlocked, or not
// needed: no clubs yet, a demo), 'none' (they have none: make one),
// 'locked' (unlock), 'unsupported' (this browser can't), or 'unknown'
// (the relay can't be asked). `note`: what went wrong last.
let pass = {state: 'open', note: '', busy: false};
let pendingCreate = null; // a club name to create once unlocked
// Whether this browser's player needs their passkey here: in a club, or
// running one.
const needsPass = () => !demo && !!me && (memberships.length > 0 || !!owner?.record || !!pendingCreate);

async function refreshPass() {
  if (!needsPass()) { pass.state = 'open'; return; }
  if (!pk.supported()) { pass.state = 'unsupported'; render(); return; }
  pk.prepare().catch(() => {});
  try {
    const st = await pk.status(me.id);
    pass.state = !st.enrolled ? 'none' : pk.session(me.id) ? 'open' : 'locked';
  } catch {
    pass.state = 'unknown';
  }
  render();
}

// The card in place of a club page until the passkey is set up or used.
function passGateHtml() {
  if (!needsPass() || pass.state === 'open' || pass.state === 'unknown') return '';
  const busy = pass.busy ? ' disabled' : '';
  const err = pass.note ? `<p class="cl-backup-text cl-down">${esc(pass.note)}</p>` : '';
  if (pass.state === 'unsupported') return '<section class="cl-left cl-pass"><b class="cl-left-title">Passkeys needed</b><p class="cl-backup-text">Clubs need a passkey, and this browser can’t make one. Try Safari, Chrome or Edge.</p></section>';
  if (pass.state === 'locked') return `<section class="cl-left cl-pass"><b class="cl-left-title">Unlock your clubs</b>${err}<button class="btn-small primary" data-cl="pass-unlock"${busy}>Use passkey</button></section>`;
  let h = '<section class="cl-left cl-pass"><b class="cl-left-title">Set up a passkey</b>';
  // Why (the one place the stakes need saying): it's what keeps the account.
  h += '<p class="cl-backup-text">Clubs need one. It keeps anyone else using this device out of your clubs, and gets your account back on a new phone.</p>';
  h += err;
  return h + `<span class="cl-pass-acts"><button class="btn-small primary" data-cl="pass-enrol"${busy}>Continue</button><button class="link-btn" data-cl="pass-recover"${busy}>I have a passkey</button></span></section>`;
}

// Sends this tab's session to connection `entry` (a membership's), if there
// is one; the relay answers 'unlocked' (then the greeting) or 'locked'.
function sendUnlock(entry) {
  entry.unlocked = false;
  const s = pk.session(me.id);
  if (s) entry.net?.send({type: 'unlock', token: s.token});
  else refreshPass();
}

// The relay's word on a connection's unlock. True if `msg` was one.
function passMessage(entry, msg) {
  if (msg?.type === 'unlocked') {
    entry.unlocked = true;
    pk.touch();
    for (const f of entry.waiting || []) f(true);
    entry.waiting = [];
    entry.greet?.();
    render();
    return true;
  }
  if (msg?.type === 'locked') {
    entry.unlocked = false;
    for (const f of entry.waiting || []) f(false);
    entry.waiting = [];
    pk.forget();
    refreshPass();
    return true;
  }
  if (msg?.type === 'unlock_again') {
    pass.note = 'Unlock with your passkey again to move chips.';
    render();
    return true;
  }
  return false;
}

// Every club connection, unlocked with the session just started. Resolves
// once they've all said so (or a few seconds have passed).
function unlockAll() {
  const s = pk.session(me.id);
  if (!s) return Promise.resolve();
  const waits = [];
  for (const entry of playerNets.values()) {
    if (!entry.net) continue;
    waits.push(new Promise(res => { (entry.waiting ||= []).push(res); setTimeout(() => res(false), 8000); }));
    entry.net.send({type: 'unlock', token: s.token});
  }
  if (owner?.connected) waits.push(owner.unlock(s.token).catch(() => false));
  return Promise.all(waits);
}

// After a passkey made or used: open, and everything carries on.
async function unlocked() {
  pass = {state: 'open', note: '', busy: false};
  render();
  await unlockAll();
  if (pendingCreate) { const n = pendingCreate; pendingCreate = null; createClub(n); }
  render();
}

// A passkey action from the gate card, with what went wrong shown on it.
async function passAct(act) {
  if (pass.busy) return;
  pass.busy = true;
  pass.note = '';
  render();
  try {
    if (act === 'enrol') await pk.enrol(me, myName());
    else if (act === 'unlock') await pk.unlock(me);
    else { await recoverAccount(); pass.busy = false; return; }
    await unlocked();
  } catch (e) {
    pass.busy = false;
    pass.note = e.message;
    // Signing in from a page without the card: said at the top.
    if (!passGateHtml()) note = e.message;
    // Someone else's passkey, or the relay forgot this one: look again.
    pk.status(me.id, true).then(st => { if (st.enrolled && pass.state === 'none') pass.state = 'locked'; render(); }).catch(() => {});
    render();
  }
}

// Recovery on this device with a passkey (#575): the clubs the account
// was in come back. With a copy of the key it opened, that's the old player
// ID, and the page reloads with it; else the relay vouched for this one.
async function recoverAccount() {
  const r = await pk.recover();
  for (const [code, c] of Object.entries(r.clubs || {})) {
    if (c.owner) {
      // The club manager reopens it (as a club backup's restore does).
      try { localStorage.setItem(RESTORE_CLUB_KEY, JSON.stringify({code, name: c.name})); } catch {}
      continue;
    }
    if (memberships.some(m => m.code === code) || !c.hostId) continue;
    // A member already (or moved over on unlock): they say hello, no request.
    memberships.push({...newMembership({code, hostId: c.hostId, invite: '', name: c.name}), status: 'member'});
  }
  saveMemberships();
  if (r.id !== me.id) { location.reload(); return; }
  for (const m of memberships) connectMembership(m);
  await unlocked();
  // Their own club, on the club manager: open it now.
  const ownClub = Object.entries(r.clubs || {}).find(([, c]) => c.owner);
  if (ownClub && mode === 'manage' && !isRemote() && !club) {
    try { localStorage.removeItem(RESTORE_CLUB_KEY); } catch {}
    await attachAlwaysOn(ownClub[0]);
  }
}

// Moving chips needs an unlock from the last few minutes (#575): asked for
// now if it's older, so the command isn't refused. Resolves to '' when it
// may go ahead, else why not.
async function freshPass() {
  if (demo || pk.fresh(me.id)) return '';
  try {
    await pk.unlock(me);
    await unlockAll();
    return '';
  } catch (e) {
    return e.message || 'Not unlocked.';
  }
}

function joinFromInvite(name, intro = '') {
  const n = String(name || '').trim().slice(0, MAX_PLAYER_NAME);
  if (!n) { note = 'Enter the name the manager will see.'; render(); return; }
  // Who you are (#621): it goes with the join, to the owner or the agent.
  const said = String(intro || '').trim().slice(0, MAX_THREAD_NOTE);
  if (invite.hostId === me.id) { note = 'That’s an invite to your own club.'; invite = null; clearInviteFromAddress(); render(); return; }
  // The first name given is this browser's; another one is for this club
  // only (#185).
  if (!myName()) { try { localStorage.setItem(NAME_KEY, n); } catch {} }
  // Joining a club: ask the browser to keep this player ID (#562).
  keepStorage();
  let mem = memberships.find(m => m.code === invite.code);
  if (mem) {
    mem.invite = invite.invite;
    if (mem.status !== 'member' && mem.status !== 'pending') mem.status = 'new';
  } else {
    mem = newMembership(invite);
    memberships.push(mem);
  }
  if (n !== myName()) mem.myName = n; else delete mem.myName;
  if (said) mem.intro = said;
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
    ? {type: 'join', club: m.code, invite: m.invite, name, intro: m.intro || ''}
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
// The replayer (replayer.js). On the club manager, the equity calculator
// opens in a tab of the player app.
const replay = new Replayer({
  onChange: () => render(),
  equityLink: hash => (mode === 'manage' ? {href: `${playerBase()}${hash}`, target: '_blank'} : {href: hash, target: ''}),
});

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
    handLists.set(`${code}|${who}`, remoteHost ? await own().run('hands', {limit: 100}) : await listHands(code, who));
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

// A history's hands as listed: its table filter applied, newest first.
const listedHands = k => (handLists.get(k) || []).filter(r => !historyTable[k] || r.table === historyTable[k]).slice(0, 100);

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
  const rows = listedHands(k);
  if (tables.length > 1) {
    h += `<select class="pl-text cl-handfilter" data-handfilter="${esc(k)}"><option value="">All tables</option>${tables.map(([id, n]) => `<option value="${esc(id)}"${id === filter ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  }
  if (!rows.length) return h + `<p class="pl-meta">No hands yet${filter ? ' at this table' : ': they show here once hands are played at the club’s tables'}.</p></div>`;
  h += '<ul class="cl-list cl-handlist">';
  for (const r of rows) {
    const mine = r.who !== 'host' ? r.seats[0] : null;
    h += `<li><span class="pl-meta">${new Date(r.at).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}</span>`;
    h += `<span>${esc(r.tableName)} #${r.hand}</span><span class="cl-chips">pot ${chips(r.pot)}</span>`;
    h += mine ? `<span class="${mine.net > 0 ? 'cl-up' : mine.net < 0 ? 'cl-down' : 'pl-meta'}">${mine.net > 0 ? '+' : ''}${chips(mine.net)}</span>` : `<span class="pl-meta">${esc(summary(r))}</span>`;
    // The seat and location flags at the table (#581), the owner's only.
    const flags = !mine && handFlagsText(r);
    if (flags) h += `<span class="cl-handflags">${esc(flags)}</span>`;
    h += `<span class="cl-acts"><button class="btn-small" data-cl="replay" data-id="${esc(r.id)}" data-list="${esc(k)}">Replay</button></span></li>`;
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
  if (!e.hand || (e.kind !== 'prize' && e.kind !== 'void')) return '';
  return ` <button class="link-btn" data-cl="promo-replay" data-code="${esc(code)}" data-who="${esc(who)}" data-hand="${esc(e.hand)}">Replay</button>`;
}

// Opens the hand behind a prize: in the host's history by its id; in a
// member's own by the table and hand number (their record of the same hand
// was made in their browser, at a slightly different time). `b`: the
// button, where it says if the hand is gone.
async function openPromoReplay(code, who, handId, b = null) {
  const key = ctlKey(b);
  const parts = String(handId).split(':');
  const at = Number(parts.pop()), hand = Number(parts.pop());
  parts.shift();
  const table = parts.join(':');
  let list = [];
  try {
    const remoteHost = isRemote() && who === 'host' && code === club?.code;
    list = remoteHost ? await own().run('hands', {limit: 200}) : await listHands(code, who, 1000);
  } catch (e) { console.warn(e); }
  const rec = list.find(r => r.id === handId)
    || list.filter(r => r.table === table && r.hand === hand && Math.abs(r.at - at) < 30 * 60e3).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
  if (!rec) {
    failAt(key, who === 'host' ? 'That hand is no longer in the club’s hand history.' : 'That hand isn’t in this browser’s hand history: it keeps the hands you played here, up to a limit.');
    return;
  }
  replay.open(rec);
}

// A hand from a list (`list`: its history's key), with the others in the
// list as the previous and next hands.
async function openReplay(id, list = '') {
  // One loaded from an always-on club's room is already in the list (#125).
  const listed = [...handLists.values()].flat().find(r => r.id === id);
  const rec = listed || await getHand(id);
  if (!rec) return;
  replay.open(rec, list ? listedHands(list) : [rec]);
}

// ---- playing at a club table ----

// Sits down at a club table: the #play page draws it (play.js), and its
// commands go to the host signed, over this club's connection.
// `amount`: the buy-in chosen on the club page (#404), added once seated.
function sitAt(code, table, amount = 0) {
  const mem = memberships.find(m => m.code === code);
  // A tournament's tables are table 'tourney:<id>' (#81): its chips are whole.
  const tourney = table.startsWith('tourney:') ? mem?.tourneys?.find(x => x.id === table.slice(8)) : null;
  const t = tourney || mem?.tables?.find(x => x.id === table);
  if (!mem || !t) return;
  // A cash table's chips come from what's available, own and credit (#404);
  // with nothing, the manager is asked from the table.
  const credit = tourney ? null : {
    available: () => availableIn(mem),
    asked: () => mem.request?.table ? mem.request.amount : 0,
    ask: n => sendToHost(code, {type: 'chip_request', club: code, amount: n, note: '', table: t.name}),
    cancel: () => sendToHost(code, {type: 'cancel_request', club: code}),
  };
  // The browser's location while seated (#581, table-location.js), to the
  // club's room on the relay; only over an unlocked connection.
  stopLocation();
  if (!demo) {
    tableLocation = watchLocation(m => {
      const entry = playerNets.get(code);
      if (entry?.unlocked) entry.net?.send(m);
    });
  }
  joinTableVia(handlers => {
    seatedAt = {code, table, handlers};
    return {
      send: cmd => sendToHost(code, {type: 'table', club: code, table, cmd}),
      close: () => { if (seatedAt?.table === table) { seatedAt = null; stopLocation(); } },
    };
  }, {
    label: `${mem.name} · ${t.name}`,
    whole: !!tourney,
    credit,
    // The club's promotions for this table (#278), kept current as they change.
    // Or, moving to another table (#425), where.
    banner: () => (seatedAt?.reserve ? `Moving to ${seatedAt.reserve.name} after this hand` : tableBannerText(mem.promos, {table, game: t.game, tourney: !!tourney})),
    // A must-move table (#518): the tables it feeds, its move order (on
    // request), and moving up.
    mustMove: () => {
      const g = mem.tables?.find(x => x.id === table)?.group;
      if (!g || g.main) return null;
      const order = g.order || [];
      return {to: (g.to || []).join(' or '), order: order.map(p => p.name), mine: order.findIndex(p => p.id === me.id) + 1, moving: seatedAt?.reserve?.name || ''};
    },
    onLeave: why => { seatedAt = null; stopLocation(); note = why || ''; location.hash = clubHash(code); },
    // Each hand you played goes in your hand history (#71), as you saw it.
    onHand: view => {
      if (view.seats[0]?.sitting_out || view.seats[0]?.empty) return;
      storeHand(handRecord({club: code, table, tableName: t.name, game: t.game, view, who: me.id}), {keep: keepHands()});
    },
  });
  if (amount > 0 && !tourney) sendToHost(code, {type: 'table', club: code, table, cmd: {type: 'request_chips', amount}});
  location.hash = 'play';
}

let tableLocation = null; // watchLocation's, while seated at a club table
function stopLocation() {
  tableLocation?.stop();
  tableLocation = null;
}

// What member `mem` may bring to a table: their balance and credit (#404;
// from an older host, the balance).
const availableIn = mem => (mem.available != null ? mem.available : Math.max(0, mem.balance || 0));

function tableUpdate(u) {
  if (!seatedAt || !u) return;
  // A fair deal (#136): this page's part of the host's round.
  if (u.type === 'fair') {
    const {code, table} = seatedAt;
    fair.message(u, cmd => sendToHost(code, {type: 'table', club: code, table, cmd}));
    return;
  }
  // Refused for good (not a member, at another table, table closed).
  if (u.type === 'rejected' && u.fatal) { seatedAt.handlers.onFail(u.reason); return; }
  // The manager removed you (#414). The club page shows your result under
  // it (Last session), as when you leave.
  // Idle too long (#421): the same, by the table.
  if (u.type === 'removed') { seatedAt.handlers.onFail(u.idle ? `You were idle for 10 minutes, so you left ${String(u.name || 'the table')}.` : `The manager removed you from ${String(u.name || 'the table')}.`); return; }
  // Moving tables (#425): a seat held for you at another table (or why
  // not), then, after your hand, the buy-in there, with what you left with.
  if (u.type === 'reserve') {
    if (u.refused) { seatedAt.reserve = null; note = String(u.refused); } else { seatedAt.reserve = {table: String(u.table), name: String(u.name || '')}; note = ''; }
    render();
    tableChanged();
    return;
  }
  if (u.type === 'moved') {
    const {code} = seatedAt;
    seatedAt.handlers.onFail('');
    sitForm = `${code}|${String(u.to)}`;
    sitAmount = Math.max(0, Number(u.chips) || 0);
    setMemberTab(code, 'tables');
    render();
    setTimeout(() => root.querySelector('form[data-sitform]')?.scrollIntoView({block: 'center'}), 300);
    return;
  }
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

// The club manager's top bar (#398): the club switcher, Live, the
// notifications bell and the account. Redrawn with the page.
let toolsDrawn = '';
function drawTools() {
  const el = mode === 'manage' && document.getElementById('mg-tools');
  if (!el) return;
  if (!el.dataset.on) { el.dataset.on = '1'; el.addEventListener('click', onClick); }
  const h = toolsHtml();
  if (h === toolsDrawn) return;
  const opened = new Set([...el.querySelectorAll('details[data-keep][open]')].map(d => d.dataset.keep));
  el.innerHTML = toolsDrawn = h;
  for (const d of el.querySelectorAll('details[data-keep]')) if (opened.has(d.dataset.keep)) d.open = true;
}

function toolsHtml() {
  const own = club || owner?.record;
  const at = me ? shownClub() : '';
  const helped = memberships.filter(helps);
  const ownName = club?.name || owner?.record?.name || '';
  const running = at === 'own' && own && !(wizard?.code === myClubCode());
  const name = running ? ownName : at && at !== 'own' ? helped.find(m => m.code === at)?.name || at : '';
  let h = '';
  if (running && club) h += `<button class="mg-burger" data-cl="mg-nav" aria-label="Menu" aria-expanded="${navOpen}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg></button>`;
  if (name) {
    h += `<details class="cl-menu mg-switch" data-keep="mg-switch"><summary title="Switch club">${esc(name)} <span aria-hidden="true">▾</span></summary><div class="cl-menu-items">`;
    if (own) h += `<a class="cl-menu-item" href="#clubs/overview">${esc(ownName)}</a>`;
    for (const m of helped) h += `<a class="cl-menu-item" href="#${clubHash(m.code)}">${esc(m.name || m.code)}</a>`;
    h += '<a class="cl-menu-item" href="#clubs">All clubs</a></div></details>';
  } else h += '<span class="mg-badge">Club manager</span>';
  h += '<span class="mg-spacer"></span>';
  if (running && club) {
    h += liveHtml();
    const n = noteCount();
    h += `<button class="mg-bell${notesOpen ? ' on' : ''}" data-cl="mg-notes" aria-label="Notifications${n ? `, ${n}` : ''}" aria-expanded="${notesOpen}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1z"/></svg>${n ? `<span class="mg-count">${n}</span>` : ''}</button>`;
  }
  if (me) {
    const who = myName() || 'You';
    h += `<details class="cl-menu mg-acct" data-keep="mg-acct"><summary class="mg-avatar" aria-label="Account" title="${esc(who)}">${esc(who.slice(0, 1).toUpperCase())}</summary><div class="cl-menu-items">`;
    h += `<span class="cl-menu-item mg-acct-id"><b>${esc(who)}</b> <code>${esc(showId(me.id))}</code></span>`;
    h += `<a class="cl-menu-item" href="${playerHref('')}">Player app</a><a class="cl-menu-item" href="#clubs">All clubs</a></div></details>`;
  }
  return h;
}

// Forms whose typing survives a redraw (#398, #404, #544).
const KEPT_FORMS = 'form[data-noteform], form[data-infoform], form[data-sitform], form[data-creditform], form[data-voidform], form[data-floatform], form[data-vaultform], form[data-schedform], form[data-threadform], form[data-letin]';
// A control that had the focus while it was busy (disabled): it gets it back
// once it's answered (#544).
let focusLater = '';

function render() {
  for (const f of listeners) f();
  updateCalls();
  drawTools();
  if (me) noticeHelp();
  if (!open || !root) return;
  const body = me ? viewHtml() : (view === 'clubs' ? `<p class="pl-meta">${esc(note || 'Loading…')}</p>` : '');
  // Nothing for this tab: the play.js part of it stands alone.
  root.hidden = !body && !replay.isOpen;
  if (root.hidden) { root.innerHTML = ''; return; }
  let h = '<div class="pl-wrap cl-wrap">' + body;
  h += replay.html();
  h += '</div>';
  // Messages arriving redraw the page; keep what the host is typing in an open form.
  const named = [...root.querySelectorAll('form[data-tourneyform]')].map(fm => ({
    key: fm.dataset.tourneyform,
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
  // And what's typed in a notification's form or the Club info editor (#398),
  // or a scheduled game's form (#599).
  const keepKey = fm => (fm.dataset.schedform != null ? `sched|${fm.dataset.schedform}` : fm.dataset.threadform ? `thread|${fm.dataset.threadform}` : fm.dataset.letin ? `letin|${fm.dataset.letin}` : `${fm.dataset.noteform || fm.dataset.infoform || fm.dataset.creditform || fm.dataset.voidform || fm.dataset.floatform || fm.dataset.vaultform || fm.dataset.table}|${fm.dataset.id || ''}`);
  const typed = [...root.querySelectorAll(KEPT_FORMS)].map(fm => ({
    key: keepKey(fm), focus: fm.contains(document.activeElement) ? document.activeElement.name : '',
    // A preset picked (#544): its radio's value.
    values: Object.fromEntries([...fm.elements].filter(el => el.name && (el.type !== 'radio' || el.checked)).map(el => [el.name, el.value])),
  }));
  // And the Members search (#398), where it was being typed.
  const search = root.querySelector('[data-msearch]');
  const searchKept = search && document.activeElement === search && {start: search.selectionStart, end: search.selectionEnd};
  // A backup's passwords, or the file chosen to prove it (#395): the form
  // itself is kept, since a chosen file can't be put back.
  const clForm = root.querySelector('form[data-clform="backup"], form[data-clform="prove"], form[data-clform="member-backup"]');
  const clFocus = clForm?.contains(document.activeElement) && document.activeElement;
  // A promotion being set up (#544), kept the same way: what's picked and
  // ticked too. Its kind redraws it, and that one's new.
  const promoKept = root.querySelector('form[data-promoform]');
  const promoFocus = promoKept?.contains(document.activeElement) && document.activeElement;
  // A payout table being edited (#424) is redrawn from what's typed; the box being typed in keeps the focus.
  const payFocus = root.querySelector('form[data-paytable]')?.contains(document.activeElement) ? document.activeElement.name : '';
  // Whatever else had the focus gets it back after the redraw (#544).
  const focusKey = root.contains(document.activeElement) ? ctlKey(document.activeElement) : focusLater;
  // And the chips being asked for, and why (a passkey prompt or a message
  // from the club can redraw the page mid-way, #575).
  const askKept = [...root.querySelectorAll('[data-ask-amt], [data-ask-note]')].map(i => [i.dataset.askAmt ? `amt|${i.dataset.askAmt}` : `note|${i.dataset.askNote}`, i.value]);
  // And the New table form's choices: switching games kept the blinds only
  // until the next message (#655).
  const tfOld = root.querySelector('form[data-tableform]');
  const tfKept = tfOld && {kind: `${tfOld.dataset.offer || ''}|${tfOld.dataset.wizard || ''}`, values: tableFormValues(tfOld)};
  root.innerHTML = h;
  const tfNew = tfKept && root.querySelector('form[data-tableform]');
  if (tfNew && `${tfNew.dataset.offer || ''}|${tfNew.dataset.wizard || ''}` === tfKept.kind) restoreTableForm(tfNew, tfKept.values);
  for (const [k, v] of askKept) {
    const [kind, code] = k.split('|');
    const i = root.querySelector(kind === 'amt' ? `[data-ask-amt="${CSS.escape(code)}"]` : `[data-ask-note="${CSS.escape(code)}"]`);
    if (i && v) i.value = v;
  }
  if (payFocus) root.querySelector(`form[data-paytable] [name="${payFocus}"]`)?.focus({preventScroll: true});
  const clFresh = clForm && root.querySelector(`form[data-clform="${clForm.dataset.clform}"]`);
  if (clFresh) { clFresh.replaceWith(clForm); if (clFocus) clFocus.focus({preventScroll: true}); }
  const promoFresh = promoKept && root.querySelector('form[data-promoform]');
  if (promoFresh && promoFresh.dataset.promoform === promoKept.dataset.promoform && promoFresh.dataset.kind === promoKept.dataset.kind) {
    promoFresh.replaceWith(promoKept);
    if (promoFocus) promoFocus.focus({preventScroll: true});
  }
  const lobbyInput = lobbyKept && root.querySelector('form[data-lobbyform] input');
  if (lobbyInput) { lobbyInput.value = lobbyKept.v; if (lobbyKept.focus) lobbyInput.focus({preventScroll: true}); }
  for (const k of typed) {
    const fm = [...root.querySelectorAll(KEPT_FORMS)].find(f => keepKey(f) === k.key);
    if (!fm) continue;
    for (const [name, v] of Object.entries(k.values)) if (fm.elements[name]) fm.elements[name].value = v;
    if (k.focus) fm.elements[k.focus]?.focus({preventScroll: true});
  }
  const searchInput = searchKept && root.querySelector('[data-msearch]');
  if (searchInput) { searchInput.focus({preventScroll: true}); searchInput.setSelectionRange(searchKept.start, searchKept.end); }
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
    const fm = root.querySelector(`form[data-tourneyform="${k.key}"]`);
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
  syncPicks(root);
  markControls();
  focusLater = '';
  if (focusKey && !root.contains(document.activeElement)) {
    const el = byKey(focusKey);
    if (el?.disabled) focusLater = focusKey;
    else el?.focus({preventScroll: true});
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
  if (view === 'play' || view === 'ladder' || view === 'quest') return '';
  // Clubs need the passkey first (#575).
  const gate = passGateHtml();
  if (gate) return msg + gate + footHtml();
  if (view === 'join') {
    const h = requestsHtml();
    return h || msg ? msg + h : '';
  }
  // A club's page (V3, #225): the club the address names (shownClub). There's
  // no list of clubs (#611): they're on the front page, so an address that
  // names none of yours goes there.
  const own = club || isRemote();
  const at = shownClub();
  if (at === 'own' && own) return msg + runHereHtml() + footHtml();
  const mem = at && memberships.find(m => m.code === at && m.status === 'member');
  // An agent's players are a tab of their own club page here (#428).
  if (mem) return msg + memberHomeHtml(mem, '') + footHtml();
  // A club you asked to join, still on its way in: its page once you're in.
  const asked = at && at !== 'own' && memberships.find(m => m.code === at);
  if (asked) return msg + `<div class="cl-home-head"><h1 class="cl-home-name">${esc(asked.name || asked.code)}</h1></div><p class="pl-meta">${esc(STATUS_TEXT[asked.status] || asked.status)}</p>` + pendingThreadHtml(asked) + footHtml();
  // The club you run, still loading.
  if (at === 'own' && (load(CLUB_KEY, null) || load('ducyClubRemote', null))) return msg + '<p class="pl-meta">Loading…</p>';
  toFrontPage();
  return '';
}

// To the front page, keeping the query (?relay=), once this redraw is done.
function toFrontPage() {
  queueMicrotask(() => { if (location.hash.startsWith('#clubs')) location.replace(`${location.pathname}${location.search}#`); });
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

// The club manager (manage.html): the club you run, a club you're an agent
// of, or the list of both.
function managerHtml() {
  // Clubs need the passkey first (#575).
  const gate = passGateHtml();
  if (gate) return gate + footHtml();
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
  h += '<div class="cl-clubs">';
  if (own) {
    const members = club?.members ? membersByStatus(club, 'member').length : 0;
    h += card({href: 'clubs/own', name: club?.name || owner.record.name, who: `You run this club${members ? ` · ${members} member${members === 1 ? '' : 's'}` : ''}`, waiting: hostWaiting()});
  }
  for (const m of helped) h += card({href: clubHash(m.code), name: m.name || m.code, who: 'Agent', waiting: helperWaiting(m)});
  h += '</div>';
  // Starting a club takes ducy's grant (#636): its one-time link opens
  // #clubs/start/<token>, and nothing else links to it. A demo club starts
  // here too; Try a demo club is off for the beta (club-beta.js).
  const starting = !own && (demo || !!grantToken());
  const tryDemo = !own && !demo && !isOff('demoClub');
  if (starting || tryDemo) h += `<div class="cl-club-acts">${starting ? createHtml() : ''}${tryDemo ? demoCardHtml() : ''}</div>`;
  return h + footHtml();
}

// Which club the address shows (#225): 'own' for the one you run (#clubs/own,
// or one of the manager's pages, #clubs/members, club-nav.js), a club code
// for one you're in (#clubs/c/CODE), or '' for none.
function shownClub() {
  const p = location.hash.slice(1).split('/');
  if (p[0] !== 'clubs' || !p[1]) return '';
  if (p[1] === 'c') return decodeURIComponent(p[2] || '');
  return managerPage(location.hash) ? 'own' : '';
}
// The address of club `code`'s page.
const clubHash = code => (code && code === myClubCode() ? 'clubs/own' : code ? `clubs/c/${encodeURIComponent(code)}` : 'clubs');

// The name of the club showing, for the breadcrumb (play-section.js), or ''.
export function clubCrumb() {
  if (!open || view !== 'clubs') return '';
  const at = shownClub();
  if (at === 'own') return club?.name || owner?.record?.name || '';
  const m = at && memberships.find(x => x.code === at && x.status === 'member');
  return m ? m.name || m.code : '';
}

/**
 * Your clubs, for the front page (home.js, #611): [{name, href, who}], the
 * one you run (on the club manager), the ones you're in, and the ones you
 * asked to join. Read from storage until the clubs have started.
 */
export function yourClubs() {
  const list = [];
  const ownClub = started ? club || owner?.record : load(CLUB_KEY, null) || load('ducyClubRemote', null);
  if (ownClub?.code) list.push({name: ownClub.name || ownClub.code, href: managerHref('clubs/own'), who: 'You run it'});
  for (const m of started ? memberships : load(MEMBERSHIPS_KEY, [])) {
    if (!m?.code || m.code === ownClub?.code) continue;
    if (m.status === 'member') list.push({name: m.name || m.code, href: `#${clubHash(m.code)}`, who: helps(m) ? 'Agent' : 'Member'});
    else if (m.status === 'new' || m.status === 'pending') list.push({name: m.name || m.code, href: '#join', who: 'Asked to join'});
  }
  return list;
}

// What's waiting for you at the club you run: join and chip requests, and
// help requests; and at one you're an agent of.
function hostWaiting() {
  if (!club?.members) return 0;
  const ms = Object.values(club.members);
  return ms.filter(m => m.status === 'pending').length + ms.filter(m => m.status === 'member' && m.request && !m.agentOf).length + openHelp(club).length;
}
function helperWaiting(m) {
  if (m.status !== 'member' || m.agent !== 'yes' || !m.agentView) return 0;
  // New players (#621) until their first chips.
  return m.agentView.recruits.length + m.agentView.players.filter(x => x.request || x.new).length;
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
    h += `<li><span class="cl-name">${esc(m.name || m.code)}</span><span class="cl-status cl-${esc(m.status)}">${inNow ? 'You’re in' : m.nameTaken && m.status === 'new' ? 'Name taken' : esc(STATUS_TEXT[m.status] || m.status)}</span>`;
    if (!inNow) h += `<span class="pl-meta cl-conn">${live}</span>`;
    h += '<span class="cl-acts">';
    if (inNow) h += `<a class="btn-small primary" href="#${clubHash(m.code)}">Open the club</a>`;
    else {
      if (!n) h += `<button class="btn-small" data-cl="retry" data-code="${esc(m.code)}">Try again</button>`;
      h += `<button class="btn-small" data-cl="forget" data-code="${esc(m.code)}">Forget</button>`;
    }
    h += '</span>';
    // What happens next (#185).
    if (m.status === 'pending' || m.status === 'new') {
      h += `<span class="pl-desc cl-next">Next: the manager lets you in, then gives you chips to play at the club’s tables. This page tells you as soon as you’re in${notifyOn() ? '' : '; to hear about it while you’re elsewhere, turn on notifications in Player settings'}.</span>`;
    } else if (inNow && !m.credit && !m.balance) {
      // Only with no chips and no credit (#633).
      h += `<span class="pl-desc cl-next">Next: ask the manager for chips on <a href="#${clubHash(m.code)}">the club’s page</a>, then sit at one of its tables.</span>`;
    } else if (m.status === 'declined') {
      h += '<span class="pl-desc cl-next">If that’s a mistake, ask the manager: they can let you in from a new invite link.</span>';
    }
    h += pendingThreadHtml(m);
    if (m.error) h += `<span class="pl-desc pl-neterr cl-err">${esc(m.error)}</span>`;
    // The name asked with is taken there (#450): another, for that club.
    if (m.nameTaken) h += clubNameHtml(m);
    h += '</li>';
  }
  return h + '</ul></section>';
}

// Your messages with the manager while you wait (#621).
function pendingThreadHtml(m) {
  if (m.status !== 'pending' || !m.thread?.length) return '';
  return memberThreadHtml(m, !!playerNets.get(m.code)?.hostHere);
}
function memberThreadHtml(m, hostHere) {
  // At most three in a row before a reply.
  const row = m.thread.length - m.thread.findLastIndex(x => !x.mine) - 1;
  return threadHtml(m.thread.map(x => ({...x, who: x.mine ? 'You' : x.by || 'Manager'})), `m|${m.code}`, {dis: hostHere ? '' : ' disabled', open: row < 3});
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
// On the club manager from a grant's link only (#636), and in a demo.
function createHtml() {
  if (club || isRemote()) return '';
  let h = '<section class="cl-act-card"><span class="cl-act-title">Start a club</span>';
  h += `<span class="cl-act-row"><input class="pl-text" id="cl-clubname" aria-label="Club name" maxlength="${MAX_CLUB_NAME}" placeholder="Club name" value="${esc(alwaysFailed?.name || (demo ? 'Demo Club' : ''))}">`;
  h += `<button class="tr-start" data-cl="create">${alwaysFailed ? 'Try again' : 'Create'}</button></span>`;
  if (alwaysFailed) {
    h += `<p class="pl-desc pl-neterr">Couldn’t start it on ducy’s server: ${esc(alwaysFailed.reason)}</p>`;
    // A link for someone else (#636): ducy needs this player's ID for one of theirs.
    if (!demo && me?.id) h += `<p class="pl-meta">Your player ID, for ducy: <code class="cl-id">${esc(me.id)}</code></p>`;
  }
  // Already have one (#191): its backup brings it back, here or on another
  // device. Not in a demo (#406), which starts empty.
  // A real button (#544), which opens the hidden file picker.
  if (!demo) h += '<span class="cl-act-desc cl-restore"><button class="link-btn" type="button" data-cl="restore-pick">Restore from backup</button><input type="file" data-clrestore accept=".json,application/json" hidden></span>';
  // Or with a passkey (#575).
  if (!demo && pk.supported()) h += '<span class="cl-act-desc cl-restore"><button class="link-btn" type="button" data-cl="pass-recover">Restore with a passkey</button></span>';
  return h + '</section>';
}

// A demo club (#406, demo.js): be its manager and its players, in this window.
function demoCardHtml() {
  return '<section class="cl-act-card"><span class="cl-act-title">Try a demo club</span><span class="cl-act-row"><button class="tr-start" data-cl="demo">Open</button></span></section>';
}

// Setting up a club (#152, #395), one step at a time (see WIZARD_STEPS):
// back it up with a password, prove the file opens, open a first table,
// then the invite link. Skipping the backup warns first, and leaves the
// club temporary.
function wizardHtml() {
  const name = club?.name || owner?.record?.name || '';
  const setup = !!wizard.setup;
  // Its steps from 1 (#544), the label always above the heading. Naming the
  // club came before them.
  const step = n => (setup ? `<span class="pl-meta cl-step">Step ${n} of 4</span>` : '');
  const err = backupNote ? `<p class="pl-desc pl-neterr">${esc(backupNote)}</p>` : '';
  let h = '<section class="cl-card cl-wizard">';
  if (wizard.step === 'skip') {
    h += `<h2>Skip the backup?</h2><p class="pl-desc pl-neterr"><b>Without a backup, your club can’t be recovered.</b> If this browser’s data is cleared, or you lose this device, nobody can run the club again: not its members, its chips or its history.</p>`;
    h += `<p class="pl-desc">Until you back it up, it’s a <b>temporary club</b>: everything works, but if no one uses it for 7 days it’s deleted.</p>`;
    return h + '<div class="pl-actions"><button class="tr-start" data-cl="wiz-back">Back up after all</button><button class="btn-small" data-cl="wiz-onward">Skip anyway</button></div></section>';
  }
  if (wizard.step === 'prove') {
    h += `${step(2)}<h2>Prove it works</h2><p class="pl-desc">Now open the file you just saved, and enter its password. This only checks it: nothing on this device changes.</p>`;
    h += '<form class="pl-idform" data-clform="prove">';
    h += '<label>Backup file<input class="pl-text" type="file" name="file" required accept=".json,application/json"></label>';
    h += '<label>Password<input class="pl-text" type="password" name="pw" required autocomplete="current-password"></label>';
    h += `<div class="pl-actions"><button class="tr-start" type="submit">Check it</button><button class="btn-small" type="button" data-cl="wiz-back">Make a new one</button><button class="btn-small" type="button" data-cl="${setup ? 'wiz-skip' : 'wiz-cancel'}">${setup ? 'Skip' : 'Cancel'}</button></div></form>`;
    return h + err + '</section>';
  }
  if (wizard.step === 'table') {
    if (provedNote) h += `<p class="pl-desc cl-proved">${provedNote}</p>`;
    h += `${step(3)}<h2>Your first table</h2>`;
    return h + tableFormHtml({wizard: true}) + '</section>';
  }
  if (wizard.step === 'invite') {
    h += `${step(4)}<h2>Your invite link</h2>`;
    h += club ? inviteRowHtml() : '<p class="pl-meta">Connecting to your club…</p>';
    return h + '<div class="pl-actions"><button class="tr-start" data-cl="wiz-done">Go to your club</button></div></section>';
  }
  h += `${step(1)}<h2>Back up ${esc(name)}</h2>`;
  h += '<p class="pl-desc">The backup is a file, locked with a password you choose, that lets you run the club again from any browser if this one loses it. Then you open it once here, to prove it works.</p>';
  h += '<form class="pl-idform" data-clform="backup">';
  h += `<label>Password<input class="pl-text" type="password" name="pw" required minlength="${MIN_NEW_PASSWORD}" autocomplete="new-password"></label>`;
  h += `<label>Again<input class="pl-text" type="password" name="pw2" required minlength="${MIN_NEW_PASSWORD}" autocomplete="new-password"></label>`;
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
  // Exporting the key needs a recent passkey unlock (#575).
  const ident = demo ? me : await pk.exportable(me);
  downloadFile(await clubBackupText(ident, password, {code, name}), `ducy-club-${code}.json`);
  setHostNote('backedUp', Date.now());
  // It's a backup of the owner's player ID too (#562).
  markBackedUp(me.id);
}

// Which relay this page uses. A page served locally but using the site's
// relay is almost always a mistake when testing, so it says so.
function relayWarningHtml() {
  // A demo's club runs in the page (#406).
  if (demo) return '';
  const relay = relayUrl();
  const live = relay === wsUrl(DEFAULT_RELAY);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (live && local) return `<p class="pl-desc pl-neterr">This local page is using the live relay (${esc(relay)}). To test against a local relay, open it with <code>?relay=ws://localhost:8788</code>; invite links then carry it.</p>`;
  return '';
}

// The club you run, on the club manager (#398): its pages by task in a
// sidebar (a drawer on a phone), the page the address names, and the
// notifications beside it (behind the bell on a phone).
let navOpen = false, notesOpen = false;

function hostHtml() {
  if (!club && isRemote()) return `<section class="cl-card"><h2>${esc(owner.record.name)}</h2><p class="pl-meta">Connecting…</p></section>`;
  if (!club) return '';
  if (!isRemote()) return movePageHtml();
  const at = managerPage(location.hash) || {page: 'overview', member: ''};
  // An older address (#clubs/players …) shows under its page's own.
  const want = ph(at.page, at.member, at);
  if (location.hash.startsWith('#clubs') && location.hash.slice(1) !== want) history.replaceState(null, '', `${location.pathname}${location.search}#${want}`);
  let h = `<div class="mg-shell${navOpen ? ' nav-open' : ''}${notesOpen ? ' notes-open' : ''}">`;
  h += sideHtml(at.page);
  h += `<section class="mg-page">${backupNagHtml()}${pageHtml(at)}</section>`;
  h += notesHtml();
  return h + '<div class="mg-scrim" data-cl="mg-close"></div></div>';
}

// A club kept in this browser from before clubs ran on ducy's server: it
// doesn't run in a tab any more (#580), and can't move there (#636): it can only go.
function movePageHtml() {
  let h = `<section class="cl-card cl-move"><h2>${esc(club.name)}</h2><p class="pl-desc">Clubs run on ducy’s server now.</p>`;
  return h + '<div class="pl-actions"><button class="btn-small" data-cl="close">Delete club</button></div></section>';
}

// Live, or how the club's connection is doing, in the top bar; nothing for
// a club that doesn't run (movePageHtml).
function liveHtml() {
  const remote = isRemote();
  if (!remote) return '';
  const on = own().online;
  const text = on ? 'Live' : own().connected ? CONN.reconnecting : CONN.off;
  let h = `<span class="mg-live${on ? ' on' : ''}" title="${text}">${text}</span>`;
  if (remote && !own().connected) h += '<button class="btn-small" data-cl="reconnect-owner">Reconnect</button>';
  return h;
}

// The sidebar: each group's pages, with what's waiting on them.
function sideHtml(page) {
  const counts = {requests: hostWaiting(), promos: (club.promos?.awards || []).filter(a => a.status === 'held').length, fairplay: fairReport()?.flagged?.length || 0};
  let h = '<nav class="mg-side" aria-label="Club manager">';
  for (const g of shownNav()) {
    h += `<div class="mg-group">${g.group ? `<span class="mg-group-name">${g.group}</span>` : ''}`;
    for (const [id, label] of g.pages) {
      const on = navOf(page) === id;
      h += `<a class="mg-link${on ? ' on' : ''}" href="#${ph(id)}"${on ? ' aria-current="page"' : ''}><span>${label}</span>${counts[id] ? `<span class="mg-count">${counts[id]}</span>` : ''}</a>`;
    }
    h += '</div>';
  }
  return h + '</nav>';
}

const pageHead = (title, extra = '') => `<div class="mg-head"><h1 class="mg-h">${title}</h1>${extra}</div>`;

function pageHtml(at) {
  const {page, member} = at;
  if (pageOff(page)) return overviewHtml();
  if (page === 'cash') return (openGame ? '' : pageHead('Tables')) + cashHtml();
  // A payout table just made in the wizard is its pick, once the club has it
  // (an always-on club's comes back from its room).
  const made = tourneyForm?.pick && (club.payoutTables || []).find(p => p.name.toLowerCase() === tourneyForm.pick);
  if (made) { tourneyForm.d.payoutTable = made.id; tourneyForm.pick = null; }
  if (page === 'tourneys') return pageHead('Tournaments') + hostTourneysHtml(club, tourneyLive(), {wizard: tourneyForm, payTable, ask: tAsk, payAsk, heading: false});
  if (page === 'promos') return pageHead('Promotions') + hostPromosHtml(club, {form: promoForm, note: promoNote, voiding});
  if (page === 'requests') return pageHead('Requests') + requestsPageHtml();
  if (page === 'members') return pageHead('Members') + membersPageHtml(at);
  if (page === 'member') return memberPageHtml(member);
  if (page === 'settle') return pageHead('Balances') + settleHtml();
  if (page === 'chips') return pageHead('Chips') + accountingHtml();
  if (page === 'fairplay') return pageHead('Fair play') + fairPlayHtml();
  if (page === 'info') return pageHead('Club info') + infoEditHtml();
  if (page === 'rules') return pageHead('Rules') + rulesHtml();
  if (page === 'backup') return pageHead('Backup and devices') + backupPageHtml();
  if (page === 'history') return pageHead('History') + historyHtml();
  return overviewHtml();
}

// Overview, the manager's home (#398, #516): what needs them (O1) and
// whether the club is running (O2), today's tournaments (O5) and the lobby
// (O6). The user stories are in the club management review; everything
// here serves one of them.
function overviewHtml() {
  const now = Date.now();
  const list = notices();
  const n = overviewNumbers(club, now);
  const seated = Object.values(seatedCounts()).reduce((s, x) => s + x, 0);
  let h = pageHead('Overview') + '<div class="mg-stats">';
  // O2: are games dealing, and how many are playing?
  h += `<a class="mg-stat green" href="#${ph('cash')}"><span class="mg-stat-label">Running</span><b class="mg-stat-val">${n.tablesActive} <span class="mg-of">of ${n.tables} tables</span></b><span class="mg-stat-label">${seated} seated</span></a>`;
  // O1: how much is waiting on the manager (the list follows).
  const oldest = Math.min(...list.map(x => x.at || now));
  h += `<div class="mg-stat ${list.length ? 'mg-needs' : 'green'}"><span class="mg-stat-label">Needs you</span><b class="mg-stat-val">${list.length}</b>${now - oldest >= 60_000 ? `<span class="mg-stat-label">oldest ${durationText(now - oldest)}</span>` : ''}</div>`;
  h += '</div>';
  // O1: each thing waiting, answered right here.
  h += `<section class="mg-sec"><div class="mg-sec-head"><h2>Needs you</h2>${clearableKeys(list).length ? '<button class="link-btn" data-cl="notes-clear">Clear</button>' : ''}</div>`;
  h += list.length ? `<ul class="mg-note-list">${list.map(noteHtml).join('')}</ul>` : '<p class="pl-meta">Nothing needs you.</p>';
  h += '</section>';
  h += '<div class="mg-split">';
  // O5: today's tournaments, a row each.
  const tours = todaysTourneys(club, now);
  if (tours.length) {
    const live = tourneyLive();
    h += `<section class="mg-sec"><div class="mg-sec-head"><h2>Tournaments today</h2><a href="#${ph('tourneys')}">Tournaments</a></div>`;
    for (const t of tours) {
      const l = live[t.id];
      const line = t.status === 'running'
        ? (l ? `Level ${l.level + 1} · ${l.playersLeft} left` : '')
        : `${new Date(t.startsAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})} · ${new Set(t.entries.map(e => e.member)).size} registered`;
      const end = t.status === 'running' ? '<span class="mg-pill on">Running</span>' : `<span class="mg-num pl-meta">${t.startsAt > now ? `in ${durationText(t.startsAt - now)}` : ''}</span>`;
      h += `<a class="mg-trow" href="#${ph('tourneys')}"><span><b>${esc(t.name)}</b><span class="pl-meta">${line}</span></span>${end}</a>`;
    }
    h += '</section>';
  }
  // O6: who's online, the last few lines, and a line to the room.
  return h + `<section class="mg-sec">${hostLobbyHtml()}</section></div>`;
}

// Requests (#398): help, people asking to join, chip requests, then the
// answered ones and the invite link.
function requestsPageHtml() {
  const pending = membersByStatus(club, 'pending');
  const asking = membersByStatus(club, 'member').filter(m => m.request && !m.agentOf).sort((a, b) => a.request.at - b.request.at);
  let h = helpListHtml(openHelp(club));
  if (pending.length || asking.length) {
    h += '<ul class="cl-list cl-needs">';
    // Letting someone in only lets them in: chips are the host's choice,
    // with Give (#395).
    for (const m of pending) {
      h += `<li><span class="cl-name">${esc(m.name)}</span><span class="pl-meta">asks to join · <code>${esc(showId(m.id))}</code>${m.agentOf && club.members[m.agentOf] ? ` · via ${esc(club.members[m.agentOf].name)}` : ''}</span>${removedHtml(m.removedAt)}`;
      // Who they are, and the messages since (#621); Let in asks Cash or Credit.
      h += letIn === `o|${m.id}` ? letInHtml(`o|${m.id}`) : `<span class="cl-acts"><button class="btn-small primary" data-cl="approve" data-id="${esc(m.id)}">Let in</button><button class="btn-small" data-cl="decline" data-id="${esc(m.id)}">Decline</button></span>`;
      h += ownerThreadHtml(m) + '</li>';
    }
    for (const m of asking) h += askRowHtml(m);
    h += '</ul>';
  } else if (!openHelp(club).length) h += '<p class="pl-meta cl-empty">Nothing waiting.</p>';
  h += requestLogHtml();
  return h + inviteRowHtml();
}

// Member `m`'s thread (#621) as the owner sees it, with a reply box.
function ownerThreadHtml(m) {
  if (!m.thread?.length) return '';
  return threadHtml(m.thread.map(x => ({...x, mine: x.from !== m.id, who: x.from === m.id ? m.name : club.members[x.from]?.name || 'You'})), `o|${m.id}`);
}

// Someone asking to join who was removed before (#488): nobody comes back
// without the manager knowing.
function removedHtml(at) {
  return at ? ` <span class="cl-flag">Removed ${esc(ago(at))}</span>` : '';
}

// A chip request on Requests: Give what was asked, another amount, or no.
function askRowHtml(m) {
  let h = `<li><span class="cl-name">${esc(m.name)}</span><span class="cl-chips">asks for ${chips(m.request.amount)}</span>`;
  if (m.request.note) h += `<span class="pl-meta">“${esc(m.request.note)}”</span>`;
  // At their credit limit (#404): never chips past it; raise it, or no.
  if (m.request.atLimit) {
    const n = {credit: creditRow(m).credit, asked: m.request.amount, available: creditRow(m).available};
    h += `<span class="pl-meta">At their credit limit (${chips(n.credit)})</span>`;
    h += `<form class="cl-acts" data-noteform="raise" data-id="${esc(m.id)}"><label class="pl-meta">New limit <input class="pl-text" name="amount" type="number" inputmode="decimal" required min="0.01" step="${CHIP_STEP}" value="${esc(chipInput(raiseTo(n)))}"></label>`;
    return h + `<button class="btn-small primary" type="submit">Raise limit</button><button class="btn-small" type="button" data-cl="deny-now" data-id="${esc(m.id)}">Decline</button></form></li>`;
  }
  h += `<span class="cl-acts"><button class="btn-small primary" data-cl="grant" data-id="${esc(m.id)}">Give ${chips(m.request.amount)}</button>`;
  h += `<button class="btn-small" data-cl="grant-other" data-id="${esc(m.id)}">Other</button><button class="btn-small" data-cl="deny" data-id="${esc(m.id)}">Decline</button></span>`;
  if (chipForm?.id === m.id && (chipForm.kind === 'grant' || chipForm.kind === 'deny')) h += chipFormHtml(m);
  return h + '</li>';
}

// Members (#398): everyone, with a search and the Overview's filters
// (club-overview.js); each opens their own page. Sorted and in pages of
// PAGE_SIZE (#426), the filter, order and page in the address
// (club-nav.js); the search and filters run over the whole list. Agents
// (#426): the agents, an agent's players (By agent), and those under none.
let memberQuery = '';
const FILTER_TEXT = {all: 'All', new: 'Joined, 7 days', inactive: 'Inactive, 30+ days', owes: 'Owes', agents: 'Agents', noagent: 'No agent'};
const SORT_TEXT = {name: 'Name', balance: 'Balance, high to low', 'balance-low': 'Balance, low to high', active: 'Last active', agent: 'Agent'};
const playersText = n => `${n} ${n === 1 ? 'player' : 'players'}`;
// A new search: the list's first page, in place of this one.
function membersFirstPage() {
  const at = managerPage(location.hash);
  if (at?.page === 'members' && at.n > 1) history.replaceState(null, '', `${location.pathname}${location.search}#${ph('members', '', {...at, n: 1})}`);
}
function membersPageHtml({sort = 'name', n = 1, show = 'all', agent = ''} = {}) {
  const now = Date.now();
  const q = memberQuery.trim().toLowerCase();
  // Last heard from: an always-on club's room keeps it (#401).
  const active = lastActive(club, (isRemote() && own().view?.seen) || {});
  const list = sortMembers(memberFilter(club, show, now, agent).filter(m => !q || m.name.toLowerCase().includes(q)), sort, active, club.members);
  const pg = pageOf(list, n);
  const agents = memberFilter(club, 'agents', now).sort((a, b) => a.name.localeCompare(b.name));
  let h = '<div class="mg-tools-row">';
  h += `<input class="pl-text mg-search" type="search" data-msearch="1" placeholder="Search" aria-label="Search members" value="${esc(memberQuery)}">`;
  h += `<button class="btn-small" data-cl="copy">${copied ? 'Copied' : 'Copy invite link'}</button></div>`;
  const shown = FILTERS.filter(x => (agents.length || (x !== 'agents' && x !== 'noagent')) && (x !== 'owes' || !OFF.has('credit')));
  h += `<div class="mg-filters" role="group" aria-label="Show">${shown.map(x => `<button class="cc-btn${x === show ? ' on' : ''}" data-cl="mfilter-here" data-f="${x}" aria-pressed="${x === show}">${FILTER_TEXT[x]} <span class="pl-meta">${memberFilter(club, x, now).length}</span></button>`).join('')}`;
  if (agents.length) {
    h += `<select class="pl-text mg-agent-pick${show === 'agent' ? ' on' : ''}" data-magent="1" aria-label="By agent"><option value="">By agent</option>`;
    h += agents.map(a => `<option value="${esc(a.id)}"${a.id === agent ? ' selected' : ''}>${esc(a.name)} (${playersOf(club, a.id).length})</option>`).join('') + '</select>';
  }
  h += '</div>';
  // A search or filter that finds no one: Clear (#544).
  if (!list.length) return h + `<p class="pl-meta cl-empty">No one.${q || show !== 'all' || agent ? ' <button class="btn-small" data-cl="msearch-clear">Clear</button>' : ''}</p>`;
  // The order: column headings, or a select on a phone.
  const sortLink = (to, label, on) => `<a class="mg-sort${on ? ' on' : ''}" href="#${ph('members', '', {sort: to, show, agent})}"${on ? ' aria-current="true"' : ''}>${label}</a>`;
  const bal = sort === 'balance' || sort === 'balance-low';
  const sorts = SORTS.filter(s => s !== 'agent' || agents.length);
  h += `<label class="mg-sort-pick">Sort <select class="pl-text" data-msort="1">${sorts.map(s => `<option value="${s}"${s === sort ? ' selected' : ''}>${SORT_TEXT[s]}</option>`).join('')}</select></label>`;
  h += '<div class="mg-rows mg-members mg-members-head" role="group" aria-label="Sort"><div class="mg-row">';
  h += sortLink('name', 'Name', sort === 'name');
  if (agents.length) h += sortLink('agent', 'Agent', sort === 'agent');
  h += `<span class="mg-row-end">${sortLink('active', 'Last active', sort === 'active')}`;
  h += sortLink(sort === 'balance' ? 'balance-low' : 'balance', `Balance${sort === 'balance' ? ' ↓' : sort === 'balance-low' ? ' ↑' : ''}`, bal);
  h += '</span></div></div>';
  h += '<ul class="mg-rows mg-members">';
  for (const m of pg.items) {
    const tags = memberTags(m);
    h += `<li><a href="#${ph('member', m.id)}"><b>${esc(m.name)}</b>`;
    if (tags.length) h += `<span class="pl-meta">${tags.join(' · ')}</span>`;
    if (m.seat) h += `<span class="pl-meta">on a table ${chips(m.seat.stack)}</span>`;
    if (m.vault) h += `<span class="pl-meta">vault ${chips(m.vault)}</span>`;
    h += `<span class="mg-row-end"><span class="pl-meta mg-active">${active[m.id] ? esc(ago(active[m.id], now)) : '–'}</span>`;
    h += `<span class="mg-bal${m.balance < 0 ? ' cl-down' : ''}">${signed(m.balance)}</span></span></a></li>`;
  }
  h += '</ul>';
  if (pg.pages > 1) {
    const to = k => `#${ph('members', '', {sort, n: k, show, agent})}`;
    h += `<nav class="mg-pager" aria-label="Pages">${pg.page > 1 ? `<a class="btn-small" data-cl="mpage" href="${to(pg.page - 1)}">Previous</a>` : '<span></span>'}`;
    h += `<span class="pl-meta">${pg.from}–${pg.to} of ${pg.total}</span>`;
    h += `${pg.page < pg.pages ? `<a class="btn-small" data-cl="mpage" href="${to(pg.page + 1)}">Next</a>` : '<span></span>'}</nav>`;
  }
  return h;
}

// A member's own page (#398): their chips, Give and Take back (paying up
// too, with a note, #454), their credit limit (#404), and the rest of what
// a manager can do for them.
function memberPageHtml(id) {
  const m = club.members[id];
  const back = `<a class="link-btn mg-back" href="#${ph('members')}">‹ Members</a>`;
  if (!m || m.status !== 'member') return back + pageHead('Member') + '<p class="pl-meta">Not a member.</p>';
  const c = creditRow(m);
  let h = back + pageHead(esc(m.name), `<code class="mg-id">${esc(showId(m.id))}</code>`);
  const tags = memberTags(m, true);
  if (tags.length) h += `<p class="pl-meta mg-tags">${tags.join(' · ')}</p>`;
  h += '<div class="mg-stats">';
  h += statHtml('Balance', signed(c.balance), c.balance < 0 ? 'down' : '');
  h += statHtml('On a table', m.seat ? chips(c.onTable) : '–');
  // Their vault (#579): its chips only; what they ask to take out is theirs.
  if (m.vault) h += statHtml('Vault', chips(m.vault));
  if (c.credit) h += statHtml('Credit limit', chips(c.credit)) + statHtml('Available', chips(c.available));
  if (m.agent === 'yes') {
    const a = accountOf(club, m.id);
    h += statHtml('Credit used', chips(a.creditUsed));
  }
  h += '</div>';
  h += `<div class="pl-actions mg-acts"><button class="btn-small primary" data-cl="give" data-id="${esc(m.id)}">Give chips</button>`;
  const take = `<button class="btn-small" data-cl="take" data-id="${esc(m.id)}">Take back</button>`;
  h += m.balance > 0 ? take : offBtn(take, 'No chips');
  // What they owe the club, paid outside ducy (#633).
  const agent = underAgent(m);
  if (m.balance < 0 && !agent) h += `<button class="btn-small" data-cl="paid" data-id="${esc(m.id)}">Record payment</button>`;
  h += memberMenuHtml(m) + '</div>';
  if (chipForm?.id === m.id) h += chipFormHtml(m);
  if (m.request) h += `<ul class="cl-list cl-needs">${askRowHtml(m)}</ul>`;
  // Their messages (#621), from when they asked to join.
  if (m.thread?.length) h += `<section class="mg-sec"><h2>Messages</h2>${ownerThreadHtml(m)}</section>`;
  // Credit (#404): the limit (0 for none), and what it leaves them. A
  // player under an agent gets theirs from the agent (#633).
  if ((!OFF.has('credit') || c.credit) && !agent) {
    h += `<form class="mg-card" data-creditform="1" data-id="${esc(m.id)}"><b>Credit</b>`;
    // None, or the tables' buy-ins (as Give offers them), or Other (#544).
    const box = `<input class="pl-text" name="amount" type="number" inputmode="decimal" required min="0" step="${CHIP_STEP}" value="${esc(chipInput(c.credit))}" aria-label="Limit">`;
    h += `<div class="pl-row"><span class="pl-label">Limit</span><div class="pl-opts">${pickHtml('amount', [0, ...quickAmounts()], c.credit || 0, v => (v ? chips(v) : 'None'), box)}</div></div>`;
    h += `<div class="pl-avail"><span>Available to ${esc(m.name)}</span><b>${chips(c.available)}</b></div>`;
    h += '<button class="btn-small primary" type="submit">Save</button></form>';
  }
  const mine = entriesOf(club, m.id);
  if (mine.length) {
    const names = memberNames();
    h += '<section class="mg-sec"><h2>Chips</h2><ul class="cl-ledger">';
    for (const e of [...mine].reverse().slice(0, 30)) h += ledgerLineHtml(e, aboutNames(club), names, false);
    h += '</ul></section>';
  }
  return h;
}

// Whether `m` plays under an agent, who then gives their chips and sets their
// credit (#633).
const underAgent = m => !!m?.agentOf && club.members[m.agentOf]?.agent === 'yes';

// (The owner's float's ledger entries are the member 'float', #589.)
const memberNames = () => ({float: 'Float', ...Object.fromEntries(Object.values(club.members).map(m => [m.id, m.name]))});

// What a member is in the club, for their row and page (the owner, agents
// and their players), as HTML. An agent's players, and a player's agent
// (#426), link to their list and page when `links`.
function memberTags(m, links = false) {
  const link = (href, text) => (links ? `<a href="#${href}">${esc(text)}</a>` : esc(text));
  const agent = m.agentOf && club.members[m.agentOf];
  return [
    // New (#621): let in, no chips or credit yet.
    m.thread?.length && !m.credit && !entriesOf(club, m.id).length && '<span class="cl-new">New</span>',
    m.id === club.ownerId && 'Owner',
    m.agent === 'yes' && link(ph('members', '', {agent: m.id}), `Agent · ${playersText(playersOf(club, m.id).length)}`),
    m.agent === 'offered' && 'Offered agent',
    agent && link(ph('member', agent.id), `Under ${agent.name}`),
    m.credit && esc(`Credit ${chips(m.credit)}`),
  ].filter(Boolean);
}

const statHtml = (label, value, cls = '') => `<div class="mg-stat"><span class="mg-stat-label">${label}</span><b class="mg-stat-val${cls ? ` cl-${cls}` : ''}">${value}</b></div>`;

// One ledger line, for the host: when, whose link (`who`), what and what
// about, for whose move (an agent's link, for a player's), the change and the
// balance after.
function ledgerLineHtml(e, about = {}, names = {}, who = true) {
  const sign = e.amount < 0 ? '−' : '+';
  const name = id => esc(names[id] || (id === 'house' ? 'House' : id));
  // Rake and time (#449): the house's, from whoever paid it.
  const by = e.player || e.from;
  return `<li><span class="pl-meta">${when(e.at)}</span> ${who ? `${name(e.member)} · ` : ''}${esc(KIND_TEXT[e.kind] || e.kind)}${e.about && about[e.about] ? ` (${esc(about[e.about])})` : ''}${by ? ` · ${name(by)}` : ''} <strong>${sign}${chips(Math.abs(e.amount))}</strong>${e.note ? ` <span class="pl-meta">“${esc(e.note)}”</span>` : ''} <span class="pl-meta">→ ${signed(e.balance)}</span>${promoReplayBtn(e, club.code, 'host')}</li>`;
}

// The rest of what the host can do for a member, in a ⋯ menu (#143).
function memberMenuHtml(m) {
  const items = [];
  if (m.id === club.ownerId) return '';
  // Ending a role and removing someone ask first, naming them (#544).
  if (m.agent === 'yes') items.push(['revoke-agent', 'Stop being an agent', '', `Stop ${m.name} being an agent?|Stop`]);
  else if (m.agent === 'offered') items.push(['revoke-agent', 'Withdraw the agent offer']);
  else if (!m.agentOf && !OFF.has('agents')) items.push(['make-agent', 'Make agent']);
  items.push(['remove', 'Remove from the club', '', `Remove ${m.name} from the club?|Remove`]);
  // Their agent is picked in the menu too (#193).
  const agents = membersByStatus(club, 'member').filter(a => a.agent === 'yes' && a.id !== m.id);
  const picker = !m.agent && agents.length
    ? `<label class="cl-menu-item cl-assign">Agent <select class="pl-text" data-assign="${esc(m.id)}"><option value="">none</option>${agents.map(a => `<option value="${esc(a.id)}"${m.agentOf === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`
    : '';
  return menuHtml(`More for ${m.name}`, items, m.id, picker);
}

// Fair play (#582): the relay's last check of how players play against
// each other (relay/src/collusion.js), each flagged player or pair with
// its numbers and hands by number. No cards: the check never sends any.
function fairPlayHtml() {
  const r = fairReport();
  if (!r) return '<p class="pl-meta">Not checked yet.</p>';
  const names = memberNames();
  let h = `<p class="pl-meta">Checked ${when(r.at)} · ${r.hands.toLocaleString()} hands</p>`;
  if (!r.flagged?.length) return h + '<p class="pl-meta">Nothing stands out.</p>';
  h += '<p class="pl-meta">Worth a look, not proof.</p>';
  for (const e of r.flagged) {
    h += `<section class="mg-sec cl-fair"><h2>${esc(entryTitle(e, names))}</h2>`;
    const flow = flowText(e, names);
    if (flow) h += `<p>${esc(flow)}</p>`;
    h += '<ul class="cl-list">';
    for (const f of e.flags) h += `<li><span>${esc(flagText(f, names))}</span>${f.hands?.length ? `<span class="pl-meta">${esc(handsText(f.hands))}</span>` : ''}</li>`;
    h += '</ul></section>';
  }
  return h;
}

// History: the hands at the club's tables (#71) and the activity log (#190).
function historyHtml() {
  let h = handsHtml(club.code, 'host', 'Hands');
  if (!club.log?.length) return h;
  const who = [...new Set(club.log.map(l => l.by).filter(Boolean))].map(id => [id, club.members[id]?.name || club.services?.[id]?.name || (id === club.hostId || id === club.ownerId ? 'You' : id)]);
  // Big chip moves stand out (#190): a full buy-in at the biggest open table or more.
  const big = bigMove(club);
  const bigCount = club.log.filter(l => isBigMove(l, big)).length;
  const shown = club.log.filter(l => (!activityBy || l.by === activityBy) && (!activityBig || isBigMove(l, big)));
  h += `<details class="cl-history" data-keep="activity" open><summary>Activity (${club.log.length})${bigCount ? ` · <span class="cl-big">${bigCount} big</span>` : ''}</summary>`;
  const filters = [];
  if (who.length > 1) filters.push(`<select class="pl-text" data-activity="1" aria-label="Whose activity"><option value="">Everyone</option>${who.map(([id, n]) => `<option value="${esc(id)}"${activityBy === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`);
  if (big != null) filters.push(`<label class="pl-meta"><input type="checkbox" data-activitybig="1"${activityBig ? ' checked' : ''}> ${chips(big)} or more</label>`);
  if (filters.length) h += `<div class="pl-row cl-activity-filters">${filters.join('')}</div>`;
  if (!shown.length) h += '<span class="pl-meta">Nothing matches.</span>';
  h += '<ul>';
  for (const l of [...shown].reverse().slice(0, 100)) h += `<li${isBigMove(l, big) ? ' class="cl-bigmove"' : ''}><span class="pl-meta">${when(l.at)}</span> ${esc(l.text)}</li>`;
  return h + '</ul></details>';
}

// The notifications (#398, club-notices.js): what needs the manager, each
// answered right there, behind the bell on every page (#516; Overview lists
// them too). `noteForm`: the notice whose Other, Reply or limit form is
// open; Clear puts away the ones that need no answer (kept per browser).
let noteForm = '';
const clearedNotes = () => new Set(hostNotes().cleared || []);
// The relay's fair play check (#582) adds its flagged players and pairs.
const fairReport = () => (isRemote() ? own().view?.checks || null : null);
const notices = () => (club ? [
  ...fairPlayNotices(fairReport(), {cleared: clearedNotes(), names: memberNames()}),
  ...managerNotices(club, {cleared: clearedNotes(), seated: seatedCounts()}),
] : []);
const noteCount = () => notices().length;

function notesHtml() {
  const list = notices();
  let h = '<aside class="mg-notes" aria-label="Needs you"><div class="mg-notes-head"><h2>Needs you</h2>';
  if (clearableKeys(list).length) h += '<button class="link-btn" data-cl="notes-clear">Clear</button>';
  h += '<button class="link-btn mg-notes-x" data-cl="mg-close" aria-label="Close">✕</button></div>';
  h += list.length ? `<ul class="mg-note-list">${list.map(noteHtml).join('')}</ul>` : '<p class="pl-meta mg-quiet">Nothing needs you.</p>';
  return h + '</aside>';
}

function noteHtml(n) {
  const id = esc(n.member || '');
  const btn = (act, label, extra = '', primary = false) => `<button class="btn-small${primary ? ' primary' : ''}" data-cl="${act}"${extra}>${label}</button>`;
  const who = `<b>${esc(n.name)}</b>`;
  const form = (kind, input, submit) => `<form class="mg-note-acts" data-noteform="${kind}" data-id="${esc(n.id || n.member)}">${input}<button class="btn-small primary" type="submit">${submit}</button><button class="btn-small" type="button" data-cl="note-cancel">Cancel</button></form>`;
  const amount = (v, label) => `<input class="pl-text" name="amount" type="number" inputmode="decimal" required min="0.01" step="${CHIP_STEP}" value="${esc(chipInput(v))}" aria-label="${label}">`;
  let top = '', body = '', acts = '';
  const open = noteForm === n.key;
  // Their message, and a reply to it (#621).
  const said = n.text ? `<span class="cl-said">“${esc(n.text)}”</span>` : '';
  const replyForm = `<form class="mg-note-acts" data-threadform="o|${id}"><input class="pl-text mg-note-wide" name="text" maxlength="${MAX_THREAD_NOTE}" required aria-label="Reply"><button class="btn-small primary" type="submit">Send</button><button class="btn-small" type="button" data-cl="note-cancel">Cancel</button></form>`;
  if (n.kind === 'join') {
    top = `${who} asks to join${n.via ? ` <span class="pl-meta">via ${esc(n.via)}</span>` : ''}${removedHtml(n.removedAt)}`;
    body = said;
    // (On Requests, the choice opens there only: one form keeps what's picked.)
    acts = letIn === `o|${n.member}` && managerPage(location.hash)?.page !== 'requests' ? letInHtml(`o|${n.member}`)
      : open ? replyForm : btn('approve', 'Let in', ` data-id="${id}"`, true) + btn('note-open', 'Reply', ` data-key="${esc(n.key)}"`) + btn('decline', 'Decline', ` data-id="${id}"`);
  } else if (n.kind === 'new') {
    // Let in, with no chips or credit yet (#621): New until then.
    top = `<a href="#${ph('member', n.member)}">${who}</a>${removedHtml(n.removedAt)}`;
    body = said;
    acts = open ? replyForm : `<a class="btn-small primary" href="#${ph('member', n.member)}">Give chips</a>` + btn('note-open', n.waiting ? 'Reply' : 'Message', ` data-key="${esc(n.key)}"`);
  } else if (n.kind === 'chips') {
    top = `${who} asks for <b>${chips(n.amount)}</b>${n.table ? ` at ${esc(n.table)}` : ''}`;
    if (n.note) body = `<span class="pl-meta">“${esc(n.note)}”</span>`;
    acts = open ? form('grant', amount(n.amount, 'Chips to give'), 'Give')
      : btn('grant', `Give ${chips(n.amount)}`, ` data-id="${id}"`, true) + btn('note-open', 'Other', ` data-key="${esc(n.key)}"`) + btn('deny-now', 'Decline', ` data-id="${id}"`);
  } else if (n.kind === 'at_limit') {
    // Credit is never given past the limit (#404): raise it, or no.
    top = `${who} asks for <b>${chips(n.asked)}</b>${n.table ? ` at ${esc(n.table)}` : ''}`;
    body = `<span class="pl-meta">At their credit limit (${chips(n.credit)})</span>`;
    acts = `<form class="mg-note-acts" data-noteform="raise" data-id="${id}"><label class="pl-meta">New limit ${amount(raiseTo(n), 'New credit limit')}</label><button class="btn-small primary" type="submit">Raise limit</button>${btn('deny-now', 'Decline', ` type="button" data-id="${id}"`)}</form>`;
  } else if (n.kind === 'help') {
    top = `${who}${n.table ? ` <span class="pl-meta">${esc(n.table)}</span>` : ''}`;
    body = `<span>“${esc(n.text)}”</span>`;
    acts = open ? form('reply', `<input class="pl-text mg-note-wide" name="reply" maxlength="${MAX_HELP_REPLY}" required aria-label="Reply">`, 'Send')
      : btn('note-open', 'Reply', ` data-key="${esc(n.key)}"`, true) + watchBtn(n.watch || '') + btn('help-done', 'Done', ` data-id="${esc(n.id)}"`);
  } else if (n.kind === 'prize') {
    top = `<b>${esc(n.promo)}</b> · ${esc(n.name)} · ${chips(n.amount)}`;
    if (n.handName) body = `<span class="pl-meta">${esc(n.handName)}</span>`;
    acts = btn('promo-approve', 'Pay', ` data-id="${esc(n.id)}"`, true) + (n.hand ? btn('promo-replay', 'Replay', ` data-code="${esc(club.code)}" data-who="host" data-hand="${esc(n.hand)}"`) : '');
  } else if (n.kind === 'stopped') {
    top = `<b>${esc(n.name)}</b> stopped dealing`;
    acts = btn('close-table-yes', 'Close table', ` data-table="${esc(n.table)}" data-ask="Close ${esc(n.name)}?" data-yes="Close"`);
  } else if (n.kind === 'left_owing') {
    const t = tableById(club, n.table)?.name || 'a table';
    top = `<a href="#${ph('member', n.member)}">${who}</a> left ${esc(t)} owing <b>${chips(n.owesNow)}</b>`;
  } else if (n.kind === 'move') {
    // A big chip move, a removal or a cap change (#576).
    top = esc(n.text);
  } else if (n.kind === 'fair_play') {
    // Flagged by the relay's check (#582): the Fair play page has the numbers.
    top = `<a href="#${ph('fairplay')}">${esc(n.name)}</a>`;
  } else if (n.kind === 'short') {
    // A scheduled game's start with too few checked in (#599).
    top = `<b>${esc(n.name)}</b>: ${n.checkedIn} checked in of ${n.min}`;
    if (n.note) body = `<span class="pl-meta">${esc(n.note)}</span>`;
    acts = btn('sched-start', 'Start short', ` data-id="${esc(n.id)}"`, true) + btn('sched-cancel', 'Cancel', ` data-id="${esc(n.id)}" data-ask="Cancel this game?" data-yes="Cancel game"`);
  }
  // One row each (#516): what kind, who and what, how long ago, the answers.
  const tag = NOTE_TAGS[n.kind] || '';
  return `<li class="mg-note"><span class="mg-note-tag k-${n.kind}">${tag}</span><span class="mg-note-text">${top}${body ? ` ${body}` : ''}</span>${when(n.at)}${acts ? (acts.startsWith('<form') ? acts : `<span class="mg-note-acts">${acts}</span>`) : '<span class="mg-note-acts"></span>'}</li>`;
}

const NOTE_TAGS = {join: 'Join', new: 'New', chips: 'Chips', at_limit: 'Chips', help: 'Help', prize: 'Prize', stopped: 'Table', left_owing: 'Owes', move: 'Check', fair_play: 'Fair play', short: 'Game'};

// When something waiting applies: "Sat 9:15 PM".
const capWhen = at => new Date(at).toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'});

// The owner's float (#589), on top of Chips (#657): what's left to give (and
// for chips on credit, #633), of its size, refilled from the owner's vault;
// the size. Both at once, with a fresh passkey unlock (#660).
function floatRowsHtml() {
  const f = floatOf(club);
  const refill = '<button class="btn-small" data-cl="refill">Refill</button>';
  let h = `<div class="pl-row"><span class="pl-label">Left</span><div class="pl-opts"><b class="cl-float-now">${chips(f.float)} of ${chips(f.size)}</b>${f.float >= f.size ? offBtn(refill, 'Full') : refill}</div></div>`;
  h += `<div class="pl-row"><span class="pl-label">Size</span><form class="pl-opts" data-floatform="size"><input class="pl-text cl-cap-in" name="amount" type="number" inputmode="decimal" required min="0.01" step="${CHIP_STEP}" value="${esc(chipInput(f.size))}" aria-label="Float size"><button class="btn-small primary" type="submit">Save</button></form></div>`;
  return h;
}

// Rules (#398): how the club's tables and members work.
function rulesHtml() {
  const remote = isRemote();
  let h = '<div class="pl-row"><span class="pl-label">Rathole</span><div class="pl-opts">';
  h += [0, 1, 2, 4, 8, 24].map(n => `<button class="cc-btn${club.ratholeHours === n ? ' on' : ''}" data-cl="rathole" data-hours="${n}">${n ? n + ' h' : 'Off'}</button>`).join('');
  h += '</div></div>';
  h += '<div class="pl-row"><span class="pl-label">Sit-out limit</span><div class="pl-opts">';
  h += [5, 10, 15, 30, 0].map(m => `<button class="cc-btn${(club.sitOutMins ?? 10) === m ? ' on' : ''}" data-cl="sitout-mins" data-mins="${m}">${m ? m + ' min' : 'None'}</button>`).join('');
  h += '</div></div>';
  // Call time (#476): the hands a player who's up plays before leaving, for
  // new tables; each table can set its own.
  h += '<div class="pl-row"><span class="pl-label">Call time</span><div class="pl-opts">';
  h += CALL_TIMES.map(n => `<button class="cc-btn${(club.stayHands ?? 0) === n ? ' on' : ''}" data-cl="call-time" data-hands="${n}">${n ? n + ' hands' : 'Off'}</button>`).join('');
  h += '</div></div>';
  // Asking to join with the club code alone (#393): off by default.
  if (remote) {
    h += `<div class="pl-row"><span class="pl-label">Join by code (${esc(club.code)})</span><div class="pl-opts">`;
    h += [[false, 'Off'], [true, 'On']].map(([on, text]) => `<button class="cc-btn${(club.codeJoin === true) === on ? ' on' : ''}" data-cl="code-join" data-on="${on ? 1 : 0}">${text}</button>`).join('');
    h += '</div></div>';
  }
  // New tables' rake or time (#449): none until the owner sets it.
  if (chargeOn(club)) h += clubChargeHtml(club, chargeNote);
  // Let everyone in (#631): off, the manager or an agent lets each one in.
  const all = club.letAllIn === true;
  h += '<div class="pl-row"><span class="pl-label">Let everyone in</span><div class="pl-opts">';
  h += [[false, 'Off'], [true, 'On']].map(([on, text]) => `<button class="cc-btn${all === on ? ' on' : ''}" data-cl="let-all-in" data-on="${on ? 1 : 0}" aria-pressed="${all === on}">${text}</button>`).join('');
  h += '</div></div>';
  h += `<div class="pl-row"><span class="pl-label">Keep hands</span><div class="pl-opts">${[1, 7, 30].map(d => `<button class="cc-btn${(club.keepDays ?? HOST_KEEP_DAYS) === d ? ' on' : ''}" data-cl="keep-days" data-days="${d}">${d} day${d > 1 ? 's' : ''}</button>`).join('')}</div></div>`;
  // Outside servers that give chips (club-services.js): an always-on club's room answers them.
  if (remote && !OFF.has('services')) h += servicesHtml(club, {form: serviceForm, note: serviceNote});
  return h;
}

// Backup and devices (#398, #399): the backup and its proof, running the
// club from another device, and deleting it.
function backupPageHtml() {
  const remote = isRemote();
  let h = '';
  if (remote) {
    // A backup counts once proved (#395), on any device: the relay keeps when.
    const last = hostNotes().backedUp, plan = own().view?.plan;
    if (plan?.temporary) h += '<p class="pl-meta pl-neterr">Temporary club: no backup proved yet.</p>';
    else if (plan?.provedAt) h += `<p class="pl-meta">Backed up ✓ ${esc(new Date(plan.provedAt).toLocaleString())}</p>`;
    if (last) h += `<p class="pl-meta">Last backup from this browser: ${esc(new Date(last).toLocaleString())}</p>`;
    // Moving devices (#191) is restoring this backup there.
    h += '<div class="pl-actions"><button class="btn-small primary" data-cl="backup">Back up the club</button></div>';
  } else h += '<p class="pl-desc">Kept in this browser only. Move it to always on to back it up.</p>';
  // Leaving this browser isn't deleting the club (#544): a section of its own.
  if (remote) h += '<h2>This browser</h2><div class="pl-actions"><button class="btn-small" data-cl="close">Stop running it here</button></div>';
  h += `<h2>Delete</h2><div class="pl-actions">${remote ? '<button class="btn-small" data-cl="delete-always">Delete club</button>' : '<button class="btn-small" data-cl="close">Delete club</button>'}</div>`;
  return h;
}

// Club info (#398, club-info.js): its sections as the managers write them;
// members see them formatted (bold, lists, links), About also on the invite.
const localInput = t => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function infoEditHtml() {
  const info = club.info || {};
  const area = (k, rows) => `<label class="mg-field"><span>${sectionName(k)}</span><textarea class="pl-text" name="${k}" rows="${rows}" maxlength="${MAX_INFO_TEXT}" placeholder="**bold**, - lists, links">${esc(info[k] || '')}</textarea></label>`;
  let h = '<form class="mg-info-form" data-infoform="1">';
  h += area('about', 5);
  const evs = [...(info.events || []), {}, {}];
  h += `<fieldset class="mg-field"><legend>${sectionName('events')}</legend>`;
  evs.forEach((e, i) => {
    h += `<div class="mg-event"><input class="pl-text" type="datetime-local" name="evat${i}" aria-label="When" value="${e.at ? localInput(e.at) : ''}">`;
    h += `<input class="pl-text" name="evtext${i}" maxlength="${MAX_EVENT_TEXT}" aria-label="What" placeholder="Event" value="${esc(e.text || '')}"></div>`;
  });
  h += '</fieldset>';
  h += area('chips', 3) + area('rules', 5);
  // Saved ✓ shows beside Save once it is (markControls).
  h += '<div class="pl-actions"><button class="btn-small primary" type="submit">Save</button></div></form>';
  return h;
}

// The Club info form, as club info.
function readInfoForm(f) {
  const events = [];
  for (let i = 0; f.elements[`evat${i}`]; i++) {
    const at = f.elements[`evat${i}`].value ? new Date(f.elements[`evat${i}`].value).getTime() : 0;
    const text = f.elements[`evtext${i}`].value.trim();
    if (at && text) events.push({at, text});
  }
  return {about: f.elements.about.value, chips: f.elements.chips.value, rules: f.elements.rules.value, events};
}

// The promotion form open (#278): 'new', 'new-bonus' or a promotion's id; and what's wrong with it.
let promoForm = null, promoNote = '';
// The prize whose Void form is open (#544).
let voiding = '';

// The Balances page (#454): the club's links with its own members, whoever
// owes chips, largest first (an agent's row is all of their players' play
// too), and whether the books add up. Give or Take back, on the member's
// page, changes them.
function settleHtml() {
  const rows = settleRows(club);
  let h = '';
  if (!rows.length) h += '<p class="pl-meta">All at zero.</p>';
  else {
    h += '<table class="cl-acct cl-settle"><tbody>';
    for (const r of rows) {
      const m = club.members[r.member];
      h += `<tr><th><a href="#${ph('member', r.member)}">${esc(m?.name || r.member)}</a></th><td>${r.balance < 0 ? 'Owes the club' : 'Club owes'}</td><td class="${r.balance < 0 ? 'cl-down' : 'cl-up'}">${chips(Math.abs(r.balance))}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  h += totals(club).conserved ? '<p class="pl-meta">Adds up ✓</p>' : '<p class="pl-desc pl-neterr">Doesn’t add up.</p>';
  return h;
}

// The Chips page (#657): where the club's chips are. The float; the chips
// out with players, adding up to their total; credit, owed and paid back;
// each member; the rake; then results by session and the ledger.
function accountingHtml() {
  const w = whereChips(club);
  const names = memberNames();
  const about = aboutNames(club);
  const ledger = ledgerView(club);
  const results = totalsByMember(tableSessions(ledger));
  const signed = n => `<span class="${n > 0 ? 'cl-up' : n < 0 ? 'cl-down' : ''}">${n > 0 ? '+' : ''}${chips(n)}</span>`;
  const row = (label, n, cls = '') => `<tr${cls}><th>${label}</th><td>${chips(n)}</td></tr>`;
  let h = `<section class="cl-chips-float"><h2>Float</h2>${floatRowsHtml()}</section>`;
  h += '<h2>Out with players</h2><table class="cl-acct cl-out"><tbody>';
  h += row('In balances', w.out.balances);
  if (w.out.vaults) h += row('In vaults', w.out.vaults);
  h += row('On tables', w.out.tables);
  if (w.out.tourneys) h += row('In tournaments', w.out.tourneys);
  h += row('Total', w.out.total, ' class="cl-acct-sum"');
  h += '</tbody></table>';
  const members = membersByStatus(club, 'member').sort((a, b) => a.name.localeCompare(b.name));
  const credit = members.some(m => creditRow(m).credit);
  // Credit (#404, #633): what members owe the club, and paid back outside ducy.
  if (credit || w.owed || w.paid) h += `<h2>Credit</h2><table class="cl-acct cl-owed"><tbody>${row('Owed to the club', w.owed)}${row('Paid back', w.paid)}</tbody></table>`;
  h += w.conserved ? '<p class="pl-meta cl-adds-up">Adds up ✓</p>' : '<p class="pl-desc pl-neterr">Doesn’t add up.</p>';
  if (members.length) {
    h += `<h2>Members</h2><table class="cl-acct cl-chip-members"><thead><tr><th>Member</th><th>Balance</th><th>On a table</th><th>Results</th>${credit ? '<th>Credit limit</th>' : ''}</tr></thead><tbody>`;
    for (const m of members) {
      const limit = creditRow(m).credit;
      h += `<tr><th><a href="#${ph('member', m.id)}">${esc(m.name)}</a></th><td>${signed(m.balance)}</td><td>${m.seat ? chips(m.seat.stack) : '–'}</td><td>${signed(results[m.id] || 0)}</td>${credit ? `<td>${limit ? chips(limit) : '–'}</td>` : ''}</tr>`;
    }
    h += '</tbody></table>';
  }
  // Each player's rake and time (#449), and each agent's players'.
  if (club.rakeBook) h += contributionsHtml(contributions(club), {link: id => `#${ph('member', id)}`});
  h += resultsHtml(ledger, names, about);
  if (ledger.length) {
    // Filtered by member, kind and what it was about, and exported as CSV (#188).
    const shown = filterLedger(ledger);
    const sel = (key, all, opts) => `<select class="pl-text" data-lf="${key}"><option value="">${all}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${ledgerFilter[key] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const kinds = [...new Set(ledger.map(e => e.kind))].map(k => [k, KIND_TEXT[k] || k]);
    const people = [...new Set(ledger.map(e => e.member))].map(id => [id, names[id] || id]).sort((a, b) => a[1].localeCompare(b[1]));
    const abouts = [...new Set(ledger.filter(e => e.about).map(e => e.about))].map(id => [id, about[id] || id]);
    h += `<details class="cl-history" data-keep="ledger"><summary>Ledger (${ledger.length})</summary>`;
    h += `<div class="pl-row cl-ledger-filters">${sel('member', 'Everyone', people)}${sel('kind', 'Everything', kinds)}${abouts.length ? sel('table', 'Anywhere', abouts) : ''}`;
    h += `<button class="btn-small" data-cl="ledger-csv">Export CSV${shown.length < ledger.length ? ` (${shown.length})` : ''}</button></div><ul>`;
    for (const e of [...shown].reverse().slice(0, 200)) h += ledgerLineHtml(e, about, names);
    h += '</ul>';
    if (shown.length > 200) h += `<p class="pl-meta">The newest 200 of ${shown.length}; Export CSV has them all.</p>`;
    if (!shown.length) h += '<p class="pl-meta">Nothing matches.</p>';
    h += '</details>';
  }
  return h;
}

// The Accounting tab's ledger filters (#188): '' for all. `table`: what an
// entry was about (a table, tournament or promotion).
let ledgerFilter = {member: '', kind: '', table: ''};
const filterLedger = ledger => ledger.filter(e => (!ledgerFilter.member || e.member === ledgerFilter.member)
  && (!ledgerFilter.kind || e.kind === ledgerFilter.kind) && (!ledgerFilter.table || e.about === ledgerFilter.table));

function exportLedger() {
  const names = {...memberNames(), club: 'Club'};
  downloadFile(ledgerCsv(filterLedger(ledgerOf(club)), names, aboutNames(club), KIND_TEXT), `ducy-ledger-${myClubCode()}.csv`, 'text/csv');
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

// A ⋯ menu (#144): items [action, label, title?, ask?], each a button
// handled like any other data-cl click.
// `attrs`: more attributes for every item (an agent's: the club's code).
// It stays open over redraws (#544).
function menuHtml(label, items, id = '', extra = '', attrs = '') {
  let h = `<details class="cl-menu" data-keep="menu:${esc(id)}:${esc(label)}"><summary class="btn-small" aria-label="${esc(label)}" title="${esc(label)}">⋯</summary><div class="cl-menu-items">`;
  for (const [act, text, title = '', ask = ''] of items) {
    // `ask`: the question it asks first (#544), and its yes ("Remove Ann?|Remove").
    const [q, yes] = ask.split('|');
    h += `<button class="cl-menu-item" data-cl="${act}"${id ? ` data-id="${esc(id)}"` : ''}${attrs}${title ? ` title="${esc(title)}"` : ''}${ask ? ` data-ask="${esc(q)}" data-yes="${esc(yes)}"` : ''}>${text}</button>`;
  }
  return h + extra + '</div></details>';
}


// The clubs you're in: on Clubs ('play' here) your balance, chips and
// tables; and, picked at the top of Clubs ('clubs'), the ones you're an agent of.
const helps = m => m.status === 'member' && m.agent === 'yes';

// The name you go by in a club (#185), with a way to change it for that
// club only. `nameForm`: the club whose name is being edited. A name
// someone there already has (#450) opens it.
let nameForm = '';
function clubNameHtml(m) {
  const code = esc(m.code);
  if (m.nameTaken) return `<p class="pl-desc pl-neterr cl-err">“${esc(m.nameTaken)}” is taken in ${esc(m.name || m.code)}.</p>${clubNameForm(m)}`;
  if (nameForm !== m.code) {
    return `<p class="pl-meta cl-myname">You’re <b>${esc(nameIn(m))}</b> in this club${m.myName ? '' : ' (your name in Player settings)'}. <button class="link-btn" data-cl="myname" data-code="${code}">Change</button></p>`;
  }
  let h = clubNameForm(m);
  if (m.myName) h += `<p class="pl-meta">Leave it as ${esc(myName() || 'empty')} to use your name in Player settings here too.</p>`;
  return h;
}

function clubNameForm(m) {
  const code = esc(m.code);
  let h = `<form class="pl-row cl-myname" data-nameform="${code}"><label class="pl-label" for="cl-myname-${code}">Your name in ${esc(m.name || m.code)}</label>`;
  h += `<input class="pl-text" id="cl-myname-${code}" name="name" maxlength="${MAX_PLAYER_NAME}" value="${esc(m.nameTaken ? '' : nameIn(m))}" placeholder="${esc(m.nameTaken ? '' : myName())}">`;
  h += `<button class="btn-small primary" type="submit">Save</button>${m.nameTaken ? '' : '<button class="btn-small" type="button" data-cl="myname-cancel">Cancel</button>'}</form>`;
  return h;
}

// Letting someone in (#621): as a Cash or a Credit player, with their credit
// line. `letIn`: whose choice is open; `to`: 'o|id' (the owner) or
// 'a|code|id' (their agent).
let letIn = '';
function letInHtml(to, dis = '') {
  let h = `<form class="mg-note-acts cl-letin" data-letin="${esc(to)}">`;
  // The owner letting in an agent's recruit: their credit is the agent's (#633).
  const [who, id] = to.split('|');
  if (!(who === 'o' && underAgent(club?.members[id]))) {
    h += '<span class="pl-opts" role="radiogroup" aria-label="Player">';
    h += `<label class="cc-btn"><input type="radio" name="kind" value="cash" checked> Cash</label><label class="cc-btn"><input type="radio" name="kind" value="credit"> Credit</label></span>`;
    h += `<input class="pl-text cl-credit-in" name="credit" type="number" inputmode="decimal" min="0.01" step="${CHIP_STEP}" placeholder="Credit line" aria-label="Credit line">`;
  }
  return h + `<button class="btn-small primary" type="submit"${dis}>Let in</button><button class="btn-small" type="button" data-cl="letin-cancel">Cancel</button></form>`;
}

// A member's thread with the club (#621): each line ({mine, who, text, at}),
// and a box to add one, its form keyed `form` (see onSubmitIn).
const MAX_THREAD_NOTE = 300;
function threadHtml(lines, form, {dis = '', open = true} = {}) {
  let h = '<div class="cl-thread">';
  if (lines.length) {
    h += '<ul class="cl-thread-lines">';
    for (const n of lines) h += `<li class="${n.mine ? 'mine' : ''}"><b>${esc(n.who)}</b> <span class="cl-thread-text">${esc(n.text)}</span> <span class="pl-meta">${when(n.at)}</span></li>`;
    h += '</ul>';
  }
  if (open) h += `<form class="cl-thread-form" data-threadform="${esc(form)}"><input class="pl-text" name="text" maxlength="${MAX_THREAD_NOTE}" required placeholder="Message" aria-label="Message"${dis}><button class="btn-small primary" type="submit"${dis}>Send</button></form>`;
  return h + '</div>';
}

// A club you're an agent of: Manage, with the agent's tools.
function manageHtml(m) {
  const hostHere = !!playerNets.get(m.code)?.hostHere;
  let h = '<section class="cl-card cl-manage"><div class="cl-title"><h2>Manage</h2><span class="cl-status cl-member">Agent</span></div>';
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
  // Your balance (negative: what you owe, #404) and any credit limit.
  h += `<span class="cl-home-chips${m.balance < 0 ? ' owes' : ''}"${m.entries?.length && !mismatch ? ' title="Your copy of the ledger adds up to this balance"' : ''}>Balance ${signed(m.balance)}</span>`;
  if (m.credit) h += `<span class="cl-home-chips">Credit limit ${chips(m.credit)}</span>`;
  if (m.vault?.vault) h += `<span class="cl-home-chips">Vault ${chips(m.vault.vault)}</span>`;
  h += '</div>';
  if (vaultTakenRecently(m.vault)) h += `<p class="cl-side-note cl-vault-taken" role="status">${esc(vaultTakenText(m.vault.taken))}</p>`;
  h += leftPanelHtml(m);
  h += memberBackupHtml();
  if (!(n?.online && n.hostHere)) h += `<p class="pl-meta cl-conn">${connText(n, 'Your seat and chips are kept.')}${n ? '' : ` <button class="btn-small" data-cl="retry" data-code="${code}">Try again</button>`}</p>`;
  if (m.error) h += `<p class="pl-desc pl-neterr cl-err">${esc(m.error)}</p>`;
  // No backup of the club proved yet (#395): it may not last.
  if (m.temporary) h += '<p class="pl-meta cl-temp">Temporary club: its owner hasn’t backed it up yet. If no one uses it for 7 days, it’s deleted.</p>';
  if (mismatch) h += '<p class="pl-desc pl-neterr">Your copy of the ledger doesn’t add up to the balance the club reports.</p>';
  if (m.agent === 'offered') {
    h += `<div class="cl-account cl-offer"><span>The owner asked you to be an <b>agent</b>.</span>${roleHtml('agent')}`;
    h += `<span><button class="btn-small primary" data-cl="agent-yes" data-code="${code}">Accept</button> <button class="btn-small" data-cl="agent-no" data-code="${code}">No thanks</button></span></div>`;
  }
  h += manage;
  const tab = memberTab(m.code);
  // Club info changed since you last looked (#398): which parts, until you do.
  const changed = changedSince(m.info, infoSeen(m.code));
  if (tab === 'info') markInfoSeen(m);
  else if (changed.length) h += `<p class="cl-updated"><button class="link-btn" data-cl="mtab" data-code="${code}" data-tab="info">Updated: ${changed.map(k => sectionName(k).toLowerCase()).join(', ')}</button></p>`;
  // The tabs (#398): Cash games · Tournaments · Club info · My chips · My hands.
  const tabBtn = (id, label) => `<button class="pl-tab${tab === id ? ' on' : ''}" role="tab" aria-selected="${tab === id}" data-cl="mtab" data-code="${code}" data-tab="${id}">${label}${id === 'info' && changed.length && tab !== 'info' ? '<span class="cl-dot" aria-label="updated"></span>' : ''}</button>`;
  h += `<div class="pl-tabs cl-dash-tabs cl-member-tabs" role="tablist">${tabNamesFor(m).map(([id, label]) => tabBtn(id, label)).join('')}</div>`;
  h += '<div class="cl-home"><section class="cl-home-main">';
  const ev = nextEvent(m.info);
  const evLine = ev ? `<p class="cl-next-event"><b>Next:</b> ${esc(ev.text)} <span class="pl-meta">${esc(new Date(ev.at).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}))}</span></p>` : '';
  if (tab === 'players') h += agentHtml(m, hostHere, {page: true});
  else if (tab === 'chips') h += myChipsHtml(m);
  else if (tab === 'history') {
    h += handsHtml(m.code, me.id, 'Your hands');
    const tableNames = Object.fromEntries((m.tables || []).map(t => [t.id, t.name]));
    h += resultsHtml(m.entries || [], null, tableNames);
  } else if (tab === 'info') h += memberInfoHtml(m);
  else if (tab === 'tourneys') {
    h += evLine + (memberTourneysHtml(m, me.id, {hostHere, playing: seatedAt?.code === m.code && seatedAt.table.startsWith('tourney:') ? seatedAt.table.slice(8) : null}) || '<p class="pl-meta cl-empty">No tournaments.</p>');
  } else {
    h += evLine + memberTablesHtml(m, hostHere);
    const promos = memberPromosHtml(m.promos);
    if (promos) h += '<h2>Promotions</h2>' + promos;
  }
  h += '</section><aside class="cl-home-side"><div class="cl-side-card">';
  // Getting chips, from the club info (#398), beside Ask for chips.
  if (m.info?.chips) h += `<div class="cl-info-text cl-getting">${formatInfo(m.info.chips)}</div>`;
  // New and without chips: the first step, with the biggest buy-in at the
  // club's tables to ask for (#185).
  const fresh = !m.request && !m.balance && !m.entries?.length && !m.credit;
  const suggest = fresh ? Math.max(0, ...(m.tables || []).map(t => t.max || 0)) : 0;
  if (fresh) h += `<p class="cl-next"><b>You’re in.</b> Ask the manager for chips to play${suggest ? `: ${chips(suggest)} covers the biggest buy-in here` : ''}.</p>`;
  if (m.request) {
    h += `<p class="cl-side-note">You asked for ${chips(m.request.amount)}${m.request.note ? ` (“${esc(m.request.note)}”)` : ''}; waiting for the manager. `;
    h += `<button class="btn-small" data-cl="cancel-ask" data-code="${code}"${online ? '' : ' disabled title="Can’t reach the club right now"'}>Cancel</button></p>`;
  } else {
    if (m.cancelQueued) h += '<p class="cl-side-note">You cancelled your request. The manager will see that when they’re back.</p>';
    // How your last request went, for a week (#188).
    const a = m.answer;
    if (a && Date.now() - a.at < 7 * 24 * 3600e3) {
      h += a.outcome === 'granted' && a.limit != null
        ? `<p class="cl-side-note cl-answer">Credit limit raised to ${chips(a.limit)} (${when(a.at)}).</p>`
        : a.outcome === 'granted'
        ? `<p class="cl-side-note cl-answer">You asked for ${chips(a.asked)} and were given ${chips(a.given)} (${when(a.at)}).</p>`
        : `<p class="cl-side-note cl-answer">Your request for ${chips(a.asked)} was declined${a.note ? `: “${esc(a.note)}”` : ''} (${when(a.at)}).</p>`;
    }
    h += `<div class="cl-ask"><input class="pl-text" type="number" min="0.01" step="${CHIP_STEP}" placeholder="Chips" aria-label="Chips to ask for" data-ask-amt="${code}"${suggest ? ` value="${esc(chipInput(suggest))}"` : ''}>`;
    h += `<input class="pl-text" maxlength="${MAX_NOTE}" placeholder="Note (optional)" aria-label="Note" data-ask-note="${code}">`;
    h += `<button class="btn-small primary" data-cl="ask" data-code="${code}"${hostHere ? '' : ' disabled title="Can’t reach the club right now"'}>Ask for chips</button></div>`;
  }
  h += '</div>';
  // Your messages with the manager (#621), from when you joined.
  if (m.thread?.length) h += `<div class="cl-side-card cl-messages"><h2>Messages</h2>${memberThreadHtml(m, hostHere)}</div>`;
  h += memberHelpHtml(m, hostHere);
  if (m.lobby) h += lobbyHtml(m.lobby.online, m.lobby.chat, m.code, hostHere);
  h += clubNameHtml(m);
  h += `<button class="link-btn cl-forget" data-cl="forget" data-code="${code}">Forget this club</button>`;
  return h + '</aside></div>';
}

// Back up your account (#562): on a member's club page until this player ID
// has a backup (Player settings' backup, saved here or there). Not in a demo
// (#406), whose people are made up.
let memberBackup = null; // null, {form: true, note?} or {saved: true}
function memberBackupHtml() {
  if (demo || !me || (isBackedUp(me.id) && !memberBackup?.saved)) return '';
  if (memberBackup?.saved) {
    return `<section class="cl-left cl-backup" role="status"><b class="cl-left-title">Backed up ✓</b><p class="cl-backup-text">${esc(BACKUP_SAVED)}</p><button class="btn-small primary" data-cl="member-backup-done">Done</button></section>`;
  }
  let h = '<section class="cl-left cl-backup"><b class="cl-left-title">Back up your account</b>';
  h += '<p class="cl-backup-text">Your account lives only in this browser. A backup gets it back on a new phone, or if the browser clears it.</p>';
  // iPhone Safari clears a site's data after 7 days without a visit, unless
  // it's on the Home Screen.
  if (safariMayClear()) h += '<p class="cl-backup-text">In Safari, tap Share, then Add to Home Screen, so Safari doesn’t clear it.</p>';
  if (memberBackup?.form) {
    h += backupFormHtml('data-clform="member-backup"', 'data-cl="member-backup-cancel"');
    if (memberBackup.note) h += `<p class="cl-backup-text cl-down">${esc(memberBackup.note)}</p>`;
  } else h += '<button class="btn-small primary" data-cl="member-backup">Download</button>';
  return h + '</section>';
}

// A balance or result: "−120", never "-120".
const signed = (n, plus = false) => (n < 0 ? `−${chips(-n)}` : `${plus && n > 0 ? '+' : ''}${chips(n)}`);

// Standing up (#404): the table left, the result there and the balance
// after it, until Done. By club code: the cash-out entry's n.
const leftPanels = new Map();
function leftPanelHtml(m) {
  const n = leftPanels.get(m.code);
  const s = n && leftSummary(m.entries || [], n);
  if (!s) return '';
  const name = m.tables?.find(t => t.id === s.table)?.name || 'the table';
  let h = `<section class="cl-left" role="status"><b class="cl-left-title">You left ${esc(name)}</b>`;
  h += `<b class="cl-left-net${s.net > 0 ? ' cl-up' : s.net < 0 ? ' cl-down' : ''}">${signed(s.net, true)}</b>`;
  h += `<div class="pl-avail"><span>Balance</span><b${s.balance < 0 ? ' class="cl-down"' : ''}>${signed(s.balance)}</b></div>`;
  return h + `<button class="btn-small primary" data-cl="left-done" data-code="${esc(m.code)}">Done</button></section>`;
}

// A member's vault (#579), on My chips: its chips; Put in (at once, from
// the balance) and Take out (after their wait, with a fresh passkey
// unlock); what's on its way out, with Cancel; and the wait, a shorter one
// applying only after the current one.
const VAULT_WAIT_TEXT = {[VAULT_WAITS[0]]: '24 h', [VAULT_WAITS[1]]: '3 days', [VAULT_WAITS[2]]: '7 days'};
function vaultHtml(m) {
  const v = m.vault || {vault: 0, wait: VAULT_WAITS[0], outs: []};
  const code = esc(m.code);
  const online = !!playerNets.get(m.code)?.hostHere;
  const off = online ? '' : ' disabled title="Can’t reach the club right now"';
  const going = (v.outs || []).reduce((n, o) => n + o.amount, 0);
  let h = `<section class="cl-vault" aria-label="Vault"><div class="cl-vault-head"><h2>Vault</h2><b class="cl-vault-chips">${chips(v.vault)}</b></div>`;
  const form = (kind, max, label) => `<form class="cl-vault-form" data-vaultform="${kind}" data-id="${code}" data-code="${code}"><input class="pl-text" name="amount" type="number" inputmode="decimal" required min="0.01" max="${chipInput(Math.max(0, max))}" step="${CHIP_STEP}" placeholder="Chips" aria-label="${label} chips"><button class="btn-small${kind === 'in' ? ' primary' : ''}" type="submit"${off}>${label}</button></form>`;
  h += '<div class="cl-vault-forms">';
  if (m.balance > 0) h += form('in', m.balance, 'Put in');
  if (v.vault - going > 0) h += form('out', v.vault - going, 'Take out');
  h += '</div>';
  for (const o of v.outs || []) {
    h += `<p class="cl-vault-out"><span><b>${chips(o.amount)}</b> out ${esc(capWhen(o.ready))}</span><button class="btn-small" data-cl="vault-cancel" data-code="${code}" data-out="${o.id}"${off}>Cancel</button></p>`;
  }
  h += `<div class="pl-row"><span class="pl-label">Wait to take out</span><div class="pl-opts">${VAULT_WAITS.map(w => `<button class="cc-btn${v.wait === w ? ' on' : ''}" data-cl="vault-wait" data-code="${code}" data-wait="${w}" aria-pressed="${v.wait === w}"${off}>${VAULT_WAIT_TEXT[w]}</button>`).join('')}</div></div>`;
  if (v.shorter) h += `<p class="pl-meta">${VAULT_WAIT_TEXT[v.shorter.to]} from ${esc(capWhen(v.shorter.applies))}</p>`;
  if (m.vaultNote) h += `<p class="pl-desc pl-neterr cl-err" role="alert">${esc(m.vaultNote)}</p>`;
  if (vaultTakenRecently(v)) h += `<p class="pl-meta cl-vault-taken">${esc(vaultTakenText(v.taken))}</p>`;
  return h + '</section>';
}

// Their agent took chips back from their vault (#579): said for a week.
const vaultTakenRecently = v => !!v?.taken && Date.now() - v.taken.at < 7 * 864e5;
const vaultTakenText = t => `Your agent took ${chips(t.amount)} back from your vault ${ago(t.at)}.`;

// A member's vault command (#579), from control `el`: taking out and the
// wait need a passkey unlock from the last few minutes.
async function vaultAct(el, op, args) {
  const code = el.dataset.code;
  const mem = memberships.find(x => x.code === code);
  if (!mem) return;
  if (op === 'in' || op === 'out') {
    if (!Number.isSafeInteger(args.amount) || args.amount <= 0) { failAt(el, 'Enter an amount above 0, like 50 or 12.50.'); return; }
  }
  if (VAULT_OPS.has(op)) {
    const no = await freshPass();
    if (no) { failAt(el, no); return; }
  }
  mem.vaultNote = '';
  sendToHost(code, {type: 'vault', club: code, op, ...args});
  if (el.tagName === 'FORM') el.reset();
  render();
}

// My chips (#398, #404): each table session as one line ("Left Main −120
// → −220"), and every other chip move, with the balance after.
function myChipsHtml(m) {
  const lines = chipLines(m.entries).slice(0, 50);
  const vault = vaultHtml(m);
  if (!lines.length) return vault + '<p class="pl-meta">No chips in or out yet.</p>';
  const tableName = id => m.tables?.find(t => t.id === id)?.name || 'a table';
  let h = vault + '<ul class="cl-ledger mg-rows">';
  for (const l of lines) {
    const what = l.kind === 'left' ? `Left ${esc(tableName(l.table))}` : l.kind === 'at' ? `At ${esc(tableName(l.table))}` : esc(KIND_TEXT[l.kind] || l.kind);
    h += `<li class="mg-row"><span>${what}${l.note ? ` <span class="pl-meta">“${esc(l.note)}”</span>` : ''}</span><span class="pl-meta">${when(l.at)}</span>${l.entry ? promoReplayBtn(l.entry, m.code, me.id) : ''}`;
    h += `<span class="mg-row-end"><b class="${l.amount > 0 ? 'cl-up' : l.amount < 0 ? 'cl-down' : ''}">${signed(l.amount, true)}</b> → ${signed(l.balance)}</span></li>`;
  }
  return h + '</ul>';
}

// The money model's entry kinds (club-money.js).
const KIND_TEXT = {give: 'Chips given', take_back: 'Chips taken back', buy_in: 'Bought in', top_up: 'Topped up', refund: 'Refunded', cash_out: 'Cashed out', tourney_buy_in: 'Tournament buy-in', prize: 'Prize', rake_share: 'Rake share', void: 'Prize voided', opening: 'Opening balance',
  // The owner's float (#589) and members' vaults (#579).
  refill: 'Float refilled', to_vault: 'Float to vault', vault_in: 'Into vault', vault_out: 'Out of vault',
  // Rake and time a player paid over a session (#449).
  rake: 'Rake and time',
  // Chips on credit come from the float and go back to it; a debt paid
  // outside ducy (#633).
  credit: 'On credit', credit_back: 'Back from credit', payment: 'Payment'};

// The names of what entries are about: tables, tournaments and promotions.
const aboutNames = c => Object.fromEntries([...(c.tables || []), ...(c.tourneys || []), ...(c.promos?.list || [])].map(x => [x.id, x.name]));

// Club info for a member (#398): each section written, formatted.
function memberInfoHtml(m) {
  if (isEmpty(m.info)) return '<p class="pl-meta cl-empty">Nothing here yet.</p>';
  let h = '';
  for (const [k, name] of SECTIONS) {
    if (k === 'events') {
      const evs = (m.info.events || []).filter(e => e.at > Date.now() - 6 * 3600e3);
      if (evs.length) h += `<section class="cl-info"><h2>${name}</h2><ul class="mg-rows">${evs.map(e => `<li class="mg-row"><b>${esc(e.text)}</b><span class="mg-row-end">${esc(new Date(e.at).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}))}</span></li>`).join('')}</ul></section>`;
    } else if (m.info[k]) h += `<section class="cl-info"><h2>${name}</h2><div class="cl-info-text">${formatInfo(m.info[k])}</div></section>`;
  }
  return h;
}

// When this browser last saw each part of a club's info (#398): {section: time}.
const infoSeen = code => load(`ducyInfoSeen:${code}`, {});
function markInfoSeen(m) {
  const at = m.info?.at || {};
  const seen = infoSeen(m.code);
  if (Object.keys(at).every(k => (seen[k] || 0) >= at[k])) return;
  save(`ducyInfoSeen:${m.code}`, {...seen, ...at});
}

// What a member's club page shows in its main column (#193, #225, #398):
// a tab each. Remembered per club.
const MEMBER_TAB_NAMES = [['tables', 'Cash games'], ['tourneys', 'Tournaments'], ['info', 'Club info'], ['chips', 'My chips'], ['history', 'My hands']];
// An agent (#428) is a player with players of their own: Your players
// first, and open unless they've picked another tab.
const tabNamesFor = m => (m?.agent === 'yes' ? [['players', 'Your players'], ...MEMBER_TAB_NAMES] : MEMBER_TAB_NAMES);
const MEMBER_TABS = [...MEMBER_TAB_NAMES.map(([id]) => id), 'players'];
function memberTab(code) {
  const m = memberships.find(x => x.code === code);
  const tabs = tabNamesFor(m).map(([id]) => id);
  let t = '';
  try { t = localStorage.getItem(`ducyMemberTab:${code}`) || ''; } catch {}
  return tabs.includes(t) ? t : tabs[0];
}
function setMemberTab(code, t) {
  if (!MEMBER_TABS.includes(t)) return;
  try { localStorage.setItem(`ducyMemberTab:${code}`, t); } catch {}
}

// Sitting down (#404): only the amount being added and what's available
// (their own chips, then credit). With less than the minimum available,
// they sit with nothing and ask the manager from the table.
let sitForm = ''; // `${code}|${table}`
// Moved from another table (#425): the amount they left it with, offered first.
let sitAmount = 0;
function sitFormHtml(m, t, r) {
  const avail = availableIn(m);
  const hi = Math.min(r.max, avail);
  const value = sitAmount ? Math.max(r.min, Math.min(hi, sitAmount)) : hi;
  let h = `<form class="cl-sitform" data-sitform="1" data-code="${esc(m.code)}" data-table="${esc(t.id)}">`;
  if (hi >= r.min) h += `<label>Adding <input class="pl-text" name="amount" type="number" inputmode="decimal" required min="${chipInput(r.min)}" max="${chipInput(hi)}" step="${CHIP_STEP}" value="${chipInput(value)}"></label>`;
  h += `<div class="pl-avail"><span>Available</span><b>${chips(avail)}</b></div>`;
  return h + '<button class="btn-small primary" type="submit">Sit down</button><button class="btn-small" type="button" data-cl="sit-cancel">Cancel</button></form>';
}

// Must move (#501, #518): "We're starting a new table. Join?" until it
// closes, Yes or No (a no takes you off the list); once answered, what they
// said.
function groupAskHtml(m) {
  const a = m.groupAsk;
  if (!a) return '';
  const k = `data-code="${esc(m.code)}" data-group="${esc(a.group)}"`;
  let h = `<div class="cl-confirm cl-groupask"><b>We’re starting a new table. Join?</b> <span class="pl-meta">${esc(a.name)}</span>`;
  if (a.answer === 'yes') h += '<span class="pl-meta">Waiting for players</span>';
  else h += `<button class="btn-small primary" data-cl="group-yes" ${k}>Yes</button><button class="btn-small" data-cl="group-no" ${k}>No</button>`;
  return h + '</div>';
}

// A table's must-move tag (#518) from its group label ({main, to}), with
// " · " after it: "Main · ", "Must move → A or B · ", or ''.
const mustMoveTag = g => (!g ? '' : g.main ? 'Main · ' : `Must move → ${(g.to || []).join(' or ')} · `);

// A game's seats in words (#518): "Heads up", "6-max", "9-handed".
const seatsName = n => (n === 2 ? 'Heads up' : n === 6 ? '6-max' : `${n}-handed`);
// A game as players pick one: "Hold'em 1/2 · 9-handed".
const gameName = t => `${gameLabel(t.game)} ${blindsOf(t)} · ${seatsName(t.seats)}`;

// Seconds left until `at`, as m:ss.
const countdown = at => {
  const s = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// A seat offered from a waitlist (#518): the game, the time left, and Sit.
// Ticks while it's open.
let offerTick = null;
function offersHtml(m, hostHere) {
  const offers = (m.lists || []).filter(l => l.offer && l.offer.until > Date.now());
  if (offers.length && !offerTick) offerTick = setTimeout(() => { offerTick = null; render(); }, 1000);
  let h = '';
  for (const l of offers) {
    const t = (m.tables || []).find(x => x.id === l.offer.table);
    if (!t) continue;
    h += `<div class="cl-offer" role="status"><span><b>${esc(gameName(t))}</b><span class="pl-meta">Seat open · ${esc(t.name)}</span></span>`;
    h += `<span class="cl-offer-time">${countdown(l.offer.until)}</span>`;
    h += `<button class="btn-small primary" data-cl="offer-sit" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${hostHere ? '' : ' disabled'}>Sit</button></div>`;
  }
  return h;
}

// A game's row on a member's Tables tab (#518): its name, who's waiting,
// and the list: Join list, your place with Leave list, or I'm back after a
// missed offer.
function gameRowHtml(m, t, hostHere, open) {
  const key = t.key || gameKey(t);
  const mine = (m.lists || []).find(l => l.key === key);
  const count = m.listCounts?.[key] || 0;
  const k = `data-code="${esc(m.code)}" data-key="${esc(key)}"${hostHere ? '' : ' disabled'}`;
  let meta, act = '';
  if (mine?.missed) {
    meta = 'You missed your seat';
    act = mine.missed > Date.now() ? `<button class="btn-small primary" data-cl="list-back" ${k}>I’m back</button>` : '';
  } else if (mine?.offer) {
    meta = 'Seat open for you';
  } else if (mine) {
    meta = `You’re ${ordinal(mine.place)} of ${mine.count}`;
    act = `<button class="btn-small" data-cl="list-leave" ${k}>Leave list</button>`;
  } else {
    meta = count ? `${count} waiting` : open ? `${open} open` : 'Full';
    // A seat open and no one waiting: sit at a table below.
    if (!open || count) act = `<button class="btn-small primary" data-cl="list-join" ${k}>Join list</button>`;
  }
  return `<li class="cl-game-head"><span><b>${esc(gameName(t))}</b><span class="pl-meta${mine ? ' cl-mine' : ''}">${esc(meta)}</span></span>${act}</li>`;
}

const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

// The club's offered games that aren't running (its menu): a row each, with
// how many are interested and Join list, saying the fewest you'd start a
// table with; once on it, Leave list. A table opens when enough say yes.
function menuGamesHtml(m, hostHere) {
  const games = (m.menu || []).filter(g => !(m.tables || []).some(t => (t.key || '') === g.key));
  if (!games.length) return '';
  let h = '<h3 class="cl-menu-head">More games</h3><ul class="cl-tables cl-tcards">';
  for (const g of games) {
    const mine = (m.lists || []).find(l => l.key === g.key);
    const count = m.listCounts?.[g.key] || 0;
    const k = `data-code="${esc(m.code)}" data-key="${esc(g.key)}"${hostHere ? '' : ' disabled'}`;
    let meta = count ? `${count} interested` : 'No one yet', act;
    if (mine) {
      meta = `You’re in · ${count} interested${mine.min ? ` · start with ${mine.min}+` : ''}`;
      act = `<button class="btn-small" data-cl="list-leave" ${k}>Leave list</button>`;
    } else {
      const opts = [`<option value="">Full table</option>`];
      for (let n = g.seats - 1; n >= 2; n--) opts.push(`<option value="${n}">${n}+</option>`);
      act = `<span class="cl-join-min"><label><span class="v3-sr">Start with</span><select class="pl-text" data-minfor="${esc(g.key)}" aria-label="Start with">${opts.join('')}</select></label>`;
      act += `<button class="btn-small primary" data-cl="list-join" ${k}>Join list</button></span>`;
    }
    h += `<li class="cl-game-head"><span><b>${esc(gameName(g))}</b><span class="pl-meta${mine ? ' cl-mine' : ''}">${esc(meta)}</span></span>${act}</li>`;
  }
  return h + '</ul>';
}

// A member's Tables tab: their last session while it's recent (#187), and
// the open tables with Sit, or why not.
// A member's stakes filter on each club's Tables tab, by club code.
const memberStakes = new Map();

function memberTablesHtml(m, hostHere) {
  let h = offersHtml(m, hostHere) + groupAskHtml(m);
  const last = tableSessions(m.entries || []).find(s => !s.open);
  if (last && Date.now() - last.end < 24 * 3600e3) {
    const where = (m.tables || []).find(t => t.id === last.table)?.name || 'a table';
    const net = last.net > 0 ? `+${chips(last.net)}` : signed(last.net);
    h += `<p class="pl-desc cl-last">Last session at ${esc(where)}: in ${chips(last.put)}, out ${chips(last.took)} → <b class="${last.net > 0 ? 'cl-up' : last.net < 0 ? 'cl-down' : ''}">${net}</b></p>`;
  }
  // Scheduled games (#599), then games the club offers that aren't running.
  h += upcomingHtml(m, hostHere, {gameName, render});
  const menu = menuGamesHtml(m, hostHere);
  if (!m.tables?.length) return h + (menu || `<p class="pl-meta cl-empty">No tables open right now. <button class="btn-small" data-cl="help-open" data-code="${esc(m.code)}"${hostHere ? '' : ' disabled'}>Ask for one</button></p>`);
  // Filter by stakes, when the club deals more than one band.
  const band = t => t.stakes || stakesBand(t.bb);
  const bands = STAKES.filter(s => m.tables.some(t => band(t) === s));
  let only = memberStakes.get(m.code) || '';
  if (!bands.includes(only)) only = '';
  h += stakesFilterHtml(bands, only, m.code);
  // A card per table (V3 Club home, #225): cream when there's a seat for you.
  // Grouped by game, each with its waitlist (#518).
  h += '<ul class="cl-tables cl-tcards">';
  const keyOf = t => t.key || gameKey(t);
  const order = [...new Set(m.tables.map(keyOf))];
  const tables = m.tables.filter(t => !only || band(t) === only).sort((a, b) => order.indexOf(keyOf(a)) - order.indexOf(keyOf(b)));
  let lastKey = null;
  for (const t of tables) {
    if (keyOf(t) !== lastKey) {
      lastKey = keyOf(t);
      const open = tables.filter(x => keyOf(x) === lastKey).reduce((n, x) => n + Math.max(0, x.seats - x.taken), 0);
      h += gameRowHtml(m, t, hostHere, open);
    }
    const here = seatedAt?.code === m.code && seatedAt.table === t.id;
    // The buy-in you'd need here, the rathole rule included (#187).
    const r = buyInRange(t, m.entries || [], m.rathole || 0);
    const free = t.seats - t.taken;
    // Why you can't sit, when you can't (#187).
    const atOther = seatedAt && !here ? (seatedAt.code === m.code ? (m.tables.find(x => x.id === seatedAt.table)?.name || 'another table') : 'another club’s table') : '';
    // At another of this club's cash tables: Move here instead (#425).
    const canMove = atOther && seatedAt.code === m.code && !seatedAt.table.startsWith('tourney:');
    const held = canMove && seatedAt.reserve?.table === t.id;
    // Must move (#501, #518): a main table, or the tables it feeds.
    const place = mustMoveTag(t.group);
    if (canMove && hostHere && (free > 0 || held)) {
      h += `<li class="cl-tcard cream"><span class="cl-tcard-text"><b class="cl-name">${esc(t.name)}</b>`;
      h += `<span class="cl-tcard-meta">${place}${esc(gameLabel(t.game))} · ${blindsOf(t)} · ${t.taken} of ${t.seats} seats · ${free > 0 ? `${free} open` : 'full'}</span>`;
      h += `<span class="cl-tcard-meta">Buy-in ${chips(r.min)}–${chips(r.max)}</span></span>`;
      h += held ? '<span class="pl-meta cl-why">Seat held · after this hand</span>'
        : `<button class="btn-small primary" data-cl="move-here" data-code="${esc(m.code)}" data-table="${esc(t.id)}">Move here</button>`;
      h += '</li>';
      continue;
    }
    const why = !hostHere ? 'Can’t reach the club right now' : atOther ? `You’re at ${atOther}: leave it first` : free <= 0 ? 'Full' : '';
    h += `<li class="cl-tcard${here || !why ? ' cream' : ''}"><span class="cl-tcard-text"><b class="cl-name">${esc(t.name)}</b>`;
    h += `<span class="cl-tcard-meta">${place}${esc(gameLabel(t.game))} · ${blindsOf(t)} · ${t.taken} of ${t.seats} seats · ${free > 0 ? `${free} open` : 'full'}</span>`;
    h += `<span class="cl-tcard-meta">Buy-in ${chips(r.min)}–${chips(r.max)}</span>`;
    // Rake or time (#449), before you sit.
    if (chargeText(t)) h += `<span class="cl-tcard-meta cl-charge">${esc(chargeText(t))}</span>`;
    h += '</span>';
    if (r.rathole && r.rathole > t.min) h += `<span class="pl-meta cl-why">You left this table with ${chips(r.rathole)} less than ${m.rathole} h ago, so you buy back in with at least that.</span>`;
    // The hit-and-run rule, before you sit.
    if (t.stayHands > 0) h += `<span class="pl-meta cl-why">Call time ${t.stayHands} hands: once you’re up here, you play them before you can leave.</span>`;
    if (here) h += '<button class="btn-small primary" data-cl="to-table">Back to the table</button>';
    else if (sitForm === `${m.code}|${t.id}` && !why) h += sitFormHtml(m, t, r);
    else {
      if (free > 0 || why !== 'Full') h += `<button class="btn-small primary" data-cl="sit-open" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${why ? ` disabled title="${esc(why)}"` : ''}>Sit down</button>`;
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
  return h + '</ul>' + menu;
}

// ---- an agent's tools (#74, #75, #76) ----

let agentForm = null; // {code, kind: 'give' | 'take' | 'grant', id}

async function agentCmd(code, cmd) {
  const mem = memberships.find(m => m.code === code);
  if (mem) mem.adminNote = '';
  // An agent's commands move chips: a recent passkey unlock (#575).
  const no = await freshPass();
  if (no) { note = no; render(); return; }
  sendToHost(code, {type: 'agent_cmd', club: code, cmd});
}

function agentFormHtml(code, x) {
  if (agentForm?.code !== code || agentForm.id !== x.id) return '';
  const {kind} = agentForm;
  // A Credit player's line (#621): 0 for none.
  if (kind === 'credit') {
    let h = `<form class="cl-chipform" data-agentform="credit" data-code="${esc(code)}" data-id="${esc(x.id)}">`;
    h += `<label class="cl-formlabel" for="cl-gamt">Credit line for ${esc(x.name)}</label>`;
    h += `<input class="pl-text" id="cl-gamt" name="amount" type="number" inputmode="decimal" required min="0" step="${CHIP_STEP}" value="${esc(chipInput(x.credit || 0))}">`;
    return h + '<button class="btn-small primary" type="submit">Save</button><button class="btn-small" type="button" data-cl="cancel-gform">Cancel</button></form>';
  }
  const label = kind === 'take' ? `Take back from ${x.name} (has ${chips(x.balance)})`
    : kind === 'grant' ? `Give ${x.name} (asked for ${chips(x.request?.amount)})` : `Give ${x.name}`;
  const value = kind === 'take' ? x.balance : kind === 'grant' ? x.request?.amount : '';
  let h = `<form class="cl-chipform" data-agentform="${kind}" data-code="${esc(code)}" data-id="${esc(x.id)}">`;
  h += `<label class="cl-formlabel" for="cl-gamt">${esc(label)}</label>`;
  h += `<input class="pl-text" id="cl-gamt" name="amount" type="number" inputmode="decimal" required min="0.01" step="${CHIP_STEP}"${kind === 'take' ? ` max="${chipInput(x.balance)}"` : ''} value="${esc(amountValue(value))}" placeholder="Chips">`;
  if (kind !== 'grant') h += `<input class="pl-text" name="note" maxlength="${MAX_NOTE}" placeholder="Note (optional)">`;
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

// An agent's players and the chips they move to and from them (#74–#76).
// On the player app it's their club page's Your players tab (#428, `page`:
// the page shows their balance already); on the club manager, under Manage.
function agentHtml(m, hostHere, {page = false} = {}) {
  const a = m.agentView;
  let h = `<div class="cl-account cl-admin cl-agent${page ? ' cl-agent-page' : ''}">`;
  if (!hostHere) h += `<span class="pl-meta">${UNREACHABLE}</span>`;
  if (m.adminNote) h += `<span class="pl-neterr">${esc(m.adminNote)}</span>`;
  if (!a) return h + '<span class="pl-meta">Loading…</span></div>';
  const dis = hostHere ? '' : ' disabled';
  // Your account in this club (#428): what you can give your players now
  // (your balance plus your credit, up to your limit), your balance, what
  // you'd owe the club if your players stood up now, and your credit limit.
  const owed = a.owed ?? a.creditUsed;
  const stat = (label, val, cls = '') => `<div class="mg-stat"><span class="mg-stat-label">${label}</span><span class="mg-stat-val${cls}">${val}</span></div>`;
  h += '<div class="mg-stats cl-agent-stats">';
  h += stat('Available', chips(Math.max(0, a.room)));
  if (!page) h += stat('Your balance', signed(a.own), a.own < 0 ? ' cl-down' : '');
  h += stat('Owed', chips(owed), owed ? ' cl-down' : '');
  h += stat('Credit limit', a.limit ? chips(a.limit) : 'None');
  h += '</div>';
  // Close to the limit: say so before a give fails (#190).
  if (a.limit && a.room <= 0.2 * a.limit) h += '<span class="pl-neterr">Near your credit limit</span>';
  h += `<div class="pl-row"><span class="pl-label">Your link</span><div class="pl-opts cl-link"><input class="pl-text" readonly value="${esc(agentLink(m))}" data-aglink="${esc(m.code)}"><button class="btn-small" data-cl="ag-copy" data-code="${esc(m.code)}">Copy</button></div></div>`;
  const btn = (act, x, label, extra = '') => `<button class="btn-small${extra}" data-cl="${act}" data-code="${esc(m.code)}" data-id="${esc(x.id)}"${dis}>${label}</button>`;
  if (a.recruits.length) {
    h += `<span class="pl-meta">Asking to join through you (${a.recruits.length})</span><ul class="cl-list">`;
    for (const x of a.recruits) {
      const to = `a|${m.code}|${x.id}`;
      h += `<li><span class="cl-name">${esc(x.name)}</span><code>${esc(showId(x.id))}</code>`;
      h += letIn === to ? letInHtml(to, dis) : `<span class="cl-acts">${btn('ag-approve', x, 'Let in', ' primary')}${btn('ag-decline', x, 'Decline')}</span>`;
      h += `${agentThreadHtml(m, x, dis)}</li>`;
    }
    h += '</ul>';
  }
  if (!page) h += `<span class="pl-meta">Your players (${a.players.length})</span>`;
  if (!a.players.length) h += '<span class="pl-meta">No players yet. Send someone your link.</span>';
  else {
    h += '<ul class="cl-list">';
    // New players first (#621): let in, no chips or credit yet.
    for (const x of [...a.players].sort((p, q) => !!q.new - !!p.new)) {
      h += `<li${x.new ? ' class="cl-new-row"' : ''}><span class="cl-name">${esc(x.name)}${x.new ? ' <span class="cl-new">New</span>' : ''}</span><span class="cl-chips">${signed(x.balance)}</span>`;
      // Their vault (#579): its chips, which a take back can reach after the balance.
      if (x.vault) h += `<span class="pl-meta">vault ${chips(x.vault)}</span>`;
      // Their credit limit (#633).
      if (x.credit) h += `<span class="pl-meta cl-credit">credit limit ${chips(x.credit)}</span>`;
      // At a table (#428): which, and their stack there.
      if (x.seated) h += `<span class="cl-at">${esc(x.table || 'At a table')}${x.stack != null ? ` · ${chips(x.stack)}` : ''}</span>`;
      // How they've done at the tables (#190).
      if (x.result) h += `<span class="${x.result > 0 ? 'cl-up' : 'cl-down'}" title="Won or lost over finished table sessions">${signed(x.result, true)} at the tables</span>`;
      if (x.request) h += `<span class="pl-meta">asks for ${chips(x.request.amount)}</span>`;
      h += '<span class="cl-acts">';
      h += x.request ? `${btn('ag-grant', x, 'Give', ' primary')}${btn('ag-deny', x, 'Decline')}` : btn('ag-give', x, 'Give');
      h += `${btn('ag-take', x, 'Take back')}${btn('ag-credit', x, 'Credit')}</span>${agentFormHtml(m.code, x)}`;
      if (x.new) h += agentThreadHtml(m, x, dis);
      h += '</li>';
    }
    h += '</ul>';
  }
  // Their players' rake and time (#449).
  if (page) h += contributionsHtml(a.rake, {agent: true});
  return h + '</div>';
}

// A player's thread with their agent (#621), on the agent's list.
function agentThreadHtml(m, x, dis) {
  if (!x.thread?.length) return '';
  return threadHtml(x.thread.map(n => ({mine: !n.player, who: n.player ? x.name : 'You', text: n.text, at: n.at})), `a|${m.code}|${x.id}`, {dis});
}

// The tools when the club can't be reached (#190): with always-on clubs,
// that's the connection, not the host being away.
const UNREACHABLE = 'Can’t reach the club right now: these work again once it’s back.';

// What each role may and may not do (#190), for the offer and for the host
// making it.
const ROLE_TEXT = {
  agent: {
    name: 'agent',
    can: ['bring in your own players with your own invite link', 'give your players chips from your balance, on credit up to your limit', 'take chips back from them and answer their requests'],
    cannot: ['create chips, or act for members who aren’t your players'],
    note: 'Chips are play money with no cash value. Don’t use ducy to play for money.',
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
  return h + `<span class="pl-meta">${esc(r.note)}</span></div>`;
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

async function onClickIn(e) {
  // The blind structure editor in the New tournament wizard redraws itself.
  const ed = tourneyForm && e.target.closest('[data-tseditor]');
  if (ed && tourneyForm.editor.click(e)) { ed.innerHTML = tourneyForm.editor.html(); return; }
  // Going to another page closes the drawer and notifications on a phone (#398).
  if (e.target.closest('a[href^="#"]') && (navOpen || notesOpen)) {
    navOpen = notesOpen = false;
    // Not a redraw: the link has yet to be followed.
    root.querySelector('.mg-shell')?.classList.remove('nav-open', 'notes-open');
  }
  // The replayer's own controls (replayer.js).
  if (replay.click(e.target.closest('[data-rp]'))) return;
  const b = e.target.closest('[data-cl]');
  if (!b) return;
  const act = b.dataset.cl;
  // Asks first, in its place (#544): the yes goes on.
  if (act === 'ask-no') { const k = asking; asking = ''; render(); byKey(k)?.focus(); return; }
  if (b.dataset.ask && !b.dataset.sure) { asking = ctlKey(b); render(); root.querySelector('[data-cl="ask-no"]')?.focus(); return; }
  if (b.dataset.sure) asking = '';
  // A ⋯ menu stays open over redraws (#544), until one of its items is picked.
  if (b.classList.contains('cl-menu-item') || b.closest('.cl-menu-items')) b.closest('details')?.removeAttribute('open');
  if (act === 'create') createClub(root.querySelector('#cl-clubname')?.value);
  else if (act === 'demo') showDemoList();
  else if (act === 'restore-pick') root.querySelector('[data-clrestore]')?.click();
  // Another page of Members (#426) starts at its top.
  else if (act === 'mpage') window.scrollTo(0, 0);
  else if (act === 'mtab') { setMemberTab(b.dataset.code, b.dataset.tab); render(); }
  // The manager's sidebar drawer and notifications on a phone (#398).
  // Opened, the focus goes in; closed, back to the button (#544).
  else if (act === 'mg-nav') { navOpen = !navOpen; notesOpen = false; render(); if (navOpen) root.querySelector('.mg-side a')?.focus(); }
  else if (act === 'mg-notes') { notesOpen = !notesOpen; navOpen = false; render(); if (notesOpen) root.querySelector('.mg-notes button')?.focus(); }
  else if (act === 'mg-close') closeDrawer();
  // Notifications' quick actions (#398).
  else if (act === 'note-open') { noteForm = b.dataset.key; render(); root.querySelector('.mg-notes form[data-noteform] input, .mg-notes form[data-threadform] input, form[data-noteform] input')?.focus(); }
  else if (act === 'note-cancel') { noteForm = ''; render(); }
  else if (act === 'left-done') { leftPanels.delete(b.dataset.code); render(); }
  // Passkeys (#575): make one, unlock, or bring an account back with one.
  else if (act === 'pass-enrol' || act === 'pass-unlock' || act === 'pass-recover') passAct(act.slice(5));
  // A member's Back up card (#562).
  else if (act === 'member-backup') { memberBackup = {form: true}; render(); root.querySelector('form[data-clform="member-backup"] [name=pw]')?.focus(); }
  else if (act === 'member-backup-cancel' || act === 'member-backup-done') { memberBackup = null; render(); }
  else if (act === 'sit-open') { sitForm = `${b.dataset.code}|${b.dataset.table}`; sitAmount = 0; render(); root.querySelector('form[data-sitform] input')?.select(); }
  else if (act === 'sit-cancel') { sitForm = ''; sitAmount = 0; render(); }
  // Grouped tables (#501): the answer to "We're starting a new table. Join?".
  else if (act === 'group-yes' || act === 'group-no') {
    const mem = memberships.find(m => m.code === b.dataset.code);
    const yes = act === 'group-yes';
    sendToHost(b.dataset.code, {type: 'table', club: b.dataset.code, table: `group:${b.dataset.group}`, cmd: {type: 'group_answer', group: b.dataset.group, yes}});
    if (mem?.groupAsk) {
      if (yes) mem.groupAsk.answer = 'yes';
      else mem.groupAsk = null;
    }
    render();
  }
  // Moving from your table to this one (#425): a seat is held here.
  else if (act === 'move-here') { b.disabled = true; sendToHost(b.dataset.code, {type: 'table', club: b.dataset.code, table: b.dataset.table, cmd: {type: 'reserve'}}); }
  // A game's waitlist (#518): joining, leaving, back after a missed seat.
  else if (act === 'list-join' || act === 'list-leave' || act === 'list-back') {
    b.disabled = true;
    const type = {'list-join': 'join_list', 'list-leave': 'leave_list', 'list-back': 'list_back'}[act];
    // An offered game that isn't running: the fewest you'd start with.
    const min = Number(b.closest('li')?.querySelector('select[data-minfor]')?.value) || null;
    sendToHost(b.dataset.code, {type: 'table', club: b.dataset.code, table: `list:${b.dataset.key}`, cmd: {type, ...(min ? {min} : {})}});
  }
  // The seat offered: at another of the club's tables, move to it; else sit.
  else if (act === 'offer-sit') {
    const {code, table} = b.dataset;
    if (seatedAt?.code === code && !seatedAt.table.startsWith('tourney:')) {
      b.disabled = true;
      sendToHost(code, {type: 'table', club: code, table, cmd: {type: 'reserve'}});
    } else { sitForm = `${code}|${table}`; sitAmount = 0; render(); root.querySelector('form[data-sitform] input')?.select(); }
  }
  else if (act === 'deny-now') hostAct('deny', {id: b.dataset.id});
  else if (act === 'notes-clear') { setHostNote('cleared', [...clearedNotes(), ...clearableKeys(notices())].slice(-300)); render(); }
  // Overview's numbers open Members, filtered.
  // Members with a filter (#426: in the address), from the Overview or on
  // Members, in the order it has, from the first page.
  else if (act === 'msearch-clear') {
    memberQuery = '';
    const to = ph('members', '', {sort: managerPage(location.hash)?.sort});
    if (location.hash.slice(1) !== to) location.hash = to; else render();
    root.querySelector('[data-msearch]')?.focus();
  }
  else if (act === 'mfilter') location.hash = ph('members', '', {show: b.dataset.f});
  else if (act === 'mfilter-here') location.hash = ph('members', '', {sort: managerPage(location.hash)?.sort, show: b.dataset.f});
  // High Hand promotions (#278).
  else if (act === 'promo-new') { promoForm = 'new'; promoNote = ''; render(); }
  else if (act === 'promo-edit') { promoForm = b.dataset.id; promoNote = ''; render(); }
  else if (act === 'promo-cancel') { promoForm = null; promoNote = ''; render(); }
  else if (act === 'promo-status') {
    if (b.dataset.status === 'ended' && !confirm('End this promotion? A period under way pays out as usual at its end.')) return;
    hostAct('promo_status', {id: b.dataset.id, status: b.dataset.status});
  } else if (act === 'promo-approve') hostAct('approve_award', {id: b.dataset.id});
  // Voiding a prize asks why, in its row (#544).
  else if (act === 'promo-void') { voiding = b.dataset.id; render(); root.querySelector('form[data-voidform] input')?.focus(); }
  else if (act === 'void-cancel') { voiding = ''; render(); }
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
  else if (act === 'wiz-done') { setWizard(null); location.hash = 'clubs/overview'; }
  else if (act === 'share') { setHostNote('shared', true); navigator.share?.({title: club?.name || 'ducy club', text: `Join ${club?.name || 'my club'} on ducy`, url: link()}).catch(() => {}); render(); }
  // Let in: Cash or Credit first (#621).
  else if (act === 'approve') { letIn = `o|${b.dataset.id}`; render(); }
  else if (act === 'letin-cancel') { letIn = ''; render(); }
  else if (act === 'backup-nag-hide') { setHostNote('backupNagHidden', true); render(); }
  else if (act === 'close-table-yes') { closingTable = null; hostAct('close_table', {table: b.dataset.table}); render(); }
  else if (act === 'close-table-no') { closingTable = null; render(); }
  else if (act === 'decline') hostAct('decline', {id: b.dataset.id});
  else if (act === 'remove') hostAct('remove', {id: b.dataset.id});
  else if (act === 'revoke') { if (confirm('Make a new invite link? The current link stops working for anyone who hasn’t used it yet.')) hostAct('revoke_invite'); }
  else if (act === 'copy') {
    try { await navigator.clipboard.writeText(link()); } catch { root.querySelector('#cl-link')?.select(); }
    copied = true;
    setHostNote('shared', true);
    render();
    setTimeout(() => { copied = false; render(); }, 1500);
  } else if (act === 'close') closeClub(b);
  else if (act === 'delete-always') deleteAlwaysOn();
  else if (act === 'attach') attachAlwaysOn(root.querySelector('#cl-attach')?.value);
  else if (act === 'forget') leaveMembership(b.dataset.code);
  else if (act === 'setname') setName(root.querySelector('#cl-myname')?.value);
  else if (act === 'reconnect-owner') { note = ''; owner.start(); render(); }
  else if (act === 'retry') { const m = memberships.find(x => x.code === b.dataset.code); if (m) { m.error = ''; connectMembership(m); render(); } }
  else if (act === 'give') openChipForm('give', b.dataset.id);
  else if (act === 'take') openChipForm('take', b.dataset.id);
  else if (act === 'paid') openChipForm('paid', b.dataset.id);
  else if (act === 'grant-other') openChipForm('grant', b.dataset.id);
  else if (act === 'cancel-form') { chipForm = null; render(); }
  else if (act === 'grant') { chipForm = null; hostAct('grant', {id: b.dataset.id}); }
  else if (act === 'deny') openChipForm('deny', b.dataset.id);
  else if (act === 'ledger-csv') exportLedger();
  else if (act === 'quick') { const f = b.closest('form'); if (f?.elements.amount) f.elements.amount.value = b.dataset.v; }
  else if (act === 'rathole') hostAct('settings', {ratholeHours: Number(b.dataset.hours)});
  else if (act === 'sitout-mins') hostAct('settings', {sitOutMins: Number(b.dataset.mins)});
  else if (act === 'call-time') hostAct('settings', {stayHands: Number(b.dataset.hands)});
  // The owner's float (#589).
  else if (act === 'refill') hostAct('refill', {});
  // A member's vault (#579): a take-out cancelled, or the wait.
  else if (act === 'vault-cancel') vaultAct(b, 'cancel', {out: Number(b.dataset.out)});
  else if (act === 'vault-wait') vaultAct(b, 'wait', {wait: Number(b.dataset.wait)});
  else if (act === 'code-join') hostAct('settings', {codeJoin: b.dataset.on === '1'});
  else if (act === 'let-all-in') hostAct('settings', {letAllIn: b.dataset.on === '1'});
  else if (act === 'new-table') { tableForm = true; render(); root.querySelector('form[data-tableform] [name=name]')?.focus(); }
  else if (act === 'cancel-table') { tableForm = false; render(); }
  // The club's menu: offering a game, and no longer offering one.
  else if (act === 'offer-game') { tableForm = 'offer'; render(); }
  else if (act === 'offer-remove') hostAct('remove_offer', {key: b.dataset.key});
  // Scheduled games (#599): a member's sign-up, leaving and check-in; the
  // owner's form, Cancel and Start short.
  else if (act === 'sched-act') { b.disabled = true; sendToHost(b.dataset.code, {type: 'table', club: b.dataset.code, table: `sched:${b.dataset.id}`, cmd: {type: b.dataset.type}}); }
  else if (act === 'sched-new' || act === 'sched-edit') { schedForm = {id: b.dataset.id || '', note: ''}; render(); root.querySelector('form[data-schedform] input[name=at]')?.focus(); }
  else if (act === 'sched-close') { schedForm = null; render(); }
  else if (act === 'sched-cancel') hostAct('cancel_scheduled', {id: b.dataset.id});
  else if (act === 'sched-start') hostAct('start_scheduled', {id: b.dataset.id});
  // The host: agents.
  else if (act === 'make-agent') openChipForm('agent', b.dataset.id);
  else if (act === 'revoke-agent') hostAct('revoke_agent', {id: b.dataset.id});
  // A member: answering an agent offer.
  else if (act === 'agent-yes' || act === 'agent-no') sendToHost(b.dataset.code, {type: 'agent_reply', club: b.dataset.code, accept: act === 'agent-yes'});
  // An agent's tools.
  else if (['ag-give', 'ag-take', 'ag-grant', 'ag-credit'].includes(act)) {
    const kind = act.slice(3);
    agentForm = agentForm?.id === b.dataset.id && agentForm.kind === kind ? null : {code: b.dataset.code, kind, id: b.dataset.id};
    render();
    root.querySelector('#cl-gamt')?.focus();
  } else if (act === 'cancel-gform') { agentForm = null; render(); }
  else if (act === 'ag-deny') agentCmd(b.dataset.code, {op: 'deny', id: b.dataset.id});
  else if (act === 'ag-approve') { letIn = `a|${b.dataset.code}|${b.dataset.id}`; render(); }
  else if (act === 'ag-decline') agentCmd(b.dataset.code, {op: 'decline', id: b.dataset.id});
  else if (act === 'ag-copy') {
    const v = root.querySelector(`[data-aglink="${b.dataset.code}"]`)?.value || '';
    try { await navigator.clipboard.writeText(v); } catch { root.querySelector(`[data-aglink="${b.dataset.code}"]`)?.select(); }
  }
  // Help requests (#192).
  else if (act === 'help-open') { helpForm = b.dataset.code; render(); root.querySelector(`form[data-helpform] [name=text]`)?.focus(); }
  else if (act === 'help-cancel') { helpForm = null; render(); }
  else if (act === 'myname') { nameForm = b.dataset.code; render(); root.querySelector('form[data-nameform] input')?.focus(); }
  else if (act === 'myname-cancel') { nameForm = ''; render(); }
  else if (act === 'help-done') answerHelpReq(b.dataset.id, b.closest('form')?.elements.reply?.value || '', true);
  else if (act === 'close-table') { closingTable = b.dataset.table; render(); }
  // The Tables page (#518): the board's filter, order and rows; a game
  // opened; another table like its first; its list; its Must move dialog.
  else if (act === 'seat-filter') { seatFilter = Number(b.dataset.n) || 0; render(); }
  // Stakes: the manager's board, or a member's Tables tab (by club).
  else if (act === 'stakes-filter') {
    if (b.dataset.code) memberStakes.set(b.dataset.code, b.dataset.s || '');
    else stakesFilter = b.dataset.s || '';
    render();
  }
  else if (act === 'board-sort') { boardSort = boardSort === b.dataset.k ? '' : b.dataset.k; render(); }
  else if (act === 'board-row') {
    if (openRows.has(b.dataset.key)) openRows.delete(b.dataset.key); else openRows.add(b.dataset.key);
    render();
  } else if (act === 'game-open') { openGame = b.dataset.key; mustMoveForm = ''; render(); window.scrollTo(0, 0); }
  else if (act === 'game-close') { openGame = ''; mustMoveForm = ''; render(); }
  else if (act === 'game-open-table') {
    // Like its first table, or, not running, as the club offers it.
    const t = openTables(club).find(x => gameKey(x) === b.dataset.key) || (club.menu || []).find(x => x.key === b.dataset.key);
    if (t) hostAct('new_table', {table: {game: t.game, sb: t.sb, bb: t.bb, ante: t.ante || 0, minBB: t.minBB, maxBB: t.maxBB, seats: t.seats, turnSecs: t.turnSecs, sitOutMins: t.sitOutMins, stayHands: t.stayHands, charge: t.charge ?? null}});
  } else if (act === 'list-remove') hostAct('list_remove', {key: b.dataset.key, id: b.dataset.id});
  else if (act === 'mm-edit') { mustMoveForm = b.dataset.key; render(); }
  else if (act === 'mm-cancel') { mustMoveForm = ''; render(); }
  else if (act === 'watch') watchTable(b.dataset.table);
  else if (act === 'seat-remove' || act === 'seat-keep') {
    hostAct(act === 'seat-keep' ? 'keep_player' : 'remove_player', {table: b.dataset.table, id: b.dataset.id});
  }
  // Hand history and the replayer.
  else if (act === 'hands') toggleHistory(b.dataset.code, b.dataset.who);
  else if (act === 'replay') openReplay(b.dataset.id, b.dataset.list);
  else if (act === 'promo-replay') openPromoReplay(b.dataset.code, b.dataset.who, b.dataset.hand, b);
  else if (act === 'keep-days') { hostAct('settings', {keepDays: Number(b.dataset.days)}); prune(club.code, 'host', {days: club.keepDays}).then(() => loadHands(club.code, 'host')); render(); }
  else if (act === 'keep-hands') { try { localStorage.setItem(KEEP_KEY, b.dataset.n); } catch {} for (const m of memberships) prune(m.code, me.id, {keep: keepHands()}); render(); }
  else if (act === 'sit') sitAt(b.dataset.code, b.dataset.table);
  // Tournaments: the host's.
  else if (act === 'new-tourney') {
    openWizard(newDraft(load(TOURNEY_KEY, {})));
    root.querySelector('form[data-tourneyform] [name=name]')?.focus();
  } else if (act === 'cancel-tourney-form') {
    // ✕ on a draft with something entered asks first (#544).
    const f = root.querySelector('form[data-tourneyform]');
    if (tourneyForm && f) readStep(f, tourneyForm.d, tourneyForm.step, {strict: false});
    if (tourneyForm && (payTable || draftKey(tourneyForm.d, tourneyForm.editor.steps()) !== tourneyForm.start)) { tourneyForm.discard = true; render(); root.querySelector('[data-cl="tw-keep"]')?.focus(); }
    else { tourneyForm = null; payTable = null; render(); }
  } else if (act === 'tw-discard') { tourneyForm = null; payTable = null; render(); }
  else if (act === 'tw-keep') { if (tourneyForm) tourneyForm.discard = false; render(); }
  // The wizard's steps: back one, or to one already done.
  else if (act === 'tw-back' || act === 'tw-go') {
    const f = root.querySelector('form[data-tourneyform]');
    if (tourneyForm && f) readStep(f, tourneyForm.d, tourneyForm.step, {strict: false});
    if (tourneyForm) { tourneyForm.step = act === 'tw-back' ? Math.max(1, tourneyForm.step - 1) : Number(b.dataset.step); tourneyForm.note = ''; }
    payTable = null;
    render();
  }
  // A tournament of a series (#477): this one, or the whole series?
  else if (act === 't-ask') { tAsk = {id: b.dataset.id, act: b.dataset.act}; render(); }
  else if (act === 't-ask-close') { tAsk = null; render(); }
  // A running tournament's payouts, once the change is confirmed (#544).
  else if (act === 'pay-yes') { payAsk = null; hostAct('set_payout_table', {id: b.dataset.id, table: b.dataset.table || null}); }
  else if (act === 'pay-no') { payAsk = null; render(); }
  else if (act === 't-edit') {
    const t = tourneyById(club, b.dataset.id);
    const se = b.dataset.series === '1' && t?.series ? (club.tourneySeries || []).find(s => s.id === t.series) : null;
    if (t) openWizard(tourneyDraft(t, se), {id: t.id, series: !!se, startsAt: t.startsAt}, t.structure);
  } else if (act === 'series-edit') {
    const se = (club.tourneySeries || []).find(s => s.id === b.dataset.id);
    if (se) {
      const s = se.settings || {};
      openWizard(tourneyDraft({...s, startsAt: se.next, opensAt: se.next - se.opensBefore}, se), {sid: se.id, series: true}, s.structure);
    }
  } else if (act === 't-cancel') {
    const whole = b.dataset.series === '1';
    if (confirm(whole ? 'Cancel this tournament and the rest of its series? Every buy-in goes back to the players.' : 'Cancel this tournament? Every buy-in goes back to the players.')) {
      tAsk = null;
      hostAct('cancel_tourney', {id: b.dataset.id, series: whole});
    }
  } else if (act === 'series-stop') { if (confirm('Cancel the rest of this series?')) hostAct('stop_series', {id: b.dataset.id}); }
  else if (act === 'cancel-tourney') { if (confirm('Cancel this tournament? Every buy-in goes back to the players.')) hostAct('cancel_tourney', {id: b.dataset.id}); }
  // The club's payout tables (#424): a new one, editing one (its rows and
  // places), deleting one.
  else if (act === 'paytable-new') {
    const f = root.querySelector('form[data-tourneyform]');
    if (tourneyForm && f) readStep(f, tourneyForm.d, tourneyForm.step, {strict: false});
    payTable = {id: 'new', name: '', draft: draftOf()};
    render();
  }
  else if (act === 'paytable-edit') { const p = payoutTableById(club, b.dataset.id); payTable = p ? {id: p.id, name: p.name, draft: draftOf(p.rows)} : null; render(); }
  else if (act === 'paytable-cancel') { payTable = null; render(); }
  else if (act === 'paytable-delete') { const p = payoutTableById(club, b.dataset.id); if (p && confirm(`Delete the payout table ${p.name}?`)) hostAct('delete_payout_table', {id: p.id}); }
  else if (payTable && (act === 'prow-add' || act === 'prow-remove' || act === 'pcol-add')) {
    if (act === 'prow-add') addRow(payTable.draft);
    else if (act === 'pcol-add') addPlace(payTable.draft);
    else removeRow(payTable.draft, Number(b.dataset.i));
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
    if (!Number.isSafeInteger(amount) || amount <= 0) { failAt(b, 'Enter an amount above 0, like 50 or 12.50.'); return; }
    // Asking for chips needs a recent passkey unlock (#575).
    const no = await freshPass();
    if (no) { failAt(b, no); return; }
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

// Closes the manager's drawer or notifications on a phone (#398), the focus
// back on the button that opened it (#544).
function closeDrawer() {
  const opener = navOpen ? '.mg-burger' : notesOpen ? '.mg-bell' : '';
  navOpen = notesOpen = false;
  render();
  if (opener) document.querySelector(opener)?.focus();
}

// The replayer's keys: ← → step, Space plays, Esc closes. Esc closes the
// manager's drawer and notifications too (#544).
function onDocKey(e) {
  if (e.key === 'Escape' && !replay.isOpen && (navOpen || notesOpen)) { closeDrawer(); return; }
  if (open) replay.key(e);
}

function onFilterIn(e) {
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
  owner?.stop();
  for (const n of playerNets.values()) n.net?.close();
  playerNets.clear();
}

function reconnectAll() {
  if (!me) return;
  // The club you run, on the club manager only; there, too, the clubs you
  // help run (their staff views come over your member connection).
  if (mode === 'manage') owner?.start();
  for (const m of memberships) if (mode === 'play' || helps(m)) connectMembership(m);
  render();
}

// Another tab of this browser changed the club or the memberships (only one
// tab can host, but any tab can show the club): show what it saved.
function onStorage(e) {
  if (e.key === CLUB_KEY) {
    club = load(CLUB_KEY, null);
    verifier = new Verifier(load(SENDERS_KEY, {}));
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
    // A backup saved in Player settings: no more Back up card (#562).
    window.addEventListener('ducy-backed-up', () => render());
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
      // The manager's dealing times move too (#398).
      if (open && (live || (mode === 'manage' && club))) render();
    }, 30_000);
    owner = createOwner({
      identity: me,
      onChange: () => { if (isRemote()) club = owner.club; render(); },
      onNote: t => { note = t; render(); },
      // Its connection proves the player's ID and is unlocked with their
      // passkey (#575, #577), except in a demo.
      gated: !demo,
      session: () => pk.session(me.id)?.token || '',
      onPass: kind => {
        if (kind === 'unlocked') { pk.touch(); return; }
        if (kind === 'locked') pk.forget();
        if (kind === 'unlock_again') pass.note = 'Unlock with your passkey again to move chips.';
        refreshPass();
      },
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
    // Clubs need the passkey (#575): made, or this visit's unlock.
    refreshPass();
  })());
}

// Draws tab `v` of the Play section (see the views above) into `el`.
export async function openClubs(el, v = 'clubs') {
  if (!root) {
    // The club rules the page draws from are ducy-play's (#455).
    await loadEngine().catch(e => { note = `The club couldn’t start: ${e.message}`; });
    root = el;
    // Which control an action comes from (#544), before it's handled.
    for (const type of ['click', 'submit', 'change']) {
      root.addEventListener(type, e => { actor = e.submitter || e.target.closest?.('button, select, input, textarea, a, form') || null; actorAt = Date.now(); }, true);
    }
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('change', onFilter);
    // Restore a club from its backup file (#191).
    root.addEventListener('change', e => {
      const f = e.target.dataset?.clrestore != null && e.target.files?.[0];
      if (f) { e.target.value = ''; restoreBackupFile(f); }
    });
    // The promotion form (#278): its kind redraws it; a session, or set
    // times, shows the days and hours.
    root.addEventListener('change', e => {
      const pf = e.target.closest('form[data-promoform]');
      if (!pf) return;
      if (e.target.dataset.promokind) { promoForm = e.target.value === 'bonus' ? 'new-bonus' : 'new'; render(); }
      if (e.target.dataset.promoevery || e.target.dataset.promohours) {
        const session = pf.elements.every.value === 'session';
        pf.querySelector('.cl-promo-hours').hidden = session;
        pf.querySelector('.cl-promo-session').hidden = !session && !pf.elements.hours.checked;
      }
    });
    root.addEventListener('change', e => {
      const f = e.target.closest('form[data-tableform]');
      if (f && ['game', 'blinds', 'sb', 'bb', 'ante', 'house'].includes(e.target.name)) syncTableForm(f, e.target.name === 'game');
      // The club's rake on Rules (#449).
      if (e.target.name === 'house' && e.target.form?.dataset.chargeform) syncChargeFields(e.target.form);
      // What a tournament pays by (#424): Default or a club payout table.
      // A running one's asks first (#544).
      const pick = e.target.dataset?.paypick;
      if (pick && e.target.value !== 'own') {
        if (e.target.dataset.running) { payAsk = {id: pick, table: e.target.value}; render(); root.querySelector('[data-cl="pay-no"]')?.focus(); }
        else hostAct('set_payout_table', {id: pick, table: e.target.value || null});
      }
      // The wizard (#477): a choice that changes what its step shows.
      const tf = e.target.closest('form[data-tourneyform]');
      if (tf && tourneyForm && WIZARD_CHOICES.has(e.target.name)) {
        tourneyForm.d.game = tf.elements.game?.value || tourneyForm.d.game;
        if (e.target.name === 'game') tourneyForm.d.tableSize = defaultSeats(e.target.value);
        readStep(tf, tourneyForm.d, tourneyForm.step, {strict: false});
        syncWizardBlinds(tourneyForm);
        render();
        if (e.target.value === 'other') root.querySelector(`[data-other="${e.target.name.replace(/Pick$/, '')}"] input`)?.focus();
      }
      // Other's box (#544) in the other forms: shown while Other is picked.
      else if (e.target.name?.endsWith('Pick')) {
        // Other starts from the amount picked (the credit limit and a
        // prize, both chip amounts).
        const box = e.target.form?.querySelector(`[data-other="${e.target.name.replace(/Pick$/, '')}"] input`);
        if (box && e.target.value !== 'other') box.value = chipInput(Number(e.target.value));
        syncPicks(root);
        if (e.target.value === 'other') root.querySelector(`[data-other="${e.target.name.replace(/Pick$/, '')}"] input`)?.focus();
      }
    });
    // The blind structure editor's fields, and the starting stack it follows.
    root.addEventListener('change', e => {
      if (!tourneyForm) return;
      const ed = root.querySelector('[data-tseditor]');
      const editor = tourneyForm.editor;
      if (e.target.dataset.tstack) { const n = Number(e.target.value); if (Number.isSafeInteger(n) && n >= 20) { tourneyForm.d.stack = n; editor.setStack(n); if (ed) ed.innerHTML = editor.html(); } return; }
      if (e.target.closest('[data-tseditor]') && editor.input(e) && ed) ed.innerHTML = editor.html();
    });
    // The Members search (#398) filters the rows as it's typed.
    root.addEventListener('input', e => {
      // A payout table being edited (#424): kept as it's typed, over redraws.
      const ptf = e.target.closest?.('form[data-paytable]');
      if (ptf) { syncPayTable(ptf); return; }
      // The Members order, on a phone (#426): the first page of it.
      if (e.target.dataset?.msort) { location.hash = ph('members', '', {...managerPage(location.hash), sort: e.target.value, n: 1}); return; }
      // An agent's players (#426); none picked: everyone.
      if (e.target.dataset?.magent) { location.hash = ph('members', '', {sort: managerPage(location.hash)?.sort, agent: e.target.value}); return; }
      if (!e.target.dataset?.msearch) return;
      memberQuery = e.target.value;
      // Over the whole list (#426), from its first page.
      membersFirstPage();
      render();
    });
    document.addEventListener('keydown', onDocKey);
    // A ⋯ menu closes when you click anywhere else. A click whose target the
    // page has just redrawn (a question asked in a menu, #544) was in it.
    document.addEventListener('click', e => {
      if (!e.target.isConnected) return;
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
    location.href = managerHref(club || isRemote() ? 'clubs/requests' : helped ? clubHash(helped.code) : 'clubs');
    return;
  }
  if (!club && !isRemote() && helped) { location.hash = clubHash(helped.code); return; }
  location.hash = 'clubs/requests';
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
  setMemberTab(c.mem.code, 'tourneys');
  location.hash = clubHash(c.mem.code);
  render();
}

// Called after anything changes, whichever tab is showing (the tab badges).
export function onClubsChange(f) {
  listeners.add(f);
}

// Whether the My clubs tab has anything: a club this browser runs, or one
// it's an agent of.
export function managesClub() {
  if (club || isRemote() || load('ducyClubRemote', null)) return true;
  return (started ? memberships : load(MEMBERSHIPS_KEY, [])).some(helps);
}

// How many things are waiting for this browser to act on (My clubs' badge):
// join and chip requests at the club it runs, and those an agent can answer.
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
export async function joinClub(inv, name, intro = '') {
  await startClubs();
  if (!me) return;
  invite = inv;
  joinFromInvite(name, intro);
}

// The name this browser joins clubs as, and changing it (Player settings,
// #144): each club's host is told.
export const memberName = () => myName();

// Brings an account back with a passkey (#575), from Player settings.
export async function recoverWithPasskey() {
  await startClubs();
  if (!me) throw new Error('This browser can’t keep a player ID.');
  await recoverAccount();
}
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
