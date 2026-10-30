// A club table's seats (#456): ducy-play's club_seats (clubSeats, from
// ducy-wasm) says what each result from a table's runner means for the club:
// chips people left with or the table handed back, the engine's stacks
// between hands, who the manager is removing or moving, the hit-and-run
// count, and chip requests. club-host.js carries out what it says.
//
// `seating`: what the club keeps on a running table between results
// ({players, complete, handNumber, playersIn, recorded, saved, stay, asking,
// removed, leaving, moves}), a plain object club-host.js keeps; each call
// updates it in place, and the club as club-commands.js does.
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';
import { startMoney } from './club-money.js';

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// A table's seating before its first result.
export const newSeating = () => ({players: [], complete: true, handNumber: 0, playersIn: 0, recorded: 0, saved: null, stay: {}, asking: [], removed: [], leaving: [], moves: {}});

// Runs `op` ('result', 'standUp', 'leaveToMove', 'tooShort') for table `tid`
// with `args`. Returns the step: {sends: [{to, update}], events (for the
// runner; a cmd without `online`), chipsChanged, onPlay, onHand, save,
// tablesChanged, armHolds, value}. Throws why not, and nothing changes.
export function seats(club, seating, tid, op, args = {}, now = Date.now()) {
  if (!club.money) startMoney(club, now);
  const r = ducy.clubSeats(JSON.stringify(club), JSON.stringify(seating), tid, op, JSON.stringify(args), now);
  if (!r.ok) throw new Error(r.message);
  merge(club.members, r.club.members);
  club.money = r.club.money;
  Object.assign(club.chips ??= {}, r.club.chips);
  club.log = r.club.log;
  club.waitlist = r.club.waitlist;
  Object.assign(seating, r.seating);
  return r.value;
}
