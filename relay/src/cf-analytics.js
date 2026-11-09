// Cloudflare's numbers for this relay (#601), for the admin site: requests,
// errors and CPU time of its Worker, and requests to its Durable Objects,
// per day, from Cloudflare's GraphQL analytics API. Only when the Worker
// has the secret CF_ANALYTICS_TOKEN (an API token with Account Analytics:
// Read) and CF_ACCOUNT_ID; the token never leaves the relay.

const API = 'https://api.cloudflare.com/client/v4/graphql';
const CACHE_MS = 10 * 60_000;

// The Worker's name in each environment (wrangler.toml).
export const scriptFor = env => env.CF_SCRIPT_NAME || ({staging: 'ducy-relay-staging', sandbox: 'ducy-relay-sandbox'}[env.ENVIRONMENT] || 'ducy-relay');

const WORKER_Q = `query ($account: String!, $script: String!, $since: Date!, $until: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workersInvocationsAdaptive(limit: 1000, filter: {scriptName: $script, date_geq: $since, date_leq: $until}) {
      dimensions { date }
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
  } }
}`;
const DO_Q = `query ($account: String!, $script: String!, $since: Date!, $until: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: {scriptName: $script, date_geq: $since, date_leq: $until}) {
      dimensions { date }
      sum { requests }
    }
  } }
}`;

async function query(env, q, vars, fetchFn) {
  const r = await fetchFn(API, {
    method: 'POST',
    headers: {authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json'},
    body: JSON.stringify({query: q, variables: vars}),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok || !out || out.errors?.length) throw new Error(out?.errors?.[0]?.message || `HTTP ${r.status}`);
  return out.data?.viewer?.accounts?.[0] || {};
}

// Rows of one dataset summed by date: {date: {...sum, ...quantiles}}.
function byDate(rows, pick) {
  const out = {};
  for (const r of rows || []) {
    const d = r.dimensions?.date;
    if (!d) continue;
    const prev = out[d] || {};
    const add = pick(r);
    for (const [k, v] of Object.entries(add)) prev[k] = k.startsWith('cpu') ? Math.max(prev[k] || 0, v || 0) : (prev[k] || 0) + (v || 0);
    out[d] = prev;
  }
  return out;
}

let cache = null; // {at, key, value}

// {enabled: false} without the token; else {enabled: true, script, days:
// [{day, requests, errors, subrequests, cpuP50, cpuP99 (µs), doRequests}],
// errors: [why a part couldn't be read]}.
export async function cfAnalytics(env, {days = 30, now = Date.now(), fetch: fetchFn = globalThis.fetch} = {}) {
  if (!env.CF_ANALYTICS_TOKEN) return {enabled: false};
  if (!env.CF_ACCOUNT_ID) return {enabled: true, days: [], errors: ['CF_ACCOUNT_ID isn’t set.']};
  const script = scriptFor(env);
  const key = `${script}:${days}`;
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.value;
  const dates = Array.from({length: days}, (_, i) => new Date(now - (days - 1 - i) * 864e5).toISOString().slice(0, 10));
  const vars = {account: env.CF_ACCOUNT_ID, script, since: dates[0], until: dates[dates.length - 1]};
  const errors = [];
  const worker = await query(env, WORKER_Q, vars, fetchFn)
    .then(a => byDate(a.workersInvocationsAdaptive, r => ({requests: r.sum?.requests, errors: r.sum?.errors, subrequests: r.sum?.subrequests, cpuP50: r.quantiles?.cpuTimeP50, cpuP99: r.quantiles?.cpuTimeP99})))
    .catch(e => { errors.push(`Workers: ${e.message}`); return {}; });
  const objects = await query(env, DO_Q, vars, fetchFn)
    .then(a => byDate(a.durableObjectsInvocationsAdaptiveGroups, r => ({doRequests: r.sum?.requests})))
    .catch(e => { errors.push(`Durable Objects: ${e.message}`); return {}; });
  const value = {
    enabled: true, script, errors,
    days: dates.map(day => ({
      day, requests: worker[day]?.requests ?? 0, errors: worker[day]?.errors ?? 0, subrequests: worker[day]?.subrequests ?? 0,
      cpuP50: worker[day]?.cpuP50 ?? null, cpuP99: worker[day]?.cpuP99 ?? null, doRequests: objects[day]?.doRequests ?? 0,
    })),
  };
  if (!errors.length) cache = {at: now, key, value};
  return value;
}
