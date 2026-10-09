// A club's tables in ducy's engine (MultiTable.club, from ducy-wasm), kept
// by table id. Shared by the page's worker (play-worker.js), where the
// host's tab runs a club, and by the relay's Worker, where an always-on club
// runs (#93). Ops, each returning the engine's result:
//   clubCreate(id, seats, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs) |
//   clubCall(id, method, ...args) for handle, disconnected, newHand,
//     advance, tick, approveChips, denyChips, remove, state, resume (the
//     time is added) | clubDrop(id) | clubSave(id) | clubRestore(id, json) |
//   clubSitOutLimit(id, ms) | clockPause(key, on)
// clubCall results also carry `players` and `departed`.
//
// Each table sees its own clock: real time, minus the time it was stopped
// (clockPause) because the host couldn't reach anyone. The page's friends
// table uses the same clocks under the key 'host'.
//
// Fair deals (#136): clubCall(id, 'newHand', seed) deals from a commit–reveal
// seed, and fairSecret() | fairCommitment(value, nonce) | fairSeed(values)
// are ducy's fair-deal functions, for the host's side of the round.
//
// Tournaments (#81, club-tourney-host.js): tourneyCreate(id, config,
// players, turnMs) | tourneyCall(id, method, ...args) for handle,
// disconnected, advance, tick, newHands, setLevel, addEntry, state (the
// time is added) | tourneyTable(id, table) | tourneyDrop(id).

import { fairCommitment, fairSecret, fairSeed } from '../wasm/ducy_wasm.js';
// The whole module too: ClubTournament is only in newer builds.
import * as ducy from '../wasm/ducy_wasm.js';

// Tournaments (#81): ducy's ClubTournament, by tournament id.
const TOURNEY_METHODS = new Set(['handle', 'disconnected', 'advance', 'tick', 'newHands', 'setLevel', 'addEntry', 'state']);

const CLUB_METHODS = new Set(['handle', 'disconnected', 'newHand', 'advance', 'tick', 'approveChips', 'denyChips', 'remove', 'state', 'resume']);

export function clubEngine(MultiTable) {
  const tables = new Map();
  const clocks = new Map();
  const tourneys = new Map();

  function now(key) {
    const c = clocks.get(key);
    return c ? (c.at ?? Date.now()) - c.lost : Date.now();
  }

  const ops = {
    clubCreate: (id, seats, minBuyIn, maxBuyIn, sb, bb, seed, game, turnMs) => {
      tables.get(id)?.free();
      clocks.delete(id);
      const t = MultiTable.club(seats, BigInt(minBuyIn), BigInt(maxBuyIn), BigInt(sb), BigInt(bb), BigInt(seed), game, BigInt(turnMs));
      tables.set(id, t);
      return t.state(now(id));
    },
    clubCall: (id, method, ...args) => {
      const t = tables.get(id);
      if (!t || !CLUB_METHODS.has(method)) throw new Error(`no table ${id} or method ${method}`);
      // newHand takes the time first, then the fair-deal seed if there is one.
      if (method === 'newHand') return t.newHand(now(id), args[0] || undefined);
      return t[method](...args, now(id));
    },
    fairSecret: () => fairSecret(),
    fairCommitment: (value, nonce) => fairCommitment(value, nonce),
    fairSeed: values => fairSeed(values),
    clubDrop: id => { tables.get(id)?.free(); clocks.delete(id); return tables.delete(id); },
    // The table as JSON for resuming it after a restart (#107); null with an
    // older ducy-wasm, which can't save tables.
    clubSave: id => { const t = tables.get(id); return t?.save ? t.save(now(id)) : null; },
    // A table saved with clubSave, paused until resume (throws if it can't be loaded).
    clubRestore: (id, json) => {
      if (!MultiTable.restore) throw new Error('this ducy-wasm can’t restore tables');
      // Times in the snapshot are time left, so the restored table starts a fresh clock.
      clocks.delete(id);
      const t = MultiTable.restore(json, Date.now());
      tables.get(id)?.free();
      tables.set(id, t);
      return t.state(Date.now());
    },
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
    // How long someone may sit out at table id before their seat goes (ms; 0: no limit).
    clubSitOutLimit: (id, ms) => { tables.get(id)?.setSitOutLimit(ms); return true; },
    // Stops (on) or restarts a table's clock: while stopped no time passes
    // for it, so no turn runs out and no sit-out expires; it resumes with the
    // time that was left.
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
