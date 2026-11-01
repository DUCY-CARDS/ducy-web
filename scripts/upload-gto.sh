#!/usr/bin/env bash
# Publishes a GTO bot model for the #play page.
#
#   scripts/upload-gto.sh <cards.bin> <blueprint.bin> <name> <rsync-target> [manifest]
#
# <cards.bin> is the compact card abstraction (ducy-gto's build_abstraction
# writes it as <abstraction>.compact, about 65 KB), <blueprint.bin> the
# trained blueprint (about 6 MB). They go to <target>/gto/<name>/, and the
# manifest, gto/current.json unless [manifest] names another, is pointed at
# them last, so visitors switch to the new model only once it's fully
# uploaded. Use a new <name> for every model: browsers keep the files for
# good, keyed by that folder.
#
# Each game has its own manifest: current.json for heads-up No-limit Hold'em,
# plo-current.json for heads-up PLO4, plo5-current.json for heads-up PLO5 and
# plo6-current.json for heads-up PLO6 (their cards.bin is the four-, five- or
# six-card PLO abstraction).
#
# The deploy workflow runs this for the newest gto-hunl-<name>, gto-plo-<name>,
# gto-plo5-<name> and gto-plo6-<name> release of the ducy repo, so publishing
# a model is: create that release with the two files attached, then deploy.
set -euo pipefail

USAGE="usage: upload-gto.sh <cards.bin> <blueprint.bin> <name> <rsync-target> [manifest]"
CARDS="${1:?$USAGE}"
BLUEPRINT="${2:?$USAGE}"
NAME="${3:?$USAGE}"
TARGET="${4:?$USAGE}"
MANIFEST="${5:-current.json}"

if ! [[ "$NAME" =~ ^[0-9a-zA-Z._-]+$ ]]; then
  echo "name must be letters, digits, '.', '_' or '-': $NAME" >&2
  exit 1
fi
if ! [[ "$MANIFEST" =~ ^[0-9a-zA-Z_-]+\.json$ ]]; then
  echo "manifest must be a plain .json file name: $MANIFEST" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/gto/$NAME"
cp "$CARDS" "$STAGE/gto/$NAME/cards.bin"
cp "$BLUEPRINT" "$STAGE/gto/$NAME/blueprint.bin"
printf '{"dir": "%s", "cards": "cards.bin", "blueprint": "blueprint.bin"}\n' "$NAME" > "$STAGE/$MANIFEST"

echo "== upload gto/$NAME"
rsync -avz "$STAGE/gto/" "$TARGET/gto/"
echo "== point gto/$MANIFEST at it"
rsync -avz "$STAGE/$MANIFEST" "$TARGET/gto/$MANIFEST"
