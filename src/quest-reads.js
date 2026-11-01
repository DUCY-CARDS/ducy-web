// Reading players in the Bankroll Challenge (#306): guess a stranger's style
// from what you can see, then check it against how they play.
//
// - **Clues:** a generic player's look, whether they're a reg or a tourist,
//   the hour (quest-people.js), how fast they act (thinkMs) and what they say
//   (bot-chat.js), and their stats, which build up for a reg across sessions.
// - **Tags:** tap a player to tag them rock, calling station, maniac, grinder
//   or not sure yet. Tags are kept with the player in the save.
// - **After a session:** each tagged player's real style, and whether the
//   read was right; for the others, what their hands suggested.
// - **Over time:** how often a first read (made before READ_HANDS hands with
//   that player) and a later one were right.
//
// The rules live in ducy-quest (Rust, #466); play.js keeps the quest.

import { quest as op } from '../wasm/ducy_wasm.js';
import { FAMILIES, FAMILY_NAMES } from './quest-people.js';

export const TAGS = [...FAMILIES, 'unsure'];
export const TAG_NAMES = {...FAMILY_NAMES, unsure: 'Not sure yet'};
/** Hands with a player before a read counts as a later one, not a first. */
export const READ_HANDS = 20;

/** Tags generic player `id` with `tag` (one of TAGS) after `hands` hands with them this session. */
export const tagPlayer = (q, id, tag, hands = 0) => (op({op: 'tagPlayer', q, id: String(id), tag: String(tag), hands}) ?? q);

/** The tag on generic player `id`, or null. */
export const tagOf = (q, id) => q.reads?.[id]?.tag ?? null;

/** A style guess from a player's rates (play-stats.js `rates`), or null with too few hands: {family, why}. */
export const suggestFamily = (r, minHands = 15) => op({op: 'suggestFamily', r: r || null, minHands}) ?? null;

/**
 * The session's review of the generic players you sat with: `people` is
 * [{id, hands, rates}] (rates from play-stats.js). Returns {rows, q}: rows
 * [{id, name, family, tag, right, guess}], and the quest with this
 * session's reads added to its accuracy and each first read cleared.
 */
export const reviewReads = (q, people) => op({op: 'reviewReads', q, people: people.map(p => ({id: String(p.id), hands: p.hands || 0, rates: p.rates || null}))});

/** "7 of 10 (70%)", or "none yet". */
export const accuracyText = s => op({op: 'accuracyText', s: s?.n ? s : null});

/**
 * How long a generic player takes to act, in ms: maniacs fast, stations
 * quick, grinders steady, rocks slow. Now and then anyone takes an odd
 * time, so it's a lean, never a rule. `rng` returns [0, 1).
 */
export const thinkMs = (family, rng = Math.random) => {
  const a = rng();
  return op({op: 'thinkMs', family: String(family), a, b: rng()});
};
