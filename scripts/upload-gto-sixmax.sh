#!/usr/bin/env bash
# Publishes the six-handed GTO bot's preflop strategy (ducy #245): the newest
# gto-sixmax-<name> release of the ducy repo, with one strategy.bin asset
# (ducy-gto's sixmax_export writes it, about 2 MB).
#
#   scripts/upload-gto-sixmax.sh <rsync-target>
#
# It goes to <target>/gto/<tag>/strategy.bin (skipped when already there),
# then gto/sixmax-current.json points at it, last, so the page switches only
# once it's uploaded. The page (play-worker.js) loads it with loadGto6 for
# six-handed tables. Needs gh, logged in or with GH_TOKEN.
set -euo pipefail

TARGET="${1:?usage: upload-gto-sixmax.sh <rsync-target>}"
REPO=allenpiscitello/ducy

# The release gto-pins.json pins (a new model goes live when a PR moves the
# pin), else the newest.
PINS="$(dirname "$0")/../gto-pins.json"
TAG="$( [ -f "$PINS" ] && jq -r '."gto-sixmax-" // empty' "$PINS" || true)"
[ -n "$TAG" ] || TAG="$(gh release list -R "$REPO" --limit 100 --json tagName,publishedAt \
  -q '[.[] | select(.tagName | startswith("gto-sixmax-"))] | sort_by(.publishedAt) | last | .tagName // empty')"
if [ -z "$TAG" ]; then echo "no gto-sixmax release yet"; exit 0; fi
if ! [[ "$TAG" =~ ^[0-9a-zA-Z._-]+$ ]]; then echo "odd tag $TAG" >&2; exit 1; fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if rsync --list-only "$TARGET/gto/$TAG/strategy.bin" >/dev/null 2>&1; then
  echo "$TAG is already published"
else
  mkdir -p "$STAGE/gto/$TAG"
  gh release download "$TAG" -R "$REPO" -p strategy.bin -D "$STAGE/gto/$TAG" --clobber
  echo "== upload gto/$TAG"
  rsync -avz "$STAGE/gto/" "$TARGET/gto/"
fi
printf '{"dir": "%s", "strategy": "strategy.bin"}\n' "$TAG" > "$STAGE/sixmax-current.json"
echo "== point gto/sixmax-current.json at it"
rsync -avz "$STAGE/sixmax-current.json" "$TARGET/gto/sixmax-current.json"
