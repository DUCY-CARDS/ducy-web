// The demo's starting points (#406): each scenario is a club state the demo
// begins in, as data, loaded into the in-page club (demo-relay.js setUp) when
// a demo starts. Later demos (a busy club with tables running and requests
// waiting, credit players, tournament night) are new entries here.
//
//   {id, name, club}
//   club: null      no club yet: the manager makes one through the real setup
//   club: {         or one already running (not used yet), owned by the manager:
//     name,
//     tables:  [{name, game, sb, bb, minBB, maxBB, seats}]    as club-tables.js newTable
//     players: [{name, kind: 'bot' | 'person', status: 'member' | 'pending',
//                balance, table (index into tables, to be seated there)}]
//                a 'person' is someone you can switch to; a 'bot' plays itself
//     requests: [{player (index), amount}]                   chip requests waiting
//   }

export const SCENARIOS = [
  {id: 'new', name: 'Brand new club', club: null},
];

export const scenarioById = id => SCENARIOS.find(s => s.id === id) || SCENARIOS[0];
