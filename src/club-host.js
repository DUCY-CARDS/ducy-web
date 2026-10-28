// Runs a club's tables in the host's tab (#68). Each table is ducy's
// MultiTable.club with its table runner (table-runner.js), in a worker
// (play-worker.js): no seat for the host, real chips. The runner has the
// table's time (the turn clock, the next hand, away players, fair deals,
// idle seats, the wait after a restart); this file is the club's side: it
// feeds the runner members' table commands and presence, sends each member
// their own view, answers chip requests from the club ledger, returns the
// chips of anyone who leaves, keeps the ledger in step between hands, and
// wakes the runner when it asks.
//
// clubs.js owns the club object and the relay; it passes in:
//   club()              the current club object
//   save()              persist the club
//   sendTable(to, msg)  send a table message (unsigned; only the host can reach a member)
//   chipsChanged(id)    a member's balance changed: send them their account
//   tablesChanged()     seat counts or tables changed: tell members
//   onHand(table, view, players) a hand finished (the host's view: no hidden
//                       cards; players: [{seat, client_id}], who sat where)
//   online(id)          whether a member is connected to the relay
//   onPlay()            a hand is in play at a table (for usage, #421)
//
// Moving tables (#425): someone at one table reserves a seat at another
// (club-tables.js reserveSeat; a manager can do it for them). They finish
// the hand they're in, then leave as usual (cash-out, the rathole rule;
// the hit-and-run rule stops them reserving while they owe hands), and
// their page sits them at the new table with the usual buy-in. The seat
// is held while they finish their hand, then holdMs for them to sit down
// (from reserving, if they weren't in a hand). A folded seat stays at the
// table until the hand is over (ducy's engine), so the time starts then.

import {
  canJoin, cashOutTable, chipsForTable, dropReservation, handsToStay, heldSeats, HOLD_MS, leftTable, limits, nextLapse,
  pruneReservations, reservations, reserveSeat, stayText, syncStacks, tableById, tableLedgerN,
} from './club-tables.js';
import { creditOf, ratholeMin, refundTopUp } from './club-chips.js';
import { logAction } from './club-log.js';
import { dropTable, getTable, putTable } from './table-store.js';
import { dealClock, isDealing } from './club-overview.js';
import { ASK_MS, IDLE_MS } from './table-runner.js';

export { ASK_MS, IDLE_MS };

let worker = null, nextId = 0;
const pending = new Map();

// The page's engine: play-worker.js in a Web Worker.
export function workerCall(op, ...args) {
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

const num = v => Number(v);

// The page's timers.
export const browserTimers = {set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h)};

// `call(op, ...args)` runs club-engine.js ops (by default in the page's
// worker), and `store` keeps saved tables (by default in IndexedDB,
// table-store.js); an always-on club passes its own (#93). `timers`
// ({set(fn, ms) → handle, clear(handle)}) wakes each table's runner when it
// asks; an always-on club's room backs it with its alarm (#135), so the
// room can sleep between turns and a restart doesn't lose them.
export function createTableHost({
  club, save, sendTable, chipsChanged, tablesChanged, onHand, online = () => true, onPlay = () => {},
  call = workerCall, store = {get: getTable, put: putTable, drop: dropTable}, timers = browserTimers,
  idleMs = IDLE_MS, askMs = ASK_MS, holdMs = HOLD_MS,
}) {
  const running = new Map(); // table id → {chain, players, view, complete, handNumber, asking: Set(seat), wakeT, ...}
  const at = new Map(); // member id → table id
  const watchers = new Map(); // table id → Set(fn(update))
  let linkOk = true;

  // Table tid's dealing clock (#398, club-overview.js): it runs while a hand
  // is being played, or between hands while two or more are in to deal to,
  // and not while the table's clock is stopped or it's closing. Returns
  // whether it started or stopped.
  function dealingNow(tid) {
    const r = running.get(tid), t = tableById(club(), tid);
    if (!t) return false;
    const on = !!r && !r.stopped && !r.paused && t.status === 'open' && (!r.complete || r.playersIn >= 2);
    const was = isDealing(t.dealing);
    t.dealing = dealClock(t.dealing, on);
    return was !== on;
  }

  // The host's link to the relay is up (true) or down: each table's clock
  // stops while it's down (an outage shouldn't fold everyone).
  function setLink(ok) {
    linkOk = ok;
    for (const tid of running.keys()) run(tid, {type: 'link', ok});
  }

  // Calls fn with the table's spectator view now and after every change.
  // Returns a function that stops watching.
  function watch(tid, fn) {
    if (!watchers.has(tid)) watchers.set(tid, new Set());
    watchers.get(tid).add(fn);
    run(tid, {type: 'state'});
    return () => watchers.get(tid)?.delete(fn);
  }

  // Sends table tid's runner an event, one at a time, and handles its step.
  function run(tid, ev) {
    const r = running.get(tid);
    if (!r) return Promise.resolve(null);
    const p = r.chain.then(async () => {
      if (!running.has(tid)) return null;
      const step = await call('runnerEvent', tid, ev);
      await apply(tid, r, step);
      return step;
    });
    r.chain = p.catch(e => console.warn(`table ${tid} ${ev.type}:`, e));
    return p;
  }

  // What the runner did: engine results, messages, idle seats; then its
  // next wake-up.
  async function apply(tid, r, step) {
    r.stopped = step.stopped;
    r.paused = step.paused;
    if (dealingNow(tid)) save();
    for (const a of step.actions) {
      if (!running.has(tid)) return;
      if (a.type === 'engine') {
        // The ledger first, then the table on disk, then the messages: after
        // a crash the table is never behind what anyone was shown (#107).
        const t = after(tid, a.res);
        if (!t) continue;
        await persist(tid, a.res);
        send(tid, a.res);
        if (t.status === 'closing' && !r.players.length) { drop(tid); return; }
      } else if (a.type === 'send') {
        sendTable(a.to, {type: 'table', table: tid, update: a.update});
      } else if (a.type === 'active') {
        const s = club().members[a.id]?.seat;
        if (s?.table === tid) s.active = a.at;
      } else if (a.type === 'idle') {
        const p = r.players.find(x => x.client_id === a.id);
        if (p) standIdle(tid, p);
      }
    }
    timers.clear(r.wakeT);
    r.wakeT = null;
    if (step.wake != null) {
      r.wakeT = timers.set(() => { r.wakeT = null; run(tid, {type: 'wake'}); }, Math.max(0, step.wake - Date.now()));
    }
  }

  // Saves the table (#107) when its state changed, so a hand in progress
  // can resume if the page closes. A table that can't be saved (an older
  // ducy-wasm, or storage blocked) just plays on, as before. Not while the
  // engine holds a chip request: the ledger has already paid an approved one
  // that the engine hasn't added yet, so a table restored from then would
  // lose those chips and ask for them again (#427). The approve or deny
  // that follows is saved.
  async function persist(tid, res) {
    const r = running.get(tid);
    if (!r || r.noSave || res.seq === r.savedSeq || res.chipRequests?.length) return;
    try {
      const json = await call('runnerSave', tid);
      if (json == null) { r.noSave = true; return; }
      await store.put(club().code, tid, {json, ledgerN: tableLedgerN(club(), tid), seq: res.seq, at: Date.now()});
      r.savedSeq = res.seq;
    } catch (e) {
      console.warn(`table ${tid}: not saved:`, e);
    }
  }

  function send(tid, res) {
    for (const m of res.out) sendTable(m.to, {type: 'table', table: tid, update: m.data});
    // The host watching (#73): the engine's host view shows no hidden cards.
    // Who sits where, and who's being removed, for the seats' ⋯ (#414).
    const watching = watchers.get(tid);
    if (!watching?.size) return;
    const players = (res.players || []).map(p => ({id: p.client_id, seat: p.seat, ...removalOf(p.client_id, tid), ...(moveOf(p.client_id, tid) ? {moving: moveOf(p.client_id, tid).to} : {})}));
    for (const fn of watching) fn({type: 'state', seq: res.seq, view: res.state, turn_ms_left: res.turnMsLeft, players});
  }

  // Takes in an engine result: who's seated, chips that came and went, the
  // hand that finished. Returns the table, or null if it's gone.
  function after(tid, res) {
    const r = running.get(tid);
    const t = tableById(club(), tid);
    if (!r || !t) return null;
    const before = r.players.length;
    r.players = res.players || [];
    for (const p of r.players) {
      // Someone new: the runner hears whether they're connected.
      if (at.get(p.client_id) !== tid) { at.set(p.client_id, tid); run(tid, {type: 'presence', id: p.client_id, on: online(p.client_id)}); }
    }
    let changed = false;
    // Chips people left with go back to their club balance.
    for (const d of res.departed || []) {
      if (at.get(d.client_id) === tid) at.delete(d.client_id);
      r.removed?.delete(d.client_id);
      const s = club().members[d.client_id]?.seat;
      const removing = s?.table === tid ? s.removing : null, put = s?.put;
      // Leaving for a seat held at another table (#425).
      const to = (s?.table === tid && s.moving?.to) || r.moves?.get(d.client_id);
      r.moves?.delete(d.client_id);
      r.leaving?.delete(d.client_id);
      if (leftTable(club(), d.client_id, num(d.chips))) { changed = true; chipsChanged(d.client_id); }
      if (removing) removed(t, d.client_id, removing, num(d.chips), put);
      else if (to) { movedOut(t, d.client_id, to, num(d.chips)); changed = true; }
    }
    // Top-ups the table capped at its maximum: the rest goes back to the balance.
    for (const f of res.refunds || []) {
      if (!club().members[f.client_id]?.seat || !num(f.chips)) continue;
      refundTopUp(club(), f.client_id, num(f.chips));
      changed = true;
      chipsChanged(f.client_id);
    }
    const state = res.state;
    r.view = state;
    r.complete = !!state.complete;
    r.handNumber = num(state.hand_number);
    if (!r.complete) onPlay();
    // A hand just finished: for the host's hand history (#71).
    if (r.complete && r.handNumber && r.handNumber !== r.recorded) {
      r.recorded = r.handNumber;
      onHand?.(tid, state, r.players);
    }
    r.playersIn = num(res.playersIn) || 0;
    if (dealingNow(tid)) changed = true;
    // Between hands the engine's count is the truth.
    if (r.complete) syncStacks(club(), r.players, r.handNumber);
    // The hand is over: anyone the manager is removing stands up now (#414).
    if (r.complete) for (const p of r.players) if (removalOf(p.client_id, tid).removing) standUp(tid, p);
    // And anyone moving to another table leaves now (#425).
    if (r.complete) for (const p of r.players) if (!removalOf(p.client_id, tid).removing && moveOf(p.client_id, tid)) leaveToMove(tid, p);
    // The hit-and-run rule: each player hears how many hands they still owe
    // the table whenever that changes, so their Leave button can say so.
    if (t.stayHands) {
      r.stay ??= new Map();
      const done = completedHands(r);
      for (const p of r.players) {
        // Being removed: the manager overrides the rule (#414).
        if (removalOf(p.client_id, tid).removing) continue;
        const left = handsToStay(club(), p.client_id, t, done);
        const was = r.stay.get(p.client_id);
        if (was === left) continue;
        r.stay.set(p.client_id, left);
        sendTable(p.client_id, {type: 'table', table: tid, update: {type: 'stay', hands: left}});
        // Owing hands, sitting out or dropping off blinds them off (dealt in,
        // checking or folding) rather than taking them out of the count.
        if (!was !== !left) run(tid, {type: 'mustPlay', id: p.client_id, on: left > 0});
      }
    }
    // Chip requests: approved if the club ledger allows them.
    for (const q of res.chipRequests || []) {
      if (r.asking.has(q.seat)) continue;
      r.asking.add(q.seat);
      const who = r.players.find(p => p.seat === q.seat)?.client_id;
      let ok = false, why = '', ask = false;
      try {
        if (!who) throw new Error('No one in that seat.');
        chipsForTable(club(), who, t, num(q.amount));
        ok = true;
        changed = true;
      } catch (e) {
        why = e.message;
        // Too little available: the panel offers to ask the manager (#404).
        ask = !!e.short;
      }
      run(tid, {type: 'chips', seat: q.seat, ok}).finally(() => r.asking.delete(q.seat));
      if (ok) chipsChanged(who);
      else if (who) sendTable(who, {type: 'table', table: tid, update: {type: 'rejected', reason: why, chips: true, ...(ask ? {ask: true} : {})}});
    }
    // Save when chips moved or a hand ended, not on every tick.
    if (changed || (r.complete && r.handNumber !== r.saved)) { r.saved = r.handNumber; save(); }
    if (before !== r.players.length) tablesChanged();
    return t;
  }

  // Stands up idle player `p` (#421), as when the manager removes them
  // (#414): the usual cash-out, the hit-and-run rule overridden, a line in
  // the log.
  function standIdle(tid, p) {
    const m = club().members[p.client_id];
    if (m?.seat?.table === tid) { m.seat.removing = {by: null, idle: true, at: Date.now()}; save(); }
    run(tid, {type: 'mustPlay', id: p.client_id, on: false});
    return standUp(tid, p, {idle: true});
  }

  // Thrown to stop starting a closing table that couldn't resume.
  class Closed extends Error {}

  // Starts table `t`. With `resume` (the host's page just opened), a table
  // saved with a hand in progress picks up where it was (#107); one that
  // can't (none saved, out of step with the ledger, unreadable) starts
  // afresh, and whoever was seated there gets the chips the ledger last had
  // for them, as before. A table that was closing (#117) finishes its hand
  // and closes, or, if it can't resume, is closed there and then.
  async function start(t, {resume = false} = {}) {
    if (running.has(t.id)) return;
    // Seats held when the club last stopped lapse on time (#425).
    armHolds();
    // A clock left running when the club last stopped: the time since isn't
    // known to have been dealt, so it starts again from here (#398).
    if (isDealing(t.dealing)) t.dealing = {...t.dealing, since: null};
    const {min, max} = limits(t);
    const r = {chain: Promise.resolve(), players: [], asking: new Set(), handNumber: 0, complete: true, wakeT: null};
    running.set(t.id, r);
    const config = {
      seats: t.seats, minBuyIn: min, maxBuyIn: max, sb: t.sb, bb: t.bb, seed: crypto.getRandomValues(new Uint32Array(1))[0],
      game: t.game, turnMs: t.turnSecs * 1000, sitOutMs: (t.sitOutMins ?? 10) * 60_000,
      open: t.status === 'open', link: linkOk, idleMs, askMs,
    };
    let resumed = false;
    r.chain = (resume ? restore(t, r, config).catch(e => { console.warn(`table ${t.id}: not resumed:`, e); return false; }) : Promise.resolve(false))
      .then(ok => {
        resumed = ok;
        if (ok) return;
        if (resume && cashOutTable(club(), t.id).length) save();
        // A closing table that can't resume is done: everyone's been settled.
        if (t.status === 'closing') throw new Closed();
        return call('runnerCreate', t.id, config);
      })
      .catch(e => {
        if (!(e instanceof Closed)) console.warn(e);
        timers.clear(r.wakeT);
        running.delete(t.id);
        if (resume && cashOutTable(club(), t.id).length) save();
        if (t.status === 'closing') { t.status = 'closed'; save(); }
      });
    await r.chain;
    // The resumed table's state: who's seated, for joins and the host's view;
    // its people get a while to come back. Players still connected never
    // left (an always-on club's room woke after sleeping, #135): they're
    // back already, and if everyone is, play goes straight on.
    if (resumed) await run(t.id, {type: 'state'});
    // A table that was closing finishes its hand, then closes (#117).
    if (running.has(t.id) && t.status === 'closing') await close(t.id);
  }

  // Loads table `t`'s saved snapshot, if it's usable. Resolves to whether
  // the table was resumed.
  async function restore(t, r, config) {
    const rec = await store.get(club().code, t.id);
    if (!rec) return false;
    if (rec.ledgerN !== tableLedgerN(club(), t.id)) {
      console.warn(`table ${t.id}: the saved hand is out of step with the ledger; not resumed`);
      return false;
    }
    // Idle seats count on from each one's last activity.
    const active = {};
    for (const m of Object.values(club().members)) if (m.seat?.table === t.id && m.seat.active) active[m.id] = m.seat.active;
    if (!await call('runnerRestore', t.id, rec.json, {...config, active})) {
      console.warn(`table ${t.id}: saved with a chip request open; not resumed`);
      return false;
    }
    r.savedSeq = rec.seq;
    return true;
  }

  // Stops taking players, removes everyone (they leave at the end of the
  // hand, with their chips), then drops the table.
  async function close(tid) {
    const r = running.get(tid);
    if (!r) return drop(tid);
    await run(tid, {type: 'open', on: false});
    for (const p of r.players) await run(tid, {type: 'remove', seat: p.seat});
    if (running.has(tid) && !r.players.length) drop(tid);
  }

  function drop(tid) {
    const r = running.get(tid);
    if (r) { timers.clear(r.wakeT); r.wakeT = null; }
    running.delete(tid);
    if (dealingNow(tid)) save();
    // Seats held here go, and anyone on their way stays where they are (#425).
    const c = club();
    if (c.waitlist?.[tid]) {
      for (const e of c.waitlist[tid]) {
        const s = c.members[e.member]?.seat;
        if (s?.moving?.to === tid) {
          delete s.moving;
          sendTable(e.member, {type: 'table', table: s.table, update: {type: 'reserve', table: tid, refused: 'That table closed.'}});
        }
      }
      delete c.waitlist[tid];
      save();
      armHolds();
    }
    Promise.resolve(call('runnerDrop', tid)).catch(() => {});
    store.drop(club().code, tid).catch(() => {});
    // Anyone watching is told the table closed.
    for (const fn of watchers.get(tid) || []) fn({type: 'closed'});
    watchers.delete(tid);
    const t = tableById(club(), tid);
    if (t && t.status === 'closing') { t.status = 'closed'; save(); }
    tablesChanged();
  }

  // Hands finished at a table: the one shown counts once it's over.
  const completedHands = r => (r.complete ? r.handNumber : Math.max(0, r.handNumber - 1));

  // ---- the manager removes a player (#414) ----
  //
  // Member `id` leaves table `tid` after the hand in play (at once if
  // they're not in it), with Undo until then. They stand up through
  // the engine's remove, as when they leave, so the cash-out (credit repaid
  // first) and the rathole rule are the usual ones; the hit-and-run rule
  // doesn't hold them. The pending removal is kept on their seat
  // (seat.removing), so the manager's page shows it and a restart keeps it.
  // `by`: who removed them, for the activity log.

  // {removing: true} while member `id` is being removed from `tid`, else {}.
  function removalOf(id, tid) {
    const s = club().members[id]?.seat;
    return s?.table === tid && s.removing ? {removing: true} : {};
  }

  // A removal never takes anyone out of a hand: they finish it (#476).
  function removePlayer(tid, id, {by = null} = {}) {
    const r = running.get(tid);
    const m = club().members[id];
    const p = r?.players.find(x => x.client_id === id);
    if (!p || m?.seat?.table !== tid) throw new Error(`${m?.name || 'That player'} isn’t at that table.`);
    m.seat.removing = {by, at: Date.now()};
    save();
    // They're going: owing hands no longer blinds them off, and they're not
    // asked if they're still here.
    run(tid, {type: 'mustPlay', id, on: false});
    run(tid, {type: 'leaving', id, on: true});
    if (!inHand(r, p)) return standUp(tid, p);
    // Watchers see "Leaving after this hand".
    return run(tid, {type: 'state'});
  }

  // Undo, before the hand ends: they stay.
  function keepPlayer(tid, id) {
    const r = running.get(tid);
    const s = club().members[id]?.seat;
    if (!r || s?.table !== tid || !s.removing) return null;
    if (r.removed?.has(id)) throw new Error('They’re already leaving.');
    delete s.removing;
    // The hit-and-run count is told again, and holds again.
    r.stay?.delete(id);
    save();
    run(tid, {type: 'leaving', id, on: false});
    return run(tid, {type: 'state'});
  }

  // The engine stands player `p` up: now between hands, else folding at
  // their turn and gone when the hand ends. Once per removal. `why`:
  // {idle: true} when they sat idle too long (#421).
  function standUp(tid, p, why = {}) {
    const r = running.get(tid);
    r.removed ??= new Set();
    if (r.removed.has(p.client_id)) return null;
    r.removed.add(p.client_id);
    // Mid-hand the engine sends them nothing more: their page leaves now,
    // rather than wait on a table that stopped for them. So does someone
    // with no chips there (no seat in the ledger, so no result to wait for).
    if (!r.complete || !club().members[p.client_id]?.seat) sendTable(p.client_id, {type: 'table', table: tid, update: {type: 'removed', name: tableById(club(), tid)?.name || '', ...why}});
    return run(tid, {type: 'remove', seat: p.seat});
  }

  // Member `id` was removed from table `t` with `chips`: the log, and their
  // page (if it hasn't left yet).
  function removed(t, id, how, chips, put) {
    const c = club();
    const name = c.members[id]?.name || id;
    const who = !how.by || how.by === c.hostId || how.by === c.ownerId ? 'The manager' : c.members[how.by]?.name || how.by;
    logAction(c, how.by || c.hostId, how.idle ? `${name} was idle, so they left ${t.name}` : `${who} removed ${name} from ${t.name}`);
    sendTable(id, {type: 'table', table: t.id, update: {type: 'removed', name: t.name, chips, ...(put != null ? {net: chips - put} : {}), ...(how.idle ? {idle: true} : {})}});
  }

  // ---- moving to another table (#425) ----

  // Member `id`'s move from table `tid`, if they're leaving it for a seat
  // held elsewhere: {to, by?}, else null.
  function moveOf(id, tid) {
    const s = club().members[id]?.seat;
    return s?.table === tid && s.moving ? s.moving : null;
  }

  // Whether player `p` is in the hand being played at a table (`r`).
  function inHand(r, p) {
    const v = r.view?.seats?.[p.seat];
    return !r.complete && !p.pending && !!v && !v.empty && !v.folded && !v.sitting_out;
  }

  // Member `id` (at another table) reserves a seat at table `tid`, or a
  // manager (`by`) does it for them. They leave their table after the hand
  // they're in (at once if they're not in one). Throws why not; their page
  // hears either way.
  function reserve(tid, id, {by = null} = {}) {
    const c = club(), t = tableById(c, tid), m = c.members[id];
    const from = m?.seat?.table || at.get(id) || '';
    const rf = from ? running.get(from) : null;
    const tell = update => { if (from) sendTable(id, {type: 'table', table: from, update: {type: 'reserve', table: tid, ...update}}); };
    const fail = why => { tell({refused: why}); throw new Error(why); };
    if (!from || !rf) fail('You’re not at a table.');
    if (!running.has(tid)) fail('That table isn’t running.');
    // The hit-and-run rule holds for a move as for leaving; a manager's
    // move overrides it, as their removal does (#414).
    const tf = tableById(c, from);
    const owed = !by && tf?.stayHands ? handsToStay(c, id, tf, completedHands(rf)) : 0;
    if (owed) fail(stayText(owed));
    const here = rf.players.find(x => x.client_id === id);
    // (In a hand, by their stack before it; it's checked again when it's over.)
    const short = here ? tooShort(id, tid, inHand(rf, here) ? m.seat?.stack || 0 : num(here.chips)) : '';
    if (short) fail(short);
    let e;
    try { e = reserveSeat(c, id, t, running.get(tid).players.length, {from, by, holdMs}); } catch (err) { fail(err.message); }
    if (m.seat) m.seat.moving = {to: tid, ...(by ? {by} : {})};
    else (rf.moves ??= new Map()).set(id, tid);
    if (by) {
      const who = by === c.hostId || by === c.ownerId ? 'The manager' : c.members[by]?.name || by;
      logAction(c, by, `${who} moved ${m.name} from ${tf?.name || 'a table'} to ${t.name}`);
      run(from, {type: 'mustPlay', id, on: false});
    }
    save();
    armHolds();
    tablesChanged();
    tell({name: t.name, until: e.until});
    const p = rf.players.find(x => x.client_id === id);
    if (p && !inHand(rf, p)) return leaveToMove(from, p);
    // Watchers see "Moving to …".
    return run(from, {type: 'state'});
  }

  // A manager moves member `id` from table `tid` to table `to` (#425).
  function movePlayer(tid, id, to, {by = null} = {}) {
    const m = club().members[id];
    if (!running.get(tid)?.players.some(x => x.client_id === id) || m?.seat?.table !== tid) throw new Error(`${m?.name || 'That player'} isn’t at that table.`);
    return reserve(to, id, {by: by || club().hostId});
  }

  // Player `p` leaves table `tid` for the seat held for them, once. Up by
  // then and owing hands (and not moved by a manager), they stay, and the
  // seat is given up.
  function leaveToMove(tid, p) {
    const r = running.get(tid), c = club(), id = p.client_id;
    const mv = moveOf(id, tid);
    r.leaving ??= new Set();
    if (r.leaving.has(id)) return null;
    const t = tableById(c, tid);
    const owed = mv && !mv.by && t?.stayHands ? handsToStay(c, id, t, completedHands(r)) : 0;
    // Too little to buy in there now (their stack here and what's
    // available to them): they stay, rather than stand up with too little.
    const short = mv && !owed ? tooShort(id, mv.to, num(p.chips)) : '';
    if (owed || short) {
      delete c.members[id].seat.moving;
      dropReservation(c, mv.to, id);
      save();
      armHolds();
      tablesChanged();
      sendTable(id, {type: 'table', table: tid, update: {type: 'reserve', table: mv.to, refused: owed ? stayText(owed) : short}});
      return run(tid, {type: 'state'});
    }
    r.leaving.add(id);
    return run(tid, {type: 'cmd', id, cmd: {type: 'leave'}, online: online(id)});
  }

  // Why member `id`, with `chips` at their table, couldn't buy in at table
  // `to` once they'd left it (their chips back in their balance, credit
  // included, against its minimum and the rathole rule), or ''.
  function tooShort(id, to, chips) {
    const c = club(), m = c.members[id], t = tableById(c, to);
    if (!m || !t) return '';
    const could = Math.max(0, (m.balance || 0) + chips + creditOf(m));
    return could < Math.max(limits(t).min, ratholeMin(c, id, to)) ? `Not enough for ${t.name} · Staying here` : '';
  }

  // Member `id` left table `t` with `chips` for the seat held at table `to`:
  // their page sits them there. Their holdMs to sit down start now (when
  // they reserved, if they weren't in a hand: they left at once).
  function movedOut(t, id, to, chips) {
    const c = club(), now = Date.now();
    const e = c.waitlist?.[to]?.find(x => x.member === id);
    if (e) e.until = now + holdMs;
    armHolds();
    const dest = tableById(c, to);
    sendTable(id, {type: 'table', table: t.id, update: {type: 'moved', to, name: dest?.name || '', chips, ...(e ? {until: e.until} : {})}});
  }

  // Seats held at table `tid` for people not at it yet.
  const held = tid => {
    const r = running.get(tid);
    return reservations(club(), tid).filter(e => !r?.players.some(p => p.client_id === e.member)).length;
  };

  // The timer for the next hold to lapse; lapsed holds free their seats.
  let holdT = null, holdDue = null;
  function armHolds() {
    const due = nextLapse(club());
    if (due === holdDue) return;
    timers.clear(holdT);
    holdT = null;
    holdDue = due;
    if (due === Infinity) return;
    holdT = timers.set(() => {
      holdT = null;
      holdDue = null;
      if (pruneReservations(club()).length) { save(); tablesChanged(); }
      armHolds();
    }, Math.max(100, due - Date.now()));
  }

  // A member's command for table `tid`.
  async function handle(tid, id, cmd) {
    const t = tableById(club(), tid);
    if (!cmd || typeof cmd.type !== 'string') return;
    // The hit-and-run rule: up at this table, they stay until they've played
    // the table's hands (their page says so before they try).
    if (cmd.type === 'leave' && t?.stayHands && running.has(tid)) {
      const left = handsToStay(club(), id, t, completedHands(running.get(tid)));
      if (left) { sendTable(id, {type: 'table', table: tid, update: {type: 'stay', hands: left, refused: true}}); return; }
    }
    // Reserving a seat here from another table (#425).
    if (cmd.type === 'reserve') { try { await reserve(tid, id); } catch {} return; }
    if (cmd.type === 'join') {
      const why = canJoin(club(), id, t, at.get(id));
      if (why) { sendTable(id, {type: 'table', table: tid, update: {type: 'rejected', reason: why, fatal: true}}); return; }
      // Seats held for others (#425) aren't free; one held for them is theirs now.
      const r = running.get(tid);
      if (r && !r.players.some(p => p.client_id === id)) {
        if (r.players.length + heldSeats(club(), tid, Date.now(), id) >= t.seats) {
          sendTable(id, {type: 'table', table: tid, update: {type: 'rejected', reason: 'That table is full.', fatal: true}});
          return;
        }
        if (dropReservation(club(), tid, id)) { save(); armHolds(); }
      }
      // Members play under their club name.
      cmd = {type: 'join', name: club().members[id].name};
    }
    if (!running.has(tid)) {
      // A fair-deal round's message or "Still here?" for a table that's gone: nothing to say.
      if (cmd.type.startsWith('fair_') || cmd.type === 'still_here') return;
      sendTable(id, {type: 'table', table: tid, update: {type: 'rejected', reason: 'That table isn’t running.', fatal: true}});
      return;
    }
    await run(tid, {type: 'cmd', id, cmd, online: online(id)});
    // "Still here?" answered: their seat's last activity is kept.
    if (cmd.type === 'still_here') save();
  }

  function disconnected(id) {
    const tid = at.get(id);
    if (tid) run(tid, {type: 'disconnected', id});
  }

  // A member's connection changed (clubs.js keeps who's online): their
  // table's clock stops while no one seated there is connected, and someone
  // connected at a table waiting after a restore is back (#135).
  function presence(id) {
    const tid = at.get(id);
    if (tid) run(tid, {type: 'presence', id, on: online(id)});
  }

  // Seats taken: people at the table, and seats held for people coming (#425).
  const seatedCounts = () => Object.fromEntries([...running].map(([tid, r]) => [tid, r.players.length + held(tid)]));

  return {start, close, handle, disconnected, presence, setLink, seatedCounts, watch, removePlayer, keepPlayer, movePlayer, reserve, tableOf: id => at.get(id) || null, running: tid => running.has(tid)};
}
