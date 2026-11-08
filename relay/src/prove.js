// Proving a connection holds its player ID's key (#577), as both relays do
// it: the Worker (worker.js) and the local relay (dev-server.mjs).
//
// A club connection (queue mode, or any connection to an always-on club's
// room) names a player ID. Until it proves it holds that ID's key it's no
// one: it gets nothing sent to that player, its messages are dropped, the
// club doesn't see it arrive, and it can't take the place of a connection
// that did prove. The relay sends {type: 'prove', challenge}; the page
// answers {type: 'prove', env}, env being {type: 'prove', room, challenge}
// signed with the player's key (identity.js); the relay says {type:
// 'proven'}, and only then does it count, replacing (4009) any other
// proven connection of the same player (their own other tab, or the page
// before a reload). Anyone who knows a player's ID can no longer knock
// them off.
//
// Friends tables' guests name a random client ID, not a player key, and
// aren't asked: they keep the old rule (a newer connection with the same
// ID wins). Their IDs are random and only the table's host sees them.

import { checkSignature } from '../../src/identity.js';

export const newChallenge = () => {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(24))) s += b.toString(16).padStart(2, '0');
  return s;
};

// Whether a connection naming player `id` in room `code` must prove it.
export const mustProve = ({queue, club}) => !!(queue || club);

// Whether message `m` proves the connection holds `id`'s key, for
// `challenge` in room `code`.
export async function proves(m, {id, code, challenge}) {
  const env = m?.type === 'prove' ? m.env : null;
  const b = env?.body;
  if (!b || env.from !== id || b.type !== 'prove' || b.room !== code || !challenge || b.challenge !== challenge) return false;
  return !(await checkSignature(env));
}
