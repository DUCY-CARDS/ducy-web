// A demo club's record (#406, demo.js), kept in this browser's own
// localStorage while the demo runs, and what belongs to it. Pure, so the
// tests run it in Node.
//
//   {id, scenario, setUp, people: [{key, name, id}], current, ending, resetting}
// `scenario` is the demo club it is (demo-scenarios.js), `setUp` whether
// that's been loaded into its club; `ending` and `resetting` ask the next
// page to delete it, or put it back to its start. It runs until End demo.

export const MANAGER = 'manager';
// What each person keeps in IndexedDB (identity.js, table-store.js, hand-store.js).
const PERSON_DBS = ['ducy', 'ducy-tables', 'ducy-hands'];

export const isOn = d => !!d && !d.ending;

export function newDemo(id, scenario = 'new') {
  return {id, scenario, setUp: false, people: [{key: MANAGER, name: 'Manager'}], current: MANAGER};
}

// The demo back at its scenario's start (Reset): the same session, the
// manager alone again (with a new identity), nothing set up.
export function resetDemo(d) {
  return newDemo(d.id, d.scenario);
}

// Where switching to person `p` ({key, id}) takes you, in demo club `club`
// (null before the manager makes one): the manager to the club manager;
// a member, an agent among them (#428), to the club's page; someone
// asking to join to their request; anyone else to the invite link.
//   {page: 'manager' | 'player', hash} or {page: 'invite'}
export function whereIs(club, p) {
  if (p.key === MANAGER) return {page: 'manager', hash: club ? 'clubs/own' : 'clubs'};
  const status = club?.members[p.id]?.status;
  if (status === 'member') return {page: 'player', hash: `clubs/c/${encodeURIComponent(club.code)}`};
  if (status === 'pending') return {page: 'player', hash: 'join'};
  return club ? {page: 'invite'} : {page: 'player', hash: 'clubs'};
}

// Where person `key` of demo `id` keeps localStorage and sessionStorage
// keys, and the suffix of their IndexedDB databases' names.
export const prefixOf = (id, key) => `ducyDemo:${id}:${key}:`;
export const dbSuffixOf = (id, key) => `@demo-${id}-${key}`;
export const relayDb = id => `ducyDemoRelay-${id}`;

// Everything of demo `d` in storage: its keys' prefix, and its databases
// (the club's, and each person's).
export function demoStorage(d) {
  return {
    prefix: `ducyDemo:${d.id}:`,
    dbs: [relayDb(d.id), ...d.people.flatMap(p => PERSON_DBS.map(n => `${n}${dbSuffixOf(d.id, p.key)}`))],
    isDemoDb: name => name === relayDb(d.id) || String(name).includes(`@demo-${d.id}-`),
  };
}
