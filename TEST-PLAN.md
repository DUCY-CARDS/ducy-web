# ducy.cards test plan

What each published part of ducy.cards must pass before a release, what CI
already checks, and what someone has to try by hand.

**Keep this current.** Every major release updates it in the same PR:
- add new features to the coverage tables;
- move a feature to "Automated" once a test covers it;
- record the manual run under [Results](#results).

A major release is any of these:
- a change to what the front page offers;
- a feature turned on or off (`BETA` in `src/home.js`, `OFF` in `src/club-beta.js`);
- a relay change to rooms, clubs or codes;
- a new Ducybot model;
- an invite to new people.

## What's published

| Part | Pages | Who uses it |
|---|---|---|
| **Main** | `/`: the front page (Friends, your clubs, Play the Regulars), hosting and joining a private game, a club member's pages, the Regulars' tables, `privacy.html` | Everyone |
| **Beta extras** | `/#welcome` and what it links to: Study (`#study`, `#equity`, `#trainer`, `#charts`), heads-up training (`#challenge`, Ducybot at `#codedoug` and `#gto-plo4/5/6`), `#ladder`, Bankroll Quest (`#quest`). The club features listed off in `src/club-beta.js`: rake at cash tables, promotions, club services | No one in the beta; reachable by address only |
| **Club manager** | club.ducy.cards (#637; staging: club-staging.ducy.cards), its own site; `manage.html` on a local page: Overview, Tables, Tournaments (with rake), Requests, Members, a member's page (with credit), Balances, Chips, Club info, Rules, Backup and devices, History; demo clubs | Club owners |
| **Admin** | admin.ducy.cards: usage, versions, relays, grants, club info, error reports | ducy's admins |

`sim.html` isn't published (`scripts/build-site.sh` doesn't ship it).

## Levels

| Level | When | What runs |
|---|---|---|
| **Every PR** | Always | CI: unit tests, browser tests, the Rust checks. Nothing merges unless all pass. A merge deploys staging.ducy.cards, not the live site. |
| **Release** | A major release | Every PR check, then [Manual: main](#manual-main) and [Manual: club manager](#manual-club-manager) on staging, before running Deploy production ([DEPLOY.md](DEPLOY.md)). After the release, M1 on the live site. |
| **Turning a beta extra on** | Before it shows on the front page or in the manager | Its row in [Manual: beta extras](#manual-beta-extras), on staging, plus a browser test added for it. |

## Automated

**How to run:**
- **Unit tests:** run the command in `.github/workflows/ci.yml`, step "Unit tests". It needs `wasm/` from a fresh build (`wasm-pack`, as in CI) and `npm ci --prefix relay`. A stale `wasm/` fails on engine wording, as `club-agents.test.mjs` once did.
- **Browser tests:** `npm ci --prefix e2e`, then `npx playwright test` in `e2e/`. `E2E_CHANNEL=chrome` uses an installed Chrome. They serve the repo and start the dev relay with `TRIALS=off`.
- **Rust:** `scripts/rust-checks.sh`.

**What the browser tests cover** (`e2e/play.spec.js`, `e2e/money.spec.js` and `e2e/club-site.spec.js`, in Chromium and WebKit, desktop and 375 px; the club tests that need a passkey run in Chromium only):

| Test | Part |
|---|---|
| Front page offers Friends and the Regulars, and nothing else, with no clubs | Main |
| With no clubs, the front page takes a club code, and `#clubs` is the front page | Main |
| One club: the front page opens it, under Play | Main |
| Several clubs: the front page lists them, and `#clubs` goes there | Main |
| The club manager offers no way to start a club | Club manager |
| A hand against the Regulars plays to its end, with no grades | Main |
| The Regulars' table keeps its seat stats and stats table | Main |
| A friend joins a hosted game by its code | Main |
| A friends table shows no player stats and keeps none; the same at a club table | Main |
| Starting a club without permission is refused | Club manager |
| A new player asks to join with a message, gets a reply, is let in as Cash and given chips | Main |
| The same as a Credit player: let in with a credit line, and can sit with it | Club manager |
| The same through an agent's link: the agent replies, lets them in and gives chips | Club manager |
| With Let everyone in on: in at once as Cash, New until the owner gives chips | Club manager |
| A demo club opens, and its main pages draw | Club manager |
| A raked table: members see the rake, the hand log and replay show it, the owner sees each player's share; the club's default rake on Rules (skipped while cash-game rake is off in the beta) | Beta extras |
| A credit player plays on credit out of the float and owes it; Balances shows it, the owner records the payment (the float untouched), and pays out a winner | Club manager |
| An agent's player let in with credit: not told to ask for chips; the agent's list shows the line, the owner can't set it; their buy-in comes out of the float | Club manager |
| A tournament with a rake: the entry costs both, the owner sees the rake, unregistering gives both back | Club manager |
| The club site (club.ducy.cards and ducy.cards served from the checkout): a first visit asks for the passkey before making a player ID, someone new goes on to the manager (Chromium; a browser without passkeys goes straight on); the wordmark goes to ducy.cards; its `app.html` sends anyone not in a demo to ducy.cards | Club manager |
| The full landing page is still at `#welcome` | Beta extras |
| The heads-up challenge deals a hand | Beta extras |

Every browser test fails on an uncaught error, a console error, or a page wider than the screen.

## Coverage

"Unit" and "Browser" name what's automated. "Manual" names the step below that covers what the tests can't.

### Main

| Feature | Unit | Browser | Manual |
|---|---|---|---|
| Front page, its tiles and links | `home.test` | yes | M1 |
| Code box: game code, club code, invite link, bad code | `play-net.test`, `relay-club.test` | partly | M2 |
| Host a private cash game: setup, code, table opens | `e2e.test`, `play-net.test` | yes | M3 |
| Host a private tournament | `private-tourney.test`, `tourney-run.test` | no | M4 |
| Join a game; play hands with two or more people | `e2e.test`, `fair-deal.test`, `pots.test` | join only | M3 |
| Bomb pots, run it twice, side pots | `pots.test`, `fair-deal.test` | no | M3 |
| Disconnects, reloads, a host's table resuming | `heartbeat.test`, `idle-seats.test`, `hit-and-run.test` | no | M5 |
| Table chat | `table-chat.test` | no | M3 |
| Play the Regulars | `regulars.test`, `bot-chat.test` | yes | M1 |
| Player stats (VPIP/PFR on seats, the stats table): bot tables only, none at tables of people | `play-stats.test` | yes | M3 |
| Joining a club, asking for chips, playing at its tables | `club.test`, `club-member-view.test`, `relay-club.test` | join, chips | M6 |
| Player settings, name, avatar | – | no | M1 |
| Identity backup and restore | `identity.test`, `backup.test` | no | M7 |
| Error reports reach the admin page | `error-report.test` | no | M8 |
| Privacy page | `privacy-page.test` | – | M1 |
| Security policy (CSP), browser support, boot order | `csp.test`, `browser-support.test`, `boot-order.test` | – | – |
| Installable web app | – | no | M9 |

### Club manager

| Feature | Unit | Browser | Manual |
|---|---|---|---|
| Starting a club takes a grant | `registry.test`, `relay-temporary.test` | yes | C1 |
| Sidebar, pages and old addresses; hidden features stay hidden | `club-nav.test`, `club-beta.test` | demo only | C2 |
| Tables: new, offer a game, move, remove a player | `club-tables.test`, `move-table.test`, `remove-from-table.test`, `table-groups.test` | no | C3 |
| Tournaments: wizard, payouts, run, results | `club-tourneys.test`, `club-tourneys-ui.test`, `payout-tables.test`, `tourney-commands.test` | no | C4 |
| Tournament rake | `club-tourneys-ui.test`, `tourney-commands.test` | yes | C4 |
| Requests and members: join, messages, give and take chips, remove | `club.test`, `club-chips.test`, `club-overview.test`, `club-log.test` | join, give | C5 |
| Credit: limits, playing on credit out of the float, a request at the limit, an agent's players' lines | `club-credit.test`, `club-credit-server.test`, ducy-club `book`, `host` and `tests/money.rs` | yes | C9 |
| Balances: who owes whom, settling both ways, a payment recorded | `club-credit.test`, `club-credit-server.test` | yes | C9 |
| Club info and rules | `club-info.test`, `club-help.test` | no | C2 |
| Backup and devices, restore | `club-backup.test`, `backup.test` | no | C6 |
| History and hand replays | `hand-replay.test` | no | C5 |
| Agents: make one, their invite, their players' requests and chips | `club-agents.test` | join, give | C8 |
| Demo clubs | `demo-club.test` | yes | C7 |
| The club site: its build and deploy (open on live, password kept on staging and sandbox, skipped without a folder, the live deploy leaves it alone), each relay allowing it | `club-site.test` | – | C10 |
| One passkey on both sites: the first visit's sign-in brings the same player ID, never a vouch there; club running and agents' commands only from a club site with a session made there | `sites.test`, `relay-club.test` | first visit | C10 |

### Beta extras

These stay unchecked until one is planned to go on. Then it needs both its row
here and a browser test.

| Feature | Unit | Manual |
|---|---|---|
| Ducybot heads-up, four games, at every depth it offers | `play-review.test`, `ladder.test` | B1 |
| Heads-up challenge | `ladder.test`, `ladder-review.test` | B2 |
| Study: equity, pre-flop ranges, charts, drills | `ranges.test`, `trainer-skills.test`, `charts.test`, `chart-skills.test`, `drills-no-repeat.test` | B3 |
| Hand review and live feedback | `play-review.test` | B4 |
| Bankroll Quest | `quest*.test` | B5 |
| Rake or time at cash tables, each player's contributions | `club-rake.test`, ducy-club's `rake.rs` | B7 |
| Promotions | `club-promos.test`, `club-promos-server.test` | B6 |
| Club services | `club-services.test`, `relay-services.test` | B6 |

### Admin

| Feature | Unit | Manual |
|---|---|---|
| Signed admin requests; non-admins refused | `relay-admin.test`, `admin-api.test` | A1 |
| Grants, club info, error reports | `admin-api.test`, `error-report.test` | A1, M8 |
| Usage counts per day, admins left out; what's live now | `stats.test`, `relay-admin.test` | A2 |
| Cloudflare's numbers, only with the relay's token | `stats.test` | A3 |
| The admin site: build, password kept on deploy, never uploaded open, live deploy leaves it alone; `admin.html` redirects; charts | `admin-site.test`, `csp.test` | A1, A4 |

## Devices

Run the manual steps on each device that has a ✓ below. Where no real device is
available, the first testers' phones stand in, and the gap is noted in Results.

| Device | Main | Club manager |
|---|---|---|
| Desktop Chrome | ✓ | ✓ |
| Desktop Safari | ✓ | ✓ |
| Desktop Firefox | ✓ | ✓ |
| iPhone, current Safari | ✓ | ✓ |
| iPhone, Safari 15.4 (the oldest supported) | ✓ | |
| Android Chrome | ✓ | ✓ |

## Manual: main

Every step runs on staging.ducy.cards (its password is in DirectAdmin) before the release, in a fresh private window unless it says otherwise. Staging has its own relay and data, so clubs and players made there never reach the live site. "Two browsers" means two devices, or two private windows in different browsers.

**M1 Front page and the Regulars**
1. Open `/`. You see Friends and Play the Regulars (and your clubs, once you have any), with no Beta or play money banners. Nothing scrolls sideways. `/#clubs` shows the front page.
2. Tap each tile. It opens its page, and Back returns to the front page.
3. Play the Regulars: sit down and play five hands. You get no grades and no hand review.
4. Open the gear: change your name and avatar, then reload. Both are kept.
5. Open Privacy from the footer. It reads, and the wordmark goes back home.

**M2 The code box** (front page)
1. Enter `hello`. You're told it isn't a code.
2. Enter a well-formed code with no game, such as `ZZZZ-ZZZZ`. You're told there's no game or club with that code, without going to another page.
3. Enter a live game's code (from M3). It goes to that game's join page.
4. Paste a club's invite link. It goes to that club's join screen.

**M2b No Start a game in the beta** (#635)
1. The front page has the code box and Join, and no Start a game.
2. Go to `/#host`. Join a game opens, and the address reads `#join`.

M3–M4 need Start a game, which the beta turns off (`startGame` in `src/club-beta.js`). To run them, add `?on=startGame` to the host's address.

**M3 A private cash game, two browsers**
1. Host: Start a game. Under Invite your friends, the setup shows a code. Open the table: it has the same code, and no "can't reach the relay".
2. Guest: enter the code, give a name, join. Each browser sees the other.
3. Play 20 hands, including an all-in with a side pot (three players), a bomb pot, and running it twice. The chips add up after each hand.
4. Use table chat, both ways.
5. Neither browser shows stats under the seats or a stats table, and the ⋯ menu has no stats items.
6. Host: End game. Standings show, and the download works.

**M4 A private tournament, three browsers**
1. Host: set one up. Its setup shows a code, and the lobby opens with it.
2. Two guests register by code. The host starts it.
3. Play to a winner. Blinds rise on schedule, and the payouts match the payout table.

**M5 Connections**
1. During M3, reload the guest. They return to their seat with their chips. At a club table (M6), the same, and a second tab of the same player takes over from the first, which says so.
2. Turn the guest's network off for 30 seconds, then back on. They return, and weren't folded while away.
3. Reload the host. The table resumes, and the hand in progress is intact.
4. Close the guest's tab for good. After the timeout the seat empties, and the chips are kept in the standings.

**M6 A club, as a member** (needs a club from C1)
1. Open the owner's invite link in a fresh browser. Fill in your name and "Who are you?" (Ask to join won't go without it), and ask to join. The passkey comes before anything reaches the club.
2. The owner sees your request in Needs you, with your message. The owner replies: the reply shows under your request, and you can answer (at most three in a row before a reply).
3. The owner lets you in as a Cash player. You're a member with a balance of 0: you see the tables and can sign up for a scheduled game, but can't sit. The owner's Needs you shows you as New, with Give chips.
4. Ask for chips. When the owner gives them, the balance shows, and you're no longer New.
5. Sit at the club's table and play five hands with another member. Stand up: the balance is right.
6. The front page's club tile has the club's name, and opens it; its breadcrumb is Play › the club. Join a second club: the front page lists both, and each opens.

**M7 Identity**
1. Save a backup from player settings.
2. In a fresh browser, restore it. The same name, the same clubs and the same balances come back.
3. On an iPhone, with the site installed and then not installed: note whether anything is lost after 7 days without a visit. This takes a week, so record the date it started.

**M8 Error reports**
1. On staging, cause an error: open the browser console and run `setTimeout(() => { throw new Error('test plan M8') })`.
2. On admin.ducy.cards, Staging → Errors, the report shows the build, page and browser, with no cards or names.

**M9 Installable app**
1. Add to home screen on iPhone and Android. The app opens full screen on the front page.
2. The installed app still runs M1 and M3.

**M10 Passkeys** (#575; on a real iPhone with iCloud Keychain, a real Android phone with Google Password Manager, and desktop Chrome; once more on iPhone with a third-party passkey manager such as 1Password if one is to hand)
1. Enrol: in a fresh browser, open a club's invite link and ask to join. Before the request goes, "Set up a passkey" shows. Continue: the device asks for Face ID, a fingerprint or the screen lock, and the request then reaches the owner.
2. Unlock: close the tab and come back. "Unlock your clubs" shows; Use passkey opens the club. Within the same tab nothing asks again, until 4 hours without using a club.
3. Chips: ask for chips more than 5 minutes after unlocking. The passkey is asked for first. As the owner, give chips more than 5 minutes after unlocking: the same.
4. Refusal: cancel the passkey prompt. The club stays locked and says "Not unlocked."; nothing is sent.
5. Recovery: on a second device signed in to the same Apple or Google account (so the passkey syncs), open the You page → Restore with a passkey → Sign in. The same player ID comes back (compare it on the You page), with the same clubs and balances, and no new join request.
6. Recovery without PRF: on a device whose passkey manager doesn't support PRF (iPhone before iOS 18, some third-party managers), do step 5. The device keeps its own player ID; the clubs list the member under it, with the same name and balance, and the owner's activity log says "Moved … to a new ID (ducy vouched)". Note which devices took which path.
7. A second device's own passkey: on the recovered device, You → Passkeys → Add. Both passkeys list, with their device and date.
8. A lost device: from the other device, You → Passkeys → Remove the first one. On the first device, the next unlock is refused, and a club page it had open stops working within 5 minutes.
9. Backups: with a passkey, You → Back up this device asks for the passkey before the file downloads, and the file restores (M7).
10. Staging and live: a passkey made on staging.ducy.cards is offered on ducy.cards too (same `ducy.cards` relying party) but the live relay doesn't know it, so it's refused there: expected.

## Manual: club manager

**C1 Starting a club**
1. Nothing in the player app or the club manager links to starting a club. Without a grant, the club site's `#clubs/new` (by address only) refuses to start a club and shows your ID.
2. Grant that ID on admin.ducy.cards (Staging → Clubs). Starting the club now works, and its owner is asked to prove a backup.

**C2 Pages**
1. Visit every sidebar page at desktop and phone width. Each draws, with no empty page or dead menu item.
2. None of the features `src/club-beta.js` turns off shows: no Promotions page, no services. `#clubs/promos` opens Overview. Balances is in the sidebar, a member's page has Credit, and the tournament wizard asks for a rake.
3. Edit club info and rules. A member sees the change, marked as updated.

**C3 Tables**
1. Make a cash table, and offer a game. A member sees both. A member just let in (0 chips, no credit) sees them too, but can't sit until given chips or credit.
2. Move a seated player to another table, then remove one. Their chips go back to their balance.

**C4 Tournaments**
1. Walk the wizard to the end: game, buy-in, stack and players, blinds, payouts, repeats.
2. Run one to a winner with two members. The prizes reach their balances, and History records it.
3. With a rake: each entry costs the buy-in plus the rake, the pool is the buy-ins only, and the owner's row shows the rake taken. Cancelling it refunds both. After a finish, Chips' Taken back includes the rake.

**C5 Members and chips**
1. A player asks to join (M6): Needs you and Requests show their message, with Let in, Reply and Decline. Reply: they see it, and their answer shows in the thread.
2. Let in: choose Cash. They're a member with nothing to sit with, and New in Needs you until you give chips. Give chips, then take some back. The member sees each change.
3. Let in another as Credit: Let in without a credit line is refused; with one, they can sit with it. Change the line later on their member page (Credit). Decline a third: they see it.
4. Remove a member: they're out, and asking again shows "Removed" on their request.
5. Rules → Let everyone in: On (History logs it). A new player asks with a message: after the passkey they're on the club's page at once, a Cash player with 0 chips who can't sit. No request waits; Needs you shows them New with their message, and Reply works both ways. Give chips: New goes. Through an agent's link, the same, under the agent. Someone removed who asks again still waits to be let in. Turn it Off: the next player asks and waits.
6. Members: search, filters and sort all work. A member's page shows their chips history and messages.
7. History: hands and replays open. Big chip moves stand out in the activity log.

**C5b Float and vaults** (#589, #579; the owner on two real devices, each with its own passkey)
1. Give chips until the float is empty: the give is refused, saying to refill. Refill: the passkey is asked for, and the float is full again, with a notice.
2. Give some, then refill again the same day: it waits 24 hours, with a notice that has Approve and Cancel. Approve on the same device: refused. Approve on the other device: the float fills, with a notice.
3. With only one passkey, the waiting refill can only be cancelled or left to go ahead after 24 hours.
4. Lower the float's size: at once. Raise it: it waits a day, with Cancel.
5. As a member: put chips in the vault (at once), take some out (the passkey first; it waits the chosen time), and cancel it from another of your devices. The owner sees the vault on your member page, but not the request.

**C6 Backup and restore**
1. Download the club's backup. Restore it into a fresh browser: the members, balances and tables come back.
2. `node relay/hostrocket/check.mjs` passes. It needs the relay's backup secrets.

**C7 Demo clubs**
1. Start each demo. Its pages draw, Reset works, and End demo returns to a clean manager.

**C8 Agents** (three browsers: owner, agent, a player)
1. Owner: on a member's page, Make agent. The member accepts, and their page shows their agent view.
2. Owner: give the agent chips to back their players.
3. A player asks to join through the agent's invite link, with a message. The request reaches the agent with the message; the agent replies and the player sees it. The agent lets them in as Cash: they're the agent's player, New, with 0 chips. Another, let in as Credit with a line, can sit with it; the agent's Credit button changes the line later.
4. The agent gives that player chips, then takes some back. Each needs a recent passkey unlock. The agent's balance goes down and up by the same amounts, and the owner's activity log shows each move.
5. The agent can't give chips to a player who isn't theirs, and can't make tables.

**C9 Credit and Balances** (#404, #454; three browsers: owner, a credit player, a cash player)
1. Owner: on a member's page, set a credit limit. Each save needs a recent passkey unlock. The member sees the limit, and can sit with it and no chips of their own. A raise bigger than a full buy-in shows in the owner's notices.
2. The credit player sits: the float on Rules drops by their buy-in (#633). With less in the float than the buy-in, they can't sit and are told the float is too low.
3. The credit player loses some and stands up. What they left with goes back to the float. They see a negative balance; the owner's Overview says they left owing, Members' Owes filter lists them, and Balances says they owe the club.
4. They pay outside ducy. The owner records it on their member page with Record payment and a note (a passkey unlock first). The float doesn't change. Balances drops the row and still adds up; the member sees the payment and note in My chips; Chips shows Debts paid.
5. The cash player stands up ahead. Balances says the club owes them; Take back with a note pays them out. All at zero, and it adds up.
6. A credit player at their limit asks for more from the table: the owner can only raise the limit or decline.
7. Agents: the agent sets a player's line (Your players → Credit, a passkey unlock first), and Your players shows each player's credit limit. The owner sees the line on the player's page but can't set or raise it. A player let in with a line isn't told to ask for chips. The player on credit counts against the agent's own limit, and their buy-in comes out of the float. Balances shows the agent's row, which carries their players; the agent's Your players shows the player's balance and seat.

**C10 The club site** (#637; on staging, club-staging.ducy.cards, then live)
1. Open club-staging.ducy.cards in a browser that has a player with a passkey on staging.ducy.cards: Sign in → Use your passkey brings the same player ID (Player settings shows it) and their clubs. No new ID was made.
2. A passkey that has never unlocked a club on staging.ducy.cards since it was made, with no copy: the club site says to unlock once on staging.ducy.cards first, and moves nothing. After that unlock, signing in on the club site works.
3. I'm new to ducy: a new player ID; Set up a passkey works; starting a club from a one-time link (#636) works there.
4. As owner on the club site: give chips, set credit, refill the float. As an agent: give chips. Each works.
5. On staging.ducy.cards, as the same player: no manager pages; the player app's manager links open the club site. A member's own chip ask works from staging.ducy.cards.
6. A demo club on the club site: switching to a player and back works (its players' pages are `app.html`); `app.html` without a demo goes to staging.ducy.cards.
7. At 375 px: the sign-in and the manager fit the screen.

## Manual: admin

On admin.ducy.cards, after the release (the admin site deploys with each release).

**A1 Access**
1. Opening admin.ducy.cards asks for the DirectAdmin password first.
2. In a fresh browser, it shows "Not on the admin list". Restore your admin key's backup file there: the Overview loads.
3. Switch Live, Staging and Sandbox: each loads, and Clubs, People, Admin log and Errors show that environment's.
4. Grants, club info and error reports work as before.
5. Someone who isn't an admin is refused cleanly, and nothing in the player app links to the admin site. `ducy.cards/admin.html` goes to admin.ducy.cards.

**A2 Usage**
1. On Staging, play three hands of a friends game with two browsers, and connect to a club as a member.
2. The Overview's last day shows one more friends game, its players, three more hands, and the member as an active player (your own admin ID isn't counted). Now shows the game and the member while they're connected.
3. Charts and Table show the same numbers, in light and dark mode.

**A3 Cloudflare** (only once `CF_ANALYTICS_TOKEN` is set on a relay)
1. The Overview shows a Cloudflare section for that relay, with requests, errors, CPU time and Durable Object requests; the others show none.

**A4 Versions**
1. Versions lists each site's release and each relay's commit. A password-protected site shows "Sign in" until you sign in to it in this browser; after that, its release shows.

## Manual: beta extras

Run a row only when that feature is about to be turned on.

- **B1:** Ducybot at each game and depth. The model loads, with progress shown on mobile data. It plays 50 hands without errors. Its description says what it's trained for and claims nothing more.
- **B2:** the heads-up challenge. Win and lose a rung. Progress is kept after a reload.
- **B3:** Study. Every tool opens. Equity results agree with a known example. The ranges and charts draw for every game.
- **B4:** hand review and live feedback. Turn each on and off. Review the grades on 10 hands.
- **B5:** Bankroll Quest. A new run, winning, going broke, travel and records.
- **B6:** each club feature in `src/club-beta.js`. First take it out of `OFF`. Then a manager can set it up, a member sees its effect, and the ledger adds up.
- **B7:** rake and time at cash tables (#449), with `cashRake` out of `OFF`, at desktop and phone width.
  1. Rules → Rake: "No rake" to start. Set 4.5% with a 2.5 BB cap: refused above 10% or at 0%; time below 0.05 or above 0.25 BB refused. New table → More options starts from it; set a table's own instead. Members see "Rake 4.5% · cap 2.5 BB" on the table before they sit, and the owner on the game's table cards and table rows.
  2. Play hands with two or three members: one that ends before the flop takes no rake (always); one that sees a flop does, in whole chips. A side pot and a run twice still pay out right. The hand log and the replay say "Rake …".
  3. Stand up: Chips → Rake and time shows each player's share today, over 7 days and in all, and per agent; the ledger has a "Rake and time" line from the house, and In the club still adds up.
  4. An agent's Your players shows their players' rake and time, and no one else's.
  5. A second table with House: Time, 0.25 BB: each player dealt in pays it every hand, from what they end it with (one who busts pays nothing); one sitting out doesn't.

## Results

Add one row per release, named by its tag (`v2026.11.20`) and the staging version it was tested on (the strip at the bottom of staging's pages). Name each device by its row in [Devices](#devices). List the failures as issue numbers. List what wasn't run, and why.

| Date | Release | Who | Devices | Passed | Failed | Not run |
|---|---|---|---|---|---|---|
| | | | | | | |
