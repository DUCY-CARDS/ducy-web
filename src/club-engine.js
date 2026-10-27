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
// Tournaments (#81, club-tourney-host.js): ducy's ClubTournament, each run
// by its tourney runner (tourney-runner.js, #458): tourneyCreate(id,
// config, players, turnMs, runner) | tourneyRestore(id, json, runner) |
// tourneyEvent(id, event) → the runner's step (the time is added) |
// tourneyTable(id, table) | tourneySave(id) | tourneyDrop(id). `runner` =
// the runner's options (structure, levelMs, nextHandMs, botPaceMs, step,
// stepLeftMs, level, hands).

import { fairCommitment, fairSecret, fairSeed } from '../wasm/ducy_wasm.js';
import { tableRunner } from './table-runner.js';
import { tourneyRunner } from './tourney-runner.js';
// The whole module too: ClubTournament is only in newer builds.
import * as ducy from '../wasm/ducy_wasm.js';

const fair = {secret: fairSecret, commitment: fairCommitment, seed: fairSeed};

// ducy's own runner (ducy-play's runner, #452), the same events in and
// steps out as table-runner.js; an older ducy-wasm doesn't have it.
const rustRunner = ducy.ClubTable
  ? {
    create: (id, c) => ducy.ClubTable.create(id, c),
    restore: (id, json, c) => ducy.ClubTable.restore(id, json, c, Date.now()) ?? null,
    wrap: t => ({event: (ev, at) => t.event(ev, at), save: at => t.save(at), free: () => t.free()}),
  }
  : null;

// `MultiTable`: ducy's (the real engine) or a stand-in a test scripts. With
// ducy's, tables run on ducy's runner when it has one; table-runner.js runs
// them otherwise.
export function clubEngine(MultiTable) {
  const runners = new Map();
  const clocks = new Map();
  const tourneys = new Map();
  const rust = MultiTable === ducy.MultiTable ? rustRunner : null;

  function now(key) {
    const c = clocks.get(key);
    return c ? (c.at ?? Date.now()) - c.lost : Date.now();
  }

  // Runs table `t` for table id with `config`'s runner options.
  function runWith(id, t, config) {
    t.setSitOutLimit(config.sitOutMs ?? 10 * 60_000);
    keep(id, tableRunner(t, {...config, id, fair}));
  }

  function keep(id, r) {
    runners.get(id)?.free();
    runners.set(id, r);
  }

  function keepTourney(id, r) {
    tourneys.get(id)?.free();
    tourneys.set(id, r);
  }

  const ops = {
    runnerCreate: (id, c) => {
      if (rust) { keep(id, rust.wrap(rust.create(id, c))); return true; }
      const t = MultiTable.club(c.seats, BigInt(c.minBuyIn), BigInt(c.maxBuyIn), BigInt(c.sb), BigInt(c.bb), BigInt(c.seed), c.game, BigInt(c.turnMs));
      runWith(id, t, c);
      return true;
    },
    // A table saved with runnerSave, waiting for its people (throws if it
    // can't be loaded). One saved holding a chip request (before #427)
    // isn't resumed: the ledger may have paid it.
    runnerRestore: (id, json, c) => {
      if (rust) {
        const t = rust.restore(id, json, c);
        if (!t) return false;
        keep(id, rust.wrap(t));
        return true;
      }
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
    tourneyCreate: (id, config, players, turnMs, runner) => {
      if (!ducy.ClubTournament) throw new Error('this ducy-wasm has no tournaments');
      keepTourney(id, tourneyRunner(new ducy.ClubTournament(config, players, turnMs), {...runner, id}));
      return true;
    },
    // An event for tournament id's runner (tourney-runner.js); the time is added.
    tourneyEvent: (id, ev) => {
      const r = tourneys.get(id);
      if (!r) throw new Error(`no tournament ${id}`);
      return r.event(ev, Date.now());
    },
    // The host's view of one of its tables (no hole cards until shown down).
    tourneyTable: (id, table) => tourneys.get(id)?.tableView(table) ?? null,
    tourneyDrop: id => { tourneys.get(id)?.free(); return tourneys.delete(id); },
    // The tournament as JSON, hands in play and clocks included, for
    // resuming it after the host restarts; null with a ducy-wasm that can't.
    tourneySave: id => tourneys.get(id)?.save(Date.now()) ?? null,
    // A tournament saved with tourneySave, its runner's clock where `runner`
    // says; throws if it can't be loaded.
    tourneyRestore: (id, json, runner) => {
      if (!ducy.ClubTournament?.restore) throw new Error('this ducy-wasm can’t restore tournaments');
      keepTourney(id, tourneyRunner(ducy.ClubTournament.restore(json, Date.now()), {...runner, id}));
      return true;
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
