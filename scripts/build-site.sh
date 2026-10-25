#!/usr/bin/env bash
# Assemble the deployable site into OUT_DIR with every asset under
# v/<version>/, so a page only ever loads files from a single release.
#
#   OUT_DIR/index.html, manage.html, admin.html, favicon.svg, apple-touch-icon.png,
#     icon-192.png, icon-512.png, manifest.webmanifest, .htaccess
#   OUT_DIR/v/<version>/src/*.js, style.css, avatars/*.svg
#   OUT_DIR/v/<version>/wasm/ducy_wasm.js, ducy_wasm_bg.wasm
#   OUT_DIR/v/<version>/relay/src/club-room.js, registry.js (a demo club's)
#
# Only index.html and manage.html (the club manager) are rewritten (to point
# at v/<version>/src/). The JS loads
# mc.js, the workers and the WASM relative to its own URL, so those resolve
# inside the same release folder.
#
# Usage: scripts/build-site.sh <version> <out-dir>
# Expects the WASM build in ./wasm (ducy_wasm.js, ducy_wasm_bg.wasm).
set -euo pipefail

VERSION="${1:?usage: build-site.sh <version> <out-dir>}"
OUT="${2:?usage: build-site.sh <version> <out-dir>}"

if ! [[ "$VERSION" =~ ^[0-9a-zA-Z._-]+$ ]]; then
  echo "version must be letters, digits, '.', '_' or '-': $VERSION" >&2
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
cp relay/src/club-room.js relay/src/registry.js "$REL/relay/src/"
cp favicon.svg apple-touch-icon.png icon-192.png icon-512.png manifest.webmanifest .htaccess "$OUT/"
# The super admin's page (#265): self-contained, unlinked, and useless
# without the relay's ADMIN_TOKEN.
cp admin.html "$OUT/"
# The pre-flop charts' data (charts.js): Ducybot's and the Regulars', as JSON.
cp -r charts "$OUT/"

sed -e "s#href=\"src/style.css\"#href=\"v/$VERSION/src/style.css\"#" \
    -e "s#src=\"src/main.js\"#src=\"v/$VERSION/src/main.js\"#" \
    index.html > "$OUT/index.html"

# Fail loudly if index.html changed shape and an asset was left unversioned.
for ref in "href=\"v/$VERSION/src/style.css\"" "src=\"v/$VERSION/src/main.js\""; do
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
    manage.html > "$OUT/manage.html"
for ref in "href=\"v/$VERSION/src/style.css\"" "src=\"v/$VERSION/src/manage.js\""; do
  grep -qF "$ref" "$OUT/manage.html" || { echo "manage.html is missing $ref" >&2; exit 1; }
done
if grep -nE '(src|href)="(src|wasm)/' "$OUT/manage.html"; then
  echo "manage.html still references unversioned assets (above)" >&2
  exit 1
fi

echo "Built release $VERSION in $OUT"
