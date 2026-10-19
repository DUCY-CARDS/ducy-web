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
//   and age. Who a room gets follows its region (REGION_MIX).
//
// Pure, and the same for the same seed. A person's look and name come from
// their seed alone, so a bot id (`g-rock-123`) always shows the same person.

import { ROOMS, regionOf, roll } from './quest-rooms.js';
import { backgroundOf, baseFor, faceUrl, lookFor, nameFor } from './quest-faces.js';

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

// ---- Who you meet where ----
// The backgrounds of the people in each region's rooms, roughly as its
// card rooms look: Texas mostly white and Mexican-American, some Black
// players, a few Indian and Asian; Los Angeles more mixed; Miami heavily
// Hispanic.
export const REGION_MIX = {
  tx: {white: 0.47, hispanic: 0.31, black: 0.13, southasian: 0.04, eastasian: 0.04, mideast: 0.01},
  la: {white: 0.27, hispanic: 0.3, eastasian: 0.22, black: 0.09, mideast: 0.07, southasian: 0.05},
  fl: {hispanic: 0.42, white: 0.34, black: 0.17, southasian: 0.03, eastasian: 0.03, mideast: 0.01},
};

// And within a background, which name pools (quest-faces.js): white Texans
// mostly have English (Anglo) names; Black players are mostly
// African-American (English-named), now and then Nigerian.
export const POOL_MIX = {
  tx: {white: {english: 0.72, irish: 0.12, italian: 0.07, polish: 0.05, greek: 0.04}, black: {english: 0.88, nigerian: 0.12}},
  la: {white: {english: 0.52, irish: 0.1, italian: 0.16, polish: 0.08, greek: 0.14}, black: {english: 0.85, nigerian: 0.15}},
  fl: {white: {english: 0.56, irish: 0.1, italian: 0.2, polish: 0.08, greek: 0.06}, black: {english: 0.8, nigerian: 0.2}},
};

const weighted = (weights, r) => {
  const entries = Object.entries(weights);
  let x = r * entries.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of entries) if ((x -= w) < 0) return k;
  return entries.at(-1)[0];
};

/**
 * A person for room `roomId` from `keys`: their seed, chosen so they come
 * from a background the room's region has (REGION_MIX), with `familyOf(s)`
 * their style. A person's looks still come from their id alone; only which
 * id the room gets is chosen.
 */
function localPerson(roomId, familyOf, ...keys) {
  const region = regionOf(ROOMS.find(r => r.id === roomId))?.id;
  const first = seedFrom(...keys);
  const mix = REGION_MIX[region];
  if (!mix) return {seed: first, family: familyOf(first)};
  const want = weighted(mix, roll(first, 'background'));
  const pools = POOL_MIX[region]?.[want];
  const pool = pools ? weighted(pools, roll(first, 'pool')) : null;
  for (let k = 0; k < 120; k++) {
    const s = k ? seedFrom(...keys, 'local', k) : first;
    const family = familyOf(s);
    const base = baseFor(family, s);
    if (backgroundOf(base) === want && (!pool || base.pool === pool)) return {seed: s, family};
  }
  return {seed: first, family: familyOf(first)};
}

// ---- Regs and tourists ----

/** Regs on each room's roster. */
export const ROSTER_SIZE = 40;

/**
 * A room's regs: [{id, home, level}], the same for a world's `seed`. `level`
 * is the stakes they usually play: 'low' (1/2, 2/5) or 'mid' (5/10, 10/20);
 * a third of them play mid.
 */
const rosters = new Map();
export function roster(seed, roomId) {
  // The same every time: worked out once (finding local faces takes a few tries).
  const key = `${seed}|${roomId}`;
  if (rosters.has(key)) return rosters.get(key);
  if (rosters.size > 64) rosters.clear();
  const out = [];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    const {seed: s, family} = localPerson(roomId, x => familyFor('reg', 0, roll(x, 'family')), seed, roomId, 'reg', i);
    out.push({id: botIdOf(family, s), home: roomId, level: roll(s, 'level') < 1 / 3 ? 'mid' : 'low'});
  }
  rosters.set(key, out);
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

/**
 * A tourist: made for a room, a game day and a slot, and gone after that
 * day. `family` gives them that style (the table asked for one), otherwise
 * it's the tourists' usual mix.
 */
export function tourist(seed, roomId, day, slot, minutes, family = null) {
  const p = localPerson(roomId, x => family || familyFor('tourist', wildness(minutes), roll(x, 'family')), seed, roomId, 'tourist', day, slot);
  return botIdOf(p.family, p.seed);
}
