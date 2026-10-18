// Bankroll Quest's card rooms and their schedules (#301): made-up rooms,
// defined as data, whose games come and go with the hour and the day. The
// world is built from the quest's seed, so it's the same on every reload and
// different from someone else's. Times are game minutes (quest.js).

// Stakes, in hundredths: [small blind, big blind].
export const STAKES = {
  '1/2': [100, 200],
  '2/5': [200, 500],
  '5/10': [500, 1000],
  '10/20': [1000, 2000],
  '25/50': [2500, 5000],
  '50/100': [5000, 10000],
};

// The games the rooms spread: Hold'em, and pot-limit Omaha (four cards).
export const GAMES = {
  nlhe: {name: 'No-limit Hold’em', short: 'Hold’em'},
  plo4: {name: 'Pot-limit Omaha', short: 'PLO'},
};
export const gameOf = g => g.game || 'nlhe';
// A game's key for its dice and table ids: Hold'em's is its stakes, so worlds
// from before Omaha keep their Hold'em tables.
const gameKey = g => (gameOf(g) === 'nlhe' ? g.stakes : `${gameOf(g)} ${g.stakes}`);

// Each room spreads some games at some stakes (Hold'em unless `game` says
// otherwise): `tables` is how many run at its busiest, `chance` (when below
// 1) how often the game runs at all in an hour that could have it, and
// `when` the hours (and days) a big game can start.
export const ROOMS = [
  {
    id: 'deuce',
    name: 'Deuce Street Card Room',
    kind: 'A busy local room',
    games: [
      {stakes: '1/2', tables: 6},
      {stakes: '2/5', tables: 2},
      {stakes: '5/10', tables: 1, chance: 0.35},
      {stakes: '1/2', game: 'plo4', tables: 1, chance: 0.6},
    ],
  },
  {
    id: 'harbor',
    name: 'Copper Harbor Casino',
    kind: 'A mid-size casino',
    games: [
      {stakes: '2/5', tables: 3},
      {stakes: '5/10', tables: 2},
      {stakes: '10/20', tables: 1, chance: 0.6},
      {stakes: '2/5', game: 'plo4', tables: 2},
      {stakes: '5/10', game: 'plo4', tables: 1, chance: 0.5},
    ],
  },
  {
    id: 'ivory',
    name: 'The Ivory Room',
    kind: 'An elite room',
    minBuyIn: 50,
    maxBuyIn: 250,
    games: [
      {stakes: '10/20', tables: 1},
      {stakes: '25/50', tables: 1, chance: 0.5, when: 'evenings'},
      {stakes: '50/100', tables: 1, chance: 0.35, when: 'weekend-nights'},
      {stakes: '25/50', game: 'plo4', tables: 1, chance: 0.4, when: 'evenings'},
    ],
  },
];

// Game minutes it takes to get from one room to another.
export const TRAVEL_MINUTES = 30;
// Big games run in blocks of this many game hours once they start.
const BLOCK_HOURS = 4;

// How busy the rooms are, 0 to 1, by hour (0 midnight): quiet mornings,
// busier afternoons, busy evenings (0.8 on a weekday); Friday and Saturday
// nights busiest, and late on into the night.
const HOURLY = [0.36, 0.28, 0.2, 0.12, 0.08, 0.08, 0.08, 0.12, 0.16, 0.2, 0.28, 0.36,
  0.4, 0.44, 0.48, 0.48, 0.52, 0.56, 0.64, 0.72, 0.8, 0.8, 0.72, 0.56];
export function activity(day, hour) {
  const weekendNight = (day === 4 || day === 5) && (hour >= 18 || hour < 1);
  const lateWeekend = (day === 5 || day === 6) && hour >= 0 && hour < 4;
  let a = HOURLY[hour];
  if (weekendNight) a *= 1.25;
  if (lateWeekend) a = Math.max(a, 0.55);
  return Math.min(1, a);
}

// A number in [0, 1) from the seed and some keys: the world's dice.
export function roll(seed, ...keys) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const k of keys.join('|')) {
    h = Math.imul(h ^ k.charCodeAt(0), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

const inWindow = (when, day, hour) => {
  if (when === 'evenings') return hour >= 19 || hour < 2;
  if (when === 'weekend-nights') return (day === 4 || day === 5) && (hour >= 20 || hour < 3);
  return true;
};

// How many tables of a room's game run at game time `minutes`.
export function tablesRunning(seed, room, game, minutes) {
  const m = Math.floor(minutes);
  const day = Math.floor(m / 1440) % 7;
  const hour = Math.floor((m % 1440) / 60);
  const a = activity(day, hour);
  if (game.when || game.chance != null) {
    if (!inWindow(game.when, day, hour)) return 0;
    // A big game runs for a block of hours once it starts: one roll a block.
    const block = Math.floor(m / (60 * BLOCK_HOURS));
    const chance = (game.chance ?? 1) * (game.when ? 1 : a);
    if (roll(seed, room.id, gameKey(game), 'block', block) >= chance) return 0;
    return Math.max(1, Math.round(game.tables * a));
  }
  // A little noise an hour, so two Fridays aren't identical.
  const hourIndex = Math.floor(m / 60);
  const noise = 0.85 + 0.3 * roll(seed, room.id, gameKey(game), 'hour', hourIndex);
  return Math.max(a >= 0.2 ? 1 : 0, Math.round(game.tables * a * noise));
}

// Every room's games right now: [{room, stakes, game, blinds, tables}], with the
// rooms' tables numbered (`ids`, stable while a table runs).
export function lobby(seed, minutes) {
  return ROOMS.map(room => ({
    room,
    games: room.games
      .map(game => {
        const tables = tablesRunning(seed, room, game, minutes);
        const key = gameKey(game).replace(' ', '-');
        return {stakes: game.stakes, game: gameOf(game), blinds: STAKES[game.stakes], tables, ids: Array.from({length: tables}, (_, i) => `${room.id}-${key}-${i + 1}`)};
      })
      .filter(g => g.tables > 0),
  }));
}

// The smallest minimum buy-in anywhere: below it, a quest is broke.
export function cheapestBuyIn(minBb = 40) {
  return Math.min(...ROOMS.flatMap(r => r.games.map(g => (r.minBuyIn ?? minBb) * STAKES[g.stakes][1])));
}

export const roomById = id => ROOMS.find(r => r.id === id) || null;
