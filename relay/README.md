# ducy relay

Forwards multiplayer messages for the `#play` page. Each table code is a room;
the host's tab and every player's tab keep a WebSocket open to it. The relay
has no game logic and stores nothing: the host's tab runs the table (ducy's
`MultiTable`) and sends each player only their own view.

| From | Sends | Relay delivers |
|---|---|---|
| host | `{to, data}` | `data` to guest `to` |
| guest | `data` | `{from, data}` to the host |
| (relay) | | `{from, event: 'open' \| 'close'}` to the host when a guest connects or drops |
| (relay) | | `{type: 'host_gone'}` to guests when the host drops (they reconnect once it's back) |

Connect to `/room/<CODE>?role=host` or `/room/<CODE>?role=guest&id=<client id>`,
where the code looks like `ABCD-EFGH`. Close codes: 4000 bad request, 4001 the
table already has a host, 4002 the host left, 4004 no such table, 4009
replaced by a newer connection with the same id, 4029 the room is full.

## Deploy to Cloudflare

`src/worker.js` is a Worker with one Durable Object per room. The Workers free plan covers it.

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

To try a relay without changing the code, open the page with
`?relay=wss://…#play`. The browser remembers it.

## Local development

```sh
cd relay
npm install
npm run dev            # ws://localhost:8787, same protocol as the Worker
```

Then open the site with `?relay=ws://localhost:8787#play`. Use separate
browser profiles or windows for each player: the player id is kept per tab.
