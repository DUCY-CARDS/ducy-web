# Deploying

| | Live | Staging | Sandbox |
|---|---|---|---|
| Site | ducy.cards | staging.ducy.cards | sandbox.ducy.cards |
| Relay (Worker) | `ducy-relay` | `ducy-relay-staging` | `ducy-relay-sandbox` |
| Deploys | every push to master (`deploy.yml`, `relay.yml`) | every push to master (`staging.yml`) | by hand, any branch (`sandbox.yml`) |
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
- **GitHub:** the repo's Environments page lists the last deploy to staging
  and sandbox.

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
symlink, `gto -> ../gto`. A new model pin reaches them when the live deploy
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
