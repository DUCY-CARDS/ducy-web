// Bankroll Quest's card rooms and their schedules (#301): made-up rooms in
// three regions (Texas, Los Angeles, Florida), defined as data, whose games
// come and go with the hour and the day. The
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

// Where the rooms are: regions you can put down roots in, each with a small
// town (where a run starts, with a few small games) and bigger cities.
export const REGIONS = [
  {
    id: 'tx', name: 'Texas', blurb: 'Small-town card rooms, then the clubs of Austin and Houston.',
    cities: [{id: 'mesquite', name: 'Mesquite Flats', small: true}, {id: 'austin', name: 'Austin'}, {id: 'houston', name: 'Houston'}],
  },
  {
    id: 'la', name: 'Los Angeles', blurb: 'A desert card club first, then LA’s big rooms and the Ivory Room.',
    cities: [{id: 'cactus', name: 'Cactus Wells', small: true}, {id: 'losangeles', name: 'Los Angeles'}],
  },
  {
    id: 'fl', name: 'Florida', blurb: 'A quiet key, then the casinos of Miami.',
    cities: [{id: 'palmetto', name: 'Palmetto Key', small: true}, {id: 'miami', name: 'Miami'}],
  },
];

// Each room spreads some games at some stakes (Hold'em unless `game` says
// otherwise): `tables` is how many run at its busiest, `chance` (when below
// 1) how often the game runs at all in an hour that could have it, and
// `when` the hours (and days) a big game can start. `city` is where it is.
// Room ids have no dashes: a table id starts with its room's.
export const ROOMS = [
  {
    id: 'deuce',
    city: 'austin',
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
    city: 'miami',
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
    city: 'losangeles',
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
  // The small towns: a run starts here, with a few small games.
  {
    id: 'mesquite',
    city: 'mesquite',
    name: 'Mesquite Flats Card Room',
    kind: 'A small-town card room',
    games: [
      {stakes: '1/2', tables: 2},
      {stakes: '2/5', tables: 1, chance: 0.3},
      {stakes: '1/2', game: 'plo4', tables: 1, chance: 0.25},
    ],
  },
  {
    id: 'cactus',
    city: 'cactus',
    name: 'Cactus Wells Card Club',
    kind: 'A small-town card club',
    games: [
      {stakes: '1/2', tables: 2},
      {stakes: '2/5', tables: 1, chance: 0.3},
    ],
  },
  {
    id: 'palmetto',
    city: 'palmetto',
    name: 'Palmetto Key Poker Room',
    kind: 'A small-town poker room',
    games: [
      {stakes: '1/2', tables: 2},
      {stakes: '1/2', game: 'plo4', tables: 1, chance: 0.4},
    ],
  },
  // More rooms in the cities.
  {
    id: 'bayou',
    city: 'houston',
    name: 'Bayou City Poker Club',
    kind: 'A big city club',
    games: [
      {stakes: '2/5', tables: 3},
      {stakes: '5/10', tables: 2},
      {stakes: '10/20', tables: 1, chance: 0.5},
      {stakes: '25/50', tables: 1, chance: 0.3, when: 'evenings'},
      {stakes: '5/10', game: 'plo4', tables: 1, chance: 0.4},
    ],
  },
  {
    id: 'sunset',
    city: 'losangeles',
    name: 'Sunset Grove Card Club',
    kind: 'A huge card club',
    games: [
      {stakes: '1/2', tables: 5},
      {stakes: '2/5', tables: 3},
      {stakes: '5/10', tables: 2},
      {stakes: '2/5', game: 'plo4', tables: 1},
    ],
  },
];

// Game minutes to get from one room to another: across town, to another
// city in the region (2 hours), or to another region (6 hours). The clock
// runs four times real time, so that's 1½, 30 and 90 real minutes. A trip
// can't be skipped, but it runs on the game clock: you can play elsewhere,
// study or close the page, and you're there when the clock says so.
export const TRAVEL = {town: 6, region: 120, far: 360};

const cityById = id => REGIONS.flatMap(r => r.cities.map(c => ({...c, region: r}))).find(c => c.id === id) || null;
/** A room's city: {id, name, small, region}. */
export const cityOf = room => cityById(room?.city);
/** A room's region. */
export const regionOf = room => cityOf(room)?.region || null;
/** The room a run starts in, in region `regionId`: its small town's. */
export const startRoom = regionId => {
  const town = REGIONS.find(r => r.id === regionId)?.cities.find(c => c.small);
  return ROOMS.find(r => r.city === town?.id) || null;
};

/** How far room `to` is from room `from`: 'town', 'region', 'far', or null for the same room. */
export function tripKind(from, to) {
  if (!from || !to || from.id === to.id) return null;
  if (from.city === to.city) return 'town';
  return regionOf(from)?.id === regionOf(to)?.id ? 'region' : 'far';
}

/** Game minutes from room `from` to room `to` (both rooms). */
export const travelMinutes = (from, to) => TRAVEL[tripKind(from, to)] ?? 0;

// ---- What life on the road costs (#351), in hundredths ----
// A trip: across town is free, another city is gas, another region airfare.
export const TRIP_COST = {town: 0, region: 4000, far: 30000};
// Moving home: to another city in the region, or to another region.
export const MOVE_COST = {region: 50000, far: 200000};
// A night in a hotel, by the size of the place.
export const HOTEL = {small: 8000, city: 15000};

/** What the trip from room `from` to room `to` costs. */
export const tripCost = (from, to) => TRIP_COST[tripKind(from, to)] ?? 0;
/** A hotel night where room `room` is. */
export const hotelCost = room => (cityOf(room)?.small ? HOTEL.small : HOTEL.city);
/** What moving home from city `fromCity` (an id) to room `room`'s city costs, or 0 if it's already home. */
export function moveCost(fromCity, room) {
  const to = cityOf(room);
  if (!to || to.id === fromCity) return 0;
  return cityById(fromCity)?.region.id === to.region.id ? MOVE_COST.region : MOVE_COST.far;
}
/** The city a quest calls home: where it moved to, else its region's small town. */
export const homeCityOf = q => q.homeCity || startRoom(q.home)?.city || null;
/** A city by id: {id, name, small, region}. */
export const cityNamed = id => cityById(id);
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
