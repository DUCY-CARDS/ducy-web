# ducy relay

Forwards multiplayer messages for the `#play` and `#clubs` pages. Each table
or club code is a room; the host's tab and every player's tab keep a
WebSocket open to it. The relay has no game logic: the host's tab runs the
table (ducy's `MultiTable`) and sends each player only their own view. The
only thing it stores is the queue below.

| From | Sends | Relay delivers |
|---|---|---|
| host | `{to, data}` | `data` to guest `to` |
| guest | `data` | `{from, data}` to the host |
| (relay) | | `{from, event: 'open' \| 'close'}` to the host when a guest connects or drops |
| (relay) | | `{type: 'host_gone'}` to guests when the host drops (they reconnect once it's back) |
| either | `{type: 'ping', t}` | `{type: 'pong', t}` back to the sender, never forwarded or queued: the host's heartbeat. While its pings go unanswered (or its socket is down) the host stops its tables' clocks, so an outage doesn't time out or fold anyone |

Connect to `/room/<CODE>?role=host` or `/room/<CODE>?role=guest&id=<client id>`,
where the code looks like `ABCD-EFGH`. Close codes: 4000 bad request, 4001 the
table already has a host, 4002 the host left, 4004 no such table, 4009
replaced by a newer connection with the same id, 4029 the room is full.

### Queue mode (clubs)

A guest that connects with `&queue=1` can reach a club whose host is away:

| From | Sends | Relay delivers |
|---|---|---|
| (relay) | | `{type: 'host_away'}` to the guest if no host is connected |
| guest, host away | `data` | stored; `{type: 'queue_full'}` back if over the limit |
| (relay) | | when the host connects: `{from, event: 'open'}` for each waiting guest, then `{from, data, queued: n}` for each stored message |
| host | `{ack: n}` | deletes stored message `n` (unacked ones are delivered again next time) |
| (relay) | | `{type: 'host_back'}` to queue-mode guests when the host connects |

Queue-mode guests stay connected when the host leaves (they get `host_gone`
but aren't closed). Limits: 10 stored messages per guest, 100 per room, 8 KB
each, kept 7 days. The Worker keeps them in the room's Durable Object
storage; the dev relay keeps them in memory.

## Deploy to Cloudflare

`src/worker.js` is a Worker with one Durable Object per room. The Workers free plan covers it.

**Automatically:** `.github/workflows/relay.yml` deploys the relay whenever a change to `relay/` reaches master, after its tests pass. It needs two repository secrets:
- `CLOUDFLARE_API_TOKEN`: create it at Cloudflare → My Profile → API Tokens, with the "Edit Cloudflare Workers" template.
- `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers overview page.

To redeploy without a change, run the workflow from the Actions tab.

**By hand:**

```sh
cd relay
npx wrangler login
npx wrangler deploy
```

Wrangler prints the URL, e.g. `https://ducy-relay.<account>.workers.dev`.
Then:

1. Set `DEFAULT_RELAY` in `src/play-net.js` to the `wss://` form of that URL,
   e.g. `wss://ducy-relay.<account>.workers.dev`. Multiplayer stays hidden
   while it's empty.
2. Optionally set `ALLOWED_ORIGINS` in `wrangler.toml` to the site's origin,
   so only your page can use the relay, and deploy again.

The site's relay is `wss://ducy-relay.ducy.workers.dev`.

To try another relay without changing the code, open the page with
`?relay=wss://…#play` (the `https://` URL wrangler prints works too). The
browser remembers it, and invite links from that browser carry it, so
friends reach the same relay. `?relay=default#play` goes back to the
site's relay.

## Local development

```sh
cd relay
npm install
npm run dev            # ws://localhost:8787, same protocol as the Worker
```

Then open the site with `?relay=ws://localhost:8787#play`. Use separate
browser profiles or windows for each player: the player id is kept per tab.
