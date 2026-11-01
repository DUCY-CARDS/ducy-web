# ducy.cards' Rust

The site's own logic, built on [ducy](https://github.com/allenpiscitello/ducy)'s
generic poker crates (`ducy`, `ducy-play`, `ducy-host`, `ducy-gto`,
`ducy-shuffle`, `ducy-identity`), pinned to one revision in `Cargo.toml`.

- `ducy-club`: poker clubs: rules, money, tables, waitlists, tournaments and promotions, the manager's views, and the relay's registry and rooms.
- `ducy-training`: the study tools: practising charts and ranges.
- `ducy-bot-games`: the games against the bots: the heads-up ladder, the Regulars' table, hand reviews and the bots' table talk.
- `ducy-quest`: Bankroll Quest.
- `ducy-wasm`: the site's bindings. Its default `site` feature has everything; the relay builds it with `--no-default-features` (clubs only).

## Building

```sh
cd rust/ducy-wasm
wasm-pack build --target web --out-dir pkg --no-typescript
cp pkg/ducy_wasm.js pkg/ducy_wasm_bg.wasm ../../wasm/
```

`scripts/rust-checks.sh` runs what CI does: lints, tests, the wasm builds and
ducy-wasm's Node tests. It needs a ducy checkout at the pinned revision
(`DUCY_DIR`, by default `ducy/` here) for some fixtures and the tiny GTO model.

To take a newer ducy, change `rev` in `Cargo.toml` and run `cargo update`.
