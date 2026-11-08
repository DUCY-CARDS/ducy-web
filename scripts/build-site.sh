#!/usr/bin/env bash
# Assemble the deployable site into OUT_DIR with every asset under
# v/<version>/, so a page only ever loads files from a single release.
#
#   OUT_DIR/index.html, manage.html, admin.html, privacy.html, admins.json, favicon.svg,
#     apple-touch-icon.png, icon-192.png, icon-512.png, manifest.webmanifest, .htaccess
#   OUT_DIR/v/<version>/src/*.js, style.css, avatars/*.svg
#   OUT_DIR/v/<version>/wasm/ducy_wasm.js, ducy_wasm_bg.wasm
#   OUT_DIR/v/<version>/relay/src/club-room.js, registry.js (a demo club's)
#
# Only index.html, manage.html (the club manager), admin.html and privacy.html are rewritten (to point
# at v/<version>/src/). The JS loads
# the workers and the WASM relative to its own URL, so those resolve
# inside the same release folder.
#
# Usage: scripts/build-site.sh <version> <out-dir>
# Expects the WASM build in ./wasm (ducy_wasm.js, ducy_wasm_bg.wasm).
#
# Settings, for staging and sandbox (DEPLOY.md):
#   DUCY_ENV     production (the default), staging or sandbox
#   RELAY_HOST   the relay's host, default ducy-relay.ducy.workers.dev; any
#                other is written into the JS and .htaccess's policy in its place
# Every build writes OUT_DIR/version.json. Any environment but production also
# gets a strip on each page naming it and the version, and a noindex header.
set -euo pipefail

VERSION="${1:?usage: build-site.sh <version> <out-dir>}"
OUT="${2:?usage: build-site.sh <version> <out-dir>}"
DUCY_ENV="${DUCY_ENV:-production}"
LIVE_RELAY_HOST='ducy-relay.ducy.workers.dev'
RELAY_HOST="${RELAY_HOST:-$LIVE_RELAY_HOST}"

if ! [[ "$VERSION" =~ ^[0-9a-zA-Z._-]+$ ]]; then
  echo "version must be letters, digits, '.', '_' or '-': $VERSION" >&2
  exit 1
fi
if ! [[ "$DUCY_ENV" =~ ^[a-z]+$ ]]; then
  echo "DUCY_ENV must be lowercase letters: $DUCY_ENV" >&2
  exit 1
fi
if ! [[ "$RELAY_HOST" =~ ^[a-z0-9.-]+$ ]]; then
  echo "RELAY_HOST must be a host name: $RELAY_HOST" >&2
  exit 1
fi
if [ "$DUCY_ENV" = production ] && [ "$RELAY_HOST" != "$LIVE_RELAY_HOST" ]; then
  echo "production uses the live relay, $LIVE_RELAY_HOST" >&2
  exit 1
fi
for f in wasm/ducy_wasm.js wasm/ducy_wasm_bg.wasm; do
  [ -f "$f" ] || { echo "missing $f (build ducy-wasm first)" >&2; exit 1; }
done

rm -rf "$OUT"
REL="$OUT/v/$VERSION"
mkdir -p "$REL/src" "$REL/wasm"

cp src/*.js src/*.css "$REL/src/"
cp -r src/avatars "$REL/src/"
cp wasm/ducy_wasm.js wasm/ducy_wasm_bg.wasm "$REL/wasm/"
# A demo club runs the relay's club room in the page (src/demo-relay.js, #406).
mkdir -p "$REL/relay/src"
cp relay/src/club-room.js relay/src/registry.js relay/src/error-log.js "$REL/relay/src/"
cp favicon.svg apple-touch-icon.png icon-192.png icon-512.png manifest.webmanifest .htaccess "$OUT/"
# Who may use the admin page (#401): public keys, so public. The relay
# bundles its own copy.
cp admins.json "$OUT/"
# The pre-flop charts' data (charts.js): Ducybot's and the Regulars', as JSON.
cp -r charts "$OUT/"

# Each source page carries the Content Security Policy in a <meta> tag, with a
# local relay, for local testing (#436). The site's pages don't: there the
# header from .htaccess is the only policy (#442), since a browser enforces
# both and Safari 15 needs a policy of its own that only the header picks.
NO_META=(-e '/<meta http-equiv="Content-Security-Policy"/d' -e '/<!-- Local testing only: the Content Security Policy/d')
CHECK="s#src=\"src/browser-check.js\"#src=\"v/$VERSION/src/browser-check.js\"#"

sed -e "s#href=\"src/style.css\"#href=\"v/$VERSION/src/style.css\"#" \
    -e "s#src=\"src/main.js\"#src=\"v/$VERSION/src/main.js\"#" \
    -e "$CHECK" "${NO_META[@]}" \
    index.html > "$OUT/index.html"

# Fail loudly if index.html changed shape and an asset was left unversioned.
for ref in "href=\"v/$VERSION/src/style.css\"" "src=\"v/$VERSION/src/main.js\"" "src=\"v/$VERSION/src/browser-check.js\""; do
  grep -qF "$ref" "$OUT/index.html" || { echo "index.html is missing $ref" >&2; exit 1; }
done
if grep -nE '(src|href)="(src|wasm)/' "$OUT/index.html"; then
  echo "index.html still references unversioned assets (above)" >&2
  exit 1
fi

# The club manager (manage.html, manage.js): a page of its own for running a
# club, pointed at the same release.
sed -e "s#href=\"src/style.css\"#href=\"v/$VERSION/src/style.css\"#" \
    -e "s#src=\"src/manage.js\"#src=\"v/$VERSION/src/manage.js\"#" \
    -e "$CHECK" "${NO_META[@]}" \
    manage.html > "$OUT/manage.html"
for ref in "href=\"v/$VERSION/src/style.css\"" "src=\"v/$VERSION/src/manage.js\"" "src=\"v/$VERSION/src/browser-check.js\""; do
  grep -qF "$ref" "$OUT/manage.html" || { echo "manage.html is missing $ref" >&2; exit 1; }
done
if grep -nE '(src|href)="(src|wasm)/' "$OUT/manage.html"; then
  echo "manage.html still references unversioned assets (above)" >&2
  exit 1
fi

# The super admin's page (#265, #401): unlinked, pointed at the same
# release. The relay answers only requests signed by a key in admins.json.
sed -e "s#href=\"src/admin.css\"#href=\"v/$VERSION/src/admin.css\"#" \
    -e "s#src=\"src/admin.js\"#src=\"v/$VERSION/src/admin.js\"#" \
    -e "$CHECK" "${NO_META[@]}" \
    admin.html > "$OUT/admin.html"
for ref in "href=\"v/$VERSION/src/admin.css\"" "src=\"v/$VERSION/src/admin.js\"" "src=\"v/$VERSION/src/browser-check.js\""; do
  grep -qF "$ref" "$OUT/admin.html" || { echo "admin.html is missing $ref" >&2; exit 1; }
done

# The privacy policy (#554): text only, no script, pointed at the same release.
sed -e "s#href=\"src/style.css\"#href=\"v/$VERSION/src/style.css\"#" \
    "${NO_META[@]}" \
    privacy.html > "$OUT/privacy.html"
grep -qF "href=\"v/$VERSION/src/style.css\"" "$OUT/privacy.html" || { echo "privacy.html is missing its stylesheet" >&2; exit 1; }

# No page carries a policy of its own (the header covers every file), nor
# mentions the local relay, nor has an inline script, <style> or on…=
# handler, which the policy would block.
grep -qF 'Header set Content-Security-Policy' "$OUT/.htaccess" || { echo ".htaccess sends no Content-Security-Policy" >&2; exit 1; }
for page in index.html manage.html admin.html privacy.html; do
  if grep -niF 'Content-Security-Policy' "$OUT/$page"; then
    echo "$page still has a policy of its own (above)" >&2
    exit 1
  fi
  if grep -nF 'localhost' "$OUT/$page"; then
    echo "$page still allows a local relay (above)" >&2
    exit 1
  fi
  if grep -nE '<script>|<script [^>]*>[^<]|<style|[[:space:]]on[a-z]+=' "$OUT/$page"; then
    echo "$page has inline code the policy blocks (above)" >&2
    exit 1
  fi
done

# Another environment's relay, in place of the live one: in the JS (play-net.js,
# admin.js, service-client.js, error-report.js) and the policy's connect-src.
if [ "$RELAY_HOST" != "$LIVE_RELAY_HOST" ]; then
  sed -i "s#//$LIVE_RELAY_HOST#//$RELAY_HOST#g" "$REL"/src/*.js "$OUT/.htaccess"
  if grep -rlF "$LIVE_RELAY_HOST" "$REL" "$OUT/.htaccess"; then
    echo "the live relay is still named in the files above" >&2
    exit 1
  fi
  grep -qF "connect-src 'self' wss://$RELAY_HOST https://$RELAY_HOST;" "$OUT/.htaccess" || { echo ".htaccess doesn't allow $RELAY_HOST" >&2; exit 1; }
fi

# Staging and sandbox: a strip on every page saying which site and release
# this is (an inline style attribute, which the policy allows), and no indexing.
if [ "$DUCY_ENV" != production ]; then
  case "$DUCY_ENV" in sandbox) BG='#f08a4b' ;; *) BG='#f5c542' ;; esac
  LABEL="${DUCY_ENV^} · $VERSION"
  STRIP="<div class=\"env-strip\" role=\"note\" style=\"position:fixed;left:0;bottom:0;z-index:2147483647;pointer-events:none;padding:2px 8px;font:600 11px/1.5 system-ui,sans-serif;color:#1b1b1b;background:$BG;border-top-right-radius:6px;opacity:.9\">$LABEL</div>"
  for page in index.html manage.html admin.html privacy.html; do
    sed -i "0,/<body[^>]*>/s||&\n$STRIP|" "$OUT/$page"
    grep -qF "$LABEL</div>" "$OUT/$page" || { echo "$page has no environment strip" >&2; exit 1; }
  done
  printf '\n# Not the live site: kept out of search engines.\n<IfModule mod_headers.c>\n  Header set X-Robots-Tag "noindex, nofollow"\n</IfModule>\n' >> "$OUT/.htaccess"
fi

# What this build is, for anyone asking a site what it runs.
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "${GITHUB_SHA:-}")"
DUCY_REV="$(scripts/ducy-rev.sh 2>/dev/null || true)"
{
  printf '{\n  "environment": "%s",\n  "version": "%s",\n  "commit": "%s",\n  "ducy": "%s",\n' "$DUCY_ENV" "$VERSION" "$COMMIT" "$DUCY_REV"
  printf '  "relay": "wss://%s",\n  "built": "%s",\n  "models": ' "$RELAY_HOST" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat gto-pins.json
  printf '}\n'
} > "$OUT/version.json"

echo "Built release $VERSION ($DUCY_ENV) in $OUT"
