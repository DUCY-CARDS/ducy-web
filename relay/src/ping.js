// The relay's heartbeat, shared by the Worker (worker.js) and the local relay
// (dev-server.mjs): {type: "ping", t} from anyone is answered with
// {type: "pong", t}, never forwarded or queued.

// {type: 'ping', t} → the {type: 'pong', t} reply, or null for anything else.
export function pingReply(msg) {
  if (typeof msg !== 'string' || msg.length > 100 || !msg.includes('"ping"')) return null;
  try {
    const m = JSON.parse(msg);
    return m?.type === 'ping' ? JSON.stringify({type: 'pong', t: m.t ?? null}) : null;
  } catch {
    return null;
  }
}
