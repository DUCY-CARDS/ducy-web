#!/usr/bin/env bash
# Upload a staging or sandbox build (build-site.sh with DUCY_ENV set) to its
# folder on the host, e.g. user@host:public_html/staging (DEPLOY.md).
#
# Those folders are password-protected by DirectAdmin, which keeps the
# Auth*/Require lines in the folder's .htaccess, and our upload replaces that
# file. So first:
#   1. Fetch the folder's .htaccess and put its Auth* and Require lines at the
#      top of the build's. With none, stop: never publish an open site.
#   2. Refuse if a .htpasswd sits in the folder itself, which the upload
#      would delete.
#   3. Add gto -> ../gto, so the site shares the live site's bot models.
# Then scripts/deploy.sh uploads it as it does the live site.
#
# Usage: scripts/deploy-env.sh <site-dir> <rsync-target>
set -euo pipefail

SITE="${1:?usage: deploy-env.sh <site-dir> <rsync-target>}"
TARGET="${2:?usage: deploy-env.sh <site-dir> <rsync-target>}"

[ -f "$SITE/version.json" ] || { echo "$SITE doesn't look like a build-site.sh output" >&2; exit 1; }
if grep -qF '"environment": "production"' "$SITE/version.json"; then
  echo "$SITE is a production build; the live site deploys with scripts/deploy.sh" >&2
  exit 1
fi
grep -qF 'class="env-strip"' "$SITE/index.html" || { echo "$SITE/index.html has no environment strip" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== keep the folder's password protection"
rsync "$TARGET/.htaccess" "$WORK/remote.htaccess"
grep -iE '^[[:space:]]*(Auth[A-Za-z]*|Require)[[:space:]]' "$WORK/remote.htaccess" > "$WORK/auth" || true
grep -qiE '^[[:space:]]*AuthUserFile[[:space:]]' "$WORK/auth" && grep -qiE '^[[:space:]]*Require[[:space:]]' "$WORK/auth" || {
  echo "the folder's .htaccess has no AuthUserFile and Require lines: not deploying an unprotected site" >&2
  exit 1
}
echo "kept $(wc -l < "$WORK/auth") Auth/Require lines"
{
  echo '# Password protection (DirectAdmin), carried over by scripts/deploy-env.sh.'
  cat "$WORK/auth"
  echo
  cat "$SITE/.htaccess"
} > "$WORK/new.htaccess"
mv "$WORK/new.htaccess" "$SITE/.htaccess"

if rsync --list-only "$TARGET/" | awk '{ print $NF }' | grep -qxF .htpasswd; then
  echo "a .htpasswd is in the folder itself, and the upload would delete it" >&2
  exit 1
fi

echo "== share the live site's bot models"
rm -rf "$SITE/gto"
ln -s ../gto "$SITE/gto"

scripts/deploy.sh "$SITE" "$TARGET"
