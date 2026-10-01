// Monte Carlo sampling kernels, shared by the main thread and mc-worker.js.
// Everything here works on plain job data (no DOM or page state), so a job can
// be posted to a worker as-is. Cards use the engine's "As" format.
import { HoldemGame, OmahaGame, OmahaHiLoGame, OmahaBombPotGame } from '../wasm/ducy_wasm.js';

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// The engine only accepts a board of 0, 3, 4 or 5 cards, so a board with
// 1-2 known cards gets a random flop completion for each sampling call.
function completeFlops(allBoardCards, available) {
  if (!allBoardCards.some(bc => bc.length === 1 || bc.length === 2)) return allBoardCards;
  shuffleArray(available);
  let dealt = 0;
  return allBoardCards.map(bc => {
    if (bc.length !== 1 && bc.length !== 2) return bc;
    const extra = available.slice(dealt, dealt + 3 - bc.length);
    dealt += extra.length;
    return [...bc, ...extra];
  });
}

// With a 1-2 card board each call shares one random flop completion, so small
// calls spread samples over more flops: 25 per flop measured about half the
// error of 100 at 100k samples, for ~1.7x the time.
function samplesPerCall(allBoardCards) {
  return allBoardCards.some(bc => bc.length === 1 || bc.length === 2) ? 25 : 1000;
}

function setBoard(game, bc, bi) {
  const args = bi == null ? [] : [bi];
  if (bc.length >= 3) game.set_flop(...args, bc.slice(0, 3).join(' '));
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
    const available = job.available.slice();
    const perCall = samplesPerCall([job.boardCards]);
    while (more()) {
      const [flop] = completeFlops([job.boardCards], available);
      const game = job.hilo ? new OmahaHiLoGame(job.cardsPer) : new OmahaGame(job.cardsPer);
      try {
        for (const h of job.hands) game.add_player(h.join(' '));
        setBoard(game, flop);
        addDead(game, job.dead);
        const eq = game.sample_equity(perCall);
        for (let i = 0; i < st.totals.length; i++) st.totals[i] += eq[i] * perCall;
        st.done += perCall;
        st.weight += perCall;
      } finally {
        game.free();
      }
    }
  } else if (job.type === 'bombpot') {
    const available = job.available.slice();
    const perCall = samplesPerCall(job.allBoardCards);
    while (more()) {
      const boards = completeFlops(job.allBoardCards, available);
      const game = new OmahaBombPotGame(job.numBoards, job.cardsPer);
      try {
        for (const h of job.hands) game.add_player(h.join(' '));
        boards.forEach((bc, bi) => setBoard(game, bc, bi));
        addDead(game, job.dead);
        const r = game.sample(perCall, job.randomIndices);
        for (let fi = 0; fi < st.totals.length; fi++) {
          st.totals[fi] += r.equity_sum[fi];
          st.scoops[fi] += r.scoops[fi];
          st.scooped[fi] += r.scooped[fi];
          for (let bi = 0; bi < job.numBoards; bi++) st.boardWins[bi][fi] += r.board_wins[bi][fi];
        }
        st.done += r.samples;
        st.weight += r.samples;
      } finally {
        game.free();
      }
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
    const available = job.available.slice();
    const perCall = samplesPerCall([job.boardCards]);
    const partialFlop = job.boardCards.length === 1 || job.boardCards.length === 2;
    while (more()) {
      const [board] = completeFlops([job.boardCards], available);
      const game = holdemGame(job, board);
      try {
        // A random flop completion changes which combos are possible, so weight
        // each batch by the engine's count of compatible combos for that flop,
        // and skip completions that block a range entirely.
        let weight = 1;
        if (partialFlop) {
          try {
            weight = game.exact_range_evaluations(job.ranges);
          } catch (err) {
            continue;
          }
        }
        const r = game.sample_range_equity(job.ranges, perCall);
        for (let i = 0; i < st.totals.length; i++) st.totals[i] += weight * r.equity_sum[i];
        st.weight += weight * r.samples;
        st.done += r.samples;
      } finally {
        game.free();
      }
    }
  } else {
    throw new Error('unknown job type ' + job.type);
  }
  return st;
}
