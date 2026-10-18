// The Bankroll Challenge's generic players (#302, #305): the regs and
// tourists of the card rooms, played by ducy's generic bots (ducy-play
// generic.rs, #256), which seat by the id `g-<family>-<seed>`.
//
// - **Families:** rock, calling station, maniac, grinder.
// - **Regs** are a room's familiar faces: a roster per room, the same in
//   every reload of a world (its seed). Each has a home room, where they
//   play most of their sessions, and the stakes they usually play.
// - **Tourists** pass through: one is made for a room and a game day, and is
//   never seen after that day.
// - **Leans, never rules:** regs are more often grinders or rocks, tourists
//   more often stations or maniacs; late weekend nights run wilder; older
//   players lean rock; headphones, a hoodie or sunglasses lean grinder, a
//   cap or a tourist shirt lean loose; a jacket leans rock.
// - **Looks and names** (quest-faces.js, #305): each person is drawn from
//   one of 60 hand-set bases with their own hairstyle, clothes and gear,
//   leaning to their style, and named from that base's name pool, gender
//   and age.
//
// Pure, and the same for the same seed. A person's look and name come from
// their seed alone, so a bot id (`g-rock-123`) always shows the same person.

import { roll } from './quest-rooms.js';
import { faceUrl, lookFor, nameFor } from './quest-faces.js';

export { lookFor, nameFor };

export const FAMILIES = ['rock', 'station', 'maniac', 'grinder'];
export const FAMILY_NAMES = {rock: 'Rock', station: 'Calling station', maniac: 'Maniac', grinder: 'Grinder'};

// Style leans: each family's weight by kind of player, then multipliers for
// age, gear and a wild hour.
const KIND_WEIGHTS = {
  reg: {rock: 0.3, station: 0.15, maniac: 0.15, grinder: 0.4},
  tourist: {rock: 0.15, station: 0.45, maniac: 0.33, grinder: 0.07},
};

const pick = (weights, r) => {
  const entries = Object.entries(weights);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let x = r * total;
  for (const [k, w] of entries) {
    if ((x -= w) < 0) return k;
  }
  return entries.at(-1)[0];
};

/**
 * A family for a new player: `kind` 'reg' or 'tourist', `wild` 0 to 1 (how
 * late and how much of a weekend it is), `r` a number in [0, 1).
 */
export function familyFor(kind, wild, r) {
  const w = {...KIND_WEIGHTS[kind]};
  w.maniac *= 1 + wild;
  w.station *= 1 + wild / 2;
  w.rock *= 1 - wild / 2;
  return pick(w, r);
}

/** The bot id that seats a person: `g-<family>-<seed>`. */
export const botIdOf = (family, seed) => `g-${family}-${seed}`;

/** A generic bot id's family and seed, or null for any other id. */
export function parseBotId(id) {
  const m = /^g-(rock|station|maniac|grinder)-(\d+)$/.exec(String(id));
  return m ? {family: m[1], seed: +m[2]} : null;
}

/** Whether `id` seats a generic player. */
export const isGeneric = id => !!parseBotId(id);

const people = new Map();
/**
 * Everything shown about a generic player, from their bot id alone:
 * {id, family, seed, look, avatar, name, buyInBb}, `avatar` an image URL of
 * their drawn face (quest-faces.js). Null for other ids.
 */
export function personOf(id) {
  if (people.has(id)) return people.get(id);
  const p = parseBotId(id);
  if (!p) return null;
  const look = lookFor(p.family, p.seed);
  const person = {id, family: p.family, seed: p.seed, look, avatar: faceUrl(look, id), name: nameFor(look, p.seed), buyInBb: usualBuyInBb(p.family, p.seed)};
  if (people.size > 2000) people.clear();
  people.set(id, person);
  return person;
}

// A player's usual buy-in in big blinds: stations and rocks often short,
// grinders around 100, maniacs deep.
const BUY_INS = {rock: [60, 100, 100], station: [40, 60, 100], maniac: [100, 150, 200], grinder: [100, 100, 150]};
export function usualBuyInBb(family, seed) {
  const list = BUY_INS[family];
  return list[Math.floor(roll(seed, 'buyin') * list.length)];
}

const seedFrom = (...keys) => Math.floor(roll(...keys) * 2 ** 31) + 1;

// ---- Regs and tourists ----

/** Regs on each room's roster. */
export const ROSTER_SIZE = 40;

/**
 * A room's regs: [{id, home, level}], the same for a world's `seed`. `level`
 * is the stakes they usually play: 'low' (1/2, 2/5) or 'mid' (5/10, 10/20);
 * a third of them play mid.
 */
export function roster(seed, roomId) {
  const out = [];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    const s = seedFrom(seed, roomId, 'reg', i);
    const family = familyFor('reg', 0, roll(s, 'family'));
    out.push({id: botIdOf(family, s), home: roomId, level: roll(s, 'level') < 1 / 3 ? 'mid' : 'low'});
  }
  return out;
}

/** Whether bot id `id` is a reg of any of `roomIds`' rosters in world `seed`. */
export function isReg(seed, roomIds, id) {
  return roomIds.some(r => roster(seed, r).some(p => p.id === id));
}

/**
 * How wild the games are at game time `minutes`, 0 to 1: late on Friday
 * and Saturday nights most, weekday afternoons least.
 */
export function wildness(minutes) {
  const m = Math.floor(minutes);
  const day = Math.floor(m / 1440) % 7;
  const hour = Math.floor((m % 1440) / 60);
  const weekendNight = ((day === 4 || day === 5) && hour >= 20) || ((day === 5 || day === 6) && hour < 4);
  if (weekendNight) return 1;
  if (hour >= 22 || hour < 4) return 0.6;
  if (hour >= 18) return 0.4;
  return 0.1;
}

/**
 * The share of seats at low stakes that tourists take at game time
 * `minutes`: most on a weekend evening, fewest on a weekday afternoon.
 */
export function touristShare(minutes) {
  const m = Math.floor(minutes);
  const day = Math.floor(m / 1440) % 7;
  const hour = Math.floor((m % 1440) / 60);
  const weekend = day >= 4 && !(day === 4 && hour < 17);
  const evening = hour >= 17 || hour < 3;
  if (weekend && evening) return 0.7;
  if (!weekend && hour >= 9 && hour < 17) return 0.3;
  return evening ? 0.55 : 0.45;
}

/** A tourist: made for a room, a game day and a slot, and gone after that day. */
export function tourist(seed, roomId, day, slot, minutes) {
  const s = seedFrom(seed, roomId, 'tourist', day, slot);
  return botIdOf(familyFor('tourist', wildness(minutes), roll(s, 'family')), s);
}
