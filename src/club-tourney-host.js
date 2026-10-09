// Runs a club's tournaments (#81), as club-host.js runs its cash tables:
// ducy's ClubTournament (through club-engine.js) deals every table, moves
// players to keep tables balanced and breaks them down to a final table,
// and blinds off anyone absent. This file starts each tournament at its
// time (or cancels it, short of players), runs the level clock with its
// breaks, paces the game, sends each player their own view, records who's
// knocked out in what place, takes late registrations and re-entries (#80),
// and pays the prizes into club balances when there's a winner (#79).
//
// Options, as for createTableHost:
//   club()               the current club object
//   save()               persist the club
//   sendTable(to, msg)   send {table: 'tourney:<id>', update} to a member (encrypted)
//   chipsChanged(id)     a member's club balance changed
//   tourneysChanged()    the lobby changed (entries, places, status): tell members
//   liveChanged()        only the live standings moved (the caller throttles it)
//   online(id)           whether a member is connected
//   call, timers, store  the engine, timers and where tournaments are saved
//                        (an always-on club's room passes its own)
//   turnMs, nextHandMs, botPaceMs, levelMs   pacing (tests use short ones;
//                        levelMs replaces each level's minutes)
//   observe(tid, res)    sees every engine result (tests)
//
// A running tournament is saved after every change (its tables, hands in
// play, turn clocks and the level clock), so when the host restarts it
// carries on where it was: members still connected are back at once, and
// anyone who isn't is blinded off until they are. Only if nothing usable was
// saved (or it's out of step with the club) is it cancelled, with every
// buy-in refunded.

import { atStart, cancelTourney, finishTourney, isIn, knockedOut, lateEntry, prizes, startTourney, tourneyById } from './club-tourneys.js';
import { browserTimers, workerCall } from './club-host.js';
import { dropTable, getTable, putTable } from './table-store.js';
import { logAction } from './club-roles.js';

const BOT_PACE_MS = 700;
const NEXT_HAND_MS = 2500;
const TURN_MS = 30_000;
export const tourneyTable = tid => `tourney:${tid}`;

export function createTourneyHost({
  club, save, sendTable, chipsChanged, tourneysChanged = () => {}, liveChanged = () => {}, online = () => true,
  call = workerCall, timers = browserTimers, store = {get: getTable, put: putTable, drop: dropTable}, turnMs = TURN_MS, nextHandMs = NEXT_HAND_MS, botPaceMs = BOT_PACE_MS, levelMs = null,
  observe = () => {},
}) {
  const running = new Map(); // tid → {chain, step, onBreak, level, timers, live}
  const scheduled = new Map(); // tid → timer handle

  const clear = (r, k) => { timers.clear(r.timers[k]); r.timers[k] = null; };
  const names = id => club().members[id]?.name || id;
  const changed = () => { save(); tourneysChanged(); };

  // Starts, or schedules the start of, every tournament waiting for it, and
  // picks up any that was running when the host stopped.
  function startAll() {
    for (const t of club().tourneys || []) {
      if (t.status === 'scheduled') schedule(t);
      else if (t.status === 'running' && !running.has(t.id)) resume(t);
    }
  }

  const outCount = t => t.entries.filter(e => e.place != null).length;

  // A tournament that was running when the host stopped: loaded from where
  // it was saved, if that's in step with the club (the same entries, the
  // same players out); otherwise cancelled with refunds, as before.
  async function resume(t) {
    const tid = t.id;
    let rec = null;
    try { rec = await store.get(club().code, tourneyTable(tid)); } catch (e) { console.warn(`tournament ${tid}: not loaded:`, e); }
    if (!rec?.json) return abandon(tid, 'the club’s host restarted, and its tables weren’t saved');
    if (rec.entries !== t.entries.length || rec.out !== outCount(t)) return abandon(tid, 'the club’s host restarted, and its saved tables were out of step with the club');
    const r = {chain: Promise.resolve(), step: rec.step ?? 0, onBreak: false, level: rec.level ?? 0, timers: {}, live: null, savedSeq: rec.seq};
    running.set(tid, r);
    try {
      await call('tourneyRestore', tid, rec.json);
    } catch (e) {
      console.warn(`tournament ${tid}: not resumed:`, e);
      running.delete(tid);
      return abandon(tid, 'the club’s host restarted, and its saved tables couldn’t be loaded');
    }
    // The level clock goes on with the time it had left.
    startStep(tid, r.step, rec.stepLeftMs);
    // Members still connected are back at once; anyone who isn't is
    // blinded off until they're back.
    for (const id of new Set(t.entries.filter(e => e.place == null).map(e => e.member))) {
      if (online(id)) run(tid, 'handle', id, {type: 'join', name: names(id)});
      else run(tid, 'disconnected', id);
    }
  }

  // Saves the tournament after a change: the engine's tables and clocks,
  // the level clock, and how many entries and players out the club had then.
  async function persist(tid, res) {
    const r = running.get(tid);
    const t = tourneyById(club(), tid);
    if (!r || !t || r.noSave || res?.seq === r.savedSeq) return;
    try {
      const json = await call('tourneySave', tid);
      if (json == null) { r.noSave = true; return; }
      const now = Date.now();
      await store.put(club().code, tourneyTable(tid), {
        json, seq: res?.seq, step: r.step, stepLeftMs: r.stepEndsAt ? Math.max(0, r.stepEndsAt - now) : null,
        level: r.level, entries: t.entries.length, out: outCount(t), at: now,
      });
      r.savedSeq = res?.seq;
    } catch (e) {
      console.warn(`tournament ${tid}: not saved:`, e);
    }
  }

  function schedule(t) {
    timers.clear(scheduled.get(t.id));
    scheduled.set(t.id, timers.set(() => begin(t.id), Math.max(0, t.startsAt - Date.now())));
  }

  // The start time: start it, or cancel it if too few registered.
  async function begin(tid) {
    scheduled.delete(tid);
    const t = tourneyById(club(), tid);
    if (!t) return;
    const what = atStart(t);
    if (what === null) { if (t.status === 'scheduled') schedule(t); return; }
    if (what === 'cancel') return abandon(tid, `fewer than ${t.minPlayers} registered`, false);
    startTourney(club(), tid);
    const r = {chain: Promise.resolve(), step: 0, onBreak: false, level: 0, timers: {}, live: null};
    running.set(tid, r);
    const levels = t.structure.filter(s => !s.break).map(({sb, bb, ante}) => ({sb, bb, ante}));
    const players = t.entries.filter(e => e.place == null).map(e => ({id: e.member, name: names(e.member)}));
    const config = {game: t.game, tableSize: t.tableSize, startingStack: t.stack, levels, paid: prizes(t).length, seed: crypto.getRandomValues(new Uint32Array(1))[0]};
    try {
      const res = await call('tourneyCreate', tid, config, players, turnMs);
      changed();
      startStep(tid, 0);
      take(tid, res);
      await persist(tid, res);
    } catch (e) {
      running.delete(tid);
      console.warn(`tournament ${tid}:`, e);
      t.status = 'scheduled'; // so it can be cancelled with refunds
      abandon(tid, 'its tables couldn’t start');
    }
  }

  // Cancels it with every buy-in back, and says why in the club's log.
  function abandon(tid, why, log = true) {
    const t = tourneyById(club(), tid);
    stop(tid);
    if (!t || t.status === 'cancelled' || t.status === 'finished') return;
    const who = [...new Set(t.entries.map(e => e.member))];
    cancelTourney(club(), tid, Date.now(), why);
    if (log) logAction(club(), club().hostId, `Tournament ${t.name} was cancelled (${why}); every buy-in was refunded`);
    for (const id of who) chipsChanged(id);
    changed();
  }

  function stop(tid) {
    const r = running.get(tid);
    if (r) {
      for (const k of Object.keys(r.timers)) clear(r, k);
      running.delete(tid);
      call('tourneyDrop', tid).catch(() => {});
    }
    store.drop(club().code, tourneyTable(tid)).catch(() => {});
    timers.clear(scheduled.get(tid));
    scheduled.delete(tid);
  }

  // The level clock: step `i` of the structure (a level, or a break) starts
  // now, or, resuming, goes on with `leftMs` to go. The last level stays
  // once it's reached.
  function startStep(tid, i, leftMs = null) {
    const r = running.get(tid);
    const t = tourneyById(club(), tid);
    if (!r || !t) return;
    const steps = t.structure;
    r.step = Math.min(i, steps.length - 1);
    const s = steps[r.step];
    r.onBreak = !!s.break;
    const level = steps.slice(0, r.step + 1).filter(x => !x.break).length - 1;
    const ms = leftMs ?? levelMs ?? s.minutes * 60_000;
    r.stepEndsAt = i < steps.length ? Date.now() + ms : null;
    clear(r, 'level');
    if (i < steps.length - 1 || s.break) r.timers.level = timers.set(() => startStep(tid, r.step + 1), ms);
    if (!r.onBreak && level !== r.level) run(tid, 'setLevel', Math.max(0, level));
    else run(tid, 'state');
  }

  // Engine calls for a tournament, one at a time, each result taken in.
  function run(tid, method, ...args) {
    const r = running.get(tid);
    if (!r) return Promise.resolve(null);
    const p = r.chain.then(async () => {
      if (!running.has(tid)) return null;
      const res = await call('tourneyCall', tid, method, ...args);
      take(tid, res);
      await persist(tid, res);
      return res;
    });
    r.chain = p.catch(e => console.warn(`tournament ${tid} ${method}:`, e));
    return p;
  }

  // A result: who's out, the winner and prizes, each player's view, and
  // what happens next.
  function take(tid, res) {
    const r = running.get(tid);
    const t = tourneyById(club(), tid);
    if (!r || !t || !res) return;
    observe(tid, res);
    const ev = res.events || {};
    let lobby = false;
    for (const f of ev.busted || []) { knockedOut(club(), tid, f.id, f.place); lobby = true; }
    if (ev.level != null) { r.level = ev.level; lobby = true; }
    r.level = res.level ?? r.level;
    r.live = {
      level: r.level, onBreak: r.onBreak, stepEndsAt: r.stepEndsAt, playersLeft: res.playersLeft, handForHand: res.handForHand,
      tables: (res.tables || []).map(x => ({id: x.id, players: x.players})),
      standings: (res.standings || []).slice().sort((a, b) => Number(b.stack) - Number(a.stack)).slice(0, 20)
        .map(s => ({id: s.id, name: s.name, stack: Number(s.stack), table: s.at?.table, absent: !!s.absent})),
    };
    for (const m of res.out || []) sendTable(m.to, {table: tourneyTable(tid), update: m.data});
    if (ev.winner) { finish(tid, ev.winner.id); return; }
    if (lobby) changed(); else liveChanged();
    pace(tid, res);
  }

  // What happens next: an absent player's move, the next hands (not during
  // a break), and the turn clocks.
  function pace(tid, res) {
    const r = running.get(tid);
    if (!r) return;
    clear(r, 'advance');
    clear(r, 'deal');
    clear(r, 'tick');
    if (res.over) return;
    if (res.autoToAct) r.timers.advance = timers.set(() => run(tid, 'advance'), botPaceMs);
    if (res.canDeal && !r.onBreak) r.timers.deal = timers.set(() => run(tid, 'newHands'), nextHandMs);
    const left = (res.tables || []).map(x => x.turnMsLeft).filter(x => x != null).map(Number);
    if (left.length) r.timers.tick = timers.set(() => run(tid, 'tick'), Math.min(...left) + 50);
  }

  // One player has all the chips: prizes into club balances.
  function finish(tid, winner) {
    const t = tourneyById(club(), tid);
    stop(tid);
    const paid = finishTourney(club(), tid, winner);
    for (const p of paid) chipsChanged(p.member);
    logAction(club(), club().hostId, `${names(winner)} won tournament ${t.name}`);
    changed();
  }

  // A member's command for tournament `tid`'s tables (join, act, sit_out,
  // sit_in, leave), or 'enter': a late registration or re-entry.
  async function handle(tid, id, cmd) {
    const r = running.get(tid);
    const t = tourneyById(club(), tid);
    if (!r || !t || !cmd || typeof cmd.type !== 'string') {
      sendTable(id, {table: tourneyTable(tid), update: {type: 'rejected', reason: 'That tournament isn’t running.', fatal: true}});
      return;
    }
    if (!isIn(t, id)) {
      sendTable(id, {table: tourneyTable(tid), update: {type: 'rejected', reason: 'You aren’t in this tournament.', fatal: true}});
      return;
    }
    await run(tid, 'handle', id, cmd);
  }

  // A late registration or a re-entry (#80): the buy-in, then a starting
  // stack at the shortest table. Throws why not.
  async function enter(tid, id) {
    const r = running.get(tid);
    if (!r) throw new Error('That tournament isn’t running.');
    lateEntry(club(), tid, id, r.level);
    chipsChanged(id);
    changed();
    await run(tid, 'addEntry', id, names(id));
  }

  // A member's connection dropped: blinded off wherever they're playing.
  function disconnected(id) {
    for (const tid of running.keys()) {
      const t = tourneyById(club(), tid);
      if (t && isIn(t, id)) run(tid, 'disconnected', id);
    }
  }

  // The host's view of one table (no hole cards until shown down).
  const tableView = (tid, table) => (running.has(tid) ? call('tourneyTable', tid, table) : Promise.resolve(null));

  return {
    startAll, schedule, begin, handle, enter, disconnected, tableView,
    cancel: (tid, why = 'the host cancelled it') => abandon(tid, why),
    live: () => Object.fromEntries([...running].map(([tid, r]) => [tid, r.live])),
    running: tid => running.has(tid),
  };
}
