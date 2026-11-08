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

### Proving the player's ID (#577)

A club connection (queue mode, or any guest of an always-on club's room) is
nobody until it proves it holds the key of the player ID it named
(`src/prove.js`). The relay sends `{type: 'prove', challenge}`; the page
answers `{type: 'prove', env}`, env being `{type: 'prove', room, challenge}`
signed with the player's key; the relay says `{type: 'proven'}`. Until then
it hears nothing sent to that player, its messages are dropped, the club and
the host don't see it arrive, and it replaces no one: only a proven
connection closes the player's other one (4009), as a reload or a second tab
does. A bad proof closes it with 4000. Friends tables' guests name a random
client ID, not a player key, and aren't asked.

### Passkeys (#575)

Clubs need a passkey. `src/passkeys.js` keeps, per player ID, each passkey's
public key (attached by a request signed with the player's own key; a second
one needs a recent unlock with the first), and checks sign-ins (WebAuthn
assertions: our challenge, a page on `ALLOWED_ORIGINS` (any local page on the
dev relay), the `ducy.cards` relying party for ducy.cards and its
subdomains, user present and verified, the signature, and a count that only
goes up). A good sign-in starts a session.

| Request | Body | Answer |
|---|---|---|
| `POST /passkey/challenge` | | `{challenge}`, good for 5 minutes, once |
| `POST /passkey/status` | `{id}` | `{enrolled, creds, movedTo}` |
| `POST /passkey/enrol` | `{env}`: signed `{type: 'passkey_enrol', challenge, credId, spki, alg, name, token?}` | `{ok, token}` |
| `POST /passkey/unlock` | `{credId, clientDataJSON, authenticatorData, signature}` | `{token, id, copy, clubs, movedTo}` |
| `POST /passkey/copy` | `{env}`: signed `{type: 'passkey_copy', challenge, token, credId, copy: {iv, ct}}` | `{ok}` |
| `POST /passkey/list` | `{token}` | `{creds: [{credId, name, at, copy, current}]}` |
| `POST /passkey/remove` | `{token, credId}` (a session from the last 5 minutes) | `{ok}` |
| `POST /passkey/vouch` | `{env}`: signed `{type: 'passkey_vouch', challenge, token}` | `{ok, from, to}` |

A club connection sends `{type: 'unlock', token}` and gets `{type:
'unlocked', at}` or `{type: 'locked', reason}` (`src/unlock.js`). Anything
else from a connection that isn't unlocked, or has been idle 4 hours, is
dropped with `{type: 'locked'}`; the session is checked again every 5
minutes, so a removed passkey's connections stop. Messages that move chips
(asking for chips, agents' commands, owner commands like `give` and
`grant`: `src/chip-moves.js`) need a sign-in from the last 5 minutes, or
they're dropped with `{type: 'unlock_again'}`.

**Recovery.** With the PRF extension, the page keeps a copy of the player's
key on the relay, locked with a key only that passkey can make
(`copy`); signing in on a new device fetches it, and the page opens it: the
same player ID. The relay can't open it. **Without PRF, the relay vouches**:
after a checked sign-in, `vouch` links the new device's own player ID to the
old one; the old ID's passkeys and clubs move to the new one, and it can't
unlock again. Each club the old ID was in moves the member over
(`move_member`, by its room) when the new ID's connection unlocks there, and
logs "Moved … to a new ID (ducy vouched)". This trusts ducy's operator, who
runs the relay and could vouch for anyone.

## Deploy to Cloudflare

`src/worker.js` is a Worker with one Durable Object per room. The Workers free plan covers it.

**Automatically:** the live relay ships with the site in a release
(`.github/workflows/deploy.yml`, "Deploy production", run by hand), after its
tests pass. Every push to master deploys the staging relay. Both need two
repository secrets:
- `CLOUDFLARE_API_TOKEN`: create it at Cloudflare → My Profile → API Tokens, with the "Edit Cloudflare Workers" template.
- `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers overview page.

Staging and sandbox have relays of their own (`ducy-relay-staging`,
`ducy-relay-sandbox`, from `[env.staging]` and `[env.sandbox]` in
`wrangler.toml`): see [DEPLOY.md](../DEPLOY.md), which also has the release
steps.

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
