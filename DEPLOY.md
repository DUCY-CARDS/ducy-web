# Deploying

| | Live | Staging | Sandbox |
|---|---|---|---|
| Site | ducy.cards | staging.ducy.cards | sandbox.ducy.cards |
| Relay (Worker) | `ducy-relay` | `ducy-relay-staging` | `ducy-relay-sandbox` |
| Deploys | a release, by hand, after approval (`deploy.yml`) | every push to master (`staging.yml`) | by hand, any branch (`sandbox.yml`) |
| Data | kept, backed up | kept, no backups | wiped Mondays and on request |
| Password | no | yes | yes |

Each relay is its own Worker, so its own Durable Objects: staging and
sandbox clubs never touch live ones. Each site has its own browser storage,
so testers get a separate player ID on each.

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
   PRs since the last one.

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
1. **The relay**, after its tests: `wrangler deploy --env <environment>`
   (`relay/wrangler.toml`), then checks `/version` reports the commit.
2. **The site**, built for that relay (`DUCY_ENV` and `RELAY_HOST` in
   `scripts/build-site.sh`), into the subdomain's folder:
   `scripts/deploy-env.sh` uploads it to `SSH_DEPLOY_TARGET/<environment>`.
3. **A check** that the site answers 401 (password protected).

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
