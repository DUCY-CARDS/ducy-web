// A player's side of a fair deal at a club table (#136; club-host.js has the
// host's). Before a hand, the page makes a secret value, sends its
// commitment, and once it has the list of everyone's commitments (the
// host's included) sends the value itself. After the hand the host
// publishes every value used; this page checks that:
//   - each value opens its commitment in that list, and its own is there;
//   - the seed is ducy's fairSeed of those values, in list order;
//   - its own hole cards and the board are what fairDeal gives for that seed.
// The result goes to the table and the hand history: "Fair deal ✓", or what
// didn't check out.

import { fairCommitment, fairDeal, fairSecret, fairSeed } from '../wasm/ducy_wasm.js';

// A player's fair-deal side, for one page (or, in tests, one simulated
// player). `message(m, send, mine)` answers a fair-deal message from the host
// (`m.type === 'fair'`), sending replies with `send(cmd)`, and returns the
// check of a finished hand ({hand, ok, why}) when `m` is the host's result.
// `mine` = {cards, board}: this player's hole cards and the board shown.
export function fairPlayer() {
  // Rounds this player is in: round id → {secret, list}. A few at most.
  const rounds = new Map();
  const checked = new Set(); // seeds of the hands already checked
  return {
    message(m, send, mine) {
      if (m.step === 'commit') {
        const secret = fairSecret();
        rounds.set(m.round, {secret});
        while (rounds.size > 4) rounds.delete(rounds.keys().next().value);
        send({type: 'fair_commit', round: m.round, c: secret.commitment});
        return null;
      }
      if (m.step === 'reveal') {
        const r = rounds.get(m.round);
        // Reveal only to a list that has this player's commitment and the
        // host's, each once.
        if (!r || !Array.isArray(m.list) || r.list) return null;
        const ids = m.list.map(e => e?.id);
        if (!m.list.some(e => e?.c === r.secret.commitment) || !ids.includes('host') || new Set(ids).size !== ids.length) return null;
        r.list = m.list;
        send({type: 'fair_reveal', round: m.round, value: r.secret.value, nonce: r.secret.nonce});
        return null;
      }
      if (m.step === 'result') {
        // The host sends recent results again when a player comes back: each
        // hand is checked once.
        if (checked.has(m.seed)) return null;
        checked.add(m.seed);
        if (checked.size > 50) checked.delete(checked.values().next().value);
        const ours = [...rounds.values()].find(r => r.list && sameList(r.list, m.list));
        return {hand: Number(m.hand), ...checkDeal(m, mine, ours?.secret)};
      }
      return null;
    },
  };
}

// Checks a finished hand's published deal (`m`) against what this player
// saw (`cards`, `board`); `secret`: their own, if they took part in the round.
export function checkDeal(m, {cards, board} = {}, secret = null) {
  try {
    const list = new Map((m.list || []).map(e => [e.id, e.c]));
    if (!list.has('host')) return bad('the host’s commitment is missing');
    const ours = secret && {secret};
    for (const u of m.reveals || []) {
      if (fairCommitment(u.value, u.nonce) !== list.get(u.id)) return bad(`${u.id === 'host' ? 'the host’s' : 'a player’s'} value doesn’t match its commitment`);
    }
    if (ours && !(m.reveals || []).some(u => u.value === ours.secret.value)) return bad('your value wasn’t used');
    // The values in list order, as the seed was made.
    const order = (m.list || []).map(e => e.id);
    const used = [...(m.reveals || [])].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (fairSeed(used.map(u => u.value)) !== m.seed) return bad('the seed isn’t made from the values');
    const deal = fairDeal(m.game, Number(m.dealt), m.seed);
    if (cards?.length && !sameCards(deal.hole_cards[Number(m.index)] || [], cards)) return bad('your cards aren’t the ones the seed deals');
    if (board?.length && deal.board.slice(0, board.length).join(' ') !== board.join(' ')) return bad('the board isn’t the one the seed deals');
    return {ok: true, why: '', ours: !!ours};
  } catch (e) {
    return bad(`it couldn’t be checked (${e.message || e})`);
  }
}

const bad = why => ({ok: false, why});
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameCards = (a, b) => [...a].sort().join(' ') === [...b].sort().join(' ');
