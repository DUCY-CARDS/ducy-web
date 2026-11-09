// Playing as if a partner's cards were known (#600), for the collusion check
// (collusion.js). If Bo tells Ava his cards, Ava knows they're in no one
// else's hand: Bo folds the A♠ and Ava, with a king-high spade flush,
// knows her opponent can't hold the nut flush, so she calls any river bet.
//
// Spots that count: a hold'em player facing a bet on the turn or river,
// heads-up, where adding another dealt-in player's cards as dead cards
// flips what's right (their chance of winning crosses the pot odds, by at
// least `minMove` all told): calling or raising against folding. The
// decision fits those cards when it's what knowing them gives. Every other
// player dealt in is tried in turn, so collusion.js compares each
// "partner" with the rest: an honest player's decisions don't follow
// anyone's cards, so they fit each player's about equally often; a cheat's
// follow one partner's.

// The model, the same with and without the extra cards: the opponent's
// hand is any two cards still possible, the strongest `betTop` share of
// them (on this board) counting fully and the rest at `bluffWeight` (a bet
// mostly means strength). Exact on the river; on the turn, averaged over
// `turnSamples` river cards. Omaha isn't judged (too many hands to count).
//
// Reads hole cards, folded ones too; nothing here leaves the relay but the
// counts and hand numbers collusion.js reports.

// ---- a 7-card hand's value, higher is better ----

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
export const cardId = c => (typeof c === 'string' && c.length === 2 ? RANKS.indexOf(c[0]) * 4 + SUITS.indexOf(c[1]) : -1);
const B = 15;

// Five ranks in a row in `mask` (bit r for rank r; the ace plays low too):
// the top rank, or -1.
function straightTop(mask) {
  for (let top = 12; top >= 4; top--) {
    const need = 0b11111 << (top - 4);
    if ((mask & need) === need) return top;
  }
  return (mask & 0b1111) === 0b1111 && (mask & (1 << 12)) ? 3 : -1;
}

// A category and up to five ranks, as one number.
const value = (cat, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0) => ((((cat * B + k0) * B + k1) * B + k2) * B + k3) * B + k4;

// Scratch space, reused: the value is worked out often (a thousand hands
// per spot).
const count = new Int8Array(13);
const suitMask = new Int32Array(4), suitN = new Int8Array(4);
const top = new Int8Array(5);

// The highest `n` ranks set in `mask` other than `skipA`, `skipB`, into top[].
function highest(mask, n, skipA = -1, skipB = -1) {
  let i = 0;
  for (let r = 12; r >= 0 && i < n; r--) if (mask & (1 << r) && r !== skipA && r !== skipB) top[i++] = r;
  while (i < 5) top[i++] = 0;
}

// The value of the best five of `ids` (card ids, 5 to 7).
export function handValue(ids) {
  count.fill(0); suitMask.fill(0); suitN.fill(0);
  let mask = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i], r = id >> 2, s = id & 3;
    count[r]++;
    mask |= 1 << r;
    suitMask[s] |= 1 << r;
    suitN[s]++;
  }
  let fs = -1;
  for (let s = 0; s < 4; s++) if (suitN[s] >= 5) fs = s;
  if (fs >= 0) {
    const sf = straightTop(suitMask[fs]);
    if (sf >= 0) return value(8, sf);
  }
  let q = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = count[r];
    if (c === 4) { if (q < 0) q = r; } else if (c === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; } else if (c === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  if (q >= 0) { highest(mask, 1, q); return value(7, q, top[0]); }
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return value(6, t1, Math.max(t2, p1));
  if (fs >= 0) { highest(suitMask[fs], 5); return value(5, top[0], top[1], top[2], top[3], top[4]); }
  const st = straightTop(mask);
  if (st >= 0) return value(4, st);
  if (t1 >= 0) { highest(mask, 2, t1); return value(3, t1, top[0], top[1]); }
  if (p2 >= 0) { highest(mask, 1, p1, p2); return value(2, p1, p2, top[0]); }
  if (p1 >= 0) { highest(mask, 3, p1); return value(1, p1, top[0], top[1], top[2]); }
  highest(mask, 5);
  return value(0, top[0], top[1], top[2], top[3], top[4]);
}

// ---- one spot ----

// The player's chance of winning (ties half) with cards `me` on full board
// `board` (5 card ids): first knowing only their own cards, then with each
// of `deads` (lists of card ids) out of the opponent's hand as well. The
// opponent's hand is any two cards still possible, the strongest `betTop`
// share counting fully and the rest at `bluffWeight`.
export function winChances(me, board, deads, {betTop, bluffWeight}) {
  const used = new Set([...me, ...board]);
  const mine = handValue([...me, ...board]);
  const n = (52 - used.size) * (51 - used.size) / 2;
  const ca = new Int8Array(n), cb = new Int8Array(n), cv = new Float64Array(n);
  const seven = [0, 0, ...board];
  let i = 0;
  for (let a = 0; a < 52; a++) {
    if (used.has(a)) continue;
    seven[0] = a;
    for (let b = a + 1; b < 52; b++) {
      if (used.has(b)) continue;
      seven[1] = b;
      ca[i] = a; cb[i] = b; cv[i] = handValue(seven); i++;
    }
  }
  const cut = Float64Array.from(cv).sort()[Math.max(0, n - Math.floor(n * betTop))];
  // The whole range's weight and the weight the player beats, and the same
  // for the hands holding each card, to take out a dead list's.
  const cardW = new Float64Array(52), cardWon = new Float64Array(52);
  const pairW = new Map();
  let all = 0, won = 0;
  for (let j = 0; j < n; j++) {
    const w = cv[j] >= cut ? 1 : bluffWeight;
    const x = w * (mine > cv[j] ? 1 : mine === cv[j] ? 0.5 : 0);
    all += w; won += x;
    cardW[ca[j]] += w; cardW[cb[j]] += w;
    cardWon[ca[j]] += x; cardWon[cb[j]] += x;
    pairW.set(ca[j] * 52 + cb[j], [w, x]);
  }
  return [[], ...deads].map(dead => {
    const d = [...new Set(dead)].filter(c => !used.has(c) && c >= 0);
    let w = all, x = won;
    for (const c of d) { w -= cardW[c]; x -= cardWon[c]; }
    // A hand holding two of the dead cards was taken out twice.
    for (let p = 0; p < d.length; p++) {
      for (let q = p + 1; q < d.length; q++) {
        const both = pairW.get(Math.min(d[p], d[q]) * 52 + Math.max(d[p], d[q]));
        if (both) { w += both[0]; x += both[1]; }
      }
    }
    return w > 1e-9 ? Math.min(1, Math.max(0, x / w)) : 0;
  });
}

// The same short of the river: averaged over `turnSamples` river cards
// (fixed by `seed`); with a dead list, over the ones it doesn't hold.
function chancesAt(me, board, deads, opts, seed) {
  if (board.length === 5) return winChances(me, board, deads, opts);
  const used = new Set([...me, ...board]);
  const rivers = [];
  let x = seed >>> 0;
  for (let tries = 0; rivers.length < opts.turnSamples && tries < 1000; tries++) {
    x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    const c = x % 52;
    if (!used.has(c) && !rivers.includes(c)) rivers.push(c);
  }
  const sums = new Array(deads.length + 1).fill(0), n = new Array(deads.length + 1).fill(0);
  for (const r of rivers) {
    const w = winChances(me, [...board, r], deads, opts);
    w.forEach((v, i) => { if (i && deads[i - 1].includes(r)) return; sums[i] += v; n[i]++; });
  }
  return sums.map((s, i) => (n[i] ? s / n[i] : 0));
}

// ---- the hands ----

// Every spot that counts in records `recs`: [{who, partner, fits (chose
// the answer knowing the partner's cards gives), ref: {table, hand, at}}].
// `opts`: {betTop, bluffWeight, turnSamples, minMove}.
export function partnerSpots(recs, opts) {
  const out = [];
  for (const rec of recs) {
    const seats = (rec.seats || []).filter(s => s.id && s.cards?.length === 2 && s.cards.every(c => cardId(c) >= 0));
    if (seats.length < 3 || seats.length !== (rec.seats || []).length) continue;
    const bySeat = new Map(seats.map(s => [s.seat, s]));
    const folded = new Set(), board = [], street = new Map();
    let pot = 0, facing = 0, bettor = null;
    const ref = {table: rec.tableName || '', hand: rec.hand, at: rec.at};
    for (const e of rec.actions || []) {
      if (e.type === 'board') { board.push(...(e.cards || []).map(cardId)); street.clear(); facing = 0; bettor = null; continue; }
      const s = bySeat.get(e.seat);
      if (!s) continue;
      const mine = street.get(e.seat) || 0;
      const add = n => { street.set(e.seat, mine + n); pot += n; };
      // A decision facing a bet, heads-up, on the turn or river.
      const live = seats.filter(x => !folded.has(x.seat));
      if (['call', 'fold', 'raise'].includes(e.type) && facing > mine && bettor != null && bettor !== e.seat
          && board.length >= 4 && live.length === 2 && board.every(c => c >= 0)) {
        const toCall = facing - mine, need = toCall / (pot + toCall);
        const me = s.cards.map(cardId), others = seats.filter(x => x.seat !== e.seat && x.seat !== bettor);
        const chances = chancesAt(me, board.slice(0, 5), others.map(o => o.cards.map(cardId)), opts, (rec.hand || 0) * 31 + e.seat);
        const base = chances[0], goes = e.type !== 'fold';
        others.forEach((o, i) => {
          const knew = chances[i + 1];
          if ((base >= need) === (knew >= need) || Math.abs(knew - base) < opts.minMove) return;
          out.push({who: s.id, partner: o.id, fits: goes === (knew >= need), ref});
        });
      }
      if (e.type === 'fold') folded.add(e.seat);
      else if (e.type === 'small_blind' || e.type === 'big_blind' || e.type === 'call') add(Number(e.amount) || 0);
      else if (e.type === 'post') { add(Number(e.live) || 0); pot += Number(e.dead) || 0; }
      else if (e.type === 'ante') pot += Number(e.amount) || 0;
      if (e.type === 'bet' || e.type === 'raise') {
        add((Number(e.to) || 0) - mine);
        facing = Number(e.to) || 0;
        bettor = e.seat;
      } else if (e.type === 'big_blind') facing = Math.max(facing, street.get(e.seat) || 0);
    }
  }
  return out;
}
