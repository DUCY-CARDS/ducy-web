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
//   players lean rock; a hoodie or sunglasses lean grinder, a cap or a
//   jersey lean loose; a jacket leans rock.
// - **Looks and names:** each person gets an avatar to fit their style (a
//   lean), then a first name and last initial to fit the avatar's gender and
//   age. Until the generic avatars of #305 are drawn, the looks are the
//   player avatars. Names are common, invented-for-the-table first names
//   with no cultural pools yet: those come with the drawn avatars.
//
// Pure, and the same for the same seed. A person's look and name come from
// their seed alone, so a bot id (`g-rock-123`) always shows the same person.

import { roll } from './quest-rooms.js';

export const FAMILIES = ['rock', 'station', 'maniac', 'grinder'];
export const FAMILY_NAMES = {rock: 'Rock', station: 'Calling station', maniac: 'Maniac', grinder: 'Grinder'};

// The player avatars as generic looks: gender (as drawn), age band, and the
// gear that's a clue to style.
export const LOOKS = [
  {avatar: 'player-01', gender: 'm', age: 'young', gear: 'hoodie'},
  {avatar: 'player-02', gender: 'm', age: 'older', gear: 'jacket'},
  {avatar: 'player-03', gender: 'f', age: 'young', gear: ''},
  {avatar: 'player-04', gender: 'm', age: 'middle', gear: ''},
  {avatar: 'player-05', gender: 'f', age: 'young', gear: ''},
  {avatar: 'player-06', gender: 'm', age: 'young', gear: 'cap'},
  {avatar: 'player-07', gender: 'f', age: 'older', gear: ''},
  {avatar: 'player-08', gender: 'f', age: 'middle', gear: ''},
  {avatar: 'player-09', gender: 'm', age: 'middle', gear: ''},
  {avatar: 'player-10', gender: 'f', age: 'middle', gear: ''},
  {avatar: 'player-11', gender: 'm', age: 'young', gear: 'sunglasses'},
  {avatar: 'player-12', gender: 'f', age: 'young', gear: ''},
  {avatar: 'player-13', gender: 'f', age: 'young', gear: 'jersey'},
  {avatar: 'player-14', gender: 'm', age: 'older', gear: 'jacket'},
  {avatar: 'player-15', gender: 'f', age: 'middle', gear: ''},
  {avatar: 'player-16', gender: 'm', age: 'young', gear: 'beanie'},
];

// First names by gender and age band: names common for that generation.
export const NAMES = {
  f: {
    young: ['Maya', 'Chloe', 'Priya', 'Sofia', 'Jasmine', 'Hannah', 'Leah', 'Nina', 'Zoe', 'Ava', 'Grace', 'Mia', 'Elena', 'Kayla', 'Tess', 'Lily', 'Ana', 'Jade', 'Rosa', 'Amara'],
    middle: ['Lisa', 'Michelle', 'Angela', 'Karen', 'Nicole', 'Tanya', 'Monica', 'Rachel', 'Denise', 'Carmen', 'Julie', 'Wendy', 'Sandra', 'Heather', 'Gina', 'Linda', 'Teresa', 'Mei', 'Dana', 'Paula'],
    older: ['Dorothy', 'Barbara', 'Joan', 'Shirley', 'Marilyn', 'Gloria', 'Betty', 'Ruth', 'Carol', 'Judy', 'Maria', 'Helen', 'Peggy', 'Irene', 'Rita', 'June', 'Vera', 'Lois', 'Edna', 'Nora'],
  },
  m: {
    young: ['Tyler', 'Jordan', 'Kevin', 'Marcus', 'Ethan', 'Dylan', 'Ryan', 'Andre', 'Luis', 'Nate', 'Jake', 'Omar', 'Sam', 'Eli', 'Owen', 'Raj', 'Cody', 'Leo', 'Dev', 'Mateo'],
    middle: ['Dave', 'Mike', 'Steve', 'Rob', 'Tony', 'Brian', 'Chris', 'Greg', 'Paul', 'Sal', 'Rick', 'Dan', 'Eddie', 'Manny', 'Jim', 'Hector', 'Ray', 'Vinny', 'Kenny', 'Frank'],
    older: ['Walt', 'Harold', 'Earl', 'Stan', 'Gene', 'Lou', 'Sid', 'Herb', 'Bernie', 'Al', 'Morris', 'Hank', 'Norm', 'Irv', 'Leon', 'Abe', 'Vern', 'Gus', 'Clyde', 'Murray'],
  },
};
const INITIALS = 'ABCDEFGHJKLMNPRSTVW';

// Style leans: each family's weight by kind of player, then multipliers for
// age, gear and a wild hour.
const KIND_WEIGHTS = {
  reg: {rock: 0.3, station: 0.15, maniac: 0.15, grinder: 0.4},
  tourist: {rock: 0.15, station: 0.45, maniac: 0.33, grinder: 0.07},
};
const GEAR_LEAN = {
  hoodie: {grinder: 2.2},
  sunglasses: {grinder: 2.2},
  beanie: {grinder: 1.4, maniac: 1.3},
  cap: {station: 1.7, maniac: 1.7},
  jersey: {station: 1.8, maniac: 1.6},
  jacket: {rock: 2.2},
};
const AGE_LEAN = {older: {rock: 2.4, maniac: 0.6}, middle: {}, young: {maniac: 1.3}};

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

// How likely a look is for a family: its gear and age leans.
const lookWeight = (look, family) => (GEAR_LEAN[look.gear]?.[family] ?? 1) * (AGE_LEAN[look.age]?.[family] ?? 1);

/** A person's look, from their family and seed: an avatar that leans to their style. */
export function lookFor(family, seed) {
  const weights = Object.fromEntries(LOOKS.map((l, i) => [i, lookWeight(l, family)]));
  return LOOKS[+pick(weights, roll(seed, 'look'))];
}

/** A person's name, from their look and seed: "Dave R.". */
export function nameFor(look, seed) {
  const list = NAMES[look.gender][look.age];
  const first = list[Math.floor(roll(seed, 'first') * list.length)];
  return `${first} ${INITIALS[Math.floor(roll(seed, 'initial') * INITIALS.length)]}.`;
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

/**
 * Everything shown about a generic player, from their bot id alone:
 * {id, family, seed, look, avatar, name, buyInBb}. Null for other ids.
 */
export function personOf(id) {
  const p = parseBotId(id);
  if (!p) return null;
  const look = lookFor(p.family, p.seed);
  return {id, family: p.family, seed: p.seed, look, avatar: look.avatar, name: nameFor(look, p.seed), buyInBb: usualBuyInBb(p.family, p.seed)};
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
