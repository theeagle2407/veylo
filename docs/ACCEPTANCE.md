# Testnet acceptance record

## Environment

- Network: Zcash testnet
- Wallet base source: https://github.com/zcash/zcash-devtool
- Base revision: 5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8
- Wallet: locally patched NU7 candidate, built from a source archive
- Binary SHA-256: 41c5cf3264f33535517a45917211ee34f292b6a9072129f02907ed90c4402470

The binary hash identifies the tested executable. Reproducing it requires
the candidate patch, dependency lockfile, build flags, and toolchain;
the base revision alone is insufficient.

## Confirmed payment

- Product: Contour
- Amount sent: 100000 zatoshis (0.001 TAZ), excluding network fees
- Transaction: ce9c527d338d779bdf7040b7b143f0fafe5d535f36e3ad27359fa1dfe97d110c
- Shielded pool reported by wallet: Ironwood
- Output index: 1
- Mined height: 4465443
- Confirmations when receipt was issued: 10

## Confirmed refund

- Transaction: 3b4a46657c870389c14e7dcf296fe8255c74bf6b3a5907bbb59e210cdd596a19
- Status recorded by Veylo: confirmed
- Confirmations recorded: 10
- Completion recorded: 2026-10-04T21:47:48.687Z

## Manual acceptance checks

The builder reported successful product download, purchase-pass export,
restoration in the normal browser, refund processing, and blocked
downloads after the completed refund.

These are builder-run acceptance checks, not independent user validation.

## Automated checks

Syntax checks and all 51 automated tests passed after the checkout fix.
The tests cover purchase authorization, receipt integrity, pass recovery,
delivery access, refund state transitions, payment matching, confirmation
thresholds, and persistence.

## Scope

This record demonstrates a working testnet purchase and seller-approved
refund flow. It does not establish production readiness, an independent
security audit, customer demand, or guaranteed refunds.
