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
// Pure: play.js keeps the quest and calls these.

import { FAMILIES, FAMILY_NAMES, personOf } from './quest-people.js';

export const TAGS = [...FAMILIES, 'unsure'];
export const TAG_NAMES = {...FAMILY_NAMES, unsure: 'Not sure yet'};
/** Hands with a player before a read counts as a later one, not a first. */
export const READ_HANDS = 20;

/**
 * Tags generic player `id` with `tag` (one of TAGS) after `hands` hands
 * with them this session. The first real tag (not 'unsure') made before
 * READ_HANDS hands is kept as the session's first read.
 */
export function tagPlayer(q, id, tag, hands = 0) {
  if (!TAGS.includes(tag) || !personOf(id)) return q;
  const old = q.reads?.[id] || {};
  const first = old.first ?? (tag !== 'unsure' && hands < READ_HANDS ? tag : undefined);
  const read = {...old, tag, at: hands, ...(first ? {first} : {})};
  return {...q, reads: {...(q.reads || {}), [id]: read}};
}

/** The tag on generic player `id`, or null. */
export const tagOf = (q, id) => q.reads?.[id]?.tag ?? null;

/**
 * A style guess from a player's rates (play-stats.js `rates`), or null
 * with too few hands: {family, why}.
 */
export function suggestFamily(r, minHands = 15) {
  if (!r || r.hands < minHands || r.vpip.v == null) return null;
  const vpip = r.vpip.v, pfr = r.pfr.v ?? 0;
  const af = r.af.v == null ? 1 : r.af.v;
  const pctText = x => `${Math.round(x * 100)}%`;
  if (vpip < 0.16) return {family: 'rock', why: `played only ${pctText(vpip)} of hands`};
  if (vpip >= 0.3 && (pfr >= 0.22 || af >= 2.5)) return {family: 'maniac', why: `played ${pctText(vpip)} of hands and raised ${pctText(pfr)}`};
  if (vpip >= 0.3) return {family: 'station', why: `played ${pctText(vpip)} of hands and rarely raised`};
  return {family: 'grinder', why: `played ${pctText(vpip)} of hands and raised ${pctText(pfr)}`};
}

/**
 * The session's review of the generic players you sat with: `people` is
 * [{id, hands, rates}] (rates from play-stats.js). Returns {rows, q}:
 * rows [{id, name, family, tag, right, guess}] (`guess` for the untagged:
 * what their hands suggested), and the quest with this session's reads
 * added to its accuracy (q.readStats: {first: {n, right}, later: {n,
 * right}}) and each player's first read cleared for next time.
 */
export function reviewReads(q, people) {
  const stats = {first: {n: 0, right: 0}, later: {n: 0, right: 0}, ...(q.readStats || {})};
  const first = {...stats.first}, later = {...stats.later};
  const reads = {...(q.reads || {})};
  const rows = [];
  for (const {id, hands, rates} of people) {
    const p = personOf(id);
    if (!p) continue;
    const read = reads[id] || {};
    const tag = read.tag && read.tag !== 'unsure' ? read.tag : null;
    if (read.first) {
      first.n += 1;
      first.right += +(read.first === p.family);
    }
    if (tag && hands >= READ_HANDS) {
      later.n += 1;
      later.right += +(tag === p.family);
    }
    if (read.first) reads[id] = {...read, first: undefined};
    rows.push({id, name: p.name, family: p.family, tag, right: tag ? tag === p.family : null, guess: tag ? null : suggestFamily(rates)});
  }
  return {rows, q: {...q, reads, readStats: {first, later}}};
}

/** "7 of 10 (70%)", or "none yet". */
export function accuracyText(s) {
  return s?.n ? `${s.right} of ${s.n} (${Math.round((100 * s.right) / s.n)}%)` : 'none yet';
}

/**
 * How long a generic player takes to act, in ms: maniacs fast, stations
 * quick, grinders steady, rocks slow. Now and then anyone takes an odd
 * time, so it's a lean, never a rule. `rng` returns [0, 1).
 */
export function thinkMs(family, rng = Math.random) {
  if (rng() < 0.15) return 400 + rng() * 1200;
  switch (family) {
    case 'maniac': return 350 + rng() * 300;
    case 'station': return 450 + rng() * 350;
    case 'grinder': return 850 + rng() * 200;
    case 'rock': return 1100 + rng() * 800;
    default: return 650;
  }
}
