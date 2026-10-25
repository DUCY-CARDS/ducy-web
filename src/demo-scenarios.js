// The demo clubs (#406): each scenario is the club state a demo begins in,
// as data, loaded into the in-page club (demo-relay.js setUp) when it
// starts, and again on Reset. A new demo club is a new entry here.
//
//   {id, name, club}
//   club: null      no club yet: the manager makes one through the real setup
//   club: {         or one already going, run by the demo's manager:
//     name,
//     tables:  [{name, game, sb, bb, minBB, maxBB, seats}]   as club-tables.js newTable
//     people:  [{name, status, balance, ask, register}]       people you can switch to
//     bots:    [{status, balance, table, ask, help, register}]  members the demo plays
//     tourney: {name, buyIn, stack, structure, startsIn (ms), …}     as club-tourneys.js newTourney
//     promo:   {kind: 'high_hand', …}                                as club-promos.js newPromo
//     sessions: [{table, ago, seats: [{name | bot, buyIn, cashOut}]}]  table sessions already played
//   }
// status: 'member' (the default) or 'pending' (asking to join); balance:
// club chips (hundredths) once let in; credit: a credit limit (#404); table:
// the index of the table a bot sits at (buying in for its maximum); ask:
// chips asked for; help: a help request; register: entered in the
// tournament. Each bot is one of Bankroll Quest's players, with their name
// and face, picked for its table's stakes (demo-bots.js, #415). A session's
// seat is a person (`name`) or a bot (`bot`, its index).

// `n` bots, the i-th from `each(i)`.
const bots = (n, each) => Array.from({length: n}, (_, i) => each(i));

// Balances that vary but are the same every time: 0 to 1,500 chips.
const balance = i => ((i * 7919) % 31) * 5000;

const NLH = {game: 'nlhe', minBB: 40, maxBB: 100};

export const SCENARIOS = [
  {id: 'new', name: 'A brand new club', club: null},
  {
    id: 'busy', name: 'A busy club',
    club: {
      name: 'Riverside Poker',
      tables: [
        {...NLH, name: 'Main 1/2', sb: 100, bb: 200, seats: 9},
        {name: 'Omaha 1/2', game: 'plo4', sb: 100, bb: 200, minBB: 40, maxBB: 100, seats: 6},
        {...NLH, name: 'High 5/10', sb: 500, bb: 1000, seats: 6},
      ],
      people: [
        {name: 'Player 1', balance: 50_000},
        {name: 'Player 2', balance: 0, ask: 20_000},
        {name: 'Player 3', status: 'pending'},
      ],
      // 42 members: 13 at the tables, 3 asking to join, 2 asking for chips,
      // 1 asking for help, 12 registered for Sunday's tournament.
      bots: bots(42, i => ({
        balance: balance(i),
        ...(i < 6 ? {table: 0} : i < 10 ? {table: 1} : i < 13 ? {table: 2} : {}),
        ...(i >= 39 ? {status: 'pending'} : {}),
        ...(i === 13 || i === 14 ? {ask: 10_000} : {}),
        ...(i === 15 ? {help: 'Can I move to the Omaha table?'} : {}),
        ...(i >= 16 && i < 28 ? {register: true, balance: balance(i) + 5_000} : {}),
      })),
      tourney: {
        name: 'Sunday Freezeout', game: 'nlhe', buyIn: 5_000, stack: 1500, startsIn: 3600e3, minPlayers: 2, maxPlayers: 60, tableSize: 9,
        structure: [{sb: 10, bb: 20, minutes: 10}, {sb: 20, bb: 40, minutes: 10}, {sb: 50, bb: 100, minutes: 10}, {sb: 100, bb: 200, minutes: 10}],
      },
      promo: {kind: 'high_hand', name: 'Hourly high hand', games: ['nlhe'], every: 'hour', prizes: [5_000], minCategory: 'pair', minPlayers: 2, tz: 0},
    },
  },
  {
    id: 'tourney', name: 'Tournament night',
    club: {
      name: 'Thursday Night Poker',
      tables: [{...NLH, name: 'Cash 1/2', sb: 100, bb: 200, seats: 6}],
      people: [
        {name: 'Player 1', balance: 20_000, register: true},
        {name: 'Player 2', balance: 10_000},
        {name: 'Player 3', status: 'pending'},
      ],
      bots: bots(17, () => ({balance: 10_000, register: true})),
      // Starts on its own 3 minutes after the demo opens; late entry to level 3.
      tourney: {
        name: 'Thursday Turbo', game: 'nlhe', buyIn: 2_000, stack: 1500, startsIn: 3 * 60e3, minPlayers: 2, maxPlayers: 30, tableSize: 6, lateLevel: 3,
        structure: [{sb: 10, bb: 20, minutes: 2}, {sb: 20, bb: 40, minutes: 2}, {sb: 50, bb: 100, minutes: 2}, {break: true, minutes: 1},
          {sb: 100, bb: 200, minutes: 2}, {sb: 200, bb: 400, minutes: 2}, {sb: 500, bb: 1000, minutes: 2}, {sb: 1000, bb: 2000, minutes: 2}],
      },
    },
  },
  {
    // Credit players (#404): sitting on credit, asking at the limit, and
    // settling a debt.
    id: 'credit', name: 'Credit players',
    club: {
      name: 'Friday Night Club',
      tables: [{...NLH, name: 'Main 1/2', sb: 100, bb: 200, seats: 6}],
      people: [
        // No chips of their own: sits on credit, up to 500.
        {name: 'Player 1', credit: 50_000},
        // At their limit: asks for 400 with 200 of credit.
        {name: 'Player 2', credit: 20_000, ask: 40_000},
        // Stood up owing 200 (the session below).
        {name: 'Player 3', credit: 20_000},
      ],
      bots: bots(5, i => ({balance: 20_000, ...(i < 3 ? {table: 0} : {})})),
      // A table session played before the demo starts: each seat's buy-in
      // and what they stood up with (adding up), `ago` ms back.
      sessions: [{table: 0, ago: 3600e3, seats: [{name: 'Player 3', buyIn: 20_000, cashOut: 0}, {bot: 3, buyIn: 20_000, cashOut: 40_000}]}],
    },
  },
];

export const scenarioById = id => SCENARIOS.find(s => s.id === id) || SCENARIOS[0];

// What a demo club's list shows of it: its members and tables.
export function scenarioFacts(s) {
  const c = s.club;
  if (!c) return '';
  const members = (c.bots || []).filter(b => b.status !== 'pending').length + c.people.filter(p => p.status !== 'pending').length;
  const parts = [`${members} members`, `${c.tables.length} ${c.tables.length === 1 ? 'table' : 'tables'}`];
  if (c.tourney) parts.push('a tournament');
  return parts.join(' · ');
}
