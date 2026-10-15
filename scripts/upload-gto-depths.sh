#!/usr/bin/env bash
# Publishes the Hold'em GTO bot's blueprints for other depths (ducy #251):
# the newest gto-depth-hunl-<N>bb-<name> release of the ducy repo for each
# depth N, each with one blueprint-<N>.bin asset, trained on the same card
# abstraction as the main model (gto/current.json).
#
#   scripts/upload-gto-depths.sh <rsync-target>
#
# Each goes to <target>/gto/<tag>/blueprint.bin (skipped when already there),
# then gto/depths.json lists them all, last, so the page sees a depth only
# once it's uploaded. The page (play-worker.js) loads them after the main
# model. Needs gh, logged in or with GH_TOKEN.
set -euo pipefail

TARGET="${1:?usage: upload-gto-depths.sh <rsync-target>}"
REPO=allenpiscitello/ducy

# The newest release for each depth: "<bb> <tag>" lines.
mapfile -t ROWS < <(gh release list -R "$REPO" --limit 100 --json tagName,publishedAt \
  -q '[.[] | select(.tagName | test("^gto-depth-hunl-[0-9]+bb-"))
      | {bb: (.tagName | capture("^gto-depth-hunl-(?<n>[0-9]+)bb-").n | tonumber), tag: .tagName, at: .publishedAt}]
      | group_by(.bb) | map(sort_by(.at) | last) | .[] | "\(.bb) \(.tag)"')
if [ ${#ROWS[@]} -eq 0 ]; then echo "no gto-depth-hunl releases yet"; exit 0; fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
LIST=""
for ROW in "${ROWS[@]}"; do
  BB="${ROW%% *}"
  TAG="${ROW#* }"
  if ! [[ "$TAG" =~ ^[0-9a-zA-Z._-]+$ ]]; then echo "skipping odd tag $TAG" >&2; continue; fi
  if rsync --list-only "$TARGET/gto/$TAG/blueprint.bin" >/dev/null 2>&1; then
    echo "$TAG is already published"
  else
    mkdir -p "$STAGE/dl" "$STAGE/gto/$TAG"
    gh release download "$TAG" -R "$REPO" -p "blueprint-$BB.bin" -D "$STAGE/dl" --clobber
    mv "$STAGE/dl/blueprint-$BB.bin" "$STAGE/gto/$TAG/blueprint.bin"
    echo "== upload gto/$TAG"
    rsync -avz "$STAGE/gto/" "$TARGET/gto/"
    rm -rf "$STAGE/gto"
  fi
  LIST="$LIST${LIST:+, }{\"bb\": $BB, \"dir\": \"$TAG\", \"blueprint\": \"blueprint.bin\"}"
done
printf '[%s]\n' "$LIST" > "$STAGE/depths.json"
echo "== point gto/depths.json at them"
rsync -avz "$STAGE/depths.json" "$TARGET/gto/depths.json"
