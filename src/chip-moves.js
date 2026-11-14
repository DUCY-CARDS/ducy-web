// Which club messages move chips (#575): they need a passkey unlock from the
// last few minutes. The relay checks (relay/src/unlock.js); the page asks
// for the passkey first, so they aren't refused (clubs.js).

// Owner commands that move chips, or change who may.
export const CHIP_OPS = new Set([
  'give', 'take', 'grant', 'set_credit', 'raise_credit', 'remove',
  'approve_award', 'void_award', 'offer_agent', 'revoke_agent', 'assign_agent',
  'service_add', 'service_update',
  // Recording a payment of what a member owes clears it (#633).
  'record_payment',
  // The owner's float (#589): refilling it and its size, both at once (#660).
  'refill', 'float_size',
]);

// Whether owner command `op` with `args` needs the unlock: letting someone in
// as an agent (#666) offers the role too.
export const chipOp = (op, args) => CHIP_OPS.has(op) || (op === 'approve' && args?.kind === 'agent');

// A member's vault commands that do (#579): taking chips out, and the wait.
// Putting chips in and cancelling a take-out keep them in, so needn't.
export const VAULT_OPS = new Set(['out', 'wait']);

// What only the club site sends (#637, relay/src/unlock.js siteOk): making
// a club, the owner's connection and commands,
// and an agent's commands. A player's own messages (asking for chips,
// their vault) come from the player app.
export const MANAGER_TYPES = new Set(['create_club', 'owner_hello', 'owner_cmd', 'agent_cmd']);
export const managerOnly = m => MANAGER_TYPES.has(m?.body?.type);

// Whether signed message `m` (identity.js's envelope) moves chips: a member
// asking for chips or taking them out of their vault, an agent's command,
// or an owner's chip command.
export function movesChips(m) {
  const b = m?.body;
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'chip_request' || b.type === 'agent_cmd') return true;
  if (b.type === 'vault') return VAULT_OPS.has(b.op);
  return b.type === 'owner_cmd' && chipOp(b.op, b.args);
}
