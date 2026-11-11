# Deploying

| | Live | Staging | Sandbox |
|---|---|---|---|
| Site | ducy.cards | staging.ducy.cards | sandbox.ducy.cards |
| Club site (#637) | club.ducy.cards | club-staging.ducy.cards | club-sandbox.ducy.cards |
| Its folder | `public_html/club` | `public_html/club-staging` | `public_html/club-sandbox` |
| Relay (Worker) | `ducy-relay` | `ducy-relay-staging` | `ducy-relay-sandbox` |
| Judge (Worker, #615) | `ducy-judge` | `ducy-judge-staging` | `ducy-judge-sandbox` |
| Deploys | a release, by hand, after approval (`deploy.yml`) | every push to master (`staging.yml`) | by hand, any branch (`sandbox.yml`) |
| Data | kept, backed up | kept, no backups | wiped Mondays and on request |
| Password | no (club site: no) | yes (club site: yes) | yes (club site: yes) |

Each relay is its own Worker, so its own Durable Objects: staging and
sandbox clubs never touch live ones. Each site has its own browser storage,
so testers get a separate player ID on each.

The admin site, **admin.ducy.cards**, is one site for all three: it reads
each relay's admin API (signed with a key in `admins.json`) and each site's
`version.json`. See [The admin site](#the-admin-site).

Each environment's club manager is a site of its own: see
[The club site](#the-club-site).

## What's running where

- **The site:** `/version.json`: environment, release folder, site commit,
  pinned ducy commit, relay and model pins. Staging and sandbox pages also
  show a strip at the bottom left, e.g. "Staging · 6221c90d-7cfc4679".
- **The relay:** `GET /version` answers its environment and commit.
- **GitHub:** the repo's Environments page lists the last deploy to each
  environment; Releases lists each release's tag and its PRs.

## Releasing to ducy.cards

Merging to master deploys staging only. The live site and relay change only
in a release: **Deploy production** (`deploy.yml`), which ships both from one
commit in one run.

1. Check the release on staging.ducy.cards ([TEST-PLAN.md](TEST-PLAN.md)).
2. Actions → **Deploy production** → Run workflow, with **ref** empty.
3. Approve the run (the `production` environment needs your review).
4. The run builds and tests, deploys the relay, then the site and the bot
   models, then tags the commit `vYYYY.MM.DD` (`vYYYY.MM.DD.2`, `.3` for
   later releases that day) and makes a GitHub release with notes from the
   PRs since the last one. The club site goes up right after the site, and
   the admin site last (both below).

If the commit already has a release tag, it's redeployed under that tag
and no new one is made.

**Rolling back:** run **Deploy production** with **ref** set to an earlier
tag, e.g. `v2026.11.20`. It redeploys that tag's site and relay and makes no
new tag. The site keeps its last 5 release folders, so pages still open keep
working. The bot models aren't rolled back: a model already published stays
the one `gto/*current.json` points at.

**Hotfix:**
1. Branch from the live tag: `git switch -c hotfix/<name> v2026.11.20`, fix,
   push.
2. Deploy the branch to the sandbox (below) and check it there.
3. Run **Deploy production** with **ref** set to the branch. It's tagged and
   released as for master.
4. Merge the fix into master as usual.

## Staging and sandbox

`deploy-env.yml` deploys one commit:
1. **The relay**, after its tests. First the judge
   (`relay/judge/wrangler.toml`), whose Durable Object the relay binds to,
   then `wrangler deploy --env <environment>` (`relay/wrangler.toml`), then
   checks that `/version` reports the commit.
2. **The site**, built for that relay (`DUCY_ENV` and `RELAY_HOST` in
   `scripts/build-site.sh`), into the subdomain's folder:
   `scripts/deploy-env.sh` uploads it to `SSH_DEPLOY_TARGET/<environment>`.
3. **A check** that the site answers 401 (password protected).
4. **The club site** (below) into `SSH_DEPLOY_TARGET/club-<environment>`,
   keeping that folder's password as for the site, then the same 401 check.
   Skipped with a warning while the folder doesn't exist.

**Password protection:** DirectAdmin protects each subdomain's folder with
Auth lines in its `.htaccess`. `deploy-env.sh` copies those lines into the
new `.htaccess` and stops if it can't find them, so the site is never
published open. To change the password, use DirectAdmin; the next deploy
keeps it.

**The live site's `.htaccess`** also applies inside these folders. Their
own `.htaccess` sets its own policy (naming its relay) and rewrite rules,
which replace the live site's.

**Bot models:** staging and sandbox share the live site's `gto/` through a
symlink, `gto -> ../gto`. A new model pin reaches them when a release
publishes it.

## Deploying the sandbox

Actions → **Deploy sandbox** → Run workflow: give a branch, tag or commit,
and tick **reset** to wipe its data afterwards. Or:

```sh
gh workflow run sandbox.yml -R DUCY-CARDS/ducy-web -f ref=my-branch -f reset=false
```

## Resetting the sandbox

Actions → **Reset sandbox** → Run workflow, or
`gh workflow run sandbox-reset.yml -R DUCY-CARDS/ducy-web`. It also runs
Mondays at 06:00 UTC.

It wipes every always-on club's room and the registry (grants, the admin
log, error reports): `relay/src/reset.js`. Friends tables keep their few
queued messages, which expire in 7 days anyway. The relay answers `/reset`
only where `RESETTABLE = "on"` (the sandbox alone) and with a `RESET_TOKEN`
secret; the workflow sets a fresh random token for each run and replaces it
afterwards.

## The club site

club.ducy.cards (#637): the club manager, where owners and agents run their
clubs (Needs you, Members, Rules, Chips, Balances, Tables, Your players,
Fair play). ducy.cards keeps what players need: joining a club, the tables,
My chips, the lobby. Built by `scripts/build-club.sh` from the same release
as the site: `manage.html` becomes its `index.html`.

**Deploys** with each release, right after the site:
`scripts/deploy-club.sh` uploads it to `SSH_DEPLOY_TARGET/club`, the
subdomain's folder (DirectAdmin names a subdomain's folder after it, as it
did `admin/`). Staging and sandbox deploy theirs to `club-staging/` and
`club-sandbox/`. With no folder, the step is skipped with a warning saying
what to create. The live deploy (`scripts/deploy.sh`) leaves all three
folders alone.

**Open on live:** no folder password. Owners and agents sign in with
passkeys, and the upload replaces the folder's `.htaccess`, so a password
set in DirectAdmin wouldn't last anyway. Staging's and the sandbox's are
password-protected like their sites (the deploy keeps the folder's Auth
lines and never uploads to a folder without them).

**One passkey for both:** passkeys belong to `ducy.cards` (the WebAuthn
relying party for every subdomain), so a player's passkey works on both
sites. The club site has its own browser storage, so its first visit asks
for the passkey before making a new player ID (`src/site-signin.js`): the
relay's copy of the player's key, opened with the passkey (PRF), brings the
same player ID over. The relay never vouches for a club site (no moving
anyone's clubs to its fresh ID); a passkey without a copy yet gets one at
its next unlock on ducy.cards.

**Running a club only there:** each relay takes club running (making or
moving a club, the owner's connection and commands, an agent's commands)
only from a connection on a club site with a passkey session made on a
club site (`CLUB_ORIGINS` in `relay/wrangler.toml`; `relay/src/unlock.js`
`siteOk`). A player's own messages (asking for chips, their vault) still
come from ducy.cards. The player app has no club manager page; its manager
links go to the club site.

**Demo clubs** play every part in one window, so on one site: on the club
site, their players' pages are its `app.html`, which sends anyone not in
a demo to ducy.cards.

**Before the first deploy:**
1. Live: DirectAdmin → Subdomains → `club` (folder `public_html/club`), no
   password protection, with a certificate (Let's Encrypt) for
   club.ducy.cards.
2. Staging: the same for `club-staging` (folder `public_html/club-staging`),
   password-protected like `staging/`. Sandbox: `club-sandbox` likewise.
   Until they exist, their deploys just warn.

## The admin site

admin.ducy.cards (#601): usage and relay numbers for live, staging and
sandbox, and the club admin that used to be `admin.html` (which now
redirects there). Built by `scripts/build-admin.sh` from `admin.html`,
`src/admin*.js` and `admin.htaccess`.

**Deploys** with each release, as the last step of **Deploy production**:
`scripts/deploy-admin.sh` uploads it to `SSH_DEPLOY_TARGET/admin`, the
subdomain's folder. The live deploy (`scripts/deploy.sh`) leaves that folder
alone, as it does `staging/` and `sandbox/`.

**Two locks:**
1. **The folder's password** (DirectAdmin). As for staging, the deploy
   copies the folder's Auth lines into the new `.htaccess`. With no folder,
   the step is skipped with a warning saying what to create, and the rest of
   the release is unaffected. With a folder but no Auth lines, the step fails
   and uploads nothing: the site never goes up open.
2. **An admin key.** Every request to a relay is signed; each relay answers
   only keys in its `admins.json`. The site has its own browser storage, so
   bring your key over once: on "Not on the admin list", restore your
   identity backup file (You → Back up this device, on ducy.cards).

Each relay allows the site's origin for its admin API only (`ADMIN_ORIGINS`
in `relay/wrangler.toml`). Each site's `.htaccess` lets the admin site read
its `version.json`; on staging and sandbox that works once you've signed in
to that site in the same browser (else the site shows "Sign in").

**Usage counts** (`relay/src/stats.js`): each relay's registry keeps totals
per day for 90 days: active and new players, friends games and players per
game, hands, clubs active and club hands. The admins' own player IDs aren't
counted. Active players come from a per-day set of salted hashes of player
IDs, deleted once the day is counted; new players from a Bloom filter of the
same hashes. Counts only: no list of who played, no IPs, no places.

**Cloudflare's numbers** (optional): requests, errors, CPU time and Durable
Object requests per day, read by each relay from Cloudflare's analytics API
and shown only when that relay has both secrets:

```sh
cd relay
npx wrangler secret put CF_ANALYTICS_TOKEN            # live
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_ANALYTICS_TOKEN --env staging
npx wrangler secret put CF_ACCOUNT_ID --env staging
npx wrangler secret put CF_ANALYTICS_TOKEN --env sandbox
npx wrangler secret put CF_ACCOUNT_ID --env sandbox
```

The token needs only **Account → Account Analytics → Read**. It stays in the
Worker; the page never sees it.
