import init, { HoldemGame, OmahaGame, OmahaHiLoGame, OmahaBombPotGame, OmahaRangeSampler } from '../wasm/ducy_wasm.js';
import { newState, mergeState, runChunk, rangeExactCost } from './mc.js';
import { RANGE_PRESETS, PRESET_GROUPS, presetRangeText } from './presets.js';
import { RK, COMBOS, parseRange, comboCount, topRange } from './ranges.js';
import { openTrainer, closeTrainer, trainerOpen } from './trainer.js';
import { openPlay, closePlay, playOpen } from './play.js';
import { openClubs, closeClubs } from './clubs.js';

const ST = [
  {ch:'♠', c:'s', cl:'bl'},
  {ch:'♥', c:'h', cl:'rd'},
  {ch:'♦', c:'d', cl:'rd'},
  {ch:'♣', c:'c', cl:'bl'},
];
const GM = {
  'nlhe':      {cards:2, max:10, numBoards:1},
  'omaha':     {cards:4, max:10, numBoards:1},
  'omaha-hl':  {cards:4, max:10, numBoards:1},
  'omaha5':    {cards:5, max:9,  numBoards:1},
  'omaha5-hl': {cards:5, max:9,  numBoards:1},
  'omaha6':    {cards:6, max:6,  numBoards:1},
  'omaha6-hl': {cards:6, max:6,  numBoards:1},
  'bomb-pot':  {cards:4, max:10, numBoards:2},
};
const CW = {2:42, 4:32, 5:28, 6:24};
const ALL_CARDS = [];
for (const suit of ST) for (const rank of RK) ALL_CARDS.push(rank + suit.c);

let wasmReady = false;
let curG = 'nlhe';
let seats = new Array(10).fill(null);
let boards = [[null,null,null,null,null]];
let deadCards = [];
let eqs = new Array(10).fill(null);
let bpStats = null;
let calced = false;
let calculating = false;
let target = null;

function g() { return GM[curG]; }
function isBombPot() { return curG === 'bomb-pot'; }

function initBoards() {
  const nb = g().numBoards;
  boards = [];
  for (let i = 0; i < nb; i++) boards.push([null,null,null,null,null]);
}

function used() {
  const u = new Set();
  for (const s of seats) if (s && s.mode==='cards') for (const c of s.cards) if (c) u.add(c);
  for (const b of boards) for (const c of b) if (c) u.add(c);
  for (const c of deadCards) u.add(c);
  return u;
}

function cd(c) {
  if (!c) return null;
  const s = ST.find(x => x.c===c[1]);
  return {t: c[0]+s.ch, cl: (s.cl==='rd'?'r':'bk')+' s-'+s.c};
}

function bestEq() {
  let b = -1;
  for (const e of eqs) if (e != null && e > b) b = e;
  return b;
}

// Phones get a tall table with seats pulled inward so side seats stay on
// screen, and hole cards wrap onto two rows (see .seat-cards in style.css).
const NARROW = window.matchMedia('(max-width: 640px)');
// PLO5/6 wrap to three cards per row; a side seat must fit in about 32% of the
// screen width (3 cards + gaps + 26px of padding/border), so those scale down
// on the narrowest phones.
const CW_NARROW = {2:'36px', 4:'min(32px, calc(10vw - 2px))', 5:'min(32px, calc((32vw - 26px) / 3))', 6:'min(32px, calc((32vw - 26px) / 3))'};

// Seats run clockwise from bottom center: up the left side, across the top,
// down the right side.
function seatPos(n, numBoards) {
  if (NARROW.matches) return seatPosNarrow(n, numBoards);
  const p = [], ax = 47, ay = 44;
  for (let i = 0; i < n; i++) {
    const a = Math.PI/2 + i * 2*Math.PI/n;
    p.push({l: 50 + ax*Math.cos(a), t: 50 + ay*Math.sin(a)});
  }
  return p;
}

// Phone layout on the tall table: one seat at bottom center, one at top center
// when the count is even, and the rest in left/right columns at 18%/82% that
// stay above and below the board so they don't cover it.
function seatPosNarrow(n, numBoards) {
  const multi = numBoards > 1;
  const [topT, bottomT] = multi ? [8, 92] : [9, 91];
  const [upper, lower] = multi ? [[10, 30], [70, 90]] : [[11, 33], [67, 89]];
  const rest = n - 1;
  const hasTop = rest % 2 === 1;
  const perSide = Math.floor(rest / 2);
  const spread = ([a, b], k) => k === 1 ? [(a + b) / 2] : Array.from({length: k}, (_, i) => a + (b - a) * i / (k - 1));
  const sideT = [...spread(upper, Math.ceil(perSide / 2)), ...spread(lower, Math.floor(perSide / 2))];

  const p = [{l: 50, t: bottomT}];
  for (let i = perSide - 1; i >= 0; i--) p.push({l: 18, t: sideT[i]});
  if (hasTop) p.push({l: 50, t: topT});
  for (let i = 0; i < perSide; i++) p.push({l: 82, t: sideT[i]});
  return p;
}

function cardToWasm(c) {
  return c[0] + c[1];
}

let mcAbort = null;
let lastMcType = null;

function createGameAndSetBoard(filled, boardCards) {
  let game;
  if (curG === 'nlhe') {
    game = new HoldemGame();
  } else if (curG.includes('hl')) {
    game = new OmahaHiLoGame(g().cards);
  } else {
    game = new OmahaGame(g().cards);
  }
  for (const si of filled) {
    game.add_player(seats[si].cards.map(cardToWasm).join(' '));
  }
  if (boardCards.length >= 3) game.set_flop(boardCards.slice(0, 3).map(cardToWasm).join(' '));
  if (boardCards.length >= 4) game.set_turn(cardToWasm(boardCards[3]));
  if (boardCards.length >= 5) game.set_river(cardToWasm(boardCards[4]));
  addDeadCards(game);
  return game;
}

function createBombPotGame(filled, allBoardCards) {
  const game = new OmahaBombPotGame(boards.length, g().cards);
  for (const si of filled) {
    game.add_player(seats[si].cards.map(cardToWasm).join(' '));
  }
  for (let bi = 0; bi < allBoardCards.length; bi++) {
    const bc = allBoardCards[bi];
    if (bc.length >= 3) game.set_flop(bi, bc.slice(0, 3).map(cardToWasm).join(' '));
    if (bc.length >= 4) game.set_turn(bi, cardToWasm(bc[3]));
    if (bc.length >= 5) game.set_river(bi, cardToWasm(bc[4]));
  }
  addDeadCards(game);
  return game;
}

function addDeadCards(game) {
  if (deadCards.length) game.add_dead_cards(deadCards.map(cardToWasm).join(' '));
}

// Set from the evaluation-time setting by applySettings()
let MC_TIME_BUDGET = 2000;
const MC_BATCH_MS = 50;
let MC_MAX_SAMPLES = 100000;

// Monte Carlo runs in a pool of workers, one per spare core, each taking an
// equal share of the sample cap. If workers are unavailable, it falls back to
// batches on the main thread.
const MC_WORKERS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
let mcPool = null;
let mcRunId = 0;

function startWorkerPool() {
  if (typeof Worker === 'undefined') return;
  try {
    mcPool = [];
    for (let i = 0; i < MC_WORKERS; i++) {
      const w = new Worker(new URL('./mc-worker.js', import.meta.url), {type: 'module'});
      w.addEventListener('error', onWorkerPoolError);
      mcPool.push(w);
    }
  } catch (err) {
    onWorkerPoolError(err);
  }
}

function onWorkerPoolError(err) {
  if (!mcPool) return;
  console.warn('Monte Carlo workers unavailable, using the main thread:', err.message || err);
  mcPool.forEach(w => w.terminate());
  mcPool = null;
  if (calculating) runEquityCalc();
}

// Runs `job` (see mc.js) and calls onDone(state, ms, failed), where failed is
// false or an error message. Exact jobs are one calculation, so they run on a
// single worker. Aborting via mcAbort drops the run without calling onDone.
function runSampling(job, onDone) {
  const id = ++mcRunId;
  const t0 = performance.now();
  const merged = newState(job);
  // An exact job finishes after one result instead of running out the budget.
  const sampleCap = job.exact ? 1 : MC_MAX_SAMPLES;
  let active = true;
  const finish = failed => {
    if (!active) return;
    active = false;
    mcAbort = null;
    onDone(merged, (performance.now() - t0).toFixed(0), failed);
  };
  const fail = message => {
    // An unusable range is a normal outcome, shown as "No valid combos".
    if (!/invalid range/i.test(message)) console.error('Monte carlo error:', message);
    finish(message || 'error');
  };

  if (mcPool) {
    const workers = job.exact ? mcPool.slice(0, 1) : mcPool;
    let pending = workers.length;
    const onMessage = e => {
      const m = e.data;
      if (m.id !== id || !active) return;
      if (m.type === 'done') {
        mergeState(merged, m.state);
        if (--pending === 0) { stop(); finish(false); }
      } else if (m.type === 'error') {
        stop();
        fail(m.message);
      }
    };
    const stop = () => workers.forEach(w => {
      w.removeEventListener('message', onMessage);
      w.postMessage({type: 'stop', id});
    });
    mcAbort = () => { stop(); active = false; };
    const maxSamples = Math.ceil(sampleCap / workers.length);
    for (const w of workers) {
      w.addEventListener('message', onMessage);
      w.postMessage({type: 'run', id, job, budgetMs: MC_TIME_BUDGET, maxSamples});
    }
    return;
  }

  mcAbort = () => { active = false; };
  const deadline = t0 + MC_TIME_BUDGET;
  function batch() {
    if (!active) return;
    try {
      runChunk(job, merged, Math.min(deadline, performance.now() + MC_BATCH_MS), sampleCap);
    } catch (err) {
      fail(String(err && err.message || err));
      return;
    }
    if (performance.now() < deadline && merged.done < sampleCap) setTimeout(batch, 0);
    else finish(false);
  }
  setTimeout(batch, 0);
}

function runEquityCalc() {
  if (!wasmReady) return;
  if (mcAbort) { mcAbort(); mcAbort = null; }

  const gm = g();
  const filled = [];
  for (let i = 0; i < gm.max; i++) {
    if (!seats[i]) continue;
    if (seats[i].mode === 'cards' && seats[i].cards.every(c => c)) filled.push(i);
    if (seats[i].mode === 'range' && seats[i].sel.size > 0) filled.push(i);
    if (seats[i].mode === 'orange' && omahaRangeInfo(seats[i].text).ok) filled.push(i);
    if (seats[i].mode === 'random') filled.push(i);
  }
  if (filled.length < 2) return;

  if (filled.some(si => seats[si].mode === 'orange')) {
    if (curG === 'nlhe' || isBombPot()) return;
    runOmahaRangeEquity(filled);
    return;
  }

  const hasRange = filled.some(si => seats[si].mode === 'range');
  if (hasRange) {
    if (curG !== 'nlhe') return;
    runRangeEquity(filled);
    return;
  }

  if (isBombPot()) {
    runBombPotEquity(filled);
    return;
  }

  const boardCards = boards[0].filter(c => c);
  const isOmaha = curG !== 'nlhe';

  if (isOmaha && boardCards.length < 3) {
    runMonteCarloEquity(filled, boardCards);
    return;
  }

  calculating = true;
  document.getElementById('timer').textContent = 'Calculating…';
  showCalcOverlay(true);

  setTimeout(() => {
    try {
      const t0 = performance.now();
      const game = createGameAndSetBoard(filled, boardCards);
      const equity = game.evaluate_equity();
      game.free();

      const ms = (performance.now() - t0).toFixed(0);
      eqs = new Array(10).fill(null);
      filled.forEach((si, j) => { eqs[si] = equity[j]; });
      calced = true;
      calculating = false;
      lastMcType = null;
      document.getElementById('timer').textContent = ms + 'ms';
      showCalcOverlay(false);
      render();
    } catch (err) {
      calculating = false;
      document.getElementById('timer').textContent = 'Error: ' + err.message;
      showCalcOverlay(false);
      console.error('Equity calc error:', err);
    }
  }, 10);
}

function runBombPotEquity(filled) {
  const hasRandom = filled.some(si => seats[si].mode === 'random');
  const allBoardCards = boards.map(b => b.filter(c => c));
  const totalBoardNeeded = allBoardCards.reduce((sum, bc) => sum + (5 - bc.length), 0);
  const needsMC = totalBoardNeeded > 0 || hasRandom;

  if (!needsMC) {
    calculating = true;
    document.getElementById('timer').textContent = 'Calculating…';
    showCalcOverlay(true);

    setTimeout(() => {
      try {
        const t0 = performance.now();
        const game = createBombPotGame(filled, allBoardCards);
        const winners = game.evaluate_winners();
        const equity = game.evaluate_equity();
        game.free();

        const ms = (performance.now() - t0).toFixed(0);
        eqs = new Array(10).fill(null);
        filled.forEach((si, j) => { eqs[si] = equity[j]; });

        bpStats = buildBpStatsFromWinners(winners, filled, 1);

        calced = true;
        calculating = false;
        lastMcType = null;
        document.getElementById('timer').textContent = ms + 'ms';
        showCalcOverlay(false);
        render();
      } catch (err) {
        calculating = false;
        document.getElementById('timer').textContent = 'Error: ' + err.message;
        showCalcOverlay(false);
        console.error('Bomb pot equity error:', err);
      }
    }, 10);
    return;
  }

  const numBoards = boards.length;

  calculating = true;
  document.getElementById('timer').textContent = 'Calculating…';
  showCalcOverlay(true);

  const usedSet = used();
  const randomIndices = [];
  const hands = [];
  for (let fi = 0; fi < filled.length; fi++) {
    const s = seats[filled[fi]];
    if (s.mode === 'random') randomIndices.push(fi);
    else hands.push(s.cards.map(cardToWasm));
  }
  const job = {
    type: 'bombpot', numPlayers: filled.length, numBoards, cardsPer: g().cards,
    hands, randomIndices, allBoardCards: allBoardCards.map(bc => bc.map(cardToWasm)),
    dead: deadCards.map(cardToWasm), available: ALL_CARDS.filter(c => !usedSet.has(c)).map(cardToWasm),
  };

  runSampling(job, (st, ms, failed) => {
    const done = st.done;
    eqs = new Array(10).fill(null);
    bpStats = null;
    if (!failed && done > 0) {
      filled.forEach((si, j) => { eqs[si] = st.totals[j] / done; });
      bpStats = {};
      for (let fi = 0; fi < filled.length; fi++) {
        bpStats[filled[fi]] = {
          boardWin: st.boardWins.map(bw => bw[fi] / done),
          scoop: st.scoops[fi] / done,
          scooped: st.scooped[fi] / done,
        };
      }
      calced = true;
    }
    calculating = false;
    lastMcType = failed ? null : 'mc';
    document.getElementById('timer').innerHTML = failed ? 'Error' : mcTimerHtml(ms, done);
    showCalcOverlay(false);
    render();
  });
}

function tallyScoopStats(winners, filled, numBoards, boardWins, scoops, scooped) {
  const perBoard = [];
  for (let bi = 0; bi < numBoards; bi++) {
    const winnerSet = new Set();
    for (const w of winners[bi]) winnerSet.add(w.player_index);
    perBoard.push(winnerSet);
    for (const fi of winnerSet) {
      if (fi < filled.length) boardWins[bi][fi]++;
    }
  }

  for (let fi = 0; fi < filled.length; fi++) {
    const wonAll = perBoard.every(ws => ws.size === 1 && ws.has(fi));
    if (wonAll) scoops[fi]++;

    const opponents = new Set();
    for (let oi = 0; oi < filled.length; oi++) {
      if (oi !== fi) opponents.add(oi);
    }
    for (const oi of opponents) {
      const oppScooped = perBoard.every(ws => ws.size === 1 && ws.has(oi));
      if (oppScooped) { scooped[fi]++; break; }
    }
  }
}

function buildBpStatsFromWinners(winners, filled, samples) {
  const numBoards = winners.length;
  const boardWins = [];
  for (let bi = 0; bi < numBoards; bi++) boardWins.push(new Array(filled.length).fill(0));
  const scoopsArr = new Array(filled.length).fill(0);
  const scoopedArr = new Array(filled.length).fill(0);
  tallyScoopStats(winners, filled, numBoards, boardWins, scoopsArr, scoopedArr);

  const stats = {};
  for (let fi = 0; fi < filled.length; fi++) {
    const si = filled[fi];
    const perBoard = [];
    for (let bi = 0; bi < numBoards; bi++) perBoard.push(boardWins[bi][fi] / samples);
    stats[si] = {
      boardWin: perBoard,
      scoop: scoopsArr[fi] / samples,
      scooped: scoopedArr[fi] / samples,
    };
  }
  return stats;
}

function runMonteCarloEquity(filled, boardCards) {
  calculating = true;
  document.getElementById('timer').textContent = 'Calculating…';
  showCalcOverlay(true);

  const usedSet = used();
  const job = {
    type: 'omaha', numPlayers: filled.length, hilo: curG.includes('hl'), cardsPer: g().cards,
    hands: filled.map(si => seats[si].cards.map(cardToWasm)), boardCards: boardCards.map(cardToWasm),
    dead: deadCards.map(cardToWasm), available: ALL_CARDS.filter(c => !usedSet.has(c)).map(cardToWasm),
  };

  runSampling(job, (st, ms, failed) => finishSampling(filled, st, ms, failed, 'mc'));
}

// `failed` is false or the engine's error message. `exact` results are a single
// complete calculation, so they get no sample count or rerun button.
function finishSampling(filled, st, ms, failed, type, exact = false) {
  eqs = new Array(10).fill(null);
  if (!failed && st.weight > 0) {
    filled.forEach((si, j) => { eqs[si] = st.totals[j] / st.weight; });
    calced = true;
  }
  calculating = false;
  lastMcType = failed || exact ? null : type;
  const timer = document.getElementById('timer');
  const noCombos = failed ? /invalid range/i.test(failed) : (type === 'range' || type === 'orange') && st.weight === 0;
  if (noCombos) timer.textContent = 'No valid combos';
  else if (failed) timer.textContent = 'Error';
  else if (exact) timer.textContent = ms + 'ms';
  else timer.innerHTML = mcTimerHtml(ms, st.done);
  showCalcOverlay(false);
  render();
}

// Exact range equity is used when it needs at most this many hand evaluations
// (an upper bound from the engine); above it, Monte Carlo sampling.
const RANGE_EXACT_MAX_EVALS = 5e6;

function runRangeEquity(filled) {
  const boardCards = boards[0].filter(c => c);
  // The engine puts known hands first, then one player per range.
  const cardSeats = filled.filter(si => seats[si].mode === 'cards');
  const rangeSeats = filled.filter(si => seats[si].mode === 'range');
  const order = [...cardSeats, ...rangeSeats];
  const usedSet = used();
  const job = {
    type: 'range', numPlayers: order.length,
    hands: cardSeats.map(si => seats[si].cards.map(cardToWasm)),
    ranges: rangeSeats.map(si => [...seats[si].sel].join(',')),
    boardCards: boardCards.map(cardToWasm), dead: deadCards.map(cardToWasm),
    available: ALL_CARDS.filter(c => !usedSet.has(c)).map(cardToWasm),
  };

  let cost;
  try {
    cost = rangeExactCost(job);
  } catch (err) {
    showNoValidCombos();
    return;
  }
  const partialFlop = boardCards.length === 1 || boardCards.length === 2;
  job.exact = !partialFlop && cost <= RANGE_EXACT_MAX_EVALS;

  calculating = true;
  document.getElementById('timer').textContent = 'Calculating…';
  showCalcOverlay(true);
  runSampling(job, (st, ms, failed) => finishSampling(order, st, ms, failed, 'range', job.exact));
}

function runOmahaRangeEquity(filled) {
  const boardCards = boards[0].filter(c => c);
  // The engine puts known hands first, then one player per range.
  const cardSeats = filled.filter(si => seats[si].mode === 'cards');
  const rangeSeats = filled.filter(si => seats[si].mode === 'orange');
  const order = [...cardSeats, ...rangeSeats];
  const usedSet = used();
  const job = {
    type: 'orange', numPlayers: order.length, hilo: curG.includes('hl'), cardsPer: g().cards,
    hands: cardSeats.map(si => seats[si].cards.map(cardToWasm)),
    ranges: rangeSeats.map(si => seats[si].text),
    boardCards: boardCards.map(cardToWasm), dead: deadCards.map(cardToWasm),
    available: ALL_CARDS.filter(c => !usedSet.has(c)).map(cardToWasm),
  };
  calculating = true;
  document.getElementById('timer').textContent = 'Calculating…';
  showCalcOverlay(true);
  runSampling(job, (st, ms, failed) => finishSampling(order, st, ms, failed, 'orange'));
}

// Omaha shorthand range info for the current game: {ok, coverage, exact, error}.
// Parsing PLO4/5 narrow ranges builds a hand list, so results are cached.
const omahaRangeCache = new Map();
function omahaRangeInfo(text) {
  const key = g().cards + '|' + text;
  if (omahaRangeCache.has(key)) return omahaRangeCache.get(key);
  let info;
  if (!wasmReady || !text.trim()) {
    info = {ok: false, error: text.trim() ? '' : 'Enter a range'};
  } else {
    let r;
    try {
      r = new OmahaRangeSampler(g().cards, text);
      info = {ok: true, coverage: r.coverage(), exact: r.coverage_exact()};
      if (info.coverage === 0 && info.exact) info = {ok: false, error: 'No hands match'};
    } catch (err) {
      info = {ok: false, error: 'Invalid range syntax'};
    } finally {
      if (r) r.free();
    }
  }
  if (wasmReady) {
    if (omahaRangeCache.size > 200) omahaRangeCache.clear();
    omahaRangeCache.set(key, info);
  }
  return info;
}

function coverageText(info) {
  if (!info.ok) return info.error || '';
  const pct = info.coverage * 100;
  const shown = pct >= 10 ? pct.toFixed(1) : pct >= 0.1 ? pct.toFixed(2) : pct.toFixed(3);
  return `${info.exact ? '' : '~'}${shown}% of hands`;
}

function showNoValidCombos() {
  calculating = false;
  document.getElementById('timer').textContent = 'No valid combos';
  showCalcOverlay(false);
}

function showCalcOverlay(show) {
  let overlay = document.getElementById('calc-overlay');
  if (show && !overlay) {
    overlay = document.createElement('div');
    overlay.id = 'calc-overlay';
    overlay.className = 'calc-overlay';
    overlay.innerHTML = '<span>Calculating…</span>';
    document.querySelector('.felt').appendChild(overlay);
  } else if (!show && overlay) {
    overlay.remove();
  }
}

function render() {
  const gm = g();
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--card-w', NARROW.matches ? CW_NARROW[gm.cards] : CW[gm.cards]+'px');
  rootStyle.setProperty('--card-cols', gm.cards <= 3 ? gm.cards : Math.ceil(gm.cards / 2));
  const tw = document.getElementById('tw');
  tw.querySelectorAll('.seat').forEach(e => e.remove());
  const pos = seatPos(gm.max, gm.numBoards);
  tw.classList.toggle('multi-board', gm.numBoards > 1);
  const be = bestEq();

  for (let i = 0; i < gm.max; i++) {
    const el = document.createElement('div');
    el.className = 'seat';
    el.style.left = pos[i].l+'%';
    el.style.top = pos[i].t+'%';
    const s = seats[i];

    if (s) {
      let h = '<div class="seat-panel">';
      if (s.mode === 'cards') {
        h += '<div class="seat-cards">';
        for (let j = 0; j < gm.cards; j++) {
          const d = cd(s.cards[j]);
          if (d) h += `<div class="sc ${d.cl}" data-s="${i}" data-c="${j}">${d.t}</div>`;
          else h += `<div class="sc empty" data-s="${i}" data-c="${j}">+</div>`;
        }
        h += '</div>';
      } else if (s.mode === 'range') {
        const cnt = [...s.sel].reduce((a,k) => a + (COMBOS[k]||0), 0);
        h += `<div class="seat-range" data-rng="${i}">`;
        h += `<div class="seat-range-label">Range</div>`;
        h += `<div class="seat-range-count">${cnt} combos</div>`;
        h += '</div>';
      } else if (s.mode === 'orange') {
        const info = omahaRangeInfo(s.text);
        h += `<div class="seat-range${info.ok ? '' : ' bad'}" data-orng="${i}" title="${escapeHtml(s.text)}">`;
        h += `<div class="seat-range-label">Range</div>`;
        h += `<div class="seat-range-count">${escapeHtml(coverageText(info) || 'Empty')}</div>`;
        h += '</div>';
      } else if (s.mode === 'random') {
        h += `<div class="seat-random">`;
        h += `<div class="seat-random-label">Random</div>`;
        h += '</div>';
      }
      if (calced && eqs[i] != null) {
        const pct = (eqs[i]*100).toFixed(settings.decimals);
        const col = eqs[i] >= be - 0.001 ? 'var(--teal)' : 'var(--fg-muted)';
        h += `<div class="seat-eq" style="color:${col}">${pct}%</div>`;
      }
      if (calced && bpStats && bpStats[i]) {
        const st = bpStats[i];
        const pct = v => (v*100).toFixed(settings.decimals) + '%';
        const stats = st.boardWin.map((w, bi) => [`B${bi+1}`, pct(w), `Board ${bi+1} equity`]);
        stats.push(['Scoop', pct(st.scoop), 'Wins both boards']);
        stats.push(['Scooped', pct(st.scooped), 'An opponent wins both boards']);
        h += '<div class="seat-bp-stats">';
        for (const [k, v, title] of stats) h += `<span class="bp-k" title="${title}">${k}</span><span class="bp-v">${v}</span>`;
        h += '</div>';
      }
      h += `<button class="seat-x" data-rm="${i}">×</button></div>`;
      el.innerHTML = h;
    } else {
      el.innerHTML = `<button class="seat-add" data-add="${i}">+</button>`;
    }
    tw.appendChild(el);
  }
  renderBoard();
  updateRandomPlayersUI();
}

function renderBoard() {
  const wrap = document.getElementById('boards-wrap');
  wrap.innerHTML = '';
  const multi = boards.length > 1;
  if (multi) wrap.classList.add('multi');
  else wrap.classList.remove('multi');

  for (let bi = 0; bi < boards.length; bi++) {
    const b = boards[bi];
    const col = document.createElement('div');
    col.className = 'board-col';
    if (multi) {
      const label = document.createElement('div');
      label.className = 'board-label';
      label.textContent = 'Board ' + (bi + 1);
      col.appendChild(label);
    }
    const boardEl = document.createElement('div');
    boardEl.className = 'board';
    let h = '';
    for (let i = 0; i < 5; i++) {
      if (i===3||i===4) h += '<div class="board-gap"></div>';
      const d = cd(b[i]);
      if (d) h += `<div class="bc ${d.cl}" data-bi="${i}" data-bb="${bi}">${d.t}</div>`;
      else h += `<div class="bc empty" data-bi="${i}" data-bb="${bi}">+</div>`;
    }
    boardEl.innerHTML = h;
    col.appendChild(boardEl);
    wrap.appendChild(col);
  }

  let dh = '';
  for (let i = 0; i < deadCards.length; i++) {
    const d = cd(deadCards[i]);
    if (d) dh += `<div class="dc ${d.cl}" data-di="${i}">${d.t}</div>`;
  }
  document.getElementById('dead').innerHTML = dh;
}

function boardFillOrder() {
  const order = [];
  for (let bi = 0; bi < boards.length; bi++)
    for (let ci = 0; ci < 3; ci++) order.push({bi, ci});
  for (let bi = 0; bi < boards.length; bi++) order.push({bi, ci: 3});
  for (let bi = 0; bi < boards.length; bi++) order.push({bi, ci: 4});
  return order;
}

function nextBoardSlot(curBoard, curCard) {
  const order = boardFillOrder();
  const curIdx = order.findIndex(s => s.bi === curBoard && s.ci === curCard);
  for (let i = curIdx + 1; i < order.length; i++) {
    if (!boards[order[i].bi][order[i].ci]) return order[i];
  }
  for (let i = 0; i <= curIdx; i++) {
    if (!boards[order[i].bi][order[i].ci]) return order[i];
  }
  return null;
}

function openSeatModePicker(seatIdx) {
  let h = `<div class="modal-header"><span>Player ${seatIdx+1}</span></div>`;
  h += '<div class="seat-mode-picker">';
  h += `<button class="seat-mode-btn" data-smode="cards" data-si="${seatIdx}">Pick Cards</button>`;
  h += `<button class="seat-mode-btn" data-smode="random" data-si="${seatIdx}">Random</button>`;
  h += '</div>';
  showModal(h);
}

function openDeadPicker() {
  target = {type:'dead'};
  const u = used();
  let h = `<div class="modal-header"><span>Dead card</span></div><div class="card-picker">`;
  for (const suit of ST) {
    h += '<div class="psuit">';
    h += `<span class="sicon ${suit.cl} s-${suit.c}">${suit.ch}</span>`;
    for (const rank of RK) {
      const card = rank + suit.c;
      const isUsed = u.has(card);
      h += `<button class="pk ${suit.cl} s-${suit.c}${isUsed?' used':''}" data-pk="${card}"${isUsed?' disabled':''}>${rank}</button>`;
    }
    h += '</div>';
  }
  h += '</div>';
  showModal(h);
}

function openCardPicker(seatIdx, cardIdx) {
  const s = seats[seatIdx];
  target = {type:'hand', seat:seatIdx, card:cardIdx, seatMode:'cards'};
  const u = used();
  const gm = g();
  const hand = s ? s.cards : [];
  const isHoldem = curG === 'nlhe';

  const uForPicker = new Set(u);
  if (hand[cardIdx]) uForPicker.delete(hand[cardIdx]);

  let h = '';
  if (isHoldem || !isBombPot()) {
    h += '<div class="modal-tabs">';
    h += '<button class="mtab on" data-mt="cards">Cards</button>';
    h += '<button class="mtab" data-mt="range">Range</button>';
    h += '</div>';
  }
  h += `<div class="modal-header"><span>Player ${seatIdx+1}</span></div>`;

  h += '<div class="picker-hand">';
  for (let j = 0; j < gm.cards; j++) {
    const c = hand[j];
    const d = cd(c);
    const active = j === cardIdx ? ' active' : '';
    if (d) {
      h += `<div class="ph-card ${d.cl}${active}" data-ph="${j}">${d.t}</div>`;
    } else {
      h += `<div class="ph-card empty${active}" data-ph="${j}">+</div>`;
    }
  }
  h += '</div>';

  h += '<div class="card-picker">';
  for (const suit of ST) {
    h += '<div class="psuit">';
    h += `<span class="sicon ${suit.cl} s-${suit.c}">${suit.ch}</span>`;
    for (const rank of RK) {
      const card = rank + suit.c;
      const isUsed = uForPicker.has(card);
      h += `<button class="pk ${suit.cl} s-${suit.c}${isUsed?' used':''}" data-pk="${card}"${isUsed?' disabled':''}>${rank}</button>`;
    }
    h += '</div>';
  }
  h += '</div>';
  showModal(h);
}

const OMAHA_RANGE_EXAMPLES = [
  ['AAxx', 'Any aces'], ['AAxx$ds', 'Double-suited aces'], ['KK$!r', 'Kings, not rainbow'],
  ['$rd$ds', 'Double-suited rundowns'], ['$rd0-1$ss', 'Single-suited rundowns, ≤1 gap'], ['$2p', 'Two pair'],
];

function openOmahaRangePicker(seatIdx) {
  const s = seats[seatIdx];
  const text = s && s.mode === 'orange' ? s.text : '';
  target = {type: 'hand', seat: seatIdx, seatMode: 'orange'};
  let h = '<div class="modal-tabs">';
  h += '<button class="mtab" data-mt="cards">Cards</button>';
  h += '<button class="mtab on" data-mt="range">Range</button>';
  h += '</div>';
  h += `<div class="modal-header"><span>Player ${seatIdx + 1} range · PLO${g().cards}</span>`;
  h += '<button class="modal-clear" id="oclear">Clear</button></div>';
  h += '<div class="range-picker">';
  h += `<textarea class="range-text" id="otxt" rows="3" placeholder="AAxx$ds, KKxx$ds, $rd$ds" spellcheck="false" autocapitalize="off">${escapeHtml(text)}</textarea>`;
  const info = omahaRangeInfo(text);
  h += `<div class="range-info"><span id="ocov" class="${info.ok || !text ? '' : 'bad'}">${escapeHtml(text ? coverageText(info) : 'Type a range in shorthand')}</span></div>`;
  h += '<div class="saved-head" style="margin-top:12px"><span>Examples</span></div><div class="preset-grid">';
  for (const [t, label] of OMAHA_RANGE_EXAMPLES) {
    h += `<button class="preset oex" data-oex="${escapeHtml(t)}" title="${escapeHtml(label)}"><span class="saved-name">${escapeHtml(t)}</span><span class="saved-meta">${escapeHtml(label)}</span></button>`;
  }
  h += '</div>';
  h += '<div class="presets-foot">Terms are separated by commas; a hand is in the range if it matches any term. ' +
    'Ranks and cards (<code>AA</code>, <code>AsKs</code>, <code>x</code> = any card), then conditions: ' +
    '<code>$ds</code> <code>$ss</code> <code>$r</code> suits, <code>$np</code> <code>$1p</code> <code>$2p</code> pairs, ' +
    '<code>$rd</code> rundown (<code>$rd1</code> one gap, <code>$3rd</code> three-card), <code>$!cond</code> negates.</div>';
  h += '</div>';
  showModal(h);
}

function setOmahaRangeText(text) {
  seats[target.seat] = {mode: 'orange', text};
  const info = omahaRangeInfo(text);
  const cov = document.getElementById('ocov');
  if (cov) {
    cov.textContent = text ? coverageText(info) : 'Type a range in shorthand';
    cov.className = info.ok || !text ? '' : 'bad';
  }
  dirty(); render();
}

// `opts.msg` is a status line for the saved-ranges section; `opts.name`
// prefills the save box (e.g. after loading a saved range).
function openRangePicker(seatIdx, opts = {}) {
  const s = seats[seatIdx];
  const sel = (s && s.mode==='range') ? s.sel : new Set();
  target = {type:'hand', seat:seatIdx, seatMode:'range'};

  let h = '<div class="modal-tabs">';
  h += '<button class="mtab" data-mt="cards">Cards</button>';
  h += '<button class="mtab on" data-mt="range">Range</button>';
  h += '</div>';
  h += `<div class="modal-header"><span>Player ${seatIdx+1} range</span>`;
  h += '<button class="modal-clear" id="rclear">Clear</button></div>';
  h += '<div class="range-picker"><div class="rgrid" id="rgrid">';

  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    let l = r===c ? RK[r]+RK[c] : r<c ? RK[r]+RK[c]+'s' : RK[c]+RK[r]+'o';
    h += `<div class="rc ${sel.has(l)?'on':'off'}" data-h="${l}">${l}</div>`;
  }

  const cnt = [...sel].reduce((a,k) => a + (COMBOS[k]||0), 0);
  const pctH = (cnt / 1326 * 100).toFixed(1);
  h += `</div><div class="range-info"><span id="rcnt">${cnt} combos · ${pctH}%</span></div>`;
  // Fills the grid with the top X% of hands by ducy's Hold'em ranking.
  const topV = Math.max(1, Math.round(cnt / 13.26));
  h += '<label class="range-top"><span>Top</span>';
  h += `<input type="range" id="rtop" min="1" max="100" step="1" value="${topV}" aria-label="Fill with the top percent of hands">`;
  h += `<b id="rtopv">${topV}%</b></label>`;
  h += `<textarea class="range-text" id="rtxt" placeholder="AA, AKs, QQ+ ...">${[...sel].join(', ')}</textarea>`;
  h += presetsHtml(sel);
  h += savedRangesHtml(sel, opts);
  h += '</div>';
  showModal(h);
}

// Whether the presets list is expanded; remembered across picker openings.
const PRESETS_OPEN_KEY = 'ducyPresetsOpen';
let presetsOpen = (() => { try { return localStorage.getItem(PRESETS_OPEN_KEY) === '1'; } catch { return false; } })();

function presetsHtml(sel) {
  let h = `<details class="presets" id="rpresets"${presetsOpen ? ' open' : ''}>`;
  h += '<summary class="saved-head"><span>Presets</span><span class="presets-note">approx. 6-max 100bb</span></summary>';
  for (const g of PRESET_GROUPS) {
    const items = RANGE_PRESETS.filter(p => p.spot === g.spot);
    h += `<div class="preset-group">${escapeHtml(g.label)}</div><div class="preset-grid">`;
    for (const p of items) {
      const ps = parseRange(presetRangeText(p));
      const cur = sel.size && sameSel(ps, sel) ? ' current' : '';
      const tip = [p.bluff ? `Value: ${p.value}\nBluffs: ${p.bluff}` : p.value, p.note].filter(Boolean).join('\n');
      h += `<button class="preset${cur}" data-rpreset="${escapeHtml(p.id)}" title="${escapeHtml(tip)}">`;
      h += `<span class="saved-name">${escapeHtml(p.name)}</span>`;
      h += `<span class="saved-meta">${(comboCount(ps) / 1326 * 100).toFixed(1)}%</span></button>`;
    }
    h += '</div>';
  }
  h += '<div class="presets-foot">Overall frequencies match published solver figures; hands are approximate. Hover a preset to see its value hands and bluffs.</div>';
  h += '</details>';
  return h;
}

// Saved ranges live in this browser's localStorage as [{name, game, range}],
// where `range` is the picker's text form ("AA, AKs, ..."). `game` lets
// Omaha ranges share the store later; only Hold'em has ranges today.
const SAVED_RANGES_KEY = 'ducyRanges';
const RANGE_NAME_MAX = 60;
const RANGE_GAME = 'nlhe';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}

function loadSavedRanges() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_RANGES_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(r => r && typeof r.name === 'string' && typeof r.range === 'string');
  } catch {
    return [];
  }
}

function storeSavedRanges(list) {
  try {
    localStorage.setItem(SAVED_RANGES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function sameSel(a, b) {
  return a.size === b.size && [...a].every(k => b.has(k));
}

function savedRangesHtml(sel, opts) {
  const list = loadSavedRanges();
  let h = '<div class="saved-ranges">';
  h += '<div class="saved-head"><span>Saved ranges</span>';
  h += '<button class="link-btn" id="rlib">Import / Export</button></div>';
  h += '<div class="saved-save">';
  h += `<input class="range-name" id="rname" maxlength="${RANGE_NAME_MAX}" placeholder="Name this range" value="${escapeHtml(opts.name || '')}" autocomplete="off">`;
  h += '<button class="btn-small" id="rsave">Save</button></div>';
  const mine = list.map((r, i) => ({r, i})).filter(({r}) => (r.game || RANGE_GAME) === RANGE_GAME);
  if (!mine.length) {
    h += '<div class="saved-empty">No saved ranges yet. Name the current range and save it to reuse it later.</div>';
  } else {
    h += '<div class="saved-list">';
    for (const {r, i} of mine) {
      const rs = parseRange(r.range);
      const cur = sel.size && sameSel(rs, sel) ? ' current' : '';
      h += `<div class="saved-row${cur}">`;
      h += `<button class="saved-load" data-rload="${i}" title="${escapeHtml(r.range)}">`;
      h += `<span class="saved-name">${escapeHtml(r.name)}</span>`;
      h += `<span class="saved-meta">${comboCount(rs)} combos</span></button>`;
      h += `<button class="saved-del" data-rdel="${i}" aria-label="Delete ${escapeHtml(r.name)}">×</button>`;
      h += '</div>';
    }
    h += '</div>';
  }
  h += `<div class="saved-msg" id="rmsg" role="status">${escapeHtml(opts.msg || '')}</div>`;
  h += '</div>';
  return h;
}

function saveCurrentRange() {
  const input = document.getElementById('rname');
  const name = (input ? input.value : '').trim().slice(0, RANGE_NAME_MAX);
  const s = seats[target.seat];
  const sel = s && s.mode === 'range' ? s.sel : new Set();
  const msg = document.getElementById('rmsg');
  if (!sel.size) { if (msg) msg.textContent = 'Select some hands first.'; return; }
  if (!name) { if (msg) msg.textContent = 'Enter a name for this range.'; if (input) input.focus(); return; }

  const list = loadSavedRanges();
  const range = [...sel].join(', ');
  const existing = list.findIndex(r => r.name === name && (r.game || RANGE_GAME) === RANGE_GAME);
  if (existing >= 0) list[existing] = {name, game: RANGE_GAME, range};
  else list.push({name, game: RANGE_GAME, range});
  const ok = storeSavedRanges(list);
  openRangePicker(target.seat, {
    name,
    msg: !ok ? 'Couldn’t save: this browser is blocking storage.'
      : existing >= 0 ? `Updated “${name}”.` : `Saved “${name}”.`,
  });
}

function exportRangesText() {
  const ranges = loadSavedRanges().map(r => ({name: r.name, game: r.game || RANGE_GAME, range: r.range}));
  return JSON.stringify({format: 'ducy-ranges', version: 1, ranges}, null, 2);
}

// Accepts the exported JSON (or a bare array of {name, range}), or plain
// lines of "Name: AA, KK, AKs". Returns {added, unchanged, invalid}.
function importRanges(text) {
  let entries = [];
  let invalid = 0;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    let data;
    try { data = JSON.parse(t); } catch { return {added: 0, unchanged: 0, invalid: 0, error: 'That isn’t valid JSON.'}; }
    entries = Array.isArray(data) ? data : Array.isArray(data && data.ranges) ? data.ranges : [];
  } else {
    for (const line of t.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const colon = line.indexOf(':');
      if (colon <= 0) { invalid++; continue; }
      entries.push({name: line.slice(0, colon), range: line.slice(colon + 1)});
    }
  }

  const list = loadSavedRanges();
  let added = 0, unchanged = 0;
  for (const e of entries) {
    const name = e && typeof e.name === 'string' ? e.name.trim().slice(0, RANGE_NAME_MAX) : '';
    const game = e && typeof e.game === 'string' ? e.game : RANGE_GAME;
    const sel = e && typeof e.range === 'string' ? parseRange(e.range) : new Set();
    if (!name || !sel.size || game !== RANGE_GAME) { invalid++; continue; }
    const range = [...sel].join(', ');
    const same = list.filter(r => (r.game || RANGE_GAME) === game);
    if (same.some(r => r.name === name && sameSel(parseRange(r.range), sel))) { unchanged++; continue; }
    let unique = name;
    for (let n = 2; same.some(r => r.name === unique); n++) unique = `${name} (${n})`;
    list.push({name: unique, game, range});
    added++;
  }
  if (added && !storeSavedRanges(list)) return {added: 0, unchanged, invalid, error: 'Couldn’t save: this browser is blocking storage.'};
  return {added, unchanged, invalid};
}

function importSummary(r) {
  if (r.error) return r.error;
  const parts = [`Imported ${r.added} range${r.added === 1 ? '' : 's'}`];
  if (r.unchanged) parts.push(`${r.unchanged} already saved`);
  if (r.invalid) parts.push(`${r.invalid} skipped (missing name or no valid hands)`);
  return parts.join(', ') + '.';
}

function openRangeLibrary(seatIdx, msg = '') {
  target = {type:'hand', seat:seatIdx, seatMode:'range'};
  const count = loadSavedRanges().length;
  let h = '<div class="modal-header"><span>Saved ranges · Import / Export</span>';
  h += '<button class="link-btn" id="rback">Back</button></div>';
  h += '<div class="range-picker range-lib">';
  h += `<div class="lib-label">Export (${count} saved)</div>`;
  h += `<textarea class="range-text lib-text" id="rexport" readonly rows="6">${escapeHtml(exportRangesText())}</textarea>`;
  h += '<div class="lib-actions">';
  h += `<button class="btn-small" id="rcopy"${count ? '' : ' disabled'}>Copy</button>`;
  h += `<button class="btn-small" id="rdownload"${count ? '' : ' disabled'}>Download .json</button></div>`;
  h += '<div class="lib-label">Import</div>';
  h += '<textarea class="range-text lib-text" id="rimport" rows="5" placeholder="Paste exported ranges, or one range per line:&#10;Tight open: 77+, ATs+, KQs, AJo+"></textarea>';
  h += '<div class="lib-actions">';
  h += '<label class="btn-small file-btn">Choose file…<input type="file" id="rfile" accept=".json,.txt,application/json,text/plain" hidden></label>';
  h += '<button class="btn-small primary" id="rimportbtn">Import</button></div>';
  h += `<div class="saved-msg" id="rmsg" role="status">${escapeHtml(msg)}</div>`;
  h += '</div>';
  showModal(h);
}

function copyExport() {
  const ta = document.getElementById('rexport');
  const msg = document.getElementById('rmsg');
  const done = ok => { if (msg) msg.textContent = ok ? 'Copied to clipboard.' : 'Select the text above and copy it.'; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(ta.value).then(() => done(true), () => { ta.select(); done(false); });
  } else {
    ta.select();
    done(false);
  }
}

function downloadExport() {
  const blob = new Blob([exportRangesText()], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ducy-ranges.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openBoardPicker(boardIdx, cardIdx) {
  const curCard = boards[boardIdx][cardIdx];
  target = {type:'board', boardIdx, card:cardIdx};
  const u = used();
  const labels = ['Flop','Flop','Flop','Turn','River'];
  const multi = boards.length > 1;
  const boardLabel = multi ? `Board ${boardIdx+1} · ${labels[cardIdx]}` : `Board · ${labels[cardIdx]}`;

  let h = `<div class="modal-header"><span>${boardLabel}</span></div>`;

  if (multi) {
    for (let bi = 0; bi < boards.length; bi++) {
      h += `<div class="picker-board-label">Board ${bi+1}</div>`;
      h += '<div class="picker-hand">';
      for (let j = 0; j < 5; j++) {
        const c = boards[bi][j];
        const d = cd(c);
        const isCur = bi === boardIdx && j === cardIdx;
        const active = isCur ? ' active' : '';
        if (j === 3) h += '<div style="width:8px"></div>';
        if (d) {
          h += `<div class="ph-card ${d.cl}${active}" data-pb="${j}" data-pbb="${bi}">${d.t}</div>`;
        } else {
          h += `<div class="ph-card empty${active}" data-pb="${j}" data-pbb="${bi}">+</div>`;
        }
      }
      h += '</div>';
    }
  } else {
    h += '<div class="picker-hand">';
    for (let j = 0; j < 5; j++) {
      const c = boards[0][j];
      const d = cd(c);
      const active = j === cardIdx ? ' active' : '';
      if (j === 3) h += '<div style="width:8px"></div>';
      if (d) {
        h += `<div class="ph-card ${d.cl}${active}" data-pb="${j}">${d.t}</div>`;
      } else {
        h += `<div class="ph-card empty${active}" data-pb="${j}">+</div>`;
      }
    }
    h += '</div>';
  }

  h += '<div class="card-picker">';
  for (const suit of ST) {
    h += '<div class="psuit">';
    h += `<span class="sicon ${suit.cl} s-${suit.c}">${suit.ch}</span>`;
    for (const rank of RK) {
      const card = rank + suit.c;
      const isUsed = u.has(card) && card !== curCard;
      h += `<button class="pk ${suit.cl} s-${suit.c}${isUsed?' used':''}" data-pk="${card}"${isUsed?' disabled':''}>${rank}</button>`;
    }
    h += '</div>';
  }
  h += '</div>';
  showModal(h);
}

function showModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('mbg').hidden = false;
}
function closeModal() {
  document.getElementById('mbg').hidden = true;
  target = null;
}

let calcTimer = null;
function dirty() {
  calced = false;
  eqs = new Array(10).fill(null);
  bpStats = null;
  lastMcType = null;
  document.getElementById('timer').textContent = '';
  if (calcTimer) clearTimeout(calcTimer);
  scheduleCalc(150);
  syncHash();
}

// Events
document.getElementById('tw').addEventListener('click', e => {
  const sc = e.target.closest('[data-s]');
  if (sc) {
    const si = +sc.dataset.s;
    const ci = sc.dataset.c != null ? +sc.dataset.c : 0;
    openCardPicker(si, ci);
    return;
  }
  const rng = e.target.closest('[data-rng]');
  if (rng) { openRangePicker(+rng.dataset.rng); return; }
  const orng = e.target.closest('[data-orng]');
  if (orng) { openOmahaRangePicker(+orng.dataset.orng); return; }
  const add = e.target.closest('[data-add]');
  if (add) {
    const i = +add.dataset.add;
    if (isBombPot()) {
      openSeatModePicker(i);
    } else {
      seats[i] = {mode:'cards', cards: new Array(g().cards).fill(null)};
      dirty(); render();
      openCardPicker(i, 0);
    }
    return;
  }
  const rm = e.target.closest('[data-rm]');
  if (rm) { seats[+rm.dataset.rm] = null; dirty(); render(); return; }

  const bc = e.target.closest('[data-bi]');
  if (bc) {
    const bi = bc.dataset.bb != null ? +bc.dataset.bb : 0;
    openBoardPicker(bi, +bc.dataset.bi);
    return;
  }
});

document.getElementById('dead-add').addEventListener('click', () => openDeadPicker());

document.getElementById('dead').addEventListener('click', e => {
  const dc = e.target.closest('[data-di]');
  if (dc) {
    deadCards.splice(+dc.dataset.di, 1);
    dirty(); render();
  }
});

document.getElementById('mbg').addEventListener('click', e => {
  if (e.target.id === 'mbg') { closeModal(); return; }

  const set = e.target.closest('[data-set]');
  if (set) { changeSetting(set.dataset.set, JSON.parse(set.dataset.val)); return; }

  const smode = e.target.closest('[data-smode]');
  if (smode) {
    const si = +smode.dataset.si;
    if (smode.dataset.smode === 'random') {
      seats[si] = {mode:'random'};
      closeModal();
      dirty(); render();
    } else {
      seats[si] = {mode:'cards', cards: new Array(g().cards).fill(null)};
      dirty(); render();
      openCardPicker(si, 0);
    }
    return;
  }

  const mt = e.target.closest('[data-mt]');
  if (mt && target && target.type === 'hand' && !isBombPot()) {
    const mode = mt.dataset.mt;
    if (mode === 'range') {
      if (curG === 'nlhe') openRangePicker(target.seat);
      else openOmahaRangePicker(target.seat);
    } else {
      if (!seats[target.seat] || seats[target.seat].mode !== 'cards') {
        seats[target.seat] = {mode:'cards', cards: new Array(g().cards).fill(null)};
        dirty(); render();
      }
      openCardPicker(target.seat, 0);
    }
    return;
  }

  const oex = e.target.closest('[data-oex]');
  if (oex && target && target.seatMode === 'orange') {
    const ta = document.getElementById('otxt');
    const cur = ta.value.trim();
    ta.value = cur ? `${cur}, ${oex.dataset.oex}` : oex.dataset.oex;
    setOmahaRangeText(ta.value);
    return;
  }
  if (e.target.id === 'oclear' && target && target.seatMode === 'orange') {
    document.getElementById('otxt').value = '';
    setOmahaRangeText('');
    return;
  }

  const ph = e.target.closest('[data-ph]');
  if (ph && target && target.type === 'hand') {
    const j = +ph.dataset.ph;
    const hand = seats[target.seat].cards;
    if (hand[j]) {
      hand[j] = null;
      dirty(); render();
      openCardPicker(target.seat, j);
    } else {
      openCardPicker(target.seat, j);
    }
    return;
  }

  const pb = e.target.closest('[data-pb]');
  if (pb && target && target.type === 'board') {
    const j = +pb.dataset.pb;
    const bi = pb.dataset.pbb != null ? +pb.dataset.pbb : target.boardIdx;
    if (boards[bi][j]) {
      boards[bi][j] = null;
      dirty(); render();
      openBoardPicker(bi, j);
    } else {
      openBoardPicker(bi, j);
    }
    return;
  }

  const pk = e.target.closest('.pk:not(.used)');
  if (pk && target) {
    const card = pk.dataset.pk;
    if (target.type === 'hand') {
      seats[target.seat].cards[target.card] = card;
      dirty(); render();
      const next = seats[target.seat].cards.indexOf(null);
      if (next !== -1) { openCardPicker(target.seat, next); } else { closeModal(); }
    } else if (target.type === 'board') {
      const bi = target.boardIdx;
      boards[bi][target.card] = card;
      dirty(); render();
      const nb = nextBoardSlot(bi, target.card);
      if (nb) { openBoardPicker(nb.bi, nb.ci); } else { closeModal(); }
    } else if (target.type === 'dead') {
      deadCards.push(card);
      dirty(); render();
      openDeadPicker();
    }
    return;
  }

  const rc = e.target.closest('.rc');
  if (rc && target && target.seatMode === 'range') {
    const h = rc.dataset.h;
    const s = seats[target.seat];
    if (!s || s.mode !== 'range') {
      seats[target.seat] = {mode:'range', sel: new Set()};
    }
    const sel = seats[target.seat].sel;
    if (sel.has(h)) sel.delete(h); else sel.add(h);
    rc.classList.toggle('on');
    rc.classList.toggle('off');
    const cnt = [...sel].reduce((a,k) => a + (COMBOS[k]||0), 0);
    const pctH = (cnt/1326*100).toFixed(1);
    const ci = document.getElementById('rcnt');
    if (ci) ci.textContent = cnt + ' combos · ' + pctH + '%';
    const tx = document.getElementById('rtxt');
    if (tx) tx.value = [...sel].join(', ');
    dirty(); render();
    return;
  }

  if (e.target.id === 'mclear' && target) {
    if (target.type === 'board') {
      boards[target.boardIdx][target.card] = null;
      dirty(); render();
      openBoardPicker(target.boardIdx, target.card);
    }
    return;
  }

  if (e.target.id === 'rclear' && target) {
    seats[target.seat] = {mode:'range', sel: new Set()};
    dirty(); render();
    openRangePicker(target.seat);
    return;
  }

  if (!target || target.seatMode !== 'range') return;
  if (e.target.id === 'rsave') { saveCurrentRange(); return; }
  if (e.target.id === 'rlib') { openRangeLibrary(target.seat); return; }
  if (e.target.id === 'rback') { openRangePicker(target.seat); return; }
  if (e.target.id === 'rcopy') { copyExport(); return; }
  if (e.target.id === 'rdownload') { downloadExport(); return; }
  if (e.target.id === 'rimportbtn') {
    const text = document.getElementById('rimport').value;
    openRangeLibrary(target.seat, text.trim() ? importSummary(importRanges(text)) : 'Paste ranges to import, or choose a file.');
    return;
  }

  const preset = e.target.closest('[data-rpreset]');
  if (preset) {
    const p = RANGE_PRESETS.find(x => x.id === preset.dataset.rpreset);
    if (!p) return;
    seats[target.seat] = {mode:'range', sel: parseRange(presetRangeText(p))};
    dirty(); render();
    openRangePicker(target.seat, {msg: `Loaded preset “${p.name}”. Edit it and save under your own name to keep a copy.`});
    return;
  }

  const load = e.target.closest('[data-rload]');
  if (load) {
    const r = loadSavedRanges()[+load.dataset.rload];
    if (!r) return;
    seats[target.seat] = {mode:'range', sel: parseRange(r.range)};
    dirty(); render();
    openRangePicker(target.seat, {name: r.name, msg: `Loaded “${r.name}”.`});
    return;
  }

  // Delete takes two clicks: the first turns the button into a confirm.
  const del = e.target.closest('[data-rdel]');
  if (del) {
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm');
      del.textContent = 'Delete?';
      setTimeout(() => { if (del.isConnected) { del.classList.remove('confirm'); del.textContent = '×'; } }, 3000);
      return;
    }
    const list = loadSavedRanges();
    const [removed] = list.splice(+del.dataset.rdel, 1);
    storeSavedRanges(list);
    openRangePicker(target.seat, {msg: removed ? `Deleted “${removed.name}”.` : ''});
  }
});

// 'toggle' doesn't bubble, so listen in the capture phase.
document.getElementById('mbg').addEventListener('toggle', e => {
  if (e.target.id !== 'rpresets') return;
  presetsOpen = e.target.open;
  try { localStorage.setItem(PRESETS_OPEN_KEY, presetsOpen ? '1' : '0'); } catch {}
}, true);

document.getElementById('mbg').addEventListener('keydown', e => {
  if (e.target.id === 'rname' && e.key === 'Enter') {
    e.preventDefault();
    saveCurrentRange();
  }
});

document.getElementById('mbg').addEventListener('change', e => {
  if (e.target.id !== 'rfile' || !target) return;
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const seat = target.seat;
  if (file.size > 1e6) { openRangeLibrary(seat, 'That file is too large to be a ranges export.'); return; }
  const reader = new FileReader();
  reader.onload = () => openRangeLibrary(seat, importSummary(importRanges(String(reader.result))));
  reader.onerror = () => openRangeLibrary(seat, 'Couldn’t read that file.');
  reader.readAsText(file);
});

document.getElementById('mbg').addEventListener('input', e => {
  if (e.target.id === 'otxt' && target && target.seatMode === 'orange') {
    setOmahaRangeText(e.target.value);
    return;
  }
  if (e.target.id === 'rtop' && target && target.seatMode === 'range') {
    const v = +e.target.value;
    const sel = topRange(v);
    seats[target.seat] = {mode:'range', sel};
    document.getElementById('rtopv').textContent = v + '%';
    const tx = document.getElementById('rtxt');
    if (tx) tx.value = [...sel].join(', ');
    syncRangeGrid(sel);
    dirty(); render();
    return;
  }
  if (e.target.id === 'rtxt' && target && target.seatMode === 'range') {
    const sel = parseRange(e.target.value);
    seats[target.seat] = {mode:'range', sel};
    syncRangeGrid(sel);
    dirty(); render();
  }
});

// Updates the picker's grid and combo count in place to match `sel`.
function syncRangeGrid(sel) {
  const cnt = [...sel].reduce((a,k) => a + (COMBOS[k]||0), 0);
  const pctH = (cnt/1326*100).toFixed(1);
  const ci = document.getElementById('rcnt');
  if (ci) ci.textContent = cnt + ' combos · ' + pctH + '%';
  document.querySelectorAll('#rgrid .rc').forEach(rc => {
    const h = rc.dataset.h;
    rc.classList.toggle('on', sel.has(h));
    rc.classList.toggle('off', !sel.has(h));
  });
}

function switchGame(newGame) {
  if (newGame === curG) return;
  curG = newGame;
  seats = new Array(10).fill(null);
  initBoards();
  deadCards = [];
  dirty(); render();
}

let omahaCards = 4, omahaHlCards = 4;

function gameKey(type, cards) {
  if (type === 'nlhe') return 'nlhe';
  if (type === 'omaha') return cards === 4 ? 'omaha' : 'omaha' + cards;
  return cards === 4 ? 'omaha-hl' : 'omaha' + cards + '-hl';
}

function updateGameUI() {
  document.querySelectorAll('.game-btn').forEach(b => b.classList.remove('on'));
  let activeType;
  if (curG === 'nlhe') activeType = 'nlhe';
  else if (curG === 'bomb-pot') activeType = 'bomb-pot';
  else if (curG.includes('hl')) activeType = 'omaha-hl';
  else activeType = 'omaha';
  document.querySelector(`.game-btn[data-game="${activeType}"]`).classList.add('on');

  document.getElementById('cc-omaha').classList.toggle('dim', activeType !== 'omaha');
  document.getElementById('cc-omaha-hl').classList.toggle('dim', activeType !== 'omaha-hl');

  document.getElementById('bp-random').hidden = activeType !== 'bomb-pot';
  updateRandomPlayersUI();

  if (activeType === 'omaha' || activeType === 'omaha-hl') {
    const cc = activeType === 'omaha' ? omahaCards : omahaHlCards;
    const container = document.getElementById('cc-' + activeType);
    container.querySelectorAll('.cc-btn').forEach(b => {
      b.classList.toggle('on', +b.dataset.cc === cc);
    });
  }
}

function updateRandomPlayersUI() {
  const n = seats.slice(0, g().max).filter(Boolean).length;
  document.querySelectorAll('#bp-random .cc-btn').forEach(b => {
    b.classList.toggle('on', +b.dataset.rp === n);
  });
}

// Grow or shrink the table to n players, adding random seats in empty spots and
// removing random seats (highest first) when shrinking. Picked hands are kept.
function setRandomPlayers(n) {
  const max = g().max;
  let count = seats.slice(0, max).filter(Boolean).length;
  for (let i = 0; i < max && count < n; i++) {
    if (!seats[i]) { seats[i] = {mode:'random'}; count++; }
  }
  for (let i = max - 1; i >= 0 && count > n; i--) {
    if (seats[i] && seats[i].mode === 'random') { seats[i] = null; count--; }
  }
  dirty(); render();
  syncHash();
}

document.getElementById('game-sel').addEventListener('click', e => {
  const rp = e.target.closest('[data-rp]');
  if (rp) { setRandomPlayers(+rp.dataset.rp); return; }
  const gb = e.target.closest('.game-btn');
  if (gb) {
    const type = gb.dataset.game;
    if (type === 'nlhe') switchGame('nlhe');
    else if (type === 'bomb-pot') switchGame('bomb-pot');
    else if (type === 'omaha') switchGame(gameKey('omaha', omahaCards));
    else if (type === 'omaha-hl') switchGame(gameKey('omaha-hl', omahaHlCards));
    updateGameUI();
    return;
  }
  const cc = e.target.closest('.cc-btn');
  if (cc) {
    const cards = +cc.dataset.cc;
    const activeType = curG.includes('hl') ? 'omaha-hl' : 'omaha';
    if (activeType === 'omaha') omahaCards = cards;
    else omahaHlCards = cards;
    switchGame(gameKey(activeType, cards));
    updateGameUI();
  }
});

document.getElementById('timer').addEventListener('click', e => {
  if (e.target.id === 'rerun-btn' && !calculating) {
    runEquityCalc();
  }
});

// Settings (per browser, not part of the share link)
const EVAL_SECONDS = [1, 2, 5, 10, 30];
const DEFAULT_SETTINGS = {evalSeconds: 2, autoCalc: true, showSamples: true, fourColor: true, decimals: 1, theme: 'system'};
let settings = {...DEFAULT_SETTINGS};
try {
  const saved = JSON.parse(localStorage.getItem('ducySettings') || 'null');
  if (saved) settings = {...settings, ...saved};
  else if (localStorage.getItem('fourColor') === '0') settings.fourColor = false;
} catch {}

function applySettings() {
  MC_TIME_BUDGET = settings.evalSeconds * 1000;
  MC_MAX_SAMPLES = settings.evalSeconds * 50000;
  const root = document.documentElement;
  root.classList.toggle('four-color', settings.fourColor);
  if (settings.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
}

function saveSettings() {
  try { localStorage.setItem('ducySettings', JSON.stringify(settings)); } catch {}
}

function scheduleCalc(delay) {
  if (calcTimer) clearTimeout(calcTimer);
  calcTimer = null;
  if (settings.autoCalc) {
    calcTimer = setTimeout(runEquityCalc, delay);
  } else {
    document.getElementById('timer').innerHTML = '<button class="rerun-btn" id="rerun-btn">Calculate</button>';
  }
}

// Worst-case 95% margin of error across players for a sampled result
function marginOfError(n) {
  const ps = eqs.filter(e => e != null);
  if (!n || !ps.length) return 0;
  return Math.max(...ps.map(p => 1.96 * Math.sqrt(p * (1 - p) / n)));
}

function mcTimerHtml(ms, done) {
  let t = `~${ms}ms`;
  if (settings.showSamples) t += ` (${done.toLocaleString()} samples, ±${(marginOfError(done) * 100).toFixed(settings.decimals)}%)`;
  return t + ' <button class="rerun-btn" id="rerun-btn">↻</button>';
}

const SETTING_ROWS = [
  ['Calculation', [
    ['evalSeconds', 'Evaluation time', EVAL_SECONDS.map(v => [v, v + 's'])],
    ['autoCalc', 'Auto-calculate', [[true, 'On'], [false, 'Off']]],
    ['showSamples', 'Samples & margin', [[true, 'Show'], [false, 'Hide']]],
  ]],
  ['Display', [
    ['fourColor', '4-color deck', [[true, 'On'], [false, 'Off']]],
    ['decimals', 'Equity decimals', [[1, '1'], [2, '2']]],
    ['theme', 'Theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]],
  ]],
];

function openSettings() {
  let h = '<div class="modal-header"><span>Settings</span></div><div class="settings">';
  for (const [section, rows] of SETTING_ROWS) {
    h += `<div class="settings-section">${section}</div>`;
    for (const [key, label, opts] of rows) {
      h += `<div class="settings-row"><span class="settings-label">${label}</span><div class="card-count">`;
      for (const [v, text] of opts) {
        h += `<button class="cc-btn${settings[key] === v ? ' on' : ''}" data-set="${key}" data-val='${JSON.stringify(v)}'>${text}</button>`;
      }
      h += '</div></div>';
    }
  }
  h += '<div class="settings-note">Longer evaluation runs more samples for tighter results. Settings are saved in this browser.</div></div>';
  showModal(h);
}

function changeSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  saveSettings();
  applySettings();
  openSettings();
  if (key === 'evalSeconds' || key === 'autoCalc') dirty();
  render();
  if (key === 'showSamples' && calced && !calculating && lastMcType) runEquityCalc();
}

applySettings();
document.getElementById('settings-btn').addEventListener('click', openSettings);

document.getElementById('clear-btn').addEventListener('click', () => {
  seats = new Array(10).fill(null);
  initBoards();
  deadCards = [];
  dirty(); render();
  syncHash();
});

function stateToHash() {
  const parts = ['g=' + curG];
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (!s) continue;
    if (s.mode === 'cards') {
      const cards = s.cards.filter(c => c);
      if (cards.length) parts.push('p' + i + '=' + cards.join('.'));
    } else if (s.mode === 'range' && s.sel.size > 0) {
      parts.push('p' + i + '=r:' + [...s.sel].join(','));
    } else if (s.mode === 'orange' && s.text.trim()) {
      parts.push('p' + i + '=o:' + encodeURIComponent(s.text.trim()));
    } else if (s.mode === 'random') {
      parts.push('p' + i + '=random');
    }
  }
  for (let bi = 0; bi < boards.length; bi++) {
    const bc = boards[bi].filter(c => c);
    const key = boards.length > 1 ? 'b' + bi : 'b';
    if (bc.length) parts.push(key + '=' + bc.join('.'));
  }
  if (deadCards.length) parts.push('d=' + deadCards.join('.'));
  return '#' + parts.join('&');
}

function syncHash() {
  if (trainerOpen() || playOpen()) return;
  const h = stateToHash();
  if (location.hash !== h) history.replaceState(null, '', h);
}

function loadFromHash() {
  const h = location.hash.slice(1);
  if (h === 'trainer' || h === 'play' || h === 'codedoug') return;
  if (!h) return;
  const params = {};
  for (const part of h.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
  }
  if (params.g && GM[params.g]) {
    curG = params.g;
    const m = curG.match(/omaha(\d)?/);
    if (m) {
      const cc = m[1] ? +m[1] : 4;
      if (curG.includes('hl')) omahaHlCards = cc; else omahaCards = cc;
    }
  }
  seats = new Array(10).fill(null);
  initBoards();
  deadCards = [];
  const gm = g();
  for (const [k, v] of Object.entries(params)) {
    const pm = k.match(/^p(\d+)$/);
    if (!pm) continue;
    const si = +pm[1];
    if (si >= gm.max) continue;
    if (v === 'random') {
      seats[si] = { mode: 'random' };
    } else if (v.startsWith('r:')) {
      seats[si] = { mode: 'range', sel: parseRange(v.slice(2)) };
    } else if (v.startsWith('o:')) {
      let text = v.slice(2);
      try { text = decodeURIComponent(text); } catch {}
      seats[si] = { mode: 'orange', text };
    } else {
      const cards = v.split('.').filter(Boolean);
      const hand = new Array(gm.cards).fill(null);
      cards.forEach((c, j) => { if (j < gm.cards) hand[j] = c; });
      seats[si] = { mode: 'cards', cards: hand };
    }
  }
  if (boards.length > 1) {
    for (let bi = 0; bi < boards.length; bi++) {
      const bkey = 'b' + bi;
      if (params[bkey]) {
        const bc = params[bkey].split('.').filter(Boolean);
        bc.forEach((c, i) => { if (i < 5) boards[bi][i] = c; });
      }
    }
  } else {
    if (params.b) {
      const bc = params.b.split('.').filter(Boolean);
      bc.forEach((c, i) => { if (i < 5) boards[0][i] = c; });
    }
  }
  if (params.d) {
    deadCards = params.d.split('.').filter(Boolean);
  }
  dirty();
}

// Modes: the equity calculator, the range trainer at #trainer, or the hidden
// bot table at #play (no tab links to it). The trainer doesn't need the
// engine, so it's set up before the WASM load below; the bot table loads it.
// `shortcut` opens the bot table straight into a preset game (see openPlay).
function setMode(mode, shortcut) {
  const trainer = mode === 'trainer', play = mode === 'play', clubs = mode === 'clubs';
  document.body.classList.toggle('mode-trainer', trainer);
  document.body.classList.toggle('mode-play', play);
  document.body.classList.toggle('mode-clubs', clubs);
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  if (trainer) openTrainer(document.getElementById('trainer'));
  else closeTrainer();
  if (play) openPlay(document.getElementById('play'), shortcut);
  else closePlay();
  if (clubs) openClubs(document.getElementById('clubs'));
  else closeClubs();
}

document.querySelector('.mode-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]');
  if (!b || b.classList.contains('on')) return;
  // Changing the hash adds a history entry, so Back returns to the other mode.
  if (b.dataset.mode === 'trainer') location.hash = 'trainer';
  else { closeTrainer(); location.hash = stateToHash() || 'g=' + curG; }
});

// #codedoug: straight to heads-up No-limit Hold'em against the GTO bot at
// 100 big blinds. The address becomes #play, so leaving the table or
// reloading lands on the usual setup.
function openShortcut() {
  history.replaceState(null, '', '#play');
  setMode('play', 'gto');
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#trainer') { setMode('trainer'); return; }
  if (location.hash === '#play') { setMode('play'); return; }
  if (location.hash === '#clubs') { setMode('clubs'); return; }
  if (location.hash === '#codedoug') { openShortcut(); return; }
  setMode('equity');
  loadFromHash(); render(); updateGameUI();
});

// A club invite opens #clubs even if the #clubs on the end of the link was
// lost (some apps cut links at the #).
const q = new URLSearchParams(location.search);
if (q.has('club') && q.has('invite') && location.hash !== '#clubs') history.replaceState(null, '', location.pathname + location.search + '#clubs');

if (location.hash === '#trainer') setMode('trainer');
else if (location.hash === '#play') setMode('play');
else if (location.hash === '#clubs') setMode('clubs');
else if (location.hash === '#codedoug') openShortcut();

// Init
const statusEl = document.getElementById('wasm-status');
try {
  await init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)});
  wasmReady = true;
  startWorkerPool();
  statusEl.textContent = '';
  statusEl.className = 'wasm-status ok';
} catch (err) {
  statusEl.textContent = 'WASM failed to load';
  statusEl.className = 'wasm-status err';
  console.error('WASM init failed:', err);
}

loadFromHash();
render();
updateGameUI();
NARROW.addEventListener('change', render);
scheduleCalc(0);
