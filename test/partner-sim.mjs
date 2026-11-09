// Made-up hold'em hands for the partner-cards check (#600): heads-up to the
// river, where one bets and the other calls or folds, the rest folded
// before the flop. The bet is sized so the pot odds sit close to the
// decider's chance of winning (hard choices, the spots that can count, come
// often). Each decider weighs that chance against the pot odds, with some
// noise; a cheat (`cheat`: [player, partner] indexes) uses their partner's
// cards too, whenever the partner is dealt in.
import { cardId, winChances } from '../relay/src/partner-cards.js';
import { partnerOpts } from '../relay/src/collusion.js';

export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECK = [...'23456789TJQKA'].flatMap(r => [...'shdc'].map(s => r + s));
export const NAMES = ['Ava', 'Bo', 'Cy', 'Dee', 'Eli'];
export const opts = partnerOpts;

export function riverHands({hands, seed, cheat = null, noise = 0.03, start = 1_000_000}) {
  const R = random(seed);
  const n = NAMES.length;
  const o = opts();
  const gauss = () => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());
  const recs = [];
  for (let h = 1; h <= hands; h++) {
    const deck = [...DECK];
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const cards = NAMES.map((_, i) => [deck[2 * i], deck[2 * i + 1]]);
    const board = deck.slice(2 * n, 2 * n + 5);
    const button = h % n, sb = (button + 1) % n, bb = (button + 2) % n;
    const p = Math.floor(R() * n);
    let b = Math.floor(R() * (n - 1));
    if (b >= p) b++;
    const put = Array(n).fill(0), actions = [];
    actions.push({type: 'small_blind', seat: sb, amount: 1}, {type: 'big_blind', seat: bb, amount: 2});
    put[sb] = 1; put[bb] = 2;
    for (let i = 0; i < n; i++) {
      const s = (button + 3 + i) % n;
      if (s === p || s === b) { if (put[s] < 2) actions.push({type: 'call', seat: s, amount: 2 - put[s], all_in: false}); put[s] = 2; } else actions.push({type: 'fold', seat: s});
    }
    for (const [street, from, to] of [['flop', 0, 3], ['turn', 3, 4]]) {
      actions.push({type: 'board', street, cards: board.slice(from, to)}, {type: 'check', seat: b}, {type: 'check', seat: p});
    }
    const partner = cheat && p === cheat[0] && cheat[1] !== b ? cheat[1] : -1;
    const ch = winChances(cards[p].map(cardId), board.map(cardId), partner >= 0 ? [cards[partner].map(cardId)] : [], o);
    // Pot odds near the decider's chance: a bet x into pot P0 asks x / (P0 + 2x).
    const before = put.reduce((x, y) => x + y, 0);
    const want = Math.min(0.45, Math.max(0.05, ch[0] + (R() - 0.5) * 0.08));
    const bet = Math.max(1, Math.round(want * before * 100 / (1 - 2 * want)));
    const scale = 100;
    actions.forEach(e => { for (const k of ['amount', 'to']) if (e[k] != null) e[k] *= scale; });
    for (let i = 0; i < n; i++) put[i] *= scale;
    actions.push({type: 'board', street: 'river', cards: board.slice(4, 5)}, {type: 'bet', seat: b, to: bet, all_in: false});
    put[b] += bet;
    const pot = put.reduce((x, y) => x + y, 0), need = bet / (pot + bet);
    const goes = ch[partner >= 0 ? 1 : 0] + noise * gauss() >= need;
    actions.push({type: goes ? 'call' : 'fold', seat: p, ...(goes ? {amount: bet, all_in: false} : {})});
    if (goes) put[p] += bet;
    const total = put.reduce((x, y) => x + y, 0);
    const winner = goes && R() < ch[0] ? p : b;
    recs.push({
      id: `T:${h}`, at: start + h * 60_000, club: 'TEST-CLUB', table: 't1', tableName: 'Main', game: 'nlhe', hand: h, sb: 100, bb: 200, button,
      seats: NAMES.map((name, i) => ({seat: i, id: `id-${name}`, name, cards: cards[i], folded: i !== p && i !== b ? true : i === p && !goes, net: (i === winner ? total : 0) - put[i], won: i === winner ? total : 0, stackEnd: 200})),
      actions, board, board2: [], pot: total, showdown: goes, pots: [], deal: null,
    });
  }
  return recs;
}
