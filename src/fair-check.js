// A player's side of a fair deal at a club or friends table (#136; ducy's
// table runner has the host's). Before a hand, the page makes a secret
// value, sends its commitment, and once it has the list of everyone's
// commitments (the host's included) sends the value itself. The hand is
// dealt from a seed made of every value revealed, so no one party picks
// the cards.
//
// Players never get the seed back (#580): with it, anyone could deal out
// every other seat's hole cards, folded hands too. So a page can't check a
// deal itself, and shows no "Fair deal ✓". Where ducy keeps a hand's full
// record (an always-on club), the seed and the values go in it.

import { fairMayReveal, fairSecret } from '../wasm/ducy_wasm.js';

// A player's fair-deal side, for one page (or, in tests, one simulated
// player). `message(m, send)` answers a fair-deal message from the host
// (`m.type === 'fair'`), sending replies with `send(cmd)`.
export function fairPlayer() {
  // Rounds this player is in: round id → {secret, list}. A few at most.
  const rounds = new Map();
  return {
    message(m, send) {
      if (m.step === 'commit') {
        const secret = fairSecret();
        rounds.set(m.round, {secret});
        while (rounds.size > 4) rounds.delete(rounds.keys().next().value);
        send({type: 'fair_commit', round: m.round, c: secret.commitment});
        return;
      }
      if (m.step === 'reveal') {
        const r = rounds.get(m.round);
        // Reveal only to a list that has this player's commitment and the
        // host's, each once.
        if (!r || !Array.isArray(m.list) || r.list) return;
        if (!fairMayReveal(JSON.stringify(m.list), r.secret.commitment)) return;
        r.list = m.list;
        send({type: 'fair_reveal', round: m.round, value: r.secret.value, nonce: r.secret.nonce});
      }
    },
  };
}
