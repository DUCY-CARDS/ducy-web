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

## Always-on clubs: timers and sleeping

An always-on club's tables run in its room (#93). Everything that happens
later is on the room's one Durable Object alarm, shared with backups:
- turn time-outs;
- the next deal;
- the sit-out sweep;
- the fair-deal round's steps (#135).

Timers in memory would hold the room awake and be lost when the runtime
evicts it. With the alarm:
- **The room can hibernate** between alarms, and while no one plays.
- **After an eviction**, the alarm wakes the room. The club opens from
  storage, and its tables, which are saved after every change, restore and set
  their timers again; any timer already due fires at once. Players still
  connected count as back, so play goes straight on.
- **Backups** keep their own due time (`backupDue`) on the same alarm.

`test/club-alarms.test.mjs` evicts a room mid-hand and checks that, with no
message afterwards, the player to act times out and the next hand is dealt.

### Measured on the live relay (#96)

On 2026-10-09 an always-on club on the live relay (relay version
`f689f17a`) had two players at one No-limit Hold'em table, with the owner's
browser closed. CPU is from `wrangler tail`; active time and duration are
from the account's Durable Object analytics (GraphQL
`durableObjectsPeriodicGroups`), per minute.

| Phase | What wakes the room | CPU per event | Active time | Duration |
|---|---|---|---|---|
| Creating the club, members joining | signed messages | 4 ms median, 16 ms max | | |
| Playing: 34 hands in 3 minutes, 269 actions | 122 messages, 51 alarms | messages 2 ms median, 4 ms p99, 6 ms max; alarms 1 ms median, 3 ms max | 6–7.5 s a minute | 0.8–0.96 GB-s a minute |
| Seated and connected, no one acting | an alarm every 5 s | under 1 ms | 0.43 s a minute | 0.055 GB-s a minute |
| Everyone gone | an alarm every 5 s, with no end (fixed, below) | under 1 ms | 0.43–0.53 s a minute | 0.05–0.07 GB-s a minute |

**CPU per message is far under the 30 s limit:** the slowest event seen, of
about 1,100, used 40 ms; play itself never more than 6 ms. Wall time per
event is mostly storage, about 35 ms.

**The room does hibernate between events.** Active time while idle is only
the alarm wakes themselves (12 of about 35 ms a minute), not the minute.

**But it was never left alone.** The sit-out sweep (`club-host.js`) re-armed
itself every 5 s while anyone was seated, even when the table's clock was
stopped because no one seated was connected. In that state the sit-out limit
doesn't count, so the seats never clear and the wakes never end: the test
club woke 12 times a minute for over an hour after everyone left, until it
was deleted. That's 17,280 requests a day per abandoned club, against the
free plan's 100,000. The sweep now stops with the clock and starts again
when someone seated reconnects (`test/club-alarms.test.mjs`), so a club with
no one connected sets no alarms; only a pending backup (at most one, 5
minutes after the last change) wakes it.

## Club services: outside servers that give chips

An always-on club's owner can let a server of theirs (a league, a rewards
scheme) give members chips without them, within limits
(`src/club-services.js`, `src/service-client.js`, `relay/src/service-http.js`).

**Proving who it is:** a service has its own signing key, made on its own
server. The private key never leaves it; the club keeps only the public
key. A request is a signed message, like a member's:
- **Only once:** each request's sequence number is the time it was signed.
  The room refuses one more than 5 minutes off its clock, or one it has
  already seen, so a copied request can't be sent again.
- **Nothing to steal from the relay:** the relay holds only public keys, so
  even its stored data can't be used to give chips.

**Limits, set by the owner** on the club's Settings page:
- **Permissions:** give chips, take them back (off by default), see the
  member list.
- **A budget:** the most it can ever give, until the owner adds more. A
  stolen key can lose at most that.
- **Caps:** the most in one give and in a day, and an optional end date.
- **Revoke:** forgets the key at once; the next request is refused.

Every give and take is in the club's ledger and History under the
service's name; refused requests are counted on its card.

**Setting one up**, on the service's server (Node 20 or later, from a
checkout of this repo):

```sh
node tools/ducy-service.mjs init                 # makes ducy-service-key.json (mode 600)
# give the club's owner the "ducy-service:1:…" line it prints; they add it
# under Settings → Services and check the service ID matches
node tools/ducy-service.mjs status  --club ABCD-EFGH
node tools/ducy-service.mjs members --club ABCD-EFGH
node tools/ducy-service.mjs give <member id> 500 "League week 3" --club ABCD-EFGH --key week3-ann
```

With `DUCY_SERVICE_PASSWORD` set, the key file is locked with it. `--key`
names the payment: sent again (after a timeout, say), it returns the first
result instead of paying twice. Amounts are in chips. From code, use
`serviceClient` in `src/service-client.js`.

**The HTTP endpoint:** `POST /club/<code>/service` with the signed message
as JSON. Answers `{ok: true, value}`, or `{ok: false, error}` with 400
(malformed), 401 (not a service of this club, revoked, expired, stale or
already seen), 403 (not allowed, over a limit, or the club is paused), 404
(no such club or member), 409 (refused, e.g. not enough chips) or 429 (more
than 5 a second to the club). A request with an `Origin` header is refused:
services are servers, so no web page can use a service's key through
someone's browser.

## Local development

```sh
cd relay
npm install
npm run dev            # ws://localhost:8787, same protocol as the Worker
```

Then open the site with `?relay=ws://localhost:8787#play`. Use separate
browser profiles or windows for each player: the player id is kept per tab.
