import init, { HoldemGame, OmahaGame, OmahaHiLoGame } from '../wasm/ducy_wasm.js';

const RK = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
const ST = [
  {ch:'♠', c:'s', cl:'bl'},
  {ch:'♥', c:'h', cl:'rd'},
  {ch:'♦', c:'d', cl:'rd'},
  {ch:'♣', c:'c', cl:'bl'},
];
const GM = {
  'nlhe':      {cards:2, max:10},
  'omaha':     {cards:4, max:10},
  'omaha-hl':  {cards:4, max:10},
  'omaha5':    {cards:5, max:9},
  'omaha5-hl': {cards:5, max:9},
  'omaha6':    {cards:6, max:6},
  'omaha6-hl': {cards:6, max:6},
};
const CW = {2:42, 4:32, 5:28, 6:24};
const COMBOS = {};
for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
  let l = r===c ? RK[r]+RK[c] : r<c ? RK[r]+RK[c]+'s' : RK[c]+RK[r]+'o';
  COMBOS[l] = r===c ? 6 : r<c ? 4 : 12;
}

let wasmReady = false;
let curG = 'nlhe';
let seats = new Array(10).fill(null);
let board = [null,null,null,null,null];
let deadCards = [];
let eqs = new Array(10).fill(null);
let calced = false;
let calculating = false;
let target = null;

function g() { return GM[curG]; }

function used() {
  const u = new Set();
  for (const s of seats) if (s && s.mode==='cards') for (const c of s.cards) if (c) u.add(c);
  for (const c of board) if (c) u.add(c);
  for (const c of deadCards) u.add(c);
  return u;
}

function cd(c) {
  if (!c) return null;
  const s = ST.find(x => x.c===c[1]);
  return {t: c[0]+s.ch, cl: s.cl==='rd'?'r':'bk'};
}

function bestEq() {
  let b = -1;
  for (const e of eqs) if (e != null && e > b) b = e;
  return b;
}

function seatPos(n) {
  const p = [], ax = 47, ay = 44;
  for (let i = 0; i < n; i++) {
    const a = Math.PI/2 + i * 2*Math.PI/n;
    p.push({l: 50 + ax*Math.cos(a), t: 50 + ay*Math.sin(a)});
  }
  return p;
}

// Card string format: "As" -> "A♠" for WASM (ducy uses "As" format)
function cardToWasm(c) {
  return c[0] + c[1];
}

function runEquityCalc() {
  if (!wasmReady) return;
  const gm = g();
  const filled = [];
  for (let i = 0; i < gm.max; i++) {
    if (!seats[i]) continue;
    if (seats[i].mode === 'cards' && seats[i].cards.every(c => c)) filled.push(i);
    if (seats[i].mode === 'range' && seats[i].sel.size > 0) filled.push(i);
  }
  if (filled.length < 2) return;

  // Range mode only supported for NLHE, skip calc if any range seat in non-NLHE
  for (const si of filled) {
    if (seats[si].mode === 'range') {
      // TODO: range equity not yet supported via WASM
      return;
    }
  }

  calculating = true;
  document.getElementById('timer').textContent = 'Calculating…';
  showCalcOverlay(true);

  // Run calc in a setTimeout to let the UI update
  setTimeout(() => {
    try {
      const t0 = performance.now();
      let equity;

      if (curG === 'nlhe') {
        const game = new HoldemGame();
        for (const si of filled) {
          game.add_player(seats[si].cards.map(cardToWasm).join(' '));
        }
        const boardCards = board.filter(c => c);
        if (boardCards.length >= 3) {
          game.set_flop(boardCards.slice(0, 3).map(cardToWasm).join(' '));
        }
        if (boardCards.length >= 4) {
          game.set_turn(cardToWasm(boardCards[3]));
        }
        if (boardCards.length >= 5) {
          game.set_river(cardToWasm(boardCards[4]));
        }
        equity = game.evaluate_equity();
        game.free();
      } else if (curG.includes('hl')) {
        const game = new OmahaHiLoGame();
        for (const si of filled) {
          game.add_player(seats[si].cards.map(cardToWasm).join(' '));
        }
        const boardCards = board.filter(c => c);
        if (boardCards.length >= 3) {
          game.set_flop(boardCards.slice(0, 3).map(cardToWasm).join(' '));
        }
        if (boardCards.length >= 4) {
          game.set_turn(cardToWasm(boardCards[3]));
        }
        if (boardCards.length >= 5) {
          game.set_river(cardToWasm(boardCards[4]));
        }
        equity = game.evaluate_equity();
        game.free();
      } else {
        const game = new OmahaGame(gm.cards);
        for (const si of filled) {
          game.add_player(seats[si].cards.map(cardToWasm).join(' '));
        }
        const boardCards = board.filter(c => c);
        if (boardCards.length >= 3) {
          game.set_flop(boardCards.slice(0, 3).map(cardToWasm).join(' '));
        }
        if (boardCards.length >= 4) {
          game.set_turn(cardToWasm(boardCards[3]));
        }
        if (boardCards.length >= 5) {
          game.set_river(cardToWasm(boardCards[4]));
        }
        equity = game.evaluate_equity();
        game.free();
      }

      const ms = (performance.now() - t0).toFixed(0);
      eqs = new Array(10).fill(null);
      filled.forEach((si, j) => { eqs[si] = equity[j]; });
      calced = true;
      calculating = false;
      document.getElementById('timer').textContent = ms + 'ms';
      showCalcOverlay(false);
      render();
    } catch (err) {
      calculating = false;
      document.getElementById('timer').textContent = 'Error: ' + err.message;
      showCalcOverlay(false);
    }
  }, 10);
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
  document.documentElement.style.setProperty('--card-w', CW[gm.cards]+'px');
  const tw = document.getElementById('tw');
  tw.querySelectorAll('.seat').forEach(e => e.remove());
  const pos = seatPos(gm.max);
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
      } else {
        const cnt = [...s.sel].reduce((a,k) => a + (COMBOS[k]||0), 0);
        h += `<div class="seat-range" data-rng="${i}">`;
        h += `<div class="seat-range-label">Range</div>`;
        h += `<div class="seat-range-count">${cnt} combos</div>`;
        h += '</div>';
      }
      if (calced && eqs[i] != null) {
        const pct = (eqs[i]*100).toFixed(1);
        const col = eqs[i] >= be - 0.001 ? 'var(--teal)' : 'var(--fg-muted)';
        h += `<div class="seat-eq" style="color:${col}">${pct}%</div>`;
      }
      h += `<button class="seat-x" data-rm="${i}">×</button></div>`;
      el.innerHTML = h;
    } else {
      el.innerHTML = `<button class="seat-add" data-add="${i}">+</button>`;
    }
    tw.appendChild(el);
  }
  renderBoard();
}

function renderBoard() {
  let h = '';
  for (let i = 0; i < 5; i++) {
    if (i===3||i===4) h += '<div class="board-gap"></div>';
    const d = cd(board[i]);
    if (d) h += `<div class="bc ${d.cl}" data-bi="${i}">${d.t}</div>`;
    else h += `<div class="bc empty" data-bi="${i}">+</div>`;
  }
  document.getElementById('board').innerHTML = h;

  let dh = '';
  for (let i = 0; i < deadCards.length; i++) {
    const d = cd(deadCards[i]);
    if (d) dh += `<div class="dc ${d.cl}" data-di="${i}">${d.t}</div>`;
  }
  document.getElementById('dead').innerHTML = dh;
}

function openDeadPicker() {
  target = {type:'dead'};
  const u = used();
  let h = `<div class="modal-header"><span>Dead card</span></div><div class="card-picker">`;
  for (const suit of ST) {
    h += '<div class="psuit">';
    h += `<span class="sicon" style="color:${suit.cl==='rd'?'var(--red)':'var(--fg-strong)'}">${suit.ch}</span>`;
    for (const rank of RK) {
      const card = rank + suit.c;
      const isUsed = u.has(card);
      h += `<button class="pk ${suit.cl}${isUsed?' used':''}" data-pk="${card}"${isUsed?' disabled':''}>${rank}</button>`;
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
  for (const c of hand) if (c) uForPicker.delete(c);

  let h = '';
  if (isHoldem) {
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
    h += `<span class="sicon" style="color:${suit.cl==='rd'?'var(--red)':'var(--fg-strong)'}">${suit.ch}</span>`;
    for (const rank of RK) {
      const card = rank + suit.c;
      const isUsed = uForPicker.has(card);
      h += `<button class="pk ${suit.cl}${isUsed?' used':''}" data-pk="${card}"${isUsed?' disabled':''}>${rank}</button>`;
    }
    h += '</div>';
  }
  h += '</div>';
  showModal(h);
}

function openRangePicker(seatIdx) {
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
  h += `<textarea class="range-text" id="rtxt" placeholder="AA, AKs, QQ+ ...">${[...sel].join(', ')}</textarea>`;
  h += '</div>';
  showModal(h);
}

function openBoardPicker(cardIdx) {
  const curCard = board[cardIdx];
  target = {type:'board', card:cardIdx};
  const u = used();
  const labels = ['Flop 1','Flop 2','Flop 3','Turn','River'];

  let h = `<div class="modal-header"><span>Board · ${labels[cardIdx]}</span>`;
  if (curCard) h += '<button class="modal-clear" id="mclear">Remove</button>';
  h += '</div><div class="card-picker">';
  for (const suit of ST) {
    h += '<div class="psuit">';
    h += `<span class="sicon" style="color:${suit.cl==='rd'?'var(--red)':'var(--fg-strong)'}">${suit.ch}</span>`;
    for (const rank of RK) {
      const card = rank + suit.c;
      const isUsed = u.has(card) && card !== curCard;
      h += `<button class="pk ${suit.cl}${isUsed?' used':''}" data-pk="${card}"${isUsed?' disabled':''}>${rank}</button>`;
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
  document.getElementById('timer').textContent = '';
  if (calcTimer) clearTimeout(calcTimer);
  calcTimer = setTimeout(runEquityCalc, 150);
}

// Range parsing
function ri(r) { return RK.indexOf(r); }

function parseRange(text) {
  const sel = new Set();
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) continue;
    const dashMatch = t.match(/^([AKQJT2-9]{2}[so]?)-([AKQJT2-9]{2}[so]?)$/);
    if (dashMatch) {
      expandDash(dashMatch[1], dashMatch[2], sel);
      continue;
    }
    const plusMatch = t.match(/^([AKQJT2-9]{2}[so]?)\+$/);
    if (plusMatch) {
      expandPlus(plusMatch[1], sel);
      continue;
    }
    if (COMBOS[t]) sel.add(t);
  }
  return sel;
}

function expandPlus(hand, sel) {
  if (hand.length === 2 && hand[0] === hand[1]) {
    const start = ri(hand[0]);
    for (let i = start; i >= 0; i--) sel.add(RK[i]+RK[i]);
  } else if (hand.length === 3) {
    const suit = hand[2];
    const hi = ri(hand[0]), lo = ri(hand[1]);
    for (let i = lo; i > hi; i--) {
      const k = RK[hi]+RK[i]+suit;
      if (COMBOS[k]) sel.add(k);
    }
  }
}

function expandDash(lo, hi, sel) {
  if (lo.length === 2 && hi.length === 2 && lo[0] === lo[1] && hi[0] === hi[1]) {
    let a = ri(lo[0]), b = ri(hi[0]);
    if (a < b) [a, b] = [b, a];
    for (let i = b; i <= a; i++) sel.add(RK[i]+RK[i]);
  }
}

// Events
document.getElementById('tw').addEventListener('click', e => {
  const sc = e.target.closest('[data-s]');
  if (sc) {
    const si = +sc.dataset.s;
    openCardPicker(si, 0);
    return;
  }
  const rng = e.target.closest('[data-rng]');
  if (rng) { openRangePicker(+rng.dataset.rng); return; }
  const add = e.target.closest('[data-add]');
  if (add) {
    const i = +add.dataset.add;
    seats[i] = {mode:'cards', cards: new Array(g().cards).fill(null)};
    dirty(); render();
    openCardPicker(i, 0);
    return;
  }
  const rm = e.target.closest('[data-rm]');
  if (rm) { seats[+rm.dataset.rm] = null; dirty(); render(); return; }
});

document.getElementById('board').addEventListener('click', e => {
  const bc = e.target.closest('[data-bi]');
  if (bc) openBoardPicker(+bc.dataset.bi);
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

  const mt = e.target.closest('[data-mt]');
  if (mt && target && target.type === 'hand' && curG === 'nlhe') {
    const mode = mt.dataset.mt;
    if (mode === 'range') {
      openRangePicker(target.seat);
    } else {
      if (!seats[target.seat] || seats[target.seat].mode !== 'cards') {
        seats[target.seat] = {mode:'cards', cards: new Array(g().cards).fill(null)};
        dirty(); render();
      }
      openCardPicker(target.seat, 0);
    }
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

  const pk = e.target.closest('.pk:not(.used)');
  if (pk && target) {
    const card = pk.dataset.pk;
    if (target.type === 'hand') {
      seats[target.seat].cards[target.card] = card;
      dirty(); render();
      const next = seats[target.seat].cards.indexOf(null);
      if (next !== -1) { openCardPicker(target.seat, next); } else { closeModal(); }
    } else if (target.type === 'board') {
      board[target.card] = card;
      dirty(); render();
      const next = board.indexOf(null);
      if (next !== -1) { openBoardPicker(next); } else { closeModal(); }
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
      board[target.card] = null;
      dirty(); closeModal(); render();
    }
    return;
  }

  if (e.target.id === 'rclear' && target) {
    seats[target.seat] = {mode:'range', sel: new Set()};
    dirty(); render();
    openRangePicker(target.seat);
    return;
  }
});

document.getElementById('mbg').addEventListener('input', e => {
  if (e.target.id === 'rtxt' && target && target.seatMode === 'range') {
    const sel = parseRange(e.target.value);
    seats[target.seat] = {mode:'range', sel};
    const cnt = [...sel].reduce((a,k) => a + (COMBOS[k]||0), 0);
    const pctH = (cnt/1326*100).toFixed(1);
    const ci = document.getElementById('rcnt');
    if (ci) ci.textContent = cnt + ' combos · ' + pctH + '%';
    document.querySelectorAll('#rgrid .rc').forEach(rc => {
      const h = rc.dataset.h;
      rc.classList.toggle('on', sel.has(h));
      rc.classList.toggle('off', !sel.has(h));
    });
    dirty(); render();
  }
});

function switchGame(newGame) {
  if (newGame === curG) return;
  curG = newGame;
  seats = new Array(10).fill(null);
  board = [null,null,null,null,null];
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
  const activeType = curG === 'nlhe' ? 'nlhe' : curG.includes('hl') ? 'omaha-hl' : 'omaha';
  document.querySelector(`.game-btn[data-game="${activeType}"]`).classList.add('on');

  document.getElementById('cc-omaha').classList.toggle('dim', activeType !== 'omaha');
  document.getElementById('cc-omaha-hl').classList.toggle('dim', activeType !== 'omaha-hl');

  if (activeType === 'omaha' || activeType === 'omaha-hl') {
    const cc = activeType === 'omaha' ? omahaCards : omahaHlCards;
    const container = document.getElementById('cc-' + activeType);
    container.querySelectorAll('.cc-btn').forEach(b => {
      b.classList.toggle('on', +b.dataset.cc === cc);
    });
  }
}

document.getElementById('game-sel').addEventListener('click', e => {
  const gb = e.target.closest('.game-btn');
  if (gb) {
    const type = gb.dataset.game;
    if (type === 'nlhe') switchGame('nlhe');
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

document.getElementById('clear-btn').addEventListener('click', () => {
  seats = new Array(10).fill(null);
  board = [null,null,null,null,null];
  deadCards = [];
  dirty(); render();
});

// Init
const statusEl = document.getElementById('wasm-status');
try {
  await init(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
  wasmReady = true;
  statusEl.textContent = '';
  statusEl.className = 'wasm-status ok';
} catch (err) {
  statusEl.textContent = 'WASM failed to load';
  statusEl.className = 'wasm-status err';
  console.error('WASM init failed:', err);
}

render();
