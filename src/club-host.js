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

import { canJoin, chipsForTable, leftTable, limits, syncStacks, tableById } from './club-tables.js';

const NEXT_HAND_MS = 3000;
const BOT_PACE_MS = 700;

let worker = null, nextId = 0;
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

const num = v => Number(v);

export function createTableHost({club, save, sendTable, chipsChanged, tablesChanged}) {
  const running = new Map(); // table id → {chain, players, timers, asking: Set(seat), handNumber, complete}
  const at = new Map(); // member id → table id
  const watchers = new Map(); // table id → Set(fn(update))

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
      after(tid, res);
      return res;
    });
    r.chain = p.catch(e => console.warn(`table ${tid} ${method}:`, e));
    return p;
  }

  function after(tid, res) {
    const r = running.get(tid);
    const t = tableById(club(), tid);
    if (!r || !t) return;
    for (const m of res.out) sendTable(m.to, {type: 'table', table: tid, update: m.data});
    // The host watching (#73): the engine's host view shows no hidden cards.
    for (const fn of watchers.get(tid) || []) fn({type: 'state', seq: res.seq, view: res.state, turn_ms_left: res.turnMsLeft});
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
    if (changed || r.complete) save();
    if (before !== r.players.length) tablesChanged();
    pace(tid, res);
    if (t.status === 'closing' && !r.players.length) drop(tid);
  }

  // What happens next at a table: an away player's or the clock's move, or
  // the next hand.
  function pace(tid, res) {
    const r = running.get(tid);
    const t = tableById(club(), tid);
    if (!r || !t) return;
    clear(r, 'tick');
    if (res.turnMsLeft != null) r.timers.tick = setTimeout(() => run(tid, 'tick'), num(res.turnMsLeft) + 50);
    if (res.botToAct) {
      clear(r, 'advance');
      r.timers.advance = setTimeout(() => run(tid, 'advance'), BOT_PACE_MS);
    }
    if (r.complete && !r.timers.deal && t.status === 'open' && num(res.playersIn) >= 2) {
      r.timers.deal = setTimeout(async () => {
        r.timers.deal = null;
        // If people left meanwhile the engine refuses; the next change
        // (someone sitting down, chips) tries again.
        try { await run(tid, 'newHand'); } catch {}
      }, r.handNumber ? NEXT_HAND_MS : 500);
    }
  }

  async function start(t) {
    if (running.has(t.id)) return;
    const {min, max} = limits(t);
    const r = {chain: Promise.resolve(), players: [], timers: {}, asking: new Set(), handNumber: 0, complete: true};
    running.set(t.id, r);
    r.chain = call('clubCreate', t.id, t.seats, min, max, t.sb, t.bb, Math.floor(Math.random() * 2 ** 32), t.game, t.turnSecs * 1000)
      .catch(e => { console.warn(e); running.delete(t.id); });
    await r.chain;
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
    if (r) for (const k of Object.keys(r.timers)) clear(r, k);
    running.delete(tid);
    call('clubDrop', tid).catch(() => {});
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
  }

  function disconnected(id) {
    const tid = at.get(id);
    if (tid) run(tid, 'disconnected', id);
  }

  const seatedCounts = () => Object.fromEntries([...running].map(([tid, r]) => [tid, r.players.length]));

  return {start, close, handle, disconnected, seatedCounts, watch, tableOf: id => at.get(id) || null, running: tid => running.has(tid)};
}
