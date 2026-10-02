#!/usr/bin/env bash
# Upload a site built by build-site.sh so visitors never get a mix of files
# from two releases:
#
#   1. Upload the new release folder (v/<version>/). Nothing points at it yet.
#   2. Upload the root files. rsync writes index.html to a temporary name and
#      renames it into place, so a request sees either the old page (whose
#      release folder is still there) or the new one (whose folder is complete).
#      Stale root files, like the old unversioned src/ and wasm/, are deleted
#      only after that.
#   3. Delete all but the newest KEEP releases, leaving recent ones for pages
#      that are still loading. Uses rsync only, so it works with a key that
#      can't run shell commands.
#
# Usage: scripts/deploy.sh <site-dir> <rsync-target>   (e.g. user@host:/var/www)
set -euo pipefail

SITE="${1:?usage: deploy.sh <site-dir> <rsync-target>}"
TARGET="${2:?usage: deploy.sh <site-dir> <rsync-target>}"
KEEP="${KEEP:-5}"
RELEASE_RE='^[0-9a-zA-Z._-]+$'

[ -f "$SITE/index.html" ] && [ -d "$SITE/v" ] || { echo "$SITE doesn't look like a build-site.sh output" >&2; exit 1; }

echo "== 1/3 upload release folder"
rsync -avz "$SITE/v/" "$TARGET/v/"

echo "== 2/3 swap in root files"
rsync -avz --delete-after --exclude '/v/' "$SITE/" "$TARGET/"

echo "== 3/3 prune old releases (keeping $KEEP)"
# --list-only lines look like: "drwxr-xr-x  4,096 2026/10/01 23:53:47 name".
# Sort by date+time, newest first, and drop everything after the first KEEP.
mapfile -t OLD < <(
  rsync --list-only "$TARGET/v/" |
    awk -v re="$RELEASE_RE" '$1 ~ /^d/ && $5 != "." && $5 ~ re { print $3 " " $4 " " $5 }' |
    sort -r | tail -n +"$((KEEP + 1))" | awk '{ print $3 }'
)
if [ "${#OLD[@]}" -eq 0 ]; then
  echo "nothing to prune"
  exit 0
fi
printf 'removing release %s\n' "${OLD[@]}"
EMPTY="$(mktemp -d)"
trap 'rmdir "$EMPTY"' EXIT
FILTERS=()
for d in "${OLD[@]}"; do FILTERS+=(--include="/$d/***"); done
# Syncing an empty dir with --delete removes only the included release folders;
# everything else is excluded and therefore left alone.
rsync -r --delete "${FILTERS[@]}" --exclude='*' "$EMPTY/" "$TARGET/v/"
