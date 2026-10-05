# Veylo NU7 wallet build

This directory preserves the uploaded source and Cargo.lock of the candidate used for Veylo’s Zcash testnet acceptance run. Upstream project: https://github.com/zcash/zcash-devtool, base revision `5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8`. Upstream licenses are included; this is a patched reference CLI, not an independently audited wallet.

## Build

Install Rust 1.97.1 with rustup, then run:

```sh
rustup toolchain install 1.97.1
bash build-locked.sh
```

Cargo may download the dependencies recorded in Cargo.lock. The build uses `--locked` and does not run `cargo update`. It runs the NU7 activation/branch test before building. The original `build-veylo-candidate.sh` is retained for provenance; it updates the lockfile and opens a locally configured buyer wallet, so use `build-locked.sh` for reproduction.

The original rust-toolchain.toml selects stable. The reproduction script explicitly selects 1.97.1, matching the reported acceptance toolchain. Platform/compiler differences can produce a different binary hash; the recorded hash identifies the executable actually tested on macOS arm64, not a promise of bit-identical builds.

## Changes

- Cargo.toml overrides zcash_protocol with the included 0.10.5 source.
- The vendored protocol sets testnet NU7 activation to 4465026 and its branch identifier to 0x77190ad9. Mainnet NU7 activation remains unset.
- RUSTFLAGS enables the existing experimental NU7 implementations across dependencies.
- wallet get-info compares the computed branch with server metadata and rejects a mismatch or a non-testnet server.
- A focused Rust test covers the activation boundary, identifier conversion and transaction-version selection.

The get-info restriction applies to that command; it is not a global mainnet lock on every CLI operation. This package is intended only for testnet evaluation.

## Integrity and evidence

TESTED-SOURCE-SHA256.json records hashes of the 111 uploaded files before adding this README and the reproduction script. Acceptance executable SHA-256: `41c5cf3264f33535517a45917211ee34f292b6a9072129f02907ed90c4402470`.

The builder compiled and used the candidate for the confirmed Contour purchase and refund. Packaging checks were performed separately; the packaging environment did not compile Rust. See `../../docs/ACCEPTANCE.md` for transaction evidence.

No wallet databases, identities, recovery phrases or compiled executable are included. Existing wallets and the working candidate installation are not modified by installing this source package.
