#!/usr/bin/env bash
# Assemble the club site (club.ducy.cards, #637): the club manager, where
# owners and agents run their clubs, on an origin of its own. Laid out as
# build-site.sh lays out the main site, so scripts/deploy-club.sh can upload
# it:
#
#   OUT_DIR/index.html            manage.html, pointed at v/<version>/src/
#   OUT_DIR/app.html              the player app's page, for demo clubs only
#                                 (a demo plays every part in one window, so
#                                 on one site); anything else goes to ducy.cards
#   OUT_DIR/privacy.html, favicon.svg, icons, version.json, .htaccess
#   OUT_DIR/v/<version>/          the same release folder as the main site's
#
# Not password-protected: owners and agents sign in with passkeys.
#
# Usage: scripts/build-club.sh <version> <out-dir>
# Settings: DUCY_ENV and RELAY_HOST, as for build-site.sh. Staging's club
# site is club-staging.ducy.cards, the sandbox's club-sandbox.ducy.cards
# (src/sites.js, which also points the page's links at its player app).
# Expects the site's WASM build in ./wasm (ducy_wasm.js, ducy_wasm_bg.wasm).
set -euo pipefail

VERSION="${1:?usage: build-club.sh <version> <out-dir>}"
OUT="${2:?usage: build-club.sh <version> <out-dir>}"
DUCY_ENV="${DUCY_ENV:-production}"
case "$DUCY_ENV" in production) CLUB_HOST=club.ducy.cards ;; *) CLUB_HOST="club-$DUCY_ENV.ducy.cards" ;; esac

DUCY_SITE=club scripts/build-site.sh "$VERSION" "$OUT" > /dev/null

# The manager is this site's page.
mv "$OUT/index.html" "$OUT/app.html"
mv "$OUT/manage.html" "$OUT/index.html"
grep -qF "src=\"v/$VERSION/src/manage.js\"" "$OUT/index.html" || { echo "index.html isn't the club manager" >&2; exit 1; }
grep -qF "src=\"v/$VERSION/src/main.js\"" "$OUT/app.html" || { echo "app.html isn't the player app" >&2; exit 1; }

# No search engine lists it (staging's and the sandbox's already say so).
if [ "$DUCY_ENV" = production ]; then
  printf '\n# The club manager: kept out of search engines.\n<IfModule mod_headers.c>\n  Header set X-Robots-Tag "noindex, nofollow"\n</IfModule>\n' >> "$OUT/.htaccess"
fi

# version.json says which site this is.
sed -i "s#^{\$#{\n  \"site\": \"club\",#" "$OUT/version.json"
grep -qF '"site": "club"' "$OUT/version.json" || { echo "version.json doesn't name the club site" >&2; exit 1; }

echo "Built the club site ($DUCY_ENV, $CLUB_HOST), release $VERSION, in $OUT"
