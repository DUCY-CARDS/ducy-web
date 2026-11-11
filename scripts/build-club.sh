#!/usr/bin/env bash
# Assemble the club site (club.ducy.cards, #637): the club manager, where
# owners and agents run their clubs, on an origin of its own, so the keys
# that move chips are kept only there. Laid out as build-site.sh lays out
# the main site, so scripts/deploy-club.sh can upload it:
#
#   OUT_DIR/index.html            manage.html, pointed at v/<version>/src/
#   OUT_DIR/privacy.html, favicon.svg, icons, admins.json, version.json
#   OUT_DIR/.htaccess             the main site's policy, without its
#                                 manage.html redirect (that's this site)
#   OUT_DIR/v/<version>/          the same release folder as the main site's
#
# Not password-protected: owners and agents sign in with passkeys.
#
# Usage: scripts/build-club.sh <version> <out-dir>
# Settings: DUCY_ENV and RELAY_HOST, as for build-site.sh. Staging's club
# site is club-staging.ducy.cards, the sandbox's club-sandbox.ducy.cards;
# the player app's link goes to <environment>.ducy.cards.
# Expects the site's WASM build in ./wasm (ducy_wasm.js, ducy_wasm_bg.wasm).
set -euo pipefail

VERSION="${1:?usage: build-club.sh <version> <out-dir>}"
OUT="${2:?usage: build-club.sh <version> <out-dir>}"
DUCY_ENV="${DUCY_ENV:-production}"
case "$DUCY_ENV" in
  production) CLUB_HOST=club.ducy.cards; PLAYER_HOST=ducy.cards ;;
  *) CLUB_HOST="club-$DUCY_ENV.ducy.cards"; PLAYER_HOST="$DUCY_ENV.ducy.cards" ;;
esac

scripts/build-site.sh "$VERSION" "$OUT" > /dev/null

# The manager is this site's page; the player app's pages aren't here.
mv "$OUT/manage.html" "$OUT/index.html"
rm -rf "$OUT/charts" "$OUT/manifest.webmanifest"
# The wordmark goes to the player app, on its own site.
sed -i "s#<a class=\"wordmark\" href=\"\./\"#<a class=\"wordmark\" href=\"https://$PLAYER_HOST/\"#" "$OUT/index.html"
grep -qF "<a class=\"wordmark\" href=\"https://$PLAYER_HOST/\"" "$OUT/index.html" || { echo "index.html's wordmark doesn't link to $PLAYER_HOST" >&2; exit 1; }
grep -qF "src=\"v/$VERSION/src/manage.js\"" "$OUT/index.html" || { echo "index.html isn't the club manager" >&2; exit 1; }

# .htaccess: this is where manage.html is sent, so an old address comes to
# the page here instead; and no search engine lists it.
sed -i "s#https://$CLUB_HOST/ \[L,R=302\]#/ [L,R=302]#" "$OUT/.htaccess"
if grep -nF "https://$CLUB_HOST/" "$OUT/.htaccess"; then
  echo ".htaccess still sends manage.html to this site (above)" >&2
  exit 1
fi
grep -qF 'RewriteRule ^manage\.html$ / [L,R=302]' "$OUT/.htaccess" || { echo ".htaccess has no manage.html rule" >&2; exit 1; }
if [ "$DUCY_ENV" = production ]; then
  printf '\n# The club manager: kept out of search engines.\n<IfModule mod_headers.c>\n  Header set X-Robots-Tag "noindex, nofollow"\n</IfModule>\n' >> "$OUT/.htaccess"
fi

# version.json says which site this is.
sed -i "s#^{\$#{\n  \"site\": \"club\",#" "$OUT/version.json"
grep -qF '"site": "club"' "$OUT/version.json" || { echo "version.json doesn't name the club site" >&2; exit 1; }

echo "Built the club site ($DUCY_ENV, $CLUB_HOST), release $VERSION, in $OUT"
