// Runs a club's tables in the host's tab (#68). Each table is ducy's
// MultiTable.club in a worker (play-worker.js): no seat for the host, real
// chips. This file feeds it members' table commands, sends each member their
// own view, answers chip requests from the club ledger, returns the chips of
// anyone who leaves, keeps the ledger in step between hands, and paces the
// game (next hand, turn clock, away players).
//
// clubs.js owns the club object and the relay; it passes in:
//   club()              the current club object
//   save()              persist the club
//   sendTable(to, msg)  send a table message (unsigned; only the host can reach a member)
//   chipsChanged(id)    a member's balance changed: send them their account
//   tablesChanged()     seat counts or tables changed: tell members
//   onHand(table, view) a hand finished (the host's view: no hidden cards)
//   online(id)          whether a member is connected to the relay
//
// A table's clock stops while the host can't reach the relay (linkHealthy
// false) or no one seated there is connected: no turn runs out, no one is
// folded or sat out, no hand is dealt, until someone is back (an outage
// shouldn't fold everyone).

import { canJoin, cashOutTable, chipsForTable, leftTable, limits, syncStacks, tableById, tableLedgerN } from './club-tables.js';
import { dropTable, getTable, putTable } from './table-store.js';

const NEXT_HAND_MS = 3000;
const BOT_PACE_MS = 700;
// A table resumed after the host's page reopened (#107) waits this long for
// the people at it to come back; then whoever isn't back counts as
// disconnected, and the clocks run again.
const RESUME_GRACE_MS = 60_000;

let worker = null, nextId = 0;
const pending = new Map();

// The page's engine: play-worker.js in a Web Worker.
function workerCall(op, ...args) {
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

// `call(op, ...args)` runs club-engine.js ops (by default in the page's
// worker), and `store` keeps saved tables (by default in IndexedDB,
// table-store.js); an always-on club passes its own (#93).
export function createTableHost({
  club, save, sendTable, chipsChanged, tablesChanged, onHand, online = () => true,
  call = workerCall, store = {get: getTable, put: putTable, drop: dropTable},
}) {
  const running = new Map(); // table id → {chain, players, timers, asking: Set(seat), handNumber, complete}
  const at = new Map(); // member id → table id
  const watchers = new Map(); // table id → Set(fn(update))
  let linkOk = true;

  // Stops or restarts table tid's clock to match who can be reached.
  function syncClock(tid) {
    const r = running.get(tid);
    if (!r) return;
    const stop = !linkOk || !r.players.some(p => online(p.client_id));
    if (stop === !!r.stopped) return;
    r.stopped = stop;
    if (stop) for (const k of Object.keys(r.timers)) clear(r, k);
    r.chain = r.chain.then(() => call('clockPause', tid, stop)).catch(e => console.warn(e));
    // Restarted: the state's turn clock and next step set the timers again.
    if (!stop) run(tid, 'state');
  }

  // The host's link to the relay is up (true) or down.
  function setLink(ok) {
    linkOk = ok;
    for (const tid of running.keys()) syncClock(tid);
  }

  // Calls fn with the table's spectator view now and after every change.
  // Returns a function that stops watching.
  function watch(tid, fn) {
    if (!watchers.has(tid)) watchers.set(tid, new Set());
    watchers.get(tid).add(fn);
    run(tid, 'state');
    return () => watchers.get(tid)?.delete(fn);
  }

  function clear(r, name) { clearTimeout(r.timers[name]); r.timers[name] = null; }

  // Runs engine calls for a table one at a time, handling each result.
  function run(tid, method, ...args) {
    const r = running.get(tid);
    if (!r) return Promise.resolve(null);
    const p = r.chain.then(async () => {
      if (!running.has(tid)) return null;
      const res = await call('clubCall', tid, method, ...args);
      // The ledger first, then the table on disk, then the messages: after
      // a crash the table is never behind what anyone was shown (#107).
      const t = after(tid, res);
      if (t) {
        await persist(tid, res);
        send(tid, res);
        pace(tid, res);
        sweep(tid, r);
        if (t.status === 'closing' && !r.players.length) drop(tid);
      }
      return res;
    });
    r.chain = p.catch(e => console.warn(`table ${tid} ${method}:`, e));
    return p;
  }

  // Saves the table (#107) when its state changed, so a hand in progress
  // can resume if the page closes. A table that can't be saved (an older
  // ducy-wasm, or storage blocked) just plays on, as before.
  async function persist(tid, res) {
    const r = running.get(tid);
    if (!r || r.noSave || res.seq === r.savedSeq) return;
    try {
      const json = await call('clubSave', tid);
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
    for (const fn of watchers.get(tid) || []) fn({type: 'state', seq: res.seq, view: res.state, turn_ms_left: res.turnMsLeft});
  }

  // Takes in an engine result: who's seated, chips that came and went, the
  // hand that finished. Returns the table, or null if it's gone.
  function after(tid, res) {
    const r = running.get(tid);
    const t = tableById(club(), tid);
    if (!r || !t) return null;
    const before = r.players.length;
    r.players = res.players || [];
    for (const p of r.players) at.set(p.client_id, tid);
    let changed = false;
    // Chips people left with go back to their club balance.
    for (const d of res.departed || []) {
      if (at.get(d.client_id) === tid) at.delete(d.client_id);
      if (leftTable(club(), d.client_id, num(d.chips))) { changed = true; chipsChanged(d.client_id); }
    }
    const state = res.state;
    r.complete = !!state.complete;
    r.handNumber = num(state.hand_number);
    // A hand just finished: for the host's hand history (#71).
    if (r.complete && r.handNumber && r.handNumber !== r.recorded) {
      r.recorded = r.handNumber;
      onHand?.(tid, state);
    }
    // Between hands the engine's count is the truth.
    if (r.complete) syncStacks(club(), r.players);
    // Chip requests: approved if the club ledger allows them.
    for (const q of res.chipRequests || []) {
      if (r.asking.has(q.seat)) continue;
      r.asking.add(q.seat);
      const who = r.players.find(p => p.seat === q.seat)?.client_id;
      let ok = false, why = '';
      try {
        if (!who) throw new Error('No one in that seat.');
        chipsForTable(club(), who, t, num(q.amount));
        ok = true;
        changed = true;
      } catch (e) {
        why = e.message;
      }
      run(tid, ok ? 'approveChips' : 'denyChips', q.seat).finally(() => r.asking.delete(q.seat));
      if (ok) chipsChanged(who);
      else if (who) sendTable(who, {type: 'table', table: tid, update: {type: 'rejected', reason: why, chips: true}});
    }
    // Save when chips moved or a hand ended, not on every tick.
    if (changed || (r.complete && r.handNumber !== r.saved)) { r.saved = r.handNumber; save(); }
    if (before !== r.players.length) tablesChanged();
    syncClock(tid);
    return t;
  }

  // The sit-out limit is checked on tick, so a table with people at it ticks
  // regularly, not only on the turn clock. An empty one doesn't, so nothing
  // keeps an always-on club's room awake while no one plays (#93).
  function sweep(tid, r) {
    if (r.players.length && !r.sweep) r.sweep = setInterval(() => { if (!r.stopped) run(tid, 'tick'); }, 5_000);
    else if (!r.players.length && r.sweep) { clearInterval(r.sweep); r.sweep = null; }
  }

  // What happens next at a table: an away player's or the clock's move, or
  // the next hand.
  function pace(tid, res) {
    const r = running.get(tid);
    const t = tableById(club(), tid);
    if (!r || !t || r.stopped) return;
    clear(r, 'tick');
    if (res.turnMsLeft != null) r.timers.tick = setTimeout(() => run(tid, 'tick'), num(res.turnMsLeft) + 50);
    if (res.botToAct) {
      clear(r, 'advance');
      r.timers.advance = setTimeout(() => run(tid, 'advance'), BOT_PACE_MS);
    }
    // A resumed table deals no new hand until its people are back.
    if (r.complete && !r.paused && !r.timers.deal && t.status === 'open' && num(res.playersIn) >= 2) {
      r.timers.deal = setTimeout(async () => {
        r.timers.deal = null;
        // If people left meanwhile the engine refuses; the next change
        // (someone sitting down, chips) tries again.
        try { await run(tid, 'newHand'); } catch {}
      }, r.handNumber ? NEXT_HAND_MS : 500);
    }
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
    const {min, max} = limits(t);
    const r = {chain: Promise.resolve(), players: [], timers: {}, asking: new Set(), handNumber: 0, complete: true};
    running.set(t.id, r);
    const fresh = () => call('clubCreate', t.id, t.seats, min, max, t.sb, t.bb, crypto.getRandomValues(new Uint32Array(1))[0], t.game, t.turnSecs * 1000);
    r.chain = (resume ? restore(t, r).catch(e => { console.warn(`table ${t.id}: not resumed:`, e); return false; }) : Promise.resolve(false))
      .then(resumed => {
        if (resumed) return;
        if (resume && cashOutTable(club(), t.id).length) save();
        // A closing table that can't resume is done: everyone's been settled.
        if (t.status === 'closing') throw new Closed();
        return fresh();
      })
      .then(() => call('clubSitOutLimit', t.id, (t.sitOutMins ?? 10) * 60_000))
      .catch(e => {
        if (!(e instanceof Closed)) console.warn(e);
        clearInterval(r.sweep);
        running.delete(t.id);
        if (resume && cashOutTable(club(), t.id).length) save();
        if (t.status === 'closing') { t.status = 'closed'; save(); }
      });
    await r.chain;
    // The resumed table's state: who's seated, for joins and the host's view.
    if (r.paused) await run(t.id, 'state');
    // A table that was closing finishes its hand, then closes (#117).
    if (running.has(t.id) && t.status === 'closing') await close(t.id);
  }

  // Loads table `t`'s saved snapshot, if it's usable. Resolves to whether
  // the table was resumed.
  async function restore(t, r) {
    const rec = await store.get(club().code, t.id);
    if (!rec) return false;
    if (rec.ledgerN !== tableLedgerN(club(), t.id)) {
      console.warn(`table ${t.id}: the saved hand is out of step with the ledger; not resumed`);
      return false;
    }
    await call('clubRestore', t.id, rec.json);
    r.paused = true;
    r.back = new Set();
    r.savedSeq = rec.seq;
    // People get a while to come back; then the table goes on without them.
    r.timers.grace = setTimeout(() => wake(t.id), RESUME_GRACE_MS);
    return true;
  }

  // A resumed table's clocks run again: everyone not back yet counts as
  // disconnected (they check or fold, and the sit-out limit counts).
  async function wake(tid) {
    const r = running.get(tid);
    if (!r?.paused) return;
    r.paused = false;
    clear(r, 'grace');
    for (const p of r.players) if (!r.back.has(p.client_id)) await run(tid, 'disconnected', p.client_id);
    await run(tid, 'resume');
  }

  // Someone at a resumed table is back: once everyone is, play goes on.
  function cameBack(tid, id) {
    const r = running.get(tid);
    if (!r?.paused) return;
    r.back.add(id);
    if (r.players.every(p => r.back.has(p.client_id))) wake(tid);
  }

  // Stops taking players, removes everyone (they leave at the end of the
  // hand, with their chips), then drops the table.
  async function close(tid) {
    const r = running.get(tid);
    if (!r) return drop(tid);
    for (const p of r.players) await run(tid, 'remove', p.seat);
    if (!r.players.length) drop(tid);
  }

  function drop(tid) {
    const r = running.get(tid);
    if (r) { for (const k of Object.keys(r.timers)) clear(r, k); clearInterval(r.sweep); }
    running.delete(tid);
    call('clubDrop', tid).catch(() => {});
    store.drop(club().code, tid).catch(() => {});
    // Anyone watching is told the table closed.
    for (const fn of watchers.get(tid) || []) fn({type: 'closed'});
    watchers.delete(tid);
    const t = tableById(club(), tid);
    if (t && t.status === 'closing') { t.status = 'closed'; save(); }
    tablesChanged();
  }

  // A member's command for table `tid`.
  async function handle(tid, id, cmd) {
    const t = tableById(club(), tid);
    if (!cmd || typeof cmd.type !== 'string') return;
    if (cmd.type === 'join') {
      const why = canJoin(club(), id, t, at.get(id));
      if (why) { sendTable(id, {type: 'table', table: tid, update: {type: 'rejected', reason: why, fatal: true}}); return; }
      // Members play under their club name.
      cmd = {type: 'join', name: club().members[id].name};
    }
    if (!running.has(tid)) {
      sendTable(id, {type: 'table', table: tid, update: {type: 'rejected', reason: 'That table isn’t running.', fatal: true}});
      return;
    }
    await run(tid, 'handle', id, cmd);
    if (cmd.type === 'join') cameBack(tid, id);
  }

  function disconnected(id) {
    const tid = at.get(id);
    if (tid) run(tid, 'disconnected', id);
  }

  // A member's connection changed (clubs.js keeps who's online).
  function presence(id) {
    const tid = at.get(id);
    if (tid) syncClock(tid);
  }

  const seatedCounts = () => Object.fromEntries([...running].map(([tid, r]) => [tid, r.players.length]));

  return {start, close, handle, disconnected, presence, setLink, seatedCounts, watch, tableOf: id => at.get(id) || null, running: tid => running.has(tid)};
}
