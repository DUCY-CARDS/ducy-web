// A club's tables in ducy's engine (ducy-wasm), each run by ducy's table
// runner (ClubTable, #452), kept by table id. Shared by the page's worker
// (play-worker.js), where the host's tab runs a club, and by the relay's
// Worker, where an always-on club runs (#93). Ops:
//   runnerCreate(id, config) | runnerRestore(id, json, config) → whether it
//     could | runnerEvent(id, event) → the runner's step (the time is
//     added) | runnerSave(id) → JSON | runnerCards(id) → every seat's
//     hole cards (an always-on club's full record, #580) | runnerDrop(id)
// config = {seats, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs,
// sitOutMs}, and the runner's own options (open, link, active, idleMs, askMs).
//
// The page's friends table (play.js, #462) runs the same way, its host in
// seat 0: runnerFriends(id, config) | runnerRestoreFriends(id, json,
// config), config as above plus {hostName, hostChips, bombEvery, autoDeal}.
//
// Tournaments (#81, club-tourney-host.js): each run by ducy's tournament
// runner (ClubTourney, #458): tourneyCreate(id, config, players, turnMs,
// runner) | tourneyRestore(id, json, runner) | tourneyEvent(id, event) →
// the runner's step (the time is added) | tourneyTable(id, table) |
// tourneySave(id) | tourneyDrop(id). `runner` = the runner's options
// (structure, levelMs, nextHandMs, botPaceMs, step, stepLeftMs, level, hands).
//
// The wasm must be loaded first (the page's worker and the relay do it).

import * as ducy from '../wasm/ducy_wasm.js';

const wrapTable = t => ({event: (ev, at) => t.event(ev, at), save: at => t.save(at), holeCards: () => t.holeCards(), free: () => t.free()});
const wrapTourney = t => ({event: (ev, at) => t.event(ev, at), save: at => t.save(at), tableView: table => t.tableView(table), free: () => t.free()});

// `ClubTable`: ducy's, or one the demo's relay makes {create, restore}.
export function clubEngine(ClubTable = ducy.ClubTable) {
  const runners = new Map();
  const tourneys = new Map();

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
      keep(id, wrapTable(ClubTable.create(id, c)));
      return true;
    },
    // A table saved with runnerSave, waiting for its people (throws if it
    // can't be loaded). One saved holding a chip request (before #427)
    // isn't resumed: the ledger may have paid it.
    runnerRestore: (id, json, c) => {
      const t = ClubTable.restore(id, json, c, Date.now());
      if (!t) return false;
      keep(id, wrapTable(t));
      return true;
    },
    // A friends table: the host plays seat 0 (ClubTable.friends).
    runnerFriends: (id, c) => {
      keep(id, wrapTable(ClubTable.friends(id, c)));
      return true;
    },
    // A friends table saved with runnerSave, waiting for its people (throws
    // if it can't be loaded).
    runnerRestoreFriends: (id, json, c) => {
      keep(id, wrapTable(ClubTable.restoreFriends(id, json, c, Date.now())));
      return true;
    },
    runnerEvent: (id, ev) => {
      const r = runners.get(id);
      if (!r) throw new Error(`no table ${id}`);
      return r.event(ev, Date.now());
    },
    // The table as JSON for resuming it after a restart (#107).
    runnerSave: id => runners.get(id)?.save(Date.now()) ?? null,
    // Every seat's hole cards in the hand at the table, folded ones too
    // ({hand, seats: [{seat, cards}]}), for an always-on club's full record
    // of it (#580). Never sent to anyone.
    runnerCards: id => runners.get(id)?.holeCards() ?? null,
    runnerDrop: id => { runners.get(id)?.free(); return runners.delete(id); },
    // A tournament (#81): every table of it, for remote players. `config` =
    // {game, tableSize, startingStack, levels: [{sb, bb, ante}], paid, seed},
    // `players` = [{id, name}], seated at random; all absent until they join.
    tourneyCreate: (id, config, players, turnMs, runner) => {
      keepTourney(id, wrapTourney(ducy.ClubTourney.create(id, config, players, turnMs, runner)));
      return true;
    },
    // An event for tournament id's runner; the time is added.
    tourneyEvent: (id, ev) => {
      const r = tourneys.get(id);
      if (!r) throw new Error(`no tournament ${id}`);
      return r.event(ev, Date.now());
    },
    // The host's view of one of its tables (no hole cards until shown down).
    tourneyTable: (id, table) => tourneys.get(id)?.tableView(table) ?? null,
    tourneyDrop: id => { tourneys.get(id)?.free(); return tourneys.delete(id); },
    // The tournament as JSON, hands in play and clocks included, for
    // resuming it after the host restarts.
    tourneySave: id => tourneys.get(id)?.save(Date.now()) ?? null,
    // A tournament saved with tourneySave, its runner's clock where `runner`
    // says; throws if it can't be loaded.
    tourneyRestore: (id, json, runner) => {
      keepTourney(id, wrapTourney(ducy.ClubTourney.restore(id, json, runner, Date.now())));
      return true;
    },
  };
  return {ops};
}
