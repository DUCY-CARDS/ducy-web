// A club's tables in ducy's engine (MultiTable.club, from ducy-wasm), each
// run by its table runner (table-runner.js), kept by table id. Shared by the
// page's worker (play-worker.js), where the host's tab runs a club, and by
// the relay's Worker, where an always-on club runs (#93). Ops:
//   runnerCreate(id, config) | runnerRestore(id, json, config) → whether it
//     could | runnerEvent(id, event) → the runner's step (the time is
//     added) | runnerSave(id) → JSON or null | runnerDrop(id)
// config = {seats, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs,
// sitOutMs}, and the runner's own options (open, link, active, idleMs, askMs).
//
// The page's friends table keeps its clock here, under the key 'host':
// real time, minus the time it was stopped (clockPause(key, on)) because
// the host couldn't reach anyone.
//
// Tournaments (#81, club-tourney-host.js): tourneyCreate(id, config,
// players, turnMs) | tourneyCall(id, method, ...args) for handle,
// disconnected, advance, tick, newHands, setLevel, addEntry, state (the
// time is added) | tourneyTable(id, table) | tourneyDrop(id) |
// tourneySave(id) | tourneyRestore(id, json).

import { fairCommitment, fairSecret, fairSeed } from '../wasm/ducy_wasm.js';
import { tableRunner } from './table-runner.js';
// The whole module too: ClubTournament is only in newer builds.
import * as ducy from '../wasm/ducy_wasm.js';

// Tournaments (#81): ducy's ClubTournament, by tournament id.
const TOURNEY_METHODS = new Set(['handle', 'disconnected', 'advance', 'tick', 'newHands', 'setLevel', 'addEntry', 'state']);

const fair = {secret: fairSecret, commitment: fairCommitment, seed: fairSeed};

export function clubEngine(MultiTable) {
  const runners = new Map();
  const clocks = new Map();
  const tourneys = new Map();

  function now(key) {
    const c = clocks.get(key);
    return c ? (c.at ?? Date.now()) - c.lost : Date.now();
  }

  // Runs table `t` for table id with `config`'s runner options.
  function runWith(id, t, config) {
    t.setSitOutLimit(config.sitOutMs ?? 10 * 60_000);
    runners.get(id)?.free();
    runners.set(id, tableRunner(t, {...config, id, fair}));
  }

  const ops = {
    runnerCreate: (id, c) => {
      const t = MultiTable.club(c.seats, BigInt(c.minBuyIn), BigInt(c.maxBuyIn), BigInt(c.sb), BigInt(c.bb), BigInt(c.seed), c.game, BigInt(c.turnMs));
      runWith(id, t, c);
      return true;
    },
    // A table saved with runnerSave, waiting for its people (throws if it
    // can't be loaded). One saved holding a chip request (before #427)
    // isn't resumed: the ledger may have paid it.
    runnerRestore: (id, json, c) => {
      if (!MultiTable.restore) throw new Error('this ducy-wasm can’t restore tables');
      // Times in the snapshot are time left, so the restored table starts a fresh clock.
      const t = MultiTable.restore(json, Date.now());
      if (t.state(Date.now()).chipRequests?.length) { t.free?.(); return false; }
      runWith(id, t, {...c, paused: true});
      return true;
    },
    runnerEvent: (id, ev) => {
      const r = runners.get(id);
      if (!r) throw new Error(`no table ${id}`);
      return r.event(ev, Date.now());
    },
    // The table as JSON for resuming it after a restart (#107); null with an
    // older ducy-wasm, which can't save tables.
    runnerSave: id => runners.get(id)?.save(Date.now()) ?? null,
    runnerDrop: id => { runners.get(id)?.free(); return runners.delete(id); },
    // A tournament (#81): every table of it, for remote players. `config` =
    // {game, tableSize, startingStack, levels: [{sb, bb, ante}], paid, seed},
    // `players` = [{id, name}], seated at random; all absent until they join.
    tourneyCreate: (id, config, players, turnMs) => {
      if (!ducy.ClubTournament) throw new Error('this ducy-wasm has no tournaments');
      tourneys.get(id)?.free();
      const t = new ducy.ClubTournament(config, players, turnMs);
      tourneys.set(id, t);
      return t.state(Date.now());
    },
    // A call on tournament id; the time is added.
    tourneyCall: (id, method, ...args) => {
      const t = tourneys.get(id);
      if (!t || !TOURNEY_METHODS.has(method)) throw new Error(`no tournament ${id} or method ${method}`);
      return t[method](...args, Date.now());
    },
    // The host's view of one of its tables (no hole cards until shown down).
    tourneyTable: (id, table) => tourneys.get(id)?.tableView(table) ?? null,
    tourneyDrop: id => { tourneys.get(id)?.free(); return tourneys.delete(id); },
    // The tournament as JSON, hands in play and clocks included, for
    // resuming it after the host restarts; null with a ducy-wasm that can't.
    tourneySave: id => { const t = tourneys.get(id); return t?.save ? t.save(Date.now()) : null; },
    // A tournament saved with tourneySave; throws if it can't be loaded.
    tourneyRestore: (id, json) => {
      if (!ducy.ClubTournament?.restore) throw new Error('this ducy-wasm can’t restore tournaments');
      const t = ducy.ClubTournament.restore(json, Date.now());
      tourneys.get(id)?.free();
      tourneys.set(id, t);
      return t.state(Date.now());
    },
    // Stops (on) or restarts the friends table's clock: while stopped no
    // time passes for it, so no turn runs out and no sit-out expires; it
    // resumes with the time that was left.
    clockPause: (key, on) => {
      const c = clocks.get(key) || {at: null, lost: 0};
      if (on && c.at == null) c.at = Date.now();
      if (!on && c.at != null) { c.lost += Date.now() - c.at; c.at = null; }
      clocks.set(key, c);
      return true;
    },
  };
  return {ops, now, clocks};
}
