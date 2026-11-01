// The manager's commands that only change the club (#456): ducy-play's club
// host (clubHost, from ducy-wasm) runs them over the whole club and says
// what each means for everyone else: replies to send, accounts to update,
// and what members online should hear again. club-server.js carries that
// out; commands that drive a running table or tournament stay with it.
//
// The club stays a plain object here: what comes back is put into the same
// objects (members, tournaments, payout tables, promotions and awards keep
// their identity). A refusal throws an Error with the host's message, and
// nothing changes.
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';
import { startMoney } from './club-money.js';

// The commands the club host runs.
export const HOSTED = new Set([
  'approve', 'decline', 'remove', 'revoke_invite', 'give', 'take', 'grant', 'deny', 'set_credit', 'raise_credit',
  'offer_agent', 'revoke_agent', 'assign_agent', 'help_answer', 'settings', 'set_info', 'set_payout',
  'add_payout_table', 'edit_payout_table', 'delete_payout_table', 'set_payout_table',
  'new_promo', 'edit_promo', 'promo_status', 'approve_award', 'void_award', 'promos',
  'new_tourney', 'cancel_tourney', 'set_must_move', 'list_remove', 'offer_game', 'remove_offer',
]);

// The club's fields a command may change.
const WRITES = ['invite', 'help', 'info', 'money', 'requestLog', 'log', 'ratholeHours', 'sitOutMins', 'stayHands', 'keepDays', 'codeJoin', 'groups', 'lists', 'waitlist', 'menu', 'interest', 'interestTried'];

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// Each of `from` made like the same id's in `list`, keeping the objects.
const byId = (list, from) => {
  const had = new Map((list || []).map(x => [x.id, x]));
  return (from || []).map(x => (had.has(x.id) ? merge(had.get(x.id), x) : x));
};

function apply(club, out) {
  merge(club.members, out.members);
  for (const k of WRITES) {
    if (out[k] === undefined || out[k] === null) delete club[k];
    else club[k] = out[k];
  }
  Object.assign(club.chips ??= {}, out.chips);
  // Lists a club has had, or now has something in.
  for (const k of ['tourneys', 'payoutTables']) {
    if (club[k] || out[k]?.length) club[k] = byId(club[k], out[k]);
  }
  if (!club.promos && !out.promos?.list?.length) return;
  const p = (club.promos ??= {});
  const {list, awards, ...rest} = out.promos || {};
  const keep = {list: byId(p.list, list), awards: byId(p.awards, awards)};
  merge(p, {...rest, list: [], awards: []});
  Object.assign(p, keep);
}

// Runs command `op` with `args` on `club`. Returns what it did: {value,
// replies, accounts, tell, tablesTo, helpTo, armPromos, schedule (new
// tournaments to time), stopTourneys (cancelled ones to stop), listsTo
// (members whose waitlists changed)}. Besides the
// manager's commands, a member's own 'register' and 'unregister' {tid, id}
// for a tournament run here too. Throws why not.
export function command(club, op, args = {}, now = Date.now()) {
  if (!club.money) startMoney(club, now);
  const r = ducy.clubHost(JSON.stringify(club), op, JSON.stringify(args ?? {}), now);
  if (!r.ok) throw new Error(r.message);
  apply(club, r.club);
  return r.value;
}
