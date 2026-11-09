// Which club messages move chips (#575): they need a passkey unlock from the
// last few minutes. The relay checks (relay/src/unlock.js); the page asks
// for the passkey first, so they aren't refused (clubs.js).

// Owner commands that move chips, or change who may.
export const CHIP_OPS = new Set([
  'give', 'take', 'grant', 'set_credit', 'raise_credit', 'remove',
  'approve_award', 'void_award', 'offer_agent', 'revoke_agent', 'assign_agent',
  'service_add', 'service_update',
  // The owner's float (#589): refilling it, approving a refill from another
  // device, cancelling one, and its size.
  'refill', 'approve_refill', 'cancel_refill', 'float_size', 'cancel_float_raise',
]);

// A member's vault commands that do (#579): taking chips out, and the wait.
// Putting chips in and cancelling a take-out keep them in, so needn't.
export const VAULT_OPS = new Set(['out', 'wait']);

// Whether signed message `m` (identity.js's envelope) moves chips: a member
// asking for chips or taking them out of their vault, an agent's command,
// or an owner's chip command.
export function movesChips(m) {
  const b = m?.body;
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'chip_request' || b.type === 'agent_cmd') return true;
  if (b.type === 'vault') return VAULT_OPS.has(b.op);
  return b.type === 'owner_cmd' && CHIP_OPS.has(b.op);
}
