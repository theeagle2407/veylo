#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
# One shared cfg across dependencies enables the existing NU7 implementations.
export RUSTFLAGS='--cfg zcash_unstable="nu7"'
unset CARGO_ENCODED_RUSTFLAGS
export CARGO_TARGET_DIR="$PWD/target"
# Only the local path override should change the lockfile. Offline prevents
# fetching a newer registry cohort during this operation.
cargo update -p zcash_protocol
cargo test --locked veylo_nu7 -- --nocapture
cargo build --locked --release
printf '\nCandidate compiled. No wallet payment was attempted.\n'
./target/release/zcash-devtool wallet \
  -w "$HOME/veylo-test-wallets/buyer" get-info --server zecrocks
