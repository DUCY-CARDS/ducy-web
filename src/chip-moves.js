// Which club messages move chips (#575): they need a passkey unlock from the
// last few minutes. The relay checks (relay/src/unlock.js); the page asks
// for the passkey first, so they aren't refused (clubs.js).

// Owner commands that move chips, or change who may.
export const CHIP_OPS = new Set([
  'give', 'take', 'grant', 'set_credit', 'raise_credit', 'remove',
  'approve_award', 'void_award', 'offer_agent', 'revoke_agent', 'assign_agent',
  'service_add', 'service_update',
]);

// Whether signed message `m` (identity.js's envelope) moves chips: a member
// asking for chips, an agent's command, or an owner's chip command.
export function movesChips(m) {
  const b = m?.body;
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'chip_request' || b.type === 'agent_cmd') return true;
  return b.type === 'owner_cmd' && CHIP_OPS.has(b.op);
}
