// A demo club's record (#406, demo.js), kept in this browser's own
// localStorage while the demo runs, and what belongs to it. Pure, so the
// tests run it in Node.
//
//   {id, scenario, setUp, endsAt, people: [{key, name, id}], current, ending, resetting}
// `scenario` is where it starts (demo-scenarios.js), `setUp` whether that's
// been loaded into its club; `ending` and `resetting` ask the next page to
// delete it, or put it back to its start.

export const DEMO_MS = 2 * 3600e3;
export const MANAGER = 'manager';
// What each person keeps in IndexedDB (identity.js, table-store.js, hand-store.js).
const PERSON_DBS = ['ducy', 'ducy-tables', 'ducy-hands'];

export const isOn = (d, now = Date.now()) => !!d && !d.ending && now < d.endsAt;

export function newDemo(id, scenario = 'new', now = Date.now()) {
  return {id, scenario, setUp: false, endsAt: now + DEMO_MS, people: [{key: MANAGER, name: 'Manager'}], current: MANAGER};
}

// The demo back at its scenario's start (Reset): the same session and clock,
// the manager alone again (with a new identity), nothing set up.
export function resetDemo(d) {
  return {id: d.id, scenario: d.scenario, setUp: false, endsAt: d.endsAt, people: [{key: MANAGER, name: 'Manager'}], current: MANAGER};
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
