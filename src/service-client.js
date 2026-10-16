// The client side of a club service (club-services.js), for an outside
// server: sends signed requests to an always-on club's room on the relay.
// Runs in Node 20 or later (WebCrypto with Ed25519); never in a web page,
// which the relay refuses. tools/ducy-service.mjs is a command line for it.
//
//   const svc = await loadService('service-key.json', {password});
//   const client = serviceClient({identity: svc, relay: DEFAULT_SERVICE_RELAY, club: 'ABCD-EFGH'});
//   await client.give('memberId', 500, {note: 'Weekly league', key: 'league-2026-10-16-ann'});
//
// Every call resolves to the club's answer (`value`), or throws an Error
// with the relay's reason and its HTTP status (err.status).

import { createIdentity, exportIdentity, exportLockedIdentity, importIdentity, signMessage } from './identity.js';
import { serviceLine } from './club-services.js';

export const DEFAULT_SERVICE_RELAY = 'https://ducy-relay.ducy.workers.dev';

// A new service key, as the file to keep on the service's server: locked
// with `password` if given. Returns {identity, file, line}.
export async function newService({password = ''} = {}) {
  const identity = await createIdentity();
  const file = password ? await exportLockedIdentity(identity, password) : await exportIdentity(identity);
  return {identity, file, line: serviceLine(identity)};
}

// Opens a service key file's text.
export const openService = (text, {password = ''} = {}) => importIdentity(text, password);

// `relay`: the relay's https:// (or ws://, wss://) address; `fetchFn` for tests.
export function serviceClient({identity, relay = DEFAULT_SERVICE_RELAY, club, fetchFn = globalThis.fetch}) {
  const base = String(relay).replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
  async function call(op, args = {}) {
    const env = await signMessage(identity, {type: 'service', club, op, args});
    const res = await fetchFn(`${base}/club/${encodeURIComponent(club)}/service`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(env)});
    let out;
    try { out = await res.json(); } catch { out = {ok: false, error: `The relay answered ${res.status}.`}; }
    if (!res.ok || !out.ok) {
      const err = new Error(out.error || `The relay answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return out.value;
  }
  return {
    call,
    // What the club allows this service, and how much it has given today.
    status: () => call('status'),
    // The club's members: [{id, name, balance}] (needs the read permission).
    members: () => call('members'),
    // `key`: any string up to 64 characters naming this payment, so sending
    // it again (after a timeout, say) never pays twice.
    give: (member, amount, {note = '', key} = {}) => call('give', {member, amount, note, key}),
    take: (member, amount, {note = '', key} = {}) => call('take', {member, amount, note, key}),
  };
}
