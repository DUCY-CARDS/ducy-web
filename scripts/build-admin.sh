#!/usr/bin/env bash
# Assemble the admin site (admin.ducy.cards, #601) into OUT_DIR, laid out as
# build-site.sh lays out the main site, so scripts/deploy.sh can upload it:
#
#   OUT_DIR/index.html            admin.html, pointed at v/<version>/src/
#   OUT_DIR/.htaccess             admin.htaccess (deploy-admin.sh adds the
#                                 folder's password protection on top)
#   OUT_DIR/version.json, favicon.svg
#   OUT_DIR/v/<version>/src/      admin.js and what it loads
#   OUT_DIR/v/<version>/wasm/     ducy's engine (signing, player IDs)
#
# One site for every environment: the page reads each one's relay. The
# relays answer only requests signed by a key in admins.json.
#
# Usage: scripts/build-admin.sh <version> <out-dir>
# Expects the site's WASM build in ./wasm (ducy_wasm.js, ducy_wasm_bg.wasm).
set -euo pipefail

VERSION="${1:?usage: build-admin.sh <version> <out-dir>}"
OUT="${2:?usage: build-admin.sh <version> <out-dir>}"

if ! [[ "$VERSION" =~ ^[0-9a-zA-Z._-]+$ ]]; then
  echo "version must be letters, digits, '.', '_' or '-': $VERSION" >&2
  exit 1
fi
for f in wasm/ducy_wasm.js wasm/ducy_wasm_bg.wasm; do
  [ -f "$f" ] || { echo "missing $f (build ducy-wasm first)" >&2; exit 1; }
done

# The page's modules: admin.js and everything it imports, in src/.
FILES=(admin.js admin.css admin-charts.js identity.js chip-format.js time-ago.js browser-check.js)

rm -rf "$OUT"
REL="$OUT/v/$VERSION"
mkdir -p "$REL/src" "$REL/wasm"
for f in "${FILES[@]}"; do cp "src/$f" "$REL/src/"; done
cp wasm/ducy_wasm.js wasm/ducy_wasm_bg.wasm "$REL/wasm/"
cp favicon.svg "$OUT/"
cp admin.htaccess "$OUT/.htaccess"

# Every import resolves inside the release folder.
for f in "$REL"/src/*.js; do
  for dep in $(grep -oE "from '\./[a-z0-9-]+\.js'" "$f" | grep -oE '[a-z0-9-]+\.js'); do
    [ -f "$REL/src/$dep" ] || { echo "$(basename "$f") imports $dep, which build-admin.sh doesn't copy" >&2; exit 1; }
  done
done

sed -e "s#href=\"src/admin.css\"#href=\"v/$VERSION/src/admin.css\"#" \
    -e "s#src=\"src/admin.js\"#src=\"v/$VERSION/src/admin.js\"#" \
    -e "s#src=\"src/browser-check.js\"#src=\"v/$VERSION/src/browser-check.js\"#" \
    -e '/<meta http-equiv="Content-Security-Policy"/d' \
    admin.html > "$OUT/index.html"
for ref in "href=\"v/$VERSION/src/admin.css\"" "src=\"v/$VERSION/src/admin.js\"" "src=\"v/$VERSION/src/browser-check.js\""; do
  grep -qF "$ref" "$OUT/index.html" || { echo "admin.html is missing $ref" >&2; exit 1; }
done
if grep -nE '(src|href)="(src|wasm)/' "$OUT/index.html"; then
  echo "index.html still references unversioned assets (above)" >&2
  exit 1
fi
if grep -niE 'Content-Security-Policy|localhost' "$OUT/index.html"; then
  echo "index.html still has a policy of its own, or a local relay (above)" >&2
  exit 1
fi
grep -qF 'Header set Content-Security-Policy' "$OUT/.htaccess" || { echo ".htaccess sends no Content-Security-Policy" >&2; exit 1; }

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "${GITHUB_SHA:-}")"
printf '{\n  "environment": "admin",\n  "version": "%s",\n  "commit": "%s",\n  "built": "%s"\n}\n' "$VERSION" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/version.json"

echo "Built the admin site, release $VERSION, in $OUT"
