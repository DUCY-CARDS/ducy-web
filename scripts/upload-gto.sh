#!/usr/bin/env bash
# Publishes a GTO bot model for the #play page.
#
#   scripts/upload-gto.sh <cards.bin> <blueprint.bin> <name> <rsync-target>
#
# <cards.bin> is the compact card abstraction (ducy-gto's build_abstraction
# writes it as <abstraction>.compact, about 65 KB), <blueprint.bin> the
# trained blueprint (about 6 MB). They go to <target>/gto/<name>/, and
# gto/current.json is pointed at them last, so visitors switch to the new
# model only once it's fully uploaded. Use a new <name> for every model:
# browsers keep the files for good, keyed by that folder.
#
# The deploy workflow runs this for the newest gto-<name> release of the
# ducy repo, so publishing a model is: create that release with the two
# files attached, then deploy.
set -euo pipefail

CARDS="${1:?usage: upload-gto.sh <cards.bin> <blueprint.bin> <name> <rsync-target>}"
BLUEPRINT="${2:?usage: upload-gto.sh <cards.bin> <blueprint.bin> <name> <rsync-target>}"
NAME="${3:?usage: upload-gto.sh <cards.bin> <blueprint.bin> <name> <rsync-target>}"
TARGET="${4:?usage: upload-gto.sh <cards.bin> <blueprint.bin> <name> <rsync-target>}"

if ! [[ "$NAME" =~ ^[0-9a-zA-Z._-]+$ ]]; then
  echo "name must be letters, digits, '.', '_' or '-': $NAME" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/gto/$NAME"
cp "$CARDS" "$STAGE/gto/$NAME/cards.bin"
cp "$BLUEPRINT" "$STAGE/gto/$NAME/blueprint.bin"
printf '{"dir": "%s", "cards": "cards.bin", "blueprint": "blueprint.bin"}\n' "$NAME" > "$STAGE/current.json"

echo "== upload gto/$NAME"
rsync -avz "$STAGE/gto/" "$TARGET/gto/"
echo "== point gto/current.json at it"
rsync -avz "$STAGE/current.json" "$TARGET/gto/current.json"
