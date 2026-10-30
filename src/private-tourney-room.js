// Runs a one-off private tournament (#394) over the relay, as play.js runs a
// one-off cash game: the host's tab runs every table (club-tourney-host.js
// over private-tourney.js's stand-in club), and the relay passes messages
// between it and each player's tab. Players join with the code or link. A
// code typed under Join a game goes to play.js's joinTable first, as for a
// cash game; the host answers that it's a tournament (tourney_room), and
// play.js hands the join over here.
//
// Over the relay (guest → host in the clear, as at a cash table; host →
// guest encrypted with a key only the two share, e2e.js, the host's key
// signed with its player ID, which the link names):
//   guest → host  {type: 'e2e_key', key} | {type: 't_register', name} |
//                 {type: 't_leave'} | {type: 't_table', cmd}
//   host → guest  {type: 'host_key', tourney, key} signed, then {enc} of
//                 {type: 't_lobby', …lobbyBody} | {type: 't_update', update}
//                 | {type: 't_error', reason} | {type: 't_removed'}
//   host → a cash table's guest  {type: 'tourney_room'}, in the clear
//
// Everyone's page is Start a game while they're in it (play.js asks this
// file for it): the lobby, how it's going, the results. Once it starts each
// player is taken to their table (play.js's joinTableVia); a player knocked
// out, and everyone at the end, comes back to the page a few seconds after
// the last hand. The host runs it and plays only if they register in the
// lobby (Play in it), as anyone does; when not at a table of their own they
// can watch any.
//
// It lives only in the host's tab: if that closes, the tournament ends
// (saving and resuming it, as a cash game can, is for later).

import { clientId, connect, joinLink, newCode, relayUrl } from './play-net.js';
import { checkSignature, loadIdentity, signMessage } from './identity.js';
import { isPublicKey, newKeyPair, open as openBox, seal, sharedKey } from './e2e.js';
import { createTourneyHost } from './club-tourney-host.js';
import { defaultSeats, maxSeats } from './club-tables.js';
import { structureEditor } from './tourney-structure-ui.js';
import { HOST_ID, MAX_POINTS, PAYOUTS, cleanName, joinPrivate, leavePrivate, lobbyBody, newPrivateTourney, privateClub, setPrizes, theTourney, tourneySettle, tourneyStandings } from './private-tourney.js';
import { bannerText, pageHtml, setupHtml, totalsText } from './private-tourney-ui.js';
import { addPlace, addRow, cleanRows, draftOf, readRows, removeRow } from './payout-table-ui.js';
import { download, fileName } from './oneoff-standings-ui.js';
import { standingsCsv } from './oneoff-standings.js';
import { joinTableVia, setTableName, setTourneyPage, tableName } from './play.js';

const FORM_KEY = 'ducyPrivateTourney';
const OUT_MS = 5000; // the last hand stays on screen this long
const LIVE_MS = 3000; // standings go out at most this often

// ---- the form ----

function loadForm() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(FORM_KEY) || 'null'); } catch {}
  const f = {name: '', game: 'nlhe', stack: 10000, tableSize: 9, payout: 'default', buyIn: 100, ...(s || {})};
  if (!PAYOUTS.some(p => p.id === f.payout)) f.payout = 'default';
  // The payout table by entries (#424), as last typed; none yet: the
  // starter's, made when first needed (tableDraft), as it's the engine's,
  // not loaded yet when this runs.
  const rows = Array.isArray(f.table?.rows) && f.table.rows.length && f.table.rows.every(r => Array.isArray(r?.places)) ? f.table.rows : null;
  f.table = rows ? {rows, cols: Number(f.table.cols) || 0} : null;
  if (!Number.isSafeInteger(f.buyIn) || f.buyIn < 0 || f.buyIn > MAX_POINTS) f.buyIn = 100;
  f.tableSize = Math.min(f.tableSize, maxSeats(f.game));
  return f;
}
const form = loadForm();
const tableDraft = () => (form.table ||= draftOf());
let editor = null;
let formNote = '';
// The blind levels stay open (or shut) as the form is redrawn. (toggle
// doesn't bubble: caught on the way down.)
let levelsOpen = false;
document.addEventListener('toggle', e => { if (e.target.matches?.('[data-tzlevels]')) levelsOpen = e.target.open; }, true);
const ed = () => (editor ||= structureEditor({stack: form.stack, tableSize: form.tableSize}));

function saveForm() {
  const {game, stack, tableSize, payout, buyIn, table} = form;
  try { localStorage.setItem(FORM_KEY, JSON.stringify({game, stack, tableSize, payout, buyIn, table})); } catch {}
}

// Reads the typed fields into the form.
function readForm(wrap) {
  const v = sel => wrap.querySelector(sel)?.value;
  if (v('[data-tzform] [name=name]') != null) form.name = String(v('[data-tzform] [name=name]')).trim().slice(0, 40);
  const stack = Number(v('[data-tzform] [name=stack]'));
  if (Number.isSafeInteger(stack) && stack >= 20 && stack !== form.stack) { form.stack = stack; ed().setStack(stack); }
  const buyIn = v('[data-tzform] [name=buyin]');
  if (buyIn != null) form.buyIn = buyIn === '' ? 0 : Number(buyIn);
  const rows = wrap.querySelector('[data-tzform] [data-tzrows]');
  if (rows) form.table = readRows(rows, tableDraft());
}

// ---- where things are ----

let role = null; // 'host' | 'guest' while in a tournament
let code = '';
let net = null;
let session = 0; // bumped on leaving, so late messages are ignored
let body = null; // the tournament as last seen (lobbyBody)
let note = '';
let connecting = true;
let seat = null; // {handlers} while at its table
let stood = false; // left the table: don't take them back to it unasked
let outTimer = null;
let linkHost = ''; // the host's player ID, for the link

// The host: the stand-in club, its tournament host, keys, and each guest.
let club = null, runner = null, keys = null, ident = null, liveTimer = null;
const guests = new Map(); // relay id → {key, sends, inbox}
const online = new Set();
// A guest: their keys and the key shared with the host.
let gkeys = null, aes = null, aesFor = '', hostId = '', inbox = Promise.resolve();

const myId = () => (role === 'host' ? HOST_ID : clientId());
const ctx = (client, hostPub, guestPub) => ({context: `tourney:${code}`, hostId: '', playerId: client, hostPub, playerPub: guestPub});
const tid = () => theTourney(club)?.id;
const mine = () => body?.players.find(p => p.id === myId()) || null;

// The prizes the host is typing, not saved yet (#403): kept over redraws.
let draft = null;

const redrawPage = setTourneyPage({
  active: () => !!role,
  html: () => pageHtml(body, {me: myId(), host: role === 'host', link: code ? joinLink(code, linkHost) : '', note, atTable: !!seat, connecting, watching: watching?.table ?? null, draft}),
  setupHtml: lead => setupHtml(form, ed(), {lead, note: formNote, levelsOpen, placeholder: tableName() ? `${tableName()}’s tournament` : 'Friday night tournament'}),
  click, change, join: joinPrivateTourney,
});

// Redraws, the host's place in a prize box kept: the standings redraw the
// page every few seconds while it runs (#403).
function redraw() {
  const el = document.activeElement;
  const i = el?.matches?.('[data-tzprize]') ? el.dataset.tzprize : null;
  const at = i != null ? [el.selectionStart, el.selectionEnd] : null;
  redrawPage();
  if (i == null) return;
  const box = document.querySelector(`[data-tzprize="${i}"]`);
  if (!box) return;
  box.focus();
  try { box.setSelectionRange(...at); } catch {} // (number inputs have no selection)
}

// Typing a prize: the totals follow, without a redraw.
document.addEventListener('input', e => {
  if (!e.target.matches?.('[data-tzprize]') || role !== 'host') return;
  draft = readPrizes();
  const t = document.querySelector('[data-tztotals]');
  if (t && body) t.textContent = totalsText(body, draft);
});

// The prize boxes as typed: whole points, an empty or bad box 0.
function readPrizes() {
  return [...document.querySelectorAll('[data-tzprize]')].map(el => {
    const n = Number(el.value);
    return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, MAX_POINTS) : 0;
  });
}

// Saves the host's prizes (null: back to the split of the buy-ins).
function savePrizes(list, quiet = false) {
  draft = null;
  try { setPrizes(club, list); note = ''; } catch (e) { note = e.message; quiet = false; }
  publish(quiet);
}

// The standings and settle-up list as a file (#403).
function downloadStandings() {
  if (!body) return;
  const csv = standingsCsv(tourneyStandings(body), tourneySettle(body), [
    ['Player', r => r.name], ['Buy-in', r => r.buyIn], ['Won', r => r.won], ['Added', r => r.added], ['Net', r => r.net],
  ], String);
  download(fileName(body.name), csv);
}

// The clock on the page (the next level) moves while it runs.
setInterval(() => { if (role && body?.status === 'running' && location.hash === '#host') redraw(); }, 20_000);

// ---- hosting ----

async function openLobby(wrap) {
  readForm(wrap);
  const name = wrap.querySelector('#pl-name')?.value;
  if (name != null && cleanName(name)) setTableName(name);
  formNote = '';
  if (!cleanName(tableName())) formNote = 'Enter your name: it’s what the others see.';
  else if (!relayUrl()) formNote = 'Games with other people need ducy’s relay, which isn’t set up here.';
  else if (ed().errors().length) formNote = ed().errors()[0];
  if (formNote) { redraw(); return; }
  const c = privateClub(newCode(), tableName());
  try {
    newPrivateTourney(c, {...form, structure: ed().steps(), rows: form.payout === 'table' ? cleanRows(tableDraft()) : null});
  } catch (e) {
    formNote = e.message;
    redraw();
    return;
  }
  saveForm();
  start('host');
  club = c;
  code = c.code;
  keys = newKeyPair();
  ident = loadIdentity().then(i => { linkHost = i?.id || ''; redraw(); return i; }).catch(() => null);
  runner = createTourneyHost({
    club: () => club, save() {}, sendTable, chipsChanged() {}, store: null,
    tourneysChanged: () => publish(), liveChanged: liveSoon, online: id => id === HOST_ID || online.has(id),
    observe: (id, res) => watched(res),
  });
  const s = session;
  net = connect(code, 'host', null, {
    // The relay tells us again who's connected.
    onOpen() { if (s === session) { online.clear(); publish(); } },
    onMessage(m) {
      if (s !== session) return;
      if (m.event === 'open') { online.add(m.from); sendHostKey(m.from); publish(); }
      else if (m.event === 'close') { online.delete(m.from); runner?.disconnected(m.from); publish(); }
      else if (m.data) hostIncoming(m.from, m.data);
    },
    onStatus(t) { if (s === session) { note = t; redraw(); } },
    // (Only when the code is in use, or the relay refused us: back to the form.)
    onFail(t) { if (s === session) { end(); formNote = t; redraw(); } },
  }, {heartbeat: true, persistent: true, inUse: 'That code is in use. Open the lobby again for another.'});
  window.addEventListener('beforeunload', warnLeaving);
  publish();
  location.hash = 'host';
}

// Closing the host's tab ends the tournament for everyone: ask first.
function warnLeaving(e) {
  if (role === 'host' && (body?.status === 'scheduled' || body?.status === 'running')) { e.preventDefault(); e.returnValue = ''; }
}

function guest(id) {
  let g = guests.get(id);
  if (!g) guests.set(id, (g = {key: null, sends: Promise.resolve(), inbox: Promise.resolve()}));
  return g;
}

async function sendHostKey(to) {
  const key = (await keys).pub;
  const b = {type: 'host_key', tourney: code, key};
  const me = await ident;
  net?.send({to, data: me ? await signMessage(me, b) : b});
}

// An update for guest `to`, encrypted; without their key it isn't sent.
function sendTo(to, data) {
  const g = guests.get(to);
  if (!g?.key) return;
  g.sends = g.sends.then(async () => { net?.send({to, data: {enc: await seal(g.key, data)}}); }).catch(e => console.warn(e));
}

const registered = id => !!body?.players.some(p => p.id === id);

// A message from guest `from`, in the order it arrived.
function hostIncoming(from, data) {
  const g = guest(from);
  const s = session;
  g.inbox = g.inbox.then(async () => {
    if (s !== session) return;
    // Heard from: connected (the relay's open and close can cross on a reconnect).
    if (!online.has(from)) { online.add(from); publish(); }
    if (data?.type === 'e2e_key') {
      if (!isPublicKey(data.key)) return;
      const hk = await keys;
      g.key = await sharedKey(hk, data.key, ctx(from, hk.pub, data.key));
      if (registered(from)) sendTo(from, body);
      return;
    }
    // Someone joining with the code as for a cash game: say what it is.
    if (data?.type === 'join') { net?.send({to: from, data: {type: 'tourney_room'}}); return; }
    if (data?.type === 't_register') {
      try { joinPrivate(club, from, data.name); publish(); } catch (e) { sendTo(from, {type: 't_error', reason: e.message}); }
      return;
    }
    if (data?.type === 't_leave') { if (leavePrivate(club, from)) publish(); return; }
    if (data?.type === 't_table' && data.cmd && typeof data.cmd === 'object' && runner?.running(tid())) await runner.handle(tid(), from, data.cmd);
  }).catch(e => console.warn(e));
}

// A table update from the tournament: ours, or a guest's.
function sendTable(to, msg) {
  if (to === HOST_ID) tableUpdate(msg.update);
  else sendTo(to, {type: 't_update', update: msg.update});
}

// The tournament changed: everyone in it is told, and this page follows.
// `quiet`: this page is left as it is (a prize just typed, #403: redrawing
// now would swallow a click on the page that blurred the box).
function publish(quiet = false) {
  if (role !== 'host' || !club) return;
  const b = lobbyBody(club, runner?.live()[tid()] || null);
  if (!b) return;
  for (const p of b.players) p.away = p.id !== HOST_ID && !online.has(p.id);
  body = b;
  for (const p of b.players) if (p.id !== HOST_ID) sendTo(p.id, b);
  follow();
  if (!quiet) redraw();
}

// Only the standings moved: told now and then, not after every action.
function liveSoon() {
  if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; publish(); }, LIVE_MS);
}

function startIt() {
  const t = theTourney(club);
  if (!t || t.status !== 'scheduled' || body.players.length < 2) return;
  t.startsAt = Date.now();
  stood = false;
  runner.begin(t.id);
}

// The host plays in it, or not after all, before the start: registered
// like anyone else, under the name they play as.
function hostPlays(on) {
  if (!club || body?.status !== 'scheduled') return;
  try {
    if (on) joinPrivate(club, HOST_ID, tableName());
    else leavePrivate(club, HOST_ID);
  } catch (e) { note = e.message; }
  publish();
}

// ---- the host watching a table ----
//
// A host who isn't at a table of their own watches any, as a club's host
// watches a cash table: the spectator's view (no hidden cards), after every
// change. If that table is broken, the watch moves to another.

let watching = null; // {table, handlers, seq}

function watchTable(table) {
  if (role !== 'host' || !runner?.running(tid())) return;
  if (watching) { watching.table = table; location.hash = 'play'; refreshWatch(); return; }
  joinTableVia(handlers => {
    watching = {table, handlers, seq: 0};
    return {send() {}, close: () => { watching = null; }};
  }, {
    label: `${body.name} (watching)`, watch: true, whole: true, club: false,
    banner: () => bannerText(body),
    onLeave: () => { watching = null; if (location.hash !== '#host') location.hash = 'host'; else redraw(); },
  });
  location.hash = 'play';
  refreshWatch();
}

// After each engine result: the watched table's view, if it changed.
function watched(res) {
  if (!watching) return;
  const ids = (res.tables || []).map(x => x.id);
  if (ids.length && !ids.includes(watching.table)) watching.table = ids[0];
  watching.seq = Math.max(watching.seq, Number(res.seq) || 0);
  watching.turnMs = res.tables?.find(x => x.id === watching.table)?.turnMsLeft ?? null;
  refreshWatch();
}

function refreshWatch() {
  const w = watching;
  if (!w || !runner) return;
  runner.tableView(tid(), w.table).then(view => {
    if (watching === w && view) w.handlers.onMessage({type: 'state', seq: w.seq, view, turn_ms_left: w.turnMs});
  }, e => console.warn(e));
}

function removePlayer(id) {
  const p = body?.players.find(x => x.id === id);
  if (!p || !confirm(`Take ${p.name} off the list?`)) return;
  sendTo(id, {type: 't_removed'});
  if (leavePrivate(club, id)) publish();
}

// ---- joining ----

// Joins tournament `code` as `name` (Join a game, through play.js's
// joinTable). `hostId`, from the link, is the host's player ID its key is
// checked against.
export function joinPrivateTourney({code: c, name, hostId: hid = ''}) {
  if (role) end();
  if (cleanName(name) && name !== tableName()) setTableName(name);
  start('guest');
  code = c;
  hostId = hid;
  linkHost = hid;
  gkeys = newKeyPair();
  aes = null;
  aesFor = '';
  inbox = Promise.resolve();
  const s = session;
  net = connect(code, 'guest', clientId(), {
    // Our key first, then registering, so the host can answer encrypted.
    // Again after a drop: the host keeps the entry.
    async onOpen() {
      if (s !== session) return;
      const key = (await gkeys).pub;
      net?.send({type: 'e2e_key', key});
      net?.send({type: 't_register', name: tableName()});
    },
    onMessage(m) { if (s === session) guestIncoming(m); },
    onStatus(t) { if (s === session) { note = t; redraw(); } },
    onFail(t) { if (s === session) disconnect(t); },
  }, {persistent: true});
  location.hash = 'host';
  redraw();
}

// A guest's incoming message, in order: the host's key, then encrypted
// messages. Anything else unencrypted is ignored but the relay's host_gone.
function guestIncoming(m) {
  const s = session;
  inbox = inbox.then(async () => {
    if (s !== session) return;
    if (m?.type === 'host_key' || m?.body?.type === 'host_key') {
      const signed = !!m.sig;
      if (signed && (await checkSignature(m) || (hostId && m.from !== hostId))) { console.warn('tournament: a host key that isn’t from the host; ignored'); return; }
      if (!signed && hostId) { console.warn('tournament: an unsigned host key; ignored'); return; }
      const b = signed ? m.body : m;
      if (b.tourney !== code || !isPublicKey(b.key) || b.key === aesFor) return;
      const gk = await gkeys;
      aes = await sharedKey(gk, b.key, ctx(clientId(), b.key, gk.pub));
      aesFor = b.key;
      return;
    }
    if (m?.enc) {
      if (!aes) return;
      let u;
      try { u = await openBox(aes, m.enc); } catch { console.warn('tournament: a message didn’t decrypt; ignored'); return; }
      guestMessage(u);
      return;
    }
    if (m?.type === 'host_gone') { note = 'The host is reconnecting…'; redraw(); }
  }).catch(e => console.warn(e));
}

function guestMessage(u) {
  if (u?.type === 't_lobby') {
    body = u;
    connecting = false;
    if (note === 'The host is reconnecting…' || note === 'Reconnecting…') note = '';
    follow();
    redraw();
  } else if (u?.type === 't_update') tableUpdate(u.update);
  // Not registered (it started, or no name): nothing more to wait for.
  else if (u?.type === 't_error') {
    const why = String(u.reason || '').slice(0, 200);
    if (!body) disconnect(why); else { note = why; redraw(); }
  }
  else if (u?.type === 't_removed') disconnect('The host took you off the list.');
}

// A guest who can't go on: the page says why, with a way out.
function disconnect(why) {
  standUp();
  session++;
  net?.close();
  net = null;
  body = null;
  connecting = false;
  note = why;
  redraw();
}

// ---- at the table ----

function tableUpdate(u) {
  if (!seat || !u) return;
  if (u.type === 'rejected' && u.fatal) seat.handlers.onFail(u.reason);
  else seat.handlers.onMessage(u);
}

// A command from our seat: to the tables, while we're still in.
function sendCmd(cmd) {
  const p = mine();
  if (body?.status !== 'running' || !p || p.place != null) return;
  if (role === 'host') runner?.handle(tid(), HOST_ID, cmd);
  else net?.send({type: 't_table', cmd});
}

function sit() {
  if (!body || body.status !== 'running') return;
  joinTableVia(handlers => {
    seat = {handlers};
    return {send: sendCmd, close: () => { seat = null; }};
  }, {
    label: body.name, whole: true, club: false,
    banner: () => bannerText(body),
    // Leaving the table blinds you off (the tournament goes on); the page
    // offers the way back.
    onLeave: why => {
      seat = null;
      stood = true;
      if (why) note = why;
      if (location.hash !== '#host') location.hash = 'host';
      else redraw();
    },
  });
  stood = false;
  location.hash = 'play';
}

// Off the table, quietly (knocked out, the end, or leaving the tournament),
// or done watching one.
function standUp() {
  clearTimeout(outTimer);
  outTimer = null;
  if (seat) seat.handlers.onFail('');
  if (watching) watching.handlers.onFail('');
}

// The tournament as it now is, for this player: to the table when it starts,
// and back to the page a few seconds after they're out or it's over. A host
// watching comes back at the end.
function follow() {
  if (watching && body?.status !== 'running' && !outTimer) outTimer = setTimeout(() => { outTimer = null; standUp(); }, OUT_MS);
  const p = mine();
  if (!body || !p) return;
  if (body.status === 'running' && p.place == null && !seat && !stood) sit();
  const done = body.status !== 'running' || p.place != null;
  if (seat && done && !outTimer) outTimer = setTimeout(() => { outTimer = null; standUp(); }, OUT_MS);
}

// ---- starting and ending ----

function start(r) {
  end();
  session++;
  role = r;
  body = null;
  draft = null;
  note = '';
  connecting = true;
  seat = null;
  stood = false;
  linkHost = '';
}

// Out of the tournament: the host's ends for everyone (cancelled if it
// hadn't finished).
function end() {
  if (!role) return;
  standUp();
  if (role === 'host') {
    const t = theTourney(club);
    if (t && (t.status === 'scheduled' || t.status === 'running')) runner?.cancel(t.id, 'the host closed it');
    clearTimeout(liveTimer);
    liveTimer = null;
    window.removeEventListener('beforeunload', warnLeaving);
  }
  session++;
  // Let the last messages (a cancellation, leaving) go before closing.
  const n = net;
  if (n) setTimeout(() => n.close(), 300);
  net = null;
  role = null;
  club = runner = keys = ident = null;
  guests.clear();
  online.clear();
  body = null;
  code = '';
  connecting = true;
  redraw();
}

async function copyLink() {
  const link = joinLink(code, linkHost);
  try { await navigator.clipboard.writeText(link); note = 'Link copied'; } catch { note = link; }
  redraw();
  setTimeout(() => { if (note === 'Link copied') { note = ''; redraw(); } }, 3000);
}

// ---- clicks ----

// A click on the form or the page; true when it was ours.
function click(e) {
  const b = e.target.closest('[data-tz],[data-tzgame],[data-tzsize],[data-tzpay],[data-ts]');
  if (!b) return false;
  const wrap = b.closest('.pl-wrap') || document;
  const d = b.dataset;
  // The form's choices: the typed fields are read first, as it's redrawn.
  if (b.closest('[data-tzform]')) {
    readForm(wrap);
    if (d.ts != null) { if (ed().click(e)) redraw(); return true; }
    if (d.tzgame) {
      form.game = d.tzgame;
      form.tableSize = Math.min(defaultSeats(form.game), maxSeats(form.game));
    }
    if (d.tzsize) form.tableSize = Math.min(+d.tzsize, maxSeats(form.game));
    if (d.tzpay) form.payout = d.tzpay;
    // The payout table by entries (#424): a row more or less, a place more.
    if (d.tz === 'prow-add') addRow(tableDraft());
    else if (d.tz === 'prow-remove') removeRow(tableDraft(), Number(d.i));
    else if (d.tz === 'pcol-add') addPlace(tableDraft());
    if (d.tz === 'open') { openLobby(wrap); return true; }
    saveForm();
    redraw();
    return true;
  }
  if (!role || !d.tz) return false;
  if (d.tz === 'start') startIt();
  else if (d.tz === 'play' || d.tz === 'unplay') hostPlays(d.tz === 'play');
  else if (d.tz === 'watch') watchTable(Number(d.table));
  else if (d.tz === 'remove') removePlayer(d.id);
  else if (d.tz === 'cancel') { if (confirm('Cancel the tournament? Everyone registered is told.')) runner?.cancel(tid(), 'the host cancelled it'); }
  else if (d.tz === 'leave') { if (confirm('Leave the tournament?')) { net?.send({type: 't_leave'}); end(); } }
  else if (d.tz === 'done') end();
  else if (d.tz === 'table') { stood = false; if (seat) location.hash = 'play'; else sit(); }
  else if (d.tz === 'copy') copyLink();
  // The host's prizes (#403): a place more (of 0) or less, or back to the split.
  else if (d.tz === 'addplace' && role === 'host') savePrizes([...readPrizes(), 0]);
  else if (d.tz === 'unplace' && role === 'host') savePrizes(readPrizes().filter((_, i) => i !== Number(d.i)));
  else if (d.tz === 'autoprizes' && role === 'host') savePrizes(null);
  else if (d.tz === 'download') downloadStandings();
  else return false;
  return true;
}

// A field changed on the form: the blind levels and the starting stack
// redraw it; true when it was ours.
function change(e) {
  // A prize typed and left (#403): saved, and everyone sees it.
  if (e.target.matches('[data-tzprize]')) { if (role === 'host') savePrizes(readPrizes(), true); return true; }
  const wrap = e.target.closest('[data-tzform]');
  if (!wrap) return false;
  readForm(wrap.closest('.pl-wrap') || document);
  if (e.target.closest('[data-ts-k]')) { if (ed().input(e)) redraw(); return true; }
  if (e.target.matches('[data-tzstack],[data-tzbuyin]')) { saveForm(); redraw(); }
  return true;
}
