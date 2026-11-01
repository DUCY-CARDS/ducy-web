#!/bin/bash
# ducy.cards' Rust (rust/): formatting, lints and tests, the wasm builds (the
# site's, the relay's clubs-only one, and Node's) and ducy-wasm's Node tests.
# Leaves the site's build in rust/ducy-wasm/pkg.
#
# DUCY_DIR is a checkout of allenpiscitello/ducy at the revision rust/Cargo.toml
# pins (some tests read its fixtures, and its tiny GTO model is built from it);
# by default ducy/ beside rust/, where CI checks it out.
set -euo pipefail
cd "$(dirname "$0")/../rust"
DUCY_DIR=${DUCY_DIR:-$(cd .. && pwd)/ducy}
export DUCY_DIR
target=${CARGO_TARGET_DIR:-$PWD/target}

cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

(cd ducy-wasm && wasm-pack build --target web --out-dir pkg --no-typescript)
# The relay's build: clubs only, no bot tables or GTO (#463).
(cd ducy-wasm && wasm-pack build --target web --out-dir pkg-clubs --no-typescript --no-default-features)
(cd ducy-wasm && wasm-pack build --target nodejs --out-dir pkg-node)

cargo run --manifest-path "$DUCY_DIR/Cargo.toml" -p ducy-gto --example tiny_model -- "$target/tiny-model"
export DUCY_TINY_MODEL="$target/tiny-model"
for t in ducy-wasm/tests/*.cjs; do
  echo "node $t"
  node "$t"
done
