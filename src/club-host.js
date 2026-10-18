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
//   onHand(table, view, players) a hand finished (the host's view: no hidden
//                       cards; players: [{seat, client_id}], who sat where)
//   online(id)          whether a member is connected to the relay
//
// A table's clock stops while the host can't reach the relay (linkHealthy
// false) or no one seated there is connected: no turn runs out, no one is
// folded or sat out, no hand is dealt, until someone is back (an outage
// shouldn't fold everyone).

import { canJoin, cashOutTable, chipsForTable, handsToStay, leftTable, limits, syncStacks, tableById, tableLedgerN } from './club-tables.js';
import { refundTopUp } from './club-chips.js';
import { dropTable, getTable, putTable } from './table-store.js';

const NEXT_HAND_MS = 3000;
const BOT_PACE_MS = 700;
// Fair deals (#136): how long players have to send a commitment, then a
// reveal, and how long a deal may wait for a round still under way before
// going ahead without one.
const FAIR_STEP_MS = 4000;
const FAIR_WAIT_MS = 6000;
// Results kept per player, to send again when they come back.
const FAIR_KEEP = 3;
// A table resumed after the host's page reopened (#107) waits this long for
// the people at it to come back; then whoever isn't back counts as
// disconnected, and the clocks run again.
const RESUME_GRACE_MS = 60_000;

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
// ({set(fn, ms) → handle, clear(handle)}) runs everything that happens
// later; an always-on club's room backs it with its alarm (#135), so the
// room can sleep between turns and a restart doesn't lose them.
export function createTableHost({
  club, save, sendTable, chipsChanged, tablesChanged, onHand, online = () => true,
  call = workerCall, store = {get: getTable, put: putTable, drop: dropTable}, timers = browserTimers,
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
    sweep(tid, r);
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

  function clear(r, name) { timers.clear(r.timers[name]); r.timers[name] = null; }

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
        // A fair-dealt hand's reveals go out after its final state (#136).
        if (r.publish) { fairPublish(tid, r.publish); r.publish = null; }
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
    // Top-ups the table capped at its maximum: the rest goes back to the balance.
    for (const f of res.refunds || []) {
      if (!club().members[f.client_id]?.seat || !num(f.chips)) continue;
      refundTopUp(club(), f.client_id, num(f.chips));
      changed = true;
      chipsChanged(f.client_id);
    }
    const state = res.state;
    r.complete = !!state.complete;
    r.handNumber = num(state.hand_number);
    // A hand just finished: for the host's hand history (#71).
    if (r.complete && r.handNumber && r.handNumber !== r.recorded) {
      r.recorded = r.handNumber;
      onHand?.(tid, state, r.players);
      r.publish = state;
    }
    // Between hands the engine's count is the truth.
    if (r.complete) syncStacks(club(), r.players, r.handNumber);
    // The hit-and-run rule: each player hears how many hands they still owe
    // the table whenever that changes, so their Leave button can say so.
    if (t.stayHands) {
      r.stay ??= new Map();
      const done = completedHands(r);
      for (const p of r.players) {
        const left = handsToStay(club(), p.client_id, t, done);
        const was = r.stay.get(p.client_id);
        if (was === left) continue;
        r.stay.set(p.client_id, left);
        sendTable(p.client_id, {type: 'table', table: tid, update: {type: 'stay', hands: left}});
        // Owing hands, sitting out or dropping off blinds them off (dealt in,
        // checking or folding) rather than taking them out of the count.
        if (!was !== !left) Promise.resolve(call('clubMustPlay', tid, p.client_id, left > 0)).catch(() => {});
      }
    }
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
  // regularly, not only on the turn clock. An empty one doesn't, and nor does
  // one whose clock is stopped (no one seated is connected, #96): the limit
  // doesn't count then anyway, and the tick would wake an always-on club's
  // room every 5 s for nothing (#93). It starts again when the clock does.
  function sweep(tid, r) {
    const want = r.players.length && !r.stopped;
    if (want && !r.sweep) {
      const tick = () => {
        r.sweep = null;
        if (!running.has(tid) || r.stopped) return;
        run(tid, 'tick');
        r.sweep = timers.set(tick, 5_000);
      };
      r.sweep = timers.set(tick, 5_000);
    } else if (!want && r.sweep) { timers.clear(r.sweep); r.sweep = null; }
  }

  // What happens next at a table: an away player's or the clock's move, or
  // the next hand.
  function pace(tid, res) {
    const r = running.get(tid);
    const t = tableById(club(), tid);
    if (!r || !t || r.stopped) return;
    clear(r, 'tick');
    if (res.turnMsLeft != null) r.timers.tick = timers.set(() => run(tid, 'tick'), num(res.turnMsLeft) + 50);
    if (res.botToAct) {
      clear(r, 'advance');
      r.timers.advance = timers.set(() => run(tid, 'advance'), BOT_PACE_MS);
    }
    // A resumed table deals no new hand until its people are back.
    if (r.complete && !r.paused && !r.timers.deal && t.status === 'open' && num(res.playersIn) >= 2) {
      // The next hand's fair-deal round, if one isn't under way already.
      if (!r.fair) fairStart(tid);
      r.timers.deal = timers.set(() => deal(tid), r.handNumber ? NEXT_HAND_MS : 500);
    }
  }

  // Deals the next hand, from the fair-deal round's seed (#136). A round
  // still under way gets a little longer; after that the hand is dealt
  // without one rather than holding the table up.
  async function deal(tid) {
    const r = running.get(tid);
    if (!r) return;
    r.timers.deal = null;
    const f = r.fair;
    if (f && !f.seed && Date.now() - f.started < FAIR_WAIT_MS) {
      r.timers.deal = timers.set(() => deal(tid), 300);
      return;
    }
    r.fair = null;
    // If people left meanwhile the engine refuses; the next change (someone
    // sitting down, chips) tries again.
    let res = null;
    try { res = await run(tid, 'newHand', f?.seed || null); } catch {}
    if (res && f?.seed) {
      // Who was dealt in: the players whose view came with their own cards
      // (someone sitting out isn't).
      const dealtIn = new Set((res.out || []).filter(m => m.data?.view?.seats?.[0]?.cards).map(m => m.to));
      r.dealt = {hand: num(res.state.hand_number), round: f, seats: r.players.filter(p => dealtIn.has(p.client_id)).map(p => ({id: p.client_id, seat: p.seat}))};
    }
    // The round for the hand after this one runs while this one is played.
    if (res) fairStart(tid);
  }

  // ---- fair deals (#136) ----
  //
  // Each seated player's page and the host commit to a random value, then,
  // once every commitment is in (a list everyone gets before revealing),
  // reveal it. The hand is dealt from the seed of all the values revealed,
  // so no single party picks the cards. After the hand the host publishes
  // the reveals, and each page checks its own cards and the board against
  // the seed (fair-check.js). A player who doesn't commit or reveal in time
  // is left out of the seed, so the table never waits on them.

  async function fairStart(tid) {
    const r = running.get(tid);
    if (!r || r.fair) return;
    const f = r.fair = {id: `${tid}:${Date.now()}`, started: Date.now(), commits: new Map(), reveals: new Map(), seed: null};
    const players = r.players.map(p => p.client_id);
    try { f.host = await call('fairSecret'); } catch (e) { console.warn('fair deal:', e); return; }
    if (r.fair !== f) return;
    f.invited = new Set(players);
    for (const id of players) sendTable(id, {type: 'table', table: tid, update: {type: 'fair', step: 'commit', round: f.id}});
    clear(r, 'fair');
    r.timers.fair = timers.set(() => fairCommitsIn(tid, f), FAIR_STEP_MS);
  }

  // Every commitment is in (or the time's up): everyone gets the list, then reveals.
  function fairCommitsIn(tid, f) {
    const r = running.get(tid);
    if (!r || r.fair !== f || f.list) return;
    clear(r, 'fair');
    f.list = [{id: 'host', c: f.host.commitment}, ...[...f.commits].map(([id, c]) => ({id, c}))];
    for (const [id] of f.commits) sendTable(id, {type: 'table', table: tid, update: {type: 'fair', step: 'reveal', round: f.id, list: f.list}});
    if (!f.commits.size) { fairRevealsIn(tid, f); return; }
    r.timers.fair = timers.set(() => fairRevealsIn(tid, f), FAIR_STEP_MS);
  }

  // Every reveal is in (or the time's up): the seed, from the values in list order.
  async function fairRevealsIn(tid, f) {
    const r = running.get(tid);
    if (!r || r.fair !== f || f.seed) return;
    clear(r, 'fair');
    f.used = f.list.filter(e => e.id === 'host' || f.reveals.has(e.id))
      .map(e => (e.id === 'host' ? {id: 'host', value: f.host.value, nonce: f.host.nonce} : {id: e.id, ...f.reveals.get(e.id)}));
    try { f.seed = await call('fairSeed', f.used.map(u => u.value)); } catch (e) { console.warn('fair deal:', e); }
  }

  // A player's commitment or reveal for the round under way.
  async function fairIncoming(tid, id, cmd) {
    const f = running.get(tid)?.fair;
    if (!f || cmd.round !== f.id || !f.invited?.has(id)) return;
    const hex = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
    if (cmd.type === 'fair_commit' && !f.list && hex(cmd.c) && !f.commits.has(id)) {
      f.commits.set(id, cmd.c);
      if (f.commits.size === f.invited.size) fairCommitsIn(tid, f);
    } else if (cmd.type === 'fair_reveal' && f.list && !f.seed && f.commits.has(id) && !f.reveals.has(id) && hex(cmd.value) && hex(cmd.nonce)) {
      // A reveal that doesn't open its commitment is left out, like a missing one.
      let opens = false;
      try { opens = (await call('fairCommitment', cmd.value, cmd.nonce)) === f.commits.get(id); } catch {}
      if (!opens || f.seed) return;
      f.reveals.set(id, {value: cmd.value, nonce: cmd.nonce});
      if (f.reveals.size === f.commits.size) fairRevealsIn(tid, f);
    }
  }

  // A hand dealt from a seed is over: everyone dealt in gets the reveals, so
  // their page can check the deal, with where their cards are in it.
  function fairPublish(tid, state) {
    const r = running.get(tid);
    const d = r?.dealt;
    if (!d || d.hand !== num(state.hand_number)) return;
    r.dealt = null;
    // Cards go to the dealt seats in seat order (ducy's Deal::from_seed).
    const dealt = d.seats.slice().sort((a, b) => a.seat - b.seat);
    const t = tableById(club(), tid);
    dealt.forEach((p, index) => {
      const update = {
        type: 'fair', step: 'result', hand: d.hand, game: t?.game || 'nlhe', dealt: dealt.length, index,
        seed: d.round.seed, list: d.round.list, reveals: d.round.used,
      };
      // Kept for a while, to send again to a player who was away when it went.
      const kept = r.results.get(p.id) || [];
      kept.push(update);
      r.results.set(p.id, kept.slice(-FAIR_KEEP));
      sendTable(p.id, {type: 'table', table: tid, update});
    });
  }

  // A player (re)joining the table gets the last few hands' results again,
  // in case they were away when they went (their page checks each once).
  function fairResend(tid, id) {
    for (const update of running.get(tid)?.results.get(id) || []) sendTable(id, {type: 'table', table: tid, update});
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
    const r = {chain: Promise.resolve(), players: [], timers: {}, asking: new Set(), handNumber: 0, complete: true, results: new Map()};
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
        timers.clear(r.sweep);
        running.delete(t.id);
        if (resume && cashOutTable(club(), t.id).length) save();
        if (t.status === 'closing') { t.status = 'closed'; save(); }
      });
    await r.chain;
    // The resumed table's state: who's seated, for joins and the host's view.
    if (r.paused) {
      await run(t.id, 'state');
      // Players still connected never left (an always-on club's room woke
      // after sleeping, #135): they're back already, and if everyone is,
      // play goes straight on.
      for (const p of r.players) if (online(p.client_id)) cameBack(t.id, p.client_id);
    }
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
    r.timers.grace = timers.set(() => wake(t.id), RESUME_GRACE_MS);
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
    if (r) { for (const k of Object.keys(r.timers)) clear(r, k); timers.clear(r.sweep); r.sweep = null; }
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

  // Hands finished at a table: the one shown counts once it's over.
  const completedHands = r => (r.complete ? r.handNumber : Math.max(0, r.handNumber - 1));

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
    // A commitment or reveal for the next hand's deal (#136).
    if (cmd.type === 'fair_commit' || cmd.type === 'fair_reveal') { await fairIncoming(tid, id, cmd); return; }
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
    if (cmd.type === 'join') { cameBack(tid, id); fairResend(tid, id); }
  }

  function disconnected(id) {
    const tid = at.get(id);
    if (tid) run(tid, 'disconnected', id);
  }

  // A member's connection changed (clubs.js keeps who's online).
  function presence(id) {
    const tid = at.get(id);
    if (!tid) return;
    syncClock(tid);
    // Connected while their table waits after a restore: they're back (#135).
    if (online(id)) cameBack(tid, id);
  }

  const seatedCounts = () => Object.fromEntries([...running].map(([tid, r]) => [tid, r.players.length]));

  return {start, close, handle, disconnected, presence, setLink, seatedCounts, watch, tableOf: id => at.get(id) || null, running: tid => running.has(tid)};
}
