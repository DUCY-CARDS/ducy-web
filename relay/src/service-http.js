// Services' requests to always-on clubs (src/club-services.js) over HTTP:
//   POST /club/<code>/service   a signed envelope (identity.js), as JSON
// Shared by the Cloudflare Worker (worker.js) and the local relay
// (dev-server.mjs). The Worker checks the request's shape (serviceHttp),
// the club's room limits the rate and answers it (serviceInRoom).

// Club codes, as in worker.js.
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
// Requests to one club: SERVICE_RATE a second, in bursts of up to
// SERVICE_BURST, whoever sends them; each at most MAX_SERVICE_BODY bytes.
export const SERVICE_RATE = 5, SERVICE_BURST = 20, MAX_SERVICE_BODY = 8 * 1024;

const json = (v, status) => Response.json(v, {status});

// `req` is a Fetch API Request; `toRoom(env)` resolves to the room's Response.
// Servers only: a request from a web page (it has an Origin header) is
// refused, so no site can use a service's key through someone's browser.
export async function serviceHttp(req, code, toRoom) {
  if (req.method !== 'POST') return json({ok: false, error: 'POST a signed request.'}, 405);
  if (req.headers.get('Origin')) return json({ok: false, error: 'Services are called from servers, not web pages.'}, 403);
  if (!CODE.test(code)) return json({ok: false, error: 'No such club.'}, 404);
  const text = await req.text();
  if (text.length > MAX_SERVICE_BODY) return json({ok: false, error: 'The request is too big.'}, 400);
  let env;
  try { env = JSON.parse(text); } catch { return json({ok: false, error: 'The request isn’t JSON.'}, 400); }
  return toRoom(env);
}

// The room's side: `club` is its running club server (club-server.js), or
// null; `holder` keeps the token bucket (the room object). Resolves to
// {status, body}.
export async function serviceInRoom(holder, club, env, now = Date.now()) {
  if (!club) return {status: 404, body: {ok: false, error: 'No such club.'}};
  const b = holder.serviceBucket || {tokens: SERVICE_BURST, at: now};
  b.tokens = Math.min(SERVICE_BURST, b.tokens + ((now - b.at) / 1000) * SERVICE_RATE);
  b.at = now;
  holder.serviceBucket = b;
  if (b.tokens < 1) return {status: 429, body: {ok: false, error: 'Too many requests; slow down.'}};
  b.tokens -= 1;
  return club.serviceRequest(env);
}
