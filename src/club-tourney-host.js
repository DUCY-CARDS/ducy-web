// Runs a club's tournaments (#81), as club-host.js runs its cash tables:
// ducy's ClubTournament (through club-engine.js) deals every table, moves
// players to keep tables balanced and breaks them down to a final table,
// and blinds off anyone absent. Its runner (ducy's ClubTourney, #458) has
// the tournament's time: the level clock with its breaks and the pacing.
// ducy-play's club_tourney_host (tourneyHost in club-tourneys.js, #456) says
// what each start time and result means for the club: starting it or
// cancelling it short of players, who's knocked out in what place, late
// registrations and re-entries (#80), and the prizes into club balances
// when there's a winner (#79). This file carries that out: it times each
// start, sends each player their own view, saves, and wakes the runner when
// it asks.
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
//                        (an always-on club's room passes its own; null:
//                        not saved, as for a one-off tournament, #394)
//   turnMs, nextHandMs, botPaceMs, levelMs   pacing (tests use short ones;
//                        levelMs replaces each level's minutes)
//   observe(tid, res)    sees every engine result (tests)
//   onHand(tid, table, view)  a hand finished at one of its tables: the
//                        table's spectator view (no hidden cards; each
//                        seat's id is the member), for promotions (#274)
//   onPlay()             a hand is in play at one of its tables (usage, #421)
//
// A running tournament is saved after every change (its tables, hands in
// play, turn clocks and the level clock), so when the host restarts it
// carries on where it was: members still connected are back at once, and
// anyone who isn't is blinded off until they are. Only if nothing usable was
// saved (or it's out of step with the club) is it cancelled, with every
// buy-in refunded.

import { tourneyById, tourneyHost } from './club-tourneys.js';
import { browserTimers, workerCall } from './club-host.js';
import { dropTable, getTable, putTable } from './table-store.js';
const TURN_MS = 30_000;
export const NEXT_HAND_MS = 2500;
export const BOT_PACE_MS = 700;
export const tourneyTable = tid => `tourney:${tid}`;

export function createTourneyHost({
  club, save, sendTable, chipsChanged, tourneysChanged = () => {}, liveChanged = () => {}, online = () => true,
  call = workerCall, timers = browserTimers, store = {get: getTable, put: putTable, drop: dropTable}, turnMs = TURN_MS, nextHandMs = NEXT_HAND_MS, botPaceMs = BOT_PACE_MS, levelMs = null,
  observe = () => {}, onHand = null, onPlay = () => {},
}) {
  const running = new Map(); // tid → {chain, step, onBreak, level, stepEndsAt, wakeT, live}
  const scheduled = new Map(); // tid → timer handle

  // The runner's options for tournament `t`, and where its clock was.
  const runnerConfig = (t, at = {}) => ({structure: t.structure, levelMs, nextHandMs, botPaceMs, hands: !!onHand, ...at});
  const changed = () => { save(); tourneysChanged(); };

  // Carries out what the club made of something (club_tourney_host): the
  // messages, balances and lobby. Returns the step.
  function carry(tid, step) {
    for (const s of step.sends) sendTable(s.to, {table: tourneyTable(tid), update: s.update});
    for (const id of step.chipsChanged) chipsChanged(id);
    if (step.over) stop(tid);
    if (step.changed) changed();
    else if (step.liveChanged) liveChanged();
    return step;
  }
  const rule = (tid, op, args) => carry(tid, tourneyHost(club(), tid, op, args));

  // Starts, or schedules the start of, every tournament waiting for it, and
  // picks up any that was running when the host stopped.
  function startAll() {
    for (const t of club().tourneys || []) {
      if (t.status === 'scheduled') schedule(t);
      else if (t.status === 'running' && !running.has(t.id)) resume(t);
    }
  }

  // A tournament that was running when the host stopped: loaded from where
  // it was saved, if that's in step with the club; otherwise cancelled with
  // refunds.
  async function resume(t) {
    const tid = t.id;
    let rec = null;
    try { rec = await store?.get(club().code, tourneyTable(tid)); } catch (e) { console.warn(`tournament ${tid}: not loaded:`, e); }
    const here = (t.entries || []).map(e => e.member).filter(id => online(id));
    const back = rule(tid, 'resume', {saved: rec?.json ? {entries: rec.entries, out: rec.out} : null, online: [...new Set(here)]});
    if (!back.value) return;
    const r = {chain: Promise.resolve(), step: rec.step ?? 0, onBreak: false, level: rec.level ?? 0, wakeT: null, live: null, savedSeq: rec.seq};
    running.set(tid, r);
    try {
      await call('tourneyRestore', tid, rec.json, runnerConfig(t, {step: rec.step ?? 0, stepLeftMs: rec.stepLeftMs ?? null, level: rec.level ?? 0}));
    } catch (e) {
      console.warn(`tournament ${tid}: not resumed:`, e);
      running.delete(tid);
      return abandon(tid, 'the club restarted, and its saved tables couldn’t be loaded');
    }
    // The level clock goes on with the time it had left; then the players
    // come back.
    run(tid, {type: 'begin'});
    for (const ev of back.events) run(tid, ev);
  }

  // Saves the tournament after a change: the engine's tables and clocks,
  // the level clock, and how many entries and players out the club had then.
  async function persist(tid, res, counts) {
    const r = running.get(tid);
    if (!store || !r || !counts || r.noSave || res?.seq === r.savedSeq) return;
    try {
      const json = await call('tourneySave', tid);
      if (json == null) { r.noSave = true; return; }
      const now = Date.now();
      await store.put(club().code, tourneyTable(tid), {
        json, seq: res?.seq, step: r.step, stepLeftMs: r.stepEndsAt ? Math.max(0, r.stepEndsAt - now) : null,
        level: r.level, entries: counts.entries, out: counts.out, at: now,
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
    const what = rule(tid, 'atStart', {seed: crypto.getRandomValues(new Uint32Array(1))[0]}).value;
    if (what === 'wait') { if (t.status === 'scheduled') schedule(t); return; }
    if (typeof what === 'string') return;
    const r = {chain: Promise.resolve(), step: 0, onBreak: false, level: 0, wakeT: null, live: null};
    running.set(tid, r);
    try {
      await call('tourneyCreate', tid, what.config, what.players, turnMs, runnerConfig(t));
      await run(tid, {type: 'begin'});
    } catch (e) {
      running.delete(tid);
      console.warn(`tournament ${tid}:`, e);
      abandon(tid, 'its tables couldn’t start');
    }
  }

  // Cancels it with every buy-in back, and says why in the club's log.
  function abandon(tid, why, log = true) {
    stop(tid);
    try { rule(tid, 'abandon', {why, log}); } catch (e) { console.warn(`tournament ${tid}: not cancelled:`, e); }
  }

  function stop(tid) {
    const r = running.get(tid);
    if (r) {
      timers.clear(r.wakeT);
      r.wakeT = null;
      running.delete(tid);
      call('tourneyDrop', tid).catch(() => {});
    }
    store?.drop(club().code, tourneyTable(tid)).catch(() => {});
    timers.clear(scheduled.get(tid));
    scheduled.delete(tid);
  }

  // Sends tournament tid's runner an event, one at a time, and handles its step.
  function run(tid, ev) {
    const r = running.get(tid);
    if (!r) return Promise.resolve(null);
    const p = r.chain.then(async () => {
      if (!running.has(tid)) return null;
      const step = await call('tourneyEvent', tid, ev);
      await apply(tid, r, step);
      return step;
    });
    r.chain = p.catch(e => console.warn(`tournament ${tid} ${ev.type}:`, e));
    return p;
  }

  // What the runner did: engine results and finished hands; then its next
  // wake-up.
  async function apply(tid, r, step) {
    Object.assign(r, {step: step.step, stepEndsAt: step.stepEndsAt, onBreak: step.onBreak, level: step.level});
    for (const a of step.actions) {
      if (!running.has(tid)) return;
      if (a.type === 'engine') {
        const counts = take(tid, a.res);
        if (!running.has(tid)) return;
        await persist(tid, a.res, counts);
      } else if (a.type === 'hand' && onHand) {
        try { onHand(tid, a.table, a.view); } catch (e) { console.warn('tournament hand:', e); }
      }
    }
    timers.clear(r.wakeT);
    r.wakeT = null;
    if (step.wake != null && running.has(tid)) {
      r.wakeT = timers.set(() => { r.wakeT = null; run(tid, {type: 'wake'}); }, Math.max(0, step.wake - Date.now()));
    }
  }

  // A result: who's out, the winner and prizes, each player's view. Returns
  // the tournament's counts to save with it.
  function take(tid, res) {
    const r = running.get(tid);
    if (!r || !res) return null;
    observe(tid, res);
    const step = tourneyHost(club(), tid, 'result', {res, clock: {level: r.level, onBreak: r.onBreak, stepEndsAt: r.stepEndsAt}});
    if (step.live) r.live = step.live;
    if (step.onPlay) onPlay();
    carry(tid, step);
    return step.counts;
  }

  // A member's command for tournament `tid`'s tables (join, act, sit_out,
  // sit_in, leave).
  async function handle(tid, id, cmd) {
    if (!rule(tid, 'check', {id, running: running.has(tid) && !!cmd && typeof cmd.type === 'string'}).value) return;
    await run(tid, {type: 'cmd', id, cmd});
  }

  // A late registration or a re-entry (#80): the buy-in, then a starting
  // stack at the shortest table. Throws why not.
  async function enter(tid, id) {
    const r = running.get(tid);
    if (!r) throw new Error('That tournament isn’t running.');
    const step = rule(tid, 'enter', {id, level: r.level});
    for (const ev of step.events) await run(tid, ev);
  }

  // A member's connection dropped: blinded off wherever they're playing.
  function disconnected(id) {
    if (!running.size) return;
    for (const tid of tourneyHost(club(), '', 'playing', {id, running: [...running.keys()]}).value) run(tid, {type: 'disconnected', id});
  }

  // The host's view of one table (no hole cards until shown down).
  const tableView = (tid, table) => (running.has(tid) ? call('tourneyTable', tid, table) : Promise.resolve(null));

  return {
    startAll, schedule, begin, handle, enter, disconnected, tableView,
    cancel: (tid, why = 'the manager cancelled it') => abandon(tid, why),
    live: () => Object.fromEntries([...running].map(([tid, r]) => [tid, r.live])),
    running: tid => running.has(tid),
  };
}
