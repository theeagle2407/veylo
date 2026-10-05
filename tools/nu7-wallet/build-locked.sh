#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export RUSTFLAGS='--cfg zcash_unstable="nu7"'
unset CARGO_ENCODED_RUSTFLAGS
export CARGO_TARGET_DIR="$PWD/target"
cargo +1.97.1 test --locked veylo_nu7 -- --nocapture
cargo +1.97.1 build --locked --release
printf '\nBuild complete. No wallet was opened and no payment was sent.\n'
