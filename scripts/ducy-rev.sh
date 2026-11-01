#!/bin/bash
# The revision of allenpiscitello/ducy that rust/Cargo.toml pins.
set -euo pipefail
grep -o -m1 'rev = "[0-9a-f]*"' "$(dirname "$0")/../rust/Cargo.toml" | cut -d'"' -f2
