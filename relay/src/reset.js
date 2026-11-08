// Wiping a test relay's data (the sandbox: DEPLOY.md). POST /reset with
// "authorization: Bearer <RESET_TOKEN>" deletes every always-on club's room
// storage and then the registry's (grants, the admin log, error reports).
// Friends tables' rooms aren't listed anywhere; the most they hold is a
// queue of messages, kept 7 days.
//
// Only where RESETTABLE is "on" (wrangler.toml sets it for the sandbox
// alone) and a RESET_TOKEN secret of at least 32 characters is set; anywhere
// else /reset is "not found". The reset workflow (sandbox-reset.yml) sets a
// fresh random token each run, so no copy of it is kept.

export const MIN_TOKEN = 32;

/** Why a reset request is refused ({status, error}), or null to go ahead. */
export function resetRefusal(env, authorization, method = 'POST') {
  if (env?.RESETTABLE !== 'on') return {status: 404, error: 'not found'};
  const token = String(env.RESET_TOKEN || '');
  if (token.length < MIN_TOKEN) return {status: 403, error: 'No reset token is set.'};
  const given = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (!same(given, token)) return {status: 403, error: 'Wrong reset token.'};
  if (method !== 'POST') return {status: 405, error: 'A reset is a POST.'};
  return null;
}

/** The club codes in the registry's `clubs` record. */
export function clubCodes(clubs) {
  const codes = new Set();
  for (const [k, rec] of Object.entries(clubs || {})) codes.add(String(rec?.code || k));
  return [...codes];
}

// Compares in time that doesn't depend on where they differ.
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
