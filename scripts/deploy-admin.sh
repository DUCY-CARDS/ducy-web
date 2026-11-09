#!/usr/bin/env bash
# Upload the admin site (build-admin.sh) to the admin.ducy.cards
# subdomain's folder, e.g. user@host:public_html/admin (DEPLOY.md, #601).
#
# The folder must be password-protected by DirectAdmin, which keeps the
# Auth*/Require lines in its .htaccess, and our upload replaces that file. So:
#   1. No folder yet (the subdomain hasn't been made): say what to make, and
#      stop without failing, so the rest of a release goes on.
#   2. Fetch the folder's .htaccess and put its Auth* and Require lines at the
#      top of the build's. With none, fail: the site never goes up open.
#   3. Refuse if a .htpasswd sits in the folder itself, which the upload
#      would delete.
# Then scripts/deploy.sh uploads it as it does the live site.
#
# Usage: scripts/deploy-admin.sh <site-dir> <rsync-target>
set -euo pipefail

SITE="${1:?usage: deploy-admin.sh <site-dir> <rsync-target>}"
TARGET="${2:?usage: deploy-admin.sh <site-dir> <rsync-target>}"
TARGET="${TARGET%/}"
PARENT="${TARGET%/*}"
NAME="${TARGET##*/}"

[ -f "$SITE/version.json" ] && grep -qF '"environment": "admin"' "$SITE/version.json" || { echo "$SITE doesn't look like a build-admin.sh output" >&2; exit 1; }

echo "== is there a folder for the admin site?"
LISTING="$(rsync --list-only "$PARENT/")"
if ! awk '$1 ~ /^d/ { print $NF }' <<< "$LISTING" | grep -qxF "$NAME"; then
  MSG="No $NAME/ folder on the host: the admin site wasn't deployed. In DirectAdmin, create the subdomain admin.ducy.cards (its folder is public_html/$NAME) and password-protect that folder, then run the release again."
  echo "::warning title=Admin site not deployed::$MSG"
  echo "$MSG" >&2
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== keep the folder's password protection"
rsync "$TARGET/.htaccess" "$WORK/remote.htaccess" 2>/dev/null || : > "$WORK/remote.htaccess"
grep -iE '^[[:space:]]*(Auth[A-Za-z]*|Require)[[:space:]]' "$WORK/remote.htaccess" > "$WORK/auth" || true
grep -qiE '^[[:space:]]*AuthUserFile[[:space:]]' "$WORK/auth" && grep -qiE '^[[:space:]]*Require[[:space:]]' "$WORK/auth" || {
  echo "::error title=Admin site not deployed::The $NAME/ folder isn't password-protected (no AuthUserFile and Require lines in its .htaccess). In DirectAdmin, password-protect public_html/$NAME, then run the release again."
  echo "the folder's .htaccess has no AuthUserFile and Require lines: not deploying an unprotected admin site" >&2
  exit 1
}
echo "kept $(wc -l < "$WORK/auth") Auth/Require lines"
{
  echo '# Password protection (DirectAdmin), carried over by scripts/deploy-admin.sh.'
  cat "$WORK/auth"
  echo
  cat "$SITE/.htaccess"
} > "$WORK/new.htaccess"
mv "$WORK/new.htaccess" "$SITE/.htaccess"

if rsync --list-only "$TARGET/" | awk '{ print $NF }' | grep -qxF .htpasswd; then
  echo "a .htpasswd is in the folder itself, and the upload would delete it" >&2
  exit 1
fi

scripts/deploy.sh "$SITE" "$TARGET"
