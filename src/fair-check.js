// A player's side of a fair deal at a club table (#136; club-host.js has the
// host's). Before a hand, the page makes a secret value, sends its
// commitment, and once it has the list of everyone's commitments (the
// host's included) sends the value itself. After the hand the host
// publishes every value used, and the page checks the deal (ducy-play's
// fair_deal, #460): each value opens its commitment, its own was used, the
// seed is made from them in list order, and its hole cards and the board
// are what the seed deals. The result goes to the table and the hand
// history: "Fair deal ✓", or what didn't check out.

import { fairCheck, fairMayReveal, fairSecret } from '../wasm/ducy_wasm.js';

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
        if (!fairMayReveal(JSON.stringify(m.list), r.secret.commitment)) return null;
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
// saw (`cards`, `board`); `secret`: their own, if they took part in the
// round. {ok, why, ours}.
export function checkDeal(m, {cards = [], board = []} = {}, secret = null) {
  return fairCheck(JSON.stringify(m ?? null), JSON.stringify({cards, board}), JSON.stringify(secret ? {value: secret.value, nonce: secret.nonce} : null));
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
