// Clubs (#66): host a club, invite players with a link and approve them, and
// see the clubs you belong to. club.js has the rules and club-server.js runs
// the host's side; this file draws the club parts of the Play section's tabs
// (play-section.js, #138) and carries signed messages over the relay
// (play-net.js, in queue mode so join requests wait while the host is away).
//
// Views, one per Play tab:
//   'play'   the clubs you belong to: balance, chips, tables to sit at
//   'join'   your join requests and how they're going
//   'host'   create a club
//   'clubs'  My clubs: the club you run, and assistant and agent tools
// The connections start with the page (startClubs), whichever tab is open,
// so requests arrive live (#145); onClubsChange tells the tab bar.
//
// Storage (this browser only, #61):
//   ducyClub          the club this browser hosts (one per host for now)
//   ducyClubSenders   the host's Verifier state (players' keys, last seq)
//   ducyClubs         clubs this browser has asked to join
//   ducyClubName      the display name sent with join requests

import { exportLockedIdentity, loadIdentity, MIN_PASSWORD, showId, signMessage, Verifier } from './identity.js';
import { chipText, chipInput, parseChips, CHIP_STEP } from './chip-format.js';
import { hostPick, onHostPick, setHostPick } from './host-choice.js';
import { downloadFile, notifyOn, RESTORE_CLUB_KEY } from './player-settings.js';
import { connect, DEFAULT_RELAY, newCode, normCode, relayUrl, wsUrl } from './play-net.js';
import {
  account, approve, decline, hostReceive, inviteLink, lastEntry, MAX_CLUB_NAME, MAX_PLAYER_NAME, membersByStatus,
  newClub, newMembership, parseInvite, playerReceive,
} from './club.js';
import { ensureChips, issue, MAX_NOTE, reclaim, totals } from './club-chips.js';
import {
  cashOutEveryone, ensureTables, gameLabel, GAMES, MAX_SEATS, MAX_TABLE_NAME, newTable, openTables, tableById, tablesBody,
} from './club-tables.js';
import { createClubServer } from './club-server.js';
import { createOwner } from './club-owner.js';
import { accountOf, settle } from './club-agents.js';
import { handRecord, replayFrames, streetStarts, summary, tableSessions, totalsByMember, STREETS } from './hand-replay.js';
import { getHand, HOST_KEEP_DAYS, listHands, PLAYER_KEEP_HANDS, prune, saveHand } from './hand-store.js';
import { getTable } from './table-store.js';
import { joinTableVia, showFairCheck } from './play.js';
import { hostTourneysHtml, memberTourneysHtml, readPayoutForm, readTourneyForm } from './club-tourneys-ui.js';
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
const when = t => (t ? new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : '');
const myName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };

const STATUS_TEXT = {
  new: 'Sending your request…',
  pending: 'Waiting for the host to approve you',
  member: 'Member',
  declined: 'The host declined your request',
  removed: 'You were removed from this club',
  bad_invite: 'That invite link isn’t valid any more; ask the host for a new one',
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
    setWizard('backup');
  } catch (e) {
    // The relay is down or full (limits, #123).
    note = '';
    alwaysFailed = {reason: e.message, name: n};
  }
  render();
}

// Creating a club (#152): a name, then a backup (or skipping it, warned).
// The club exists from the first step, so closing the page mid-way comes
// back to the backup step.
const WIZARD_KEY = 'ducyClubWizard';
let wizard = load(WIZARD_KEY, null); // {code, step: 'backup' | 'skip'}
if (wizard && wizard.step !== 'backup' && wizard.step !== 'skip') wizard = null; // an older step (#111)
const myClubCode = () => club?.code || owner?.record?.code || '';

function setWizard(step) {
  wizard = step ? {code: myClubCode(), step} : null;
  if (wizard) save(WIZARD_KEY, wizard);
  else try { localStorage.removeItem(WIZARD_KEY); } catch {}
  render();
}

// The New table form (#113): three choices (game, blinds, seats) as
// buttons, everything else under More options with good defaults. Native,
// so the browser checks the numbers. The last choices are remembered.
// `code`: an assistant's form for that club (sent to its host), else the
// host's. `wizard`: step 2 of creating a club (#111), which can be skipped.
const TABLE_KEY = 'ducyTableChoice';
// In hundredths (chip-format.js): 100/200 shows as 1/2.
const BLINDS = [[100, 200], [200, 500], [500, 1000]];
const SEATS = [2, 6, 9];
const SHORT = {nlhe: 'Hold’em', plo4: 'Omaha', plo5: 'Omaha 5', plo6: 'Omaha 6'};

function tableFormHtml(code = '', {wizard = false} = {}) {
  const last = load(TABLE_KEY, {});
  const game = GAMES.some(g => g.id === last.game) ? last.game : GAMES[0].id;
  const blinds = BLINDS.find(([s, b]) => s === last.sb && b === last.bb) ? `${last.sb}/${last.bb}` : last.sb ? 'other' : '100/200';
  const seats = SEATS.includes(last.seats) ? String(last.seats) : last.seats ? 'other' : '9';
  const radio = (name, value, label, on) => `<label class="cc-btn tf-opt"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}>${label}</label>`;
  let h = `<form class="cl-tableform tf" data-tableform="1"${code ? ` data-code="${esc(code)}"` : ''}${wizard ? ' data-wizard="1"' : ''}>`;
  h += `<div class="pl-row"><span class="pl-label">Game</span><div class="pl-opts">${GAMES.map(g => radio('game', g.id, esc(SHORT[g.id] || g.label), g.id === game)).join('')}</div></div>`;
  h += `<div class="pl-row"><span class="pl-label">Blinds</span><div class="pl-opts">${BLINDS.map(([s, b]) => radio('blinds', `${s}/${b}`, `${chipText(s)}/${chipText(b)}`, blinds === `${s}/${b}`)).join('')}${radio('blinds', 'other', 'Other', blinds === 'other')}</div></div>`;
  h += `<div class="pl-row tf-other tf-other-blinds"><label>Small blind<input class="pl-text" name="sb" type="number" min="0.01" step="${CHIP_STEP}" value="${esc(chipInput(last.sb || 100))}"></label><label>Big blind<input class="pl-text" name="bb" type="number" min="0.01" step="${CHIP_STEP}" value="${esc(chipInput(last.bb || 200))}"></label></div>`;
  h += `<div class="pl-row"><span class="pl-label">Seats</span><div class="pl-opts">${SEATS.map(n => radio('seatsPick', n, n, seats === String(n))).join('')}${radio('seatsPick', 'other', 'Other', seats === 'other')}</div></div>`;
  h += `<div class="pl-row tf-other tf-other-seats"><label>Seats<input class="pl-text" name="seats" type="number" min="2" max="${MAX_SEATS}" step="1" value="${esc(last.seats || MAX_SEATS)}"></label></div>`;
  // Sit-out limit (#70): this table's, starting from the club's default (an
  // assistant's browser doesn't have the club, so theirs starts at 10 minutes).
  const defOut = club?.sitOutMins ?? 10;
  h += '<details class="tf-more"><summary>More options</summary><div class="tf-fields">';
  h += `<label>Name<input class="pl-text" name="name" maxlength="${MAX_TABLE_NAME}" placeholder="${code ? 'Table name' : `Table ${(club?.tables?.length || 0) + 1}`}"></label>`;
  h += `<label>Min buy-in (BB)<input class="pl-text" name="minBB" type="number" required min="1" step="1" value="${esc(last.minBB || 40)}"></label>`;
  h += `<label>Max buy-in (BB)<input class="pl-text" name="maxBB" type="number" required min="1" step="1" value="${esc(last.maxBB || 100)}"></label>`;
  h += `<label>Time to act<select class="pl-text" name="turnSecs">${[15, 30, 60, 0].map(s => `<option value="${s}"${s === (last.turnSecs ?? 30) ? ' selected' : ''}>${s ? s + ' s' : 'None'}</option>`).join('')}</select></label>`;
  h += `<label>Sitting out<select class="pl-text" name="sitOutMins">${[5, 10, 15, 30, 0].map(m => `<option value="${m}"${m === defOut ? ' selected' : ''}>${m ? m + ' min' : 'No limit'}</option>`).join('')}</select></label>`;
  h += '</div></details>';
  h += '<div class="cl-formacts"><button class="btn-small primary" type="submit">Open table</button>';
  h += wizard ? '<button class="btn-small" type="button" data-cl="wiz-skip">Skip for now</button>' : '<button class="btn-small" type="button" data-cl="cancel-table">Cancel</button>';
  return h + '</div></form>';
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
  };
  if (blinds === 'other' && !(Number.isSafeInteger(sb) && Number.isSafeInteger(bb) && sb >= 1 && sb <= bb)) {
    alert('Blinds are amounts like 1 or 0.25: the small blind at least 0.01 and no more than the big blind.');
    return;
  }
  save(TABLE_KEY, {game: settings.game, sb, bb, seats, minBB: settings.minBB, maxBB: settings.maxBB, turnSecs: settings.turnSecs});
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
    onLeave: why => { note = why || ''; location.hash = 'clubs'; },
  });
  location.hash = 'play';
}

function closeTable(id) {
  const t = club.tables.find(x => x.id === id);
  if (!t || !confirm(`Close ${t.name}? Everyone is cashed out at the end of the hand.`)) return;
  hostAct('close_table', {table: id});
}

function tablesHtml() {
  const tables = openTables(club);
  const counts = seatedCounts();
  let h = `<h3>Tables${tables.length ? ` (${tables.length})` : ''}</h3>`;
  if (tables.length) {
    h += '<ul class="cl-list">';
    for (const t of tables) {
      h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameLabel(t.game))} · ${chips(t.sb)}/${chips(t.bb)} · buy-in ${t.minBB}–${t.maxBB} BB · ${counts[t.id] || 0}/${t.seats} seated</span>`;
      h += t.status === 'closing'
        ? '<span class="cl-acts pl-meta">Closing after this hand…</span>'
        : `<span class="cl-acts"><button class="btn-small" data-cl="watch" data-table="${esc(t.id)}"${tableRunning(t.id) ? '' : ' disabled'}>Watch</button><button class="btn-small" data-cl="close-table" data-table="${esc(t.id)}">Close</button></span>`;
      const seated = Object.values(club.members).filter(m => m.seat?.table === t.id);
      if (seated.length) h += `<span class="pl-desc cl-err">${seated.map(m => `${esc(m.name)} ${chips(m.seat.stack)}`).join(' · ')}</span>`;
      h += '</li>';
    }
    h += '</ul>';
  } else if (tableForm !== true) h += '<p class="pl-meta">No tables yet.</p>';
  h += tableForm === true ? tableFormHtml() : '<div class="pl-actions"><button class="btn-small primary" data-cl="new-table">New table</button></div>';
  return h;
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
  h += `<label class="cl-formlabel" for="cl-amt">${esc(t.label)}</label>`;
  h += `<input class="pl-text" id="cl-amt" name="amount" type="number" inputmode="decimal" required min="${chipInput(t.min ?? 1)}" step="${CHIP_STEP}"${t.max != null ? ` max="${chipInput(t.max)}"` : ''} value="${esc(amountValue(t.value))}" placeholder="Chips">`;
  if (t.note) h += `<input class="pl-text" name="note" maxlength="${MAX_NOTE}" placeholder="Note (optional)">`;
  h += `<button class="btn-small primary" type="submit">${t.submit}</button><button class="btn-small" type="button" data-cl="cancel-form">Cancel</button></form>`;
  return h;
}

function openChipForm(kind, id) {
  chipForm = chipForm?.kind === kind && chipForm.id === id ? null : {kind, id};
  render();
  const input = root.querySelector('#cl-amt');
  if (input) { input.focus(); input.select(); }
}

function onSubmit(e) {
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
  const amount = parseChips(f.elements.amount.value);
  const why = f.elements.note?.value || '';
  chipForm = null;
  const op = {give: 'give', take: 'take', grant: 'grant', agent: 'offer_agent', limit: 'credit_limit', settle: 'settle'}[kind];
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
  try { await owner.attach(code); note = ''; location.hash = 'clubs'; } catch (e) { note = e.message; }
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
  return inviteLink(club, location.href, relay !== wsUrl(DEFAULT_RELAY) ? relay : '', myName());
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
    if (mem.status === 'new' && !myName()) { mem.error = 'Enter your name above and click Save to send your request.'; render(); return; }
    const key = (await entry.keys).pub;
    const body = mem.status === 'new'
      ? {type: 'join', club: mem.code, invite: mem.invite, name: myName(), key}
      : {type: 'hello', club: mem.code, name: myName(), since: lastEntry(mem), key};
    sendToHost(mem.code, body);
    // Back at a club table after the host (or this page) reconnected.
    if (seatedAt?.code === mem.code) sendToHost(mem.code, {type: 'table', club: mem.code, table: seatedAt.table, cmd: {type: 'join', name: myName()}});
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
    if (await playerReceive(mem, msg)) {
      if (before !== 'member' && mem.status === 'member') {
        justJoined.add(mem.code);
        // Approved: say so wherever you are (#185).
        if (before) notice(`You’re in ${mem.name || mem.code}. Ask the host for chips to play.`);
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
    onOpen() { entry.online = true; entry.hostHere = true; mem.error = ''; greet(); render(); },
    // One message at a time, in order: a new host key must be in place
    // before the encrypted updates after it.
    onMessage(msg) { entry.inbox = entry.inbox.then(() => handle(msg)).catch(e => console.warn(e)); },
    onStatus(s) { entry.online = !s; render(); },
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

// Saves the display name and tells each club's host: a pending request is
// sent (or re-sent) with it, and members' names are updated.
async function setName(name) {
  const n = String(name || '').trim().slice(0, MAX_PLAYER_NAME);
  if (!n) { alert('Enter a name.'); return; }
  try { localStorage.setItem(NAME_KEY, n); } catch {}
  for (const m of memberships) {
    m.error = '';
    const body = m.status === 'new'
      ? {type: 'join', club: m.code, invite: m.invite, name: n}
      : {type: 'hello', club: m.code, name: n};
    sendToHost(m.code, body);
  }
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
  if (!rows.length) return h + '<p class="pl-meta">No hands yet.</p></div>';
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
  let h = '<details class="cl-history"><summary>Results by table session</summary>';
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
    onLeave: why => { seatedAt = null; note = why || ''; location.hash = 'play'; },
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
  const typing = root.querySelector('form[data-chipform]');
  const kept = typing && {key: typing.dataset.chipform + typing.dataset.id, values: [...typing.elements].map(el => el.value), focus: document.activeElement?.name};
  root.innerHTML = h;
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
  const msg = note ? `<p class="pl-desc pl-neterr">${esc(note)}</p>` : '';
  if (view === 'play') {
    const h = membershipsHtml('play');
    return h ? msg + h : '';
  }
  if (view === 'join') {
    const h = requestsHtml();
    return h || msg ? msg + h : '';
  }
  if (view === 'host') return msg + createHtml() + footHtml();
  // My clubs: the club you run, and the clubs you help run, one at a time
  // with a picker when there's more than one (#143).
  const own = club || isRemote();
  const helped = memberships.filter(helps);
  if (!own && !helped.length) return msg;
  const choices = [...(own ? [['own', club?.name || owner.record.name]] : []), ...helped.map(m => [m.code, m.name || m.code])];
  if (!choices.some(([k]) => k === pick)) pick = choices[0][0];
  let h = '';
  if (choices.length > 1) {
    h += `<div class="pl-row cl-picker"><span class="pl-label">Club</span><div class="pl-opts">${choices.map(([k, name]) => `<button class="cc-btn${k === pick ? ' on' : ''}" data-cl="pick" data-code="${esc(k)}">${esc(name)}</button>`).join('')}</div></div>`;
  }
  h += pick === 'own' ? hostHtml() : membershipsHtml('clubs', pick);
  return msg + h + footHtml();
}
let pick = 'own'; // My clubs' club: 'own' (the one you run), or a code you help run

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
    const live = n?.online ? (n.hostHere ? 'Host online' : 'Host away: your request waits for them') : 'Offline';
    const inNow = m.status === 'member';
    h += `<li><span class="cl-name">${esc(m.name || m.code)}</span><span class="cl-status cl-${esc(m.status)}">${inNow ? 'You’re in' : esc(STATUS_TEXT[m.status] || m.status)}</span>`;
    if (!inNow) h += `<span class="pl-meta">${live}</span>`;
    h += '<span class="cl-acts">';
    if (inNow) h += '<a class="btn-small primary" href="#play">Play</a>';
    else {
      if (!n) h += `<button class="btn-small" data-cl="retry" data-code="${esc(m.code)}">Try again</button>`;
      h += `<button class="btn-small" data-cl="forget" data-code="${esc(m.code)}">Forget</button>`;
    }
    h += '</span>';
    // What happens next (#185).
    if (m.status === 'pending' || m.status === 'new') {
      h += `<span class="pl-desc cl-next">Next: the host lets you in, then gives you chips (play money) to play at the club’s tables. This page tells you as soon as you’re in${notifyOn() ? '' : '; to hear about it while you’re elsewhere, turn on notifications in Player settings'}.</span>`;
    } else if (inNow) {
      h += '<span class="pl-desc cl-next">Next: ask the host for chips on the Play tab, then sit at one of the club’s tables.</span>';
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

// The Host tab's club part (#152), once "Create a club" is picked: just a
// name. The club is always on; there's nothing else to choose here.
function createHtml() {
  const mine = club || isRemote();
  if (mine && wizard?.code === myClubCode()) return wizardHtml();
  if (hostPick() !== 'club') return '';
  if (mine) {
    const name = club?.name || owner.record.name;
    return `<section class="cl-card"><h2>Create a club</h2><p class="pl-desc">You run <b>${esc(name)}</b>: manage it in <a href="#clubs">My clubs</a>. A browser runs one club for now.</p></section>`;
  }
  let h = '<section class="cl-card"><h2>Create a club</h2>';
  h += '<p class="pl-desc">Members join with your invite link, you give them chips (play money), and they play at your tables. It runs on ducy’s server, so they can play whenever, with this page closed.</p>';
  h += `<div class="pl-row"><span class="pl-label">Club name</span><input class="pl-text" id="cl-clubname" maxlength="${MAX_CLUB_NAME}" placeholder="Friday Night Game" value="${esc(alwaysFailed?.name || '')}"></div>`;
  if (alwaysFailed) {
    h += `<p class="pl-desc pl-neterr">Couldn’t start it on ducy’s server: ${esc(alwaysFailed.reason)}</p>`;
    h += '<div class="pl-actions"><button class="tr-start" data-cl="create">Try again</button></div>';
  } else {
    h += '<div class="pl-actions"><button class="tr-start" data-cl="create">Create the club</button></div>';
  }
  return h + '</section>';
}

// Right after creating a club (#152): back it up with a password, or skip
// that knowing it then can't be recovered.
function wizardHtml() {
  const name = club?.name || owner?.record?.name || '';
  let h = `<section class="cl-card"><h2>${esc(name)} is ready</h2>`;
  if (wizard.step === 'skip') {
    h += '<p class="pl-desc pl-neterr"><b>Without a backup, your club can’t be recovered.</b> If this browser’s data is cleared, or you lose this device, nobody can run the club again: not its members, its chips or its history.</p>';
    return h + '<div class="pl-actions"><button class="tr-start" data-cl="wiz-back">Back up after all</button><button class="btn-small" data-cl="wiz-done">Skip anyway</button></div></section>';
  }
  h += '<p class="pl-desc">Back it up now. The backup is a file, locked with a password you choose, that lets you run the club again from any browser if this one loses it. You can make another later, in the club’s Settings.</p>';
  h += '<form class="pl-idform" data-clform="backup">';
  h += `<label>Password<input class="pl-text" type="password" name="pw" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
  h += `<label>Again<input class="pl-text" type="password" name="pw2" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
  h += '<p class="pl-desc">It isn’t kept anywhere, so if you forget it the file can’t be opened.</p>';
  if (backupNote) h += `<p class="pl-desc pl-neterr">${esc(backupNote)}</p>`;
  h += '<div class="pl-actions"><button class="tr-start" type="submit">Save the backup</button><button class="btn-small" type="button" data-cl="wiz-skip">Skip</button></div></form>';
  return h + '</section>';
}

// The backup form, after creating the club or from its Settings.
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
  backupNote = 'Backup saved. Keep the file and the password safe: with both, anyone can run this club.';
  backupForm = false;
  if (wizard) { setWizard(null); dashTab = 'tables'; location.hash = 'clubs'; }
  render();
}
let backupNote = '', backupForm = false; // the Settings tab's backup form

// Saves the club's backup (#152): your player ID, which owns the club, locked
// with `password`, with the club's code and name. Restoring it (Player
// settings) brings the ID back and reopens the club in that browser.
async function backupClub(password) {
  const code = myClubCode(), name = club?.name || owner?.record?.name || '';
  const locked = JSON.parse(await exportLockedIdentity(me, password));
  downloadFile(JSON.stringify({...locked, club: {code, name}}), `ducy-club-${code}.json`);
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
  const badge = remote ? (owner.online ? '' : owner.connected ? 'Reconnecting…' : 'Not connected')
    : stalled ? 'No answer from the relay' : hostOnline ? 'Open' : hostNet ? 'Connecting…' : 'Offline';
  let h = `<section class="cl-card"><div class="cl-title"><h2>${esc(club.name)}</h2>${badge ? `<span class="cl-badge${on ? ' on' : ''}">${badge}</span>` : ''}`;
  if (!remote && !hostNet) h += '<button class="btn-small" data-cl="reconnect">Reconnect</button>';
  if (remote && !owner.connected) h += '<button class="btn-small" data-cl="reconnect-owner">Reconnect</button>';
  h += '</div>';
  if (!remote && hostNet && (stalled || !hostOnline)) h += '<p class="pl-desc pl-neterr">The tables are paused until the connection is back: no one is folded or timed out meanwhile.</p>';
  if (!remote && !hostNet) h += '<p class="pl-desc pl-neterr">This tab isn’t hosting the club right now, so players can’t reach it from here, and changes made here reach them only when they next connect. If the club is open in another tab, use that one.</p>';
  h += `<p class="pl-meta">${remote ? '' : 'Runs in this tab · '}code ${esc(club.code)} · ${members.length} member${members.length === 1 ? '' : 's'}</p>`;
  // Four tabs (#152): Tables, Players (with what needs you, #143), Settings
  // and History.
  const asking = members.filter(m => m.request && !m.agentOf).sort((a, b) => a.request.at - b.request.at);
  const waiting = pending.length + asking.length;
  const tables = openTables(club);
  const sub = (id, label) => `<button class="pl-tab${dashTab === id ? ' on' : ''}" role="tab" aria-selected="${dashTab === id}" data-cl="dash" data-tab="${id}">${label}</button>`;
  const players = `Players${waiting ? ` <span class="pt-badge" aria-label="${waiting} waiting for you">${waiting}</span>` : ''}`;
  const tourneys = (club.tourneys || []).filter(t => t.status === 'scheduled' || t.status === 'running').length;
  h += `<div class="pl-tabs cl-dash-tabs" role="tablist">${sub('tables', `Tables (${tables.length})`)}${sub('tourneys', `Tournaments${tourneys ? ` (${tourneys})` : ''}`)}${sub('players', players)}${sub('accounting', 'Accounting')}${sub('history', 'History')}${sub('settings', 'Settings')}</div>`;
  if (dashTab === 'tables') h += tablesHtml();
  else if (dashTab === 'tourneys') h += hostTourneysHtml(club, tourneyLive(), {form: tourneyForm, editor: tEditor, last: load(TOURNEY_KEY, {}), payoutEdit});
  else if (dashTab === 'settings') h += settingsHtml();
  else if (dashTab === 'players') {
    if (pending.length || asking.length) {
      h += `<div class="cl-needs"><h3>Needs you (${pending.length + asking.length})</h3><ul class="cl-list">`;
      for (const m of pending) {
        h += `<li><span class="cl-name">${esc(m.name)}</span><span class="pl-meta">asks to join · <code>${esc(showId(m.id))}</code>${m.agentOf && club.members[m.agentOf] ? ` · via ${esc(club.members[m.agentOf].name)}` : ''}</span>`;
        h += `<span class="cl-acts"><button class="btn-small primary" data-cl="approve" data-id="${esc(m.id)}">Approve</button><button class="btn-small" data-cl="decline" data-id="${esc(m.id)}">Decline</button></span></li>`;
      }
      for (const m of asking) {
        h += `<li><span class="cl-name">${esc(m.name)}</span><span class="cl-chips">asks for ${chips(m.request.amount)}</span>`;
        if (m.request.note) h += `<span class="pl-meta">“${esc(m.request.note)}”</span>`;
        h += `<span class="cl-acts"><button class="btn-small primary" data-cl="grant" data-id="${esc(m.id)}">Give ${chips(m.request.amount)}</button>`;
        h += `<button class="btn-small" data-cl="grant-other" data-id="${esc(m.id)}">Other amount</button><button class="btn-small" data-cl="deny" data-id="${esc(m.id)}">Decline</button></span>`;
        if (chipForm?.kind === 'grant') h += chipFormHtml(m);
        h += '</li>';
      }
      h += '</ul></div>';
    }
    h += '<div class="pl-row"><span class="pl-label">Invite link</span><div class="pl-opts cl-link">';
    h += `<input class="pl-text" readonly value="${esc(link())}" id="cl-link">`;
    h += `<button class="btn-small" data-cl="copy">${copied ? 'Copied' : 'Copy'}</button>`;
    if (navigator.share) h += '<button class="btn-small" data-cl="share">Share…</button>';
    h += '<button class="link-btn" data-cl="revoke" title="Make a new link; the old one stops working">New link</button>';
    h += '</div></div>';
    h += `<h3>Members (${members.length})</h3>`;
    if (!members.length) h += '<p class="pl-meta">No members yet. Send someone the invite link.</p>';
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
      h += `<details class="cl-history"><summary>Assistant activity (${club.log.length})</summary><ul>`;
      for (const l of [...club.log].reverse().slice(0, 100)) h += `<li><span class="pl-meta">${when(l.at)}</span> ${esc(l.text)}</li>`;
      h += '</ul></details>';
    }
  }
  return h + '</section>';
}

// The club page's tab (#152): 'tables', 'players', 'accounting', 'history' or 'settings'.
let dashTab = 'tables';

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
    h += `<details class="cl-history"><summary>Ledger (${ledger.length})</summary><ul>`;
    for (const e of [...ledger].reverse().slice(0, 200)) {
      const sign = ['reclaim', 'buy_in', 'top_up', 'transfer_out'].includes(e.kind) ? '−' : '+';
      h += `<li><span class="pl-meta">${when(e.at)}</span> ${esc(names[e.member] || e.member)} · ${esc(KIND_TEXT[e.kind] || e.kind)}${e.table && tableNames[e.table] ? ` (${esc(tableNames[e.table])})` : ''} <strong>${sign}${chips(e.amount)}</strong>${e.note ? ` <span class="pl-meta">“${esc(e.note)}”</span>` : ''} <span class="pl-meta">→ ${chips(e.balance)}</span></li>`;
    }
    h += '</ul></details>';
  }
  return h;
}

// A ⋯ menu (#144): items [action, label, title?, data-id?], each a button
// handled like any other data-cl click.
function menuHtml(label, items, id = '') {
  let h = `<details class="cl-menu"><summary class="btn-small" aria-label="${esc(label)}" title="${esc(label)}">⋯</summary><div class="cl-menu-items">`;
  for (const [act, text, title = ''] of items) h += `<button class="cl-menu-item" data-cl="${act}"${id ? ` data-id="${esc(id)}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${text}</button>`;
  return h + '</div></details>';
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
  h += `<div class="pl-row"><span class="pl-label">Keep hands</span><div class="pl-opts">${[1, 7, 30].map(d => `<button class="cc-btn${(club.keepDays ?? HOST_KEEP_DAYS) === d ? ' on' : ''}" data-cl="keep-days" data-days="${d}">${d} day${d > 1 ? 's' : ''}</button>`).join('')}</div><span class="pl-desc">How long the hands at your tables are kept for the history.</span></div>`;
  h += '<h3>Backup</h3>';
  if (remote) {
    h += '<p class="pl-desc">A file, locked with a password, that lets you run the club again from any browser if this one loses it.</p>';
    if (backupForm) {
      h += '<form class="pl-idform" data-clform="backup">';
      h += `<label>Password<input class="pl-text" type="password" name="pw" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
      h += `<label>Again<input class="pl-text" type="password" name="pw2" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
      h += '<div class="pl-actions"><button class="btn-small primary" type="submit">Save the backup</button><button class="btn-small" type="button" data-cl="backup-cancel">Cancel</button></div></form>';
    } else h += '<div class="pl-actions"><button class="btn-small" data-cl="backup">Back up the club</button></div>';
    if (backupNote) h += `<p class="pl-desc">${esc(backupNote)}</p>`;
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
  h += menuHtml(`More for ${m.name}`, items, m.id) + '</span>';
  if (!m.agent && agents.length) {
    h += `<label class="pl-meta cl-assign">Agent <select class="pl-text" data-assign="${esc(m.id)}"><option value="">none</option>`;
    h += agents.map(a => `<option value="${esc(a.id)}"${m.agentOf === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('') + '</select></label>';
  }
  if (chipForm && chipForm.kind !== 'grant') h += chipFormHtml(m);
  return h + '</li>';
}

// The clubs you're in: on the Play tab ('play') your balance, chips and
// tables; on My clubs ('clubs') the ones you help run, with those tools.
const helps = m => m.status === 'member' && (m.role === 'assistant' || m.agent === 'yes');

function membershipsHtml(mode, only = '') {
  const list = memberships.filter(m => (mode === 'play' ? m.status === 'member' : helps(m) && (!only || m.code === only)));
  if (!list.length) return '';
  let h = `<section class="cl-card"><h2>${mode === 'play' ? 'Your clubs' : list.length === 1 ? esc(list[0].name || list[0].code) : 'Clubs you help run'}</h2>`;
  h += '<ul class="cl-list">';
  for (const m of list) {
    const n = playerNets.get(m.code);
    const live = n?.online ? (n.hostHere ? 'Host online' : 'Host away') : 'Offline';
    h += `<li><span class="cl-name">${esc(m.name || m.code)}</span>`;
    if (mode === 'clubs') h += `<span class="cl-status cl-member">${m.role === 'assistant' ? 'Game assistant' : 'Agent'}</span>`;
    h += `<span class="pl-meta">${live}</span><span class="cl-acts">`;
    if (!n) h += `<button class="btn-small" data-cl="retry" data-code="${esc(m.code)}">Try again</button>`;
    if (mode === 'play') h += `<button class="btn-small" data-cl="forget" data-code="${esc(m.code)}">Forget</button>`;
    h += '</span>';
    if (m.error) h += `<span class="pl-desc pl-neterr cl-err">${esc(m.error)}</span>`;
    if (mode === 'clubs') {
      if (m.role === 'assistant') h += adminHtml(m, !!n?.hostHere);
      if (m.agent === 'yes') h += agentHtml(m, !!n?.hostHere);
      h += '</li>';
      continue;
    }
    h += accountHtml(m, !!n?.hostHere);
    if (m.role === 'offered') {
      h += '<div class="cl-account cl-offer"><span>The host asked you to be a <b>game assistant</b>: approve players, give out chips from your own balance, and open and close tables.</span>';
      h += `<span><button class="btn-small primary" data-cl="role-yes" data-code="${esc(m.code)}">Accept</button> <button class="btn-small" data-cl="role-no" data-code="${esc(m.code)}">No thanks</button></span></div>`;
    }
    if (m.agent === 'offered') {
      h += `<div class="cl-account cl-offer"><span>The host asked you to be an <b>agent</b>, with a credit limit of ${chips(m.creditLimit)}: recruit your own players, give them chips from your balance, and back them on credit.</span>`;
      h += `<span><button class="btn-small primary" data-cl="agent-yes" data-code="${esc(m.code)}">Accept</button> <button class="btn-small" data-cl="agent-no" data-code="${esc(m.code)}">No thanks</button></span></div>`;
    }
    if (helps(m)) h += `<p class="pl-meta">You help run this club: its tools are in <a href="#clubs">My clubs</a>.</p>`;
    h += '</li>';
  }
  h += '</ul></section>';
  return h;
}

const KIND_TEXT = {issue: 'Given by the host', grant: 'Request granted', reclaim: 'Taken back by the host', buy_in: 'Bought in', top_up: 'Topped up', top_up_refund: 'Top-up handed back (over the table maximum)', cash_out: 'Cashed out', transfer_in: 'Received chips', transfer_out: 'Gave chips', settle: 'Settlement recorded', tourney_buyin: 'Tournament buy-in', tourney_refund: 'Tournament buy-in refunded', tourney_prize: 'Tournament prize'};

// A member's chips in a club: balance, a request, and their own ledger copy.
function accountHtml(m, hostHere) {
  let h = '<div class="cl-account">';
  h += `<div class="cl-balance"><span class="cl-chips">${chips(m.balance)} chips</span>`;
  if (m.entries?.length) h += m.ledgerOk === false
    ? '<span class="pl-neterr" title="Your copy of the ledger doesn’t add up to the balance the host reports">✗ doesn’t match your records</span>'
    : '<span class="pl-meta" title="Your copy of the ledger adds up to this balance">✓ matches your records</span>';
  h += '</div>';
  if (m.request) {
    h += `<div class="pl-row"><span class="pl-meta">You asked for ${chips(m.request.amount)}${m.request.note ? ` (“${esc(m.request.note)}”)` : ''}; waiting for the host.</span>`;
    h += `<button class="btn-small" data-cl="cancel-ask" data-code="${esc(m.code)}"${hostHere ? '' : ' disabled'}>Cancel</button></div>`;
  } else {
    // New and without chips: the first step, with the biggest buy-in at the
    // club's tables to ask for (#185).
    const fresh = !m.balance && !m.entries?.length;
    const suggest = fresh ? Math.max(0, ...(m.tables || []).map(t => t.max || 0)) : 0;
    if (fresh) h += `<p class="pl-desc cl-next"><b>You’re in.</b> Ask the host for chips (play money) to play${suggest ? `: ${chips(suggest)} covers the biggest buy-in here` : ''}.</p>`;
    h += `<div class="pl-row cl-ask"><input class="pl-text" type="number" min="0.01" step="${CHIP_STEP}" placeholder="Chips" data-ask-amt="${esc(m.code)}"${suggest ? ` value="${esc(chipInput(suggest))}"` : ''}>`;
    h += `<input class="pl-text" maxlength="${MAX_NOTE}" placeholder="Note (optional)" data-ask-note="${esc(m.code)}">`;
    h += `<button class="btn-small primary" data-cl="ask" data-code="${esc(m.code)}"${hostHere ? '' : ' disabled title="The host is away"'}>Ask for chips</button></div>`;
  }
  if (m.tables?.length) {
    h += '<ul class="cl-tables">';
    for (const t of m.tables) {
      const here = seatedAt?.code === m.code && seatedAt.table === t.id;
      h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameLabel(t.game))} · ${chips(t.sb)}/${chips(t.bb)} · buy-in ${chips(t.min)}–${chips(t.max)} · ${t.taken}/${t.seats} seated</span>`;
      h += here
        ? '<button class="btn-small primary" data-cl="to-table">Back to the table</button>'
        : `<button class="btn-small primary" data-cl="sit" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${hostHere && !seatedAt && t.taken < t.seats ? '' : ' disabled'}>Sit</button>`;
      h += '</li>';
    }
    h += '</ul>';
  } else h += '<p class="pl-meta">No tables open right now.</p>';
  h += memberTourneysHtml(m, me.id, {hostHere, playing: seatedAt?.code === m.code && seatedAt.table.startsWith('tourney:') ? seatedAt.table.slice(8) : null});
  h += handsHtml(m.code, me.id, 'Your hands');
  const tableNames = Object.fromEntries((m.tables || []).map(t => [t.id, t.name]));
  h += resultsHtml(m.entries || [], null, tableNames);
  if (m.entries?.length) {
    h += `<details class="cl-history"><summary>History (${m.entries.length})</summary><ul>`;
    for (const e of [...m.entries].reverse().slice(0, 50)) {
      const sign = ['reclaim', 'buy_in', 'top_up', 'transfer_out', 'tourney_buyin'].includes(e.kind) ? '−' : '+';
      h += `<li><span class="pl-meta">${when(e.at)}</span> ${esc(KIND_TEXT[e.kind] || e.kind)} <strong>${sign}${chips(e.amount)}</strong>${e.note ? ` <span class="pl-meta">“${esc(e.note)}”</span>` : ''} <span class="pl-meta">→ ${chips(e.balance)}</span></li>`;
    }
    h += '</ul></details>';
  }
  return h + '</div>';
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
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('club', m.code);
  u.searchParams.set('invite', m.agentView.invite);
  u.searchParams.set('host', m.hostId);
  // What the link opens on says which club, and that it's from you (#185).
  if (m.name) u.searchParams.set('name', m.name);
  if (myName()) u.searchParams.set('by', myName());
  const relay = relayUrl();
  if (relay !== wsUrl(DEFAULT_RELAY)) u.searchParams.set('relay', relay);
  u.hash = 'join';
  return u.toString();
}

function agentHtml(m, hostHere) {
  const a = m.agentView;
  let h = '<div class="cl-account cl-admin"><b>Agent tools</b>';
  if (!hostHere) h += '<span class="pl-meta">The host is away: these work again when the host is back.</span>';
  if (m.adminNote) h += `<span class="pl-neterr">${esc(m.adminNote)}</span>`;
  if (!a) return h + '<span class="pl-meta">Loading…</span></div>';
  const dis = hostHere ? '' : ' disabled';
  h += `<span>Your account: <b class="cl-chips">${chips(a.total)}</b> <span class="pl-meta">(your balance ${chips(a.own)} + your players’ ${chips(a.shares)})</span></span>`;
  h += `<span class="${a.creditUsed ? 'cl-down' : 'pl-meta'}">Credit used ${chips(a.creditUsed)} of ${chips(a.limit)} · you can still give out ${chips(Math.max(0, a.room))}</span>`;
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
      if (x.request) h += `<span class="pl-meta">asks for ${chips(x.request.amount)}</span>`;
      h += '<span class="cl-acts">';
      h += x.request ? `${btn('ag-grant', x, 'Give', ' primary')}${btn('ag-deny', x, 'Decline')}` : btn('ag-give', x, 'Give');
      h += `${btn('ag-take', x, 'Take back')}</span>${agentFormHtml(m.code, x)}</li>`;
    }
    h += '</ul>';
  }
  return h + '</div>';
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

function adminHtml(m, hostHere) {
  const a = m.admin;
  let h = '<div class="cl-account cl-admin"><b>Assistant tools</b>';
  if (!hostHere) h += '<span class="pl-meta">The host is away: these work again when the host is back.</span>';
  if (m.adminNote) h += `<span class="pl-neterr">${esc(m.adminNote)}</span>`;
  if (!a) return h + '<span class="pl-meta">Loading…</span></div>';
  const dis = hostHere ? '' : ' disabled';
  const btn = (act, x, label, extra = '') => `<button class="btn-small${extra}" data-cl="${act}" data-code="${esc(m.code)}" data-id="${esc(x.id)}"${dis}>${label}</button>`;
  if (a.pending.length) {
    h += `<span class="pl-meta">Requests to join (${a.pending.length})</span><ul class="cl-list">`;
    for (const x of a.pending) h += `<li><span class="cl-name">${esc(x.name)}</span><code>${esc(showId(x.id))}</code><span class="cl-acts">${btn('a-approve', x, 'Approve', ' primary')}${btn('a-decline', x, 'Decline')}</span></li>`;
    h += '</ul>';
  }
  const asking = a.members.filter(x => x.request);
  if (asking.length) {
    h += `<span class="pl-meta">Chip requests (${asking.length})</span><ul class="cl-list">`;
    for (const x of asking) {
      h += `<li><span class="cl-name">${esc(x.name)}</span><span class="cl-chips">asks for ${chips(x.request.amount)}</span>`;
      h += `<span class="cl-acts">${btn('a-grant', x, 'Give from mine', ' primary')}${btn('a-deny', x, 'Decline')}</span>${adminFormHtml(m.code, x)}</li>`;
    }
    h += '</ul>';
  }
  const others = a.members.filter(x => x.id !== me?.id);
  h += `<span class="pl-meta">Members (${a.members.length})</span><ul class="cl-list">`;
  for (const x of others) {
    h += `<li><span class="cl-name">${esc(x.name)}</span><span class="cl-chips">${chips(x.balance)} chips</span>${x.assistant ? '<span class="pl-meta">assistant</span>' : ''}`;
    h += `<span class="cl-acts">${btn('a-give', x, 'Give')}${x.assistant ? '' : btn('a-remove', x, 'Remove')}</span>${!x.request ? adminFormHtml(m.code, x) : ''}</li>`;
  }
  h += '</ul>';
  const open = a.tables.filter(t => t.status !== 'closed');
  const closed = a.tables.filter(t => t.status === 'closed');
  h += `<span class="pl-meta">Tables (${open.length})</span><ul class="cl-list">`;
  for (const t of open) {
    h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameLabel(t.game))} · ${chips(t.sb)}/${chips(t.bb)} · ${t.taken}/${t.seats} seated${t.status === 'closing' ? ' · closing' : ''}</span>`;
    if (t.status === 'open') h += `<span class="cl-acts"><button class="btn-small" data-cl="a-close-table" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${dis}>Close</button></span>`;
    h += '</li>';
  }
  for (const t of closed) h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">closed</span><span class="cl-acts"><button class="btn-small" data-cl="a-hide-table" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${dis}>Remove</button></span></li>`;
  h += '</ul>';
  h += tableForm === m.code ? tableFormHtml(m.code) : `<div class="pl-actions"><button class="btn-small" data-cl="a-new-table" data-code="${esc(m.code)}"${dis}>New table</button></div>`;
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
  else if (act === 'dash') { dashTab = b.dataset.tab; render(); }
  else if (act === 'pick') { pick = b.dataset.code; render(); }
  else if (act === 'backup') { backupForm = true; backupNote = ''; render(); root.querySelector('form[data-clform=backup] [name=pw]')?.focus(); }
  else if (act === 'backup-cancel') { backupForm = false; render(); }
  // After creating a club: Skip asks once more, warning it can't be recovered.
  else if (act === 'wiz-skip') setWizard('skip');
  else if (act === 'wiz-back') setWizard('backup');
  else if (act === 'wiz-done') { setWizard(null); dashTab = 'tables'; location.hash = 'clubs'; }
  else if (act === 'share') navigator.share?.({title: club?.name || 'ducy club', text: `Join ${club?.name || 'my club'} on ducy`, url: link()}).catch(() => {});
  else if (act === 'approve') hostAct('approve', {id: b.dataset.id});
  else if (act === 'decline') hostAct('decline', {id: b.dataset.id});
  else if (act === 'remove') { if (confirm('Remove this member from the club?')) hostAct('remove', {id: b.dataset.id}); }
  else if (act === 'revoke') { if (confirm('Make a new invite link? The current link stops working for anyone who hasn’t used it yet.')) hostAct('revoke_invite'); }
  else if (act === 'copy') {
    try { await navigator.clipboard.writeText(link()); } catch { root.querySelector('#cl-link')?.select(); }
    copied = true;
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
  else if (act === 'deny') hostAct('deny', {id: b.dataset.id});
  else if (act === 'rathole') hostAct('settings', {ratholeHours: Number(b.dataset.hours)});
  else if (act === 'sitout-mins') hostAct('settings', {sitOutMins: Number(b.dataset.mins)});
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
  else if (act === 'offer-role') hostAct('offer_assistant', {id: b.dataset.id});
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
  else if (act === 'close-table') closeTable(b.dataset.table);
  else if (act === 'watch') watchTable(b.dataset.table);
  // Hand history and the replayer.
  else if (act === 'hands') toggleHistory(b.dataset.code, b.dataset.who);
  else if (act === 'replay') openReplay(b.dataset.id);
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
  else if (act === 'ask') {
    const code = b.dataset.code;
    const amount = parseChips(root.querySelector(`[data-ask-amt="${code}"]`)?.value);
    const why = root.querySelector(`[data-ask-note="${code}"]`)?.value || '';
    if (!Number.isSafeInteger(amount) || amount <= 0) { alert('Enter an amount above 0, like 50 or 12.50.'); return; }
    sendToHost(code, {type: 'chip_request', club: code, amount, note: why});
  } else if (act === 'cancel-ask') sendToHost(b.dataset.code, {type: 'cancel_request', club: b.dataset.code});
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
  const pid = e.target.dataset?.assign;
  if (pid != null) {
    hostAct('assign_agent', {id: pid, agent: e.target.value || null});
    render();
    return;
  }
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
  startHosting();
  owner?.start();
  for (const m of memberships) connectMembership(m);
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
    owner = createOwner({
      identity: me,
      onChange: () => { if (isRemote()) club = owner.club; render(); },
      onNote: t => { note = t; render(); },
    });
    // Finds the always-on club's record, from IndexedDB if need be.
    await owner.start();
    // A club backup was just restored (Player settings): reopen its club.
    const restored = load(RESTORE_CLUB_KEY, null);
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
    onHostPick(() => { alwaysFailed = null; if (open && view === 'host') render(); });
  }
  if (v !== 'join') justJoined.clear();
  view = v;
  open = true;
  render();
  await startClubs();
  // A club created but not yet backed up (the page closed mid-way): Host
  // goes back to its backup step.
  if (view === 'host' && wizard && wizard.code === myClubCode()) setHostPick('club');
  render();
}

// Opens My clubs on the Players tab, where requests are answered (from a
// notification, play-section.js).
export function showClubPlayers() {
  dashTab = 'players';
  pick = 'own';
  location.hash = 'clubs';
  render();
}

// Leaving the tab keeps the connections open, so a host's club stays
// reachable, and requests keep arriving, while the page is open.
export function closeClubs() {
  open = false;
  if (root) root.hidden = true;
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
  let n = 0;
  if (club?.members) {
    const ms = Object.values(club.members);
    n += ms.filter(m => m.status === 'pending').length;
    n += ms.filter(m => m.status === 'member' && m.request && !m.agentOf).length;
  }
  for (const m of memberships) {
    if (m.status !== 'member') continue;
    if (m.role === 'assistant' && m.admin) n += m.admin.pending.length + m.admin.members.filter(x => x.request).length;
    if (m.agent === 'yes' && m.agentView) n += m.agentView.recruits.length + m.agentView.players.filter(x => x.request).length;
  }
  return n;
}

// Open tables with a free seat across the clubs this browser is in (the
// Play tab's dot when one opens).
export function openSeats() {
  return memberships.filter(m => m.status === 'member')
    .reduce((n, m) => n + (m.tables || []).filter(t => t.taken < t.seats).length, 0);
}

// Asks to join the club in invite `inv` (from a pasted invite link, on the
// Join tab), as `name`.
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
