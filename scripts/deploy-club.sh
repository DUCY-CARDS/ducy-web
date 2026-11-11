#!/usr/bin/env bash
# Upload the club site (build-club.sh, #637) to its subdomain's folder:
#   live      club.ducy.cards           SSH_DEPLOY_TARGET/club
#   staging   club-staging.ducy.cards   SSH_DEPLOY_TARGET/club-staging
#   sandbox   club-sandbox.ducy.cards   SSH_DEPLOY_TARGET/club-sandbox
# (DEPLOY.md). DirectAdmin keeps each subdomain's folder inside the live
# site's, so the folder name is the one it makes for the subdomain.
#
#   1. No folder yet (the subdomain hasn't been made): say what to make, and
#      stop without failing, so the rest of the deploy goes on.
#   2. The live club site is open (owners and agents sign in with passkeys):
#      scripts/deploy.sh uploads it as it does the live site. Staging's and
#      the sandbox's are password-protected like their sites:
#      scripts/deploy-env.sh keeps the folder's password, and never uploads
#      to a folder without one.
# With GITHUB_OUTPUT set, writes deployed=true or false there.
#
# Usage: scripts/deploy-club.sh <site-dir> <rsync-target>
set -euo pipefail

SITE="${1:?usage: deploy-club.sh <site-dir> <rsync-target>}"
TARGET="${2:?usage: deploy-club.sh <site-dir> <rsync-target>}"
TARGET="${TARGET%/}"
PARENT="${TARGET%/*}"
NAME="${TARGET##*/}"
out() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "deployed=$1" >> "$GITHUB_OUTPUT"; }

[ -f "$SITE/version.json" ] && grep -qF '"site": "club"' "$SITE/version.json" || { echo "$SITE doesn't look like a build-club.sh output" >&2; exit 1; }
ENV_NAME="$(grep -oE '"environment": "[a-z]+"' "$SITE/version.json" | grep -oE '[a-z]+"$' | tr -d '"')"
case "$ENV_NAME" in
  production) HOST=club.ducy.cards; WANT=club ;;
  staging|sandbox) HOST="club-$ENV_NAME.ducy.cards"; WANT="club-$ENV_NAME" ;;
  *) echo "not an environment: $ENV_NAME" >&2; exit 1 ;;
esac
[ "$NAME" = "$WANT" ] || { echo "a $ENV_NAME club site goes in a folder named $WANT, not $NAME" >&2; exit 1; }

echo "== is there a folder for $HOST?"
LISTING="$(rsync --list-only "$PARENT/")"
if ! awk '$1 ~ /^d/ { print $NF }' <<< "$LISTING" | grep -qxF "$NAME"; then
  MSG="No $NAME/ folder on the host: the club site wasn't deployed. In DirectAdmin, create the subdomain $HOST (its folder is public_html/$NAME), then deploy again."
  [ "$ENV_NAME" = production ] || MSG="$MSG Password-protect that folder as $ENV_NAME.ducy.cards is."
  echo "::warning title=Club site not deployed::$MSG"
  echo "$MSG" >&2
  out false
  exit 0
fi

if [ "$ENV_NAME" = production ]; then
  scripts/deploy.sh "$SITE" "$TARGET"
else
  scripts/deploy-env.sh "$SITE" "$TARGET"
fi
out true
