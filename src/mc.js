// Monte Carlo sampling kernels, shared by the main thread and mc-worker.js.
// Everything here works on plain job data (no DOM or page state), so a job can
// be posted to a worker as-is. Cards use the engine's "As" format.
import { HoldemGame, OmahaGame, OmahaHiLoGame, OmahaBombPotGame, OmahaRange } from '../wasm/ducy_wasm.js';

// Samples per engine call.
const PER_CALL = 1000;

// The flop may be 1-3 known cards: ducy deals the rest of it for each sample.
function setBoard(game, bc, bi) {
  const args = bi == null ? [] : [bi];
  if (bc.length >= 1) game.set_flop(...args, bc.slice(0, 3).join(' '));
  if (bc.length >= 4) game.set_turn(...args, bc[3]);
  if (bc.length >= 5) game.set_river(...args, bc[4]);
}

function addDead(game, dead) {
  if (dead.length) game.add_dead_cards(dead.join(' '));
}

// Range jobs: card-mode hands are added as players first, then one player per
// range string, so results come back in that order.
function holdemGame(job, board) {
  const game = new HoldemGame();
  try {
    for (const h of job.hands) game.add_player(h.join(' '));
    setBoard(game, board);
    addDead(game, job.dead);
  } catch (err) {
    game.free();
    throw err;
  }
  return game;
}

// Upper bound on hand evaluations for an exact range calculation. Throws if a
// range has no usable combos (blocked by the board, dead cards or known hands).
export function rangeExactCost(job) {
  const game = holdemGame(job, job.boardCards.length >= 3 ? job.boardCards : []);
  try {
    return game.exact_range_evaluations(job.ranges);
  } finally {
    game.free();
  }
}

// The last bomb pot game built, for its job: reused while the same job runs.
let bombPot = {key: null, game: null};

function bombPotGame(job) {
  const key = JSON.stringify(job);
  if (bombPot.key === key) return bombPot.game;
  if (bombPot.game) bombPot.game.free();
  bombPot = {key: null, game: null};
  const game = new OmahaBombPotGame(job.numBoards, job.cardsPer);
  try {
    for (const h of job.hands) game.add_player(h.join(' '));
    job.allBoardCards.forEach((bc, bi) => setBoard(game, bc, bi));
    addDead(game, job.dead);
    // Seats holding an Omaha range: dealt a hand from it each sample.
    for (const {seat, text} of job.rangeSeats || []) {
      const range = new OmahaRange(job.cardsPer);
      try {
        range.add(text);
        game.set_seat_range(seat, range);
      } finally {
        range.free();
      }
    }
  } catch (err) {
    game.free();
    throw err;
  }
  bombPot = {key, game};
  return game;
}

export function newState(job) {
  const n = job.numPlayers;
  // `weight` is what `totals` divide by; it equals `done` unless batches are weighted.
  const st = {done: 0, weight: 0, totals: new Array(n).fill(0)};
  if (job.type === 'bombpot') {
    st.boardWins = Array.from({length: job.numBoards}, () => new Array(n).fill(0));
    st.scoops = new Array(n).fill(0);
    st.scooped = new Array(n).fill(0);
  }
  return st;
}

export function mergeState(into, from) {
  into.done += from.done;
  into.weight += from.weight;
  for (let i = 0; i < into.totals.length; i++) into.totals[i] += from.totals[i];
  if (into.boardWins) {
    for (let i = 0; i < into.totals.length; i++) {
      into.scoops[i] += from.scoops[i];
      into.scooped[i] += from.scooped[i];
      for (let bi = 0; bi < into.boardWins.length; bi++) into.boardWins[bi][i] += from.boardWins[bi][i];
    }
  }
  return into;
}

// Sample until `deadline` (performance.now() time) or until st.done reaches `maxSamples`.
export function runChunk(job, st, deadline, maxSamples) {
  const more = () => performance.now() < deadline && st.done < maxSamples;
  if (job.type === 'omaha') {
    const game = job.hilo ? new OmahaHiLoGame(job.cardsPer) : new OmahaGame(job.cardsPer);
    try {
      for (const h of job.hands) game.add_player(h.join(' '));
      setBoard(game, job.boardCards);
      addDead(game, job.dead);
      while (more()) {
        const eq = game.sample_equity(PER_CALL);
        for (let i = 0; i < st.totals.length; i++) st.totals[i] += eq[i] * PER_CALL;
        st.done += PER_CALL;
        st.weight += PER_CALL;
      }
    } finally {
      game.free();
    }
  } else if (job.type === 'bombpot') {
    // Built once per job and kept across chunks: preparing a narrow range
    // (AAxx) can take longer than a chunk.
    const game = bombPotGame(job);
    while (more()) {
      const r = game.sample(PER_CALL, job.randomIndices);
      for (let fi = 0; fi < st.totals.length; fi++) {
        st.totals[fi] += r.equity_sum[fi];
        st.scoops[fi] += r.scoops[fi];
        st.scooped[fi] += r.scooped[fi];
        for (let bi = 0; bi < job.numBoards; bi++) st.boardWins[bi][fi] += r.board_wins[bi][fi];
      }
      st.done += r.samples;
      st.weight += r.samples;
    }
  } else if (job.type === 'orange') {
    // Omaha shorthand ranges: known hands first, then one player per range.
    const game = job.hilo ? new OmahaHiLoGame(job.cardsPer) : new OmahaGame(job.cardsPer);
    try {
      for (const h of job.hands) game.add_player(h.join(' '));
      setBoard(game, job.boardCards);
      addDead(game, job.dead);
      while (more()) {
        const r = game.sample_range_equity(job.ranges, PER_CALL);
        for (let i = 0; i < st.totals.length; i++) st.totals[i] += r.equity_sum[i];
        st.done += r.samples;
        st.weight += r.samples;
      }
    } finally {
      game.free();
    }
  } else if (job.type === 'range') {
    if (job.exact) {
      if (st.done > 0) return st;
      const game = holdemGame(job, job.boardCards);
      try {
        const eq = game.range_equity(job.ranges);
        for (let i = 0; i < st.totals.length; i++) st.totals[i] += eq[i];
        st.done = 1;
        st.weight = 1;
      } finally {
        game.free();
      }
      return st;
    }
    const game = holdemGame(job, job.boardCards);
    try {
      while (more()) {
        const r = game.sample_range_equity(job.ranges, PER_CALL);
        for (let i = 0; i < st.totals.length; i++) st.totals[i] += r.equity_sum[i];
        st.weight += r.samples;
        st.done += r.samples;
      }
    } finally {
      game.free();
    }
  } else {
    throw new Error('unknown job type ' + job.type);
  }
  return st;
}
