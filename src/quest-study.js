// Study while you travel or wait for a seat (Bankroll Challenge): quick
// questions on the numbers players use at the table, pot odds, outs and
// combinations. Question `n` of a world (its seed) is always the same, so a
// redrawn page shows the question you were on. From ducy-quest (Rust, #466).

import { quest as op } from '../wasm/ducy_wasm.js';

/** Question `n` for world `seed`: {kind, text, choices: [text], answer (its index), why}. */
export const question = (seed, n) => op({op: 'question', seed, n});
