# Testnet setup

Use a dedicated testnet wallet. Never put mnemonic phrases, identity file contents or purchase passes into Git or a support message.

## Existing installation

If `.env.testnet` already exists, the setup script leaves it untouched. Start with:

```sh
node --env-file=.env.testnet server.mjs
```

## New installation

Build `zcash-devtool` separately, initialize a seller testnet wallet and record its account UUID using the tool's `wallet list-accounts` command. Consult the checked-out tool's `--help`: its interface is not a stable production API.

Run `node scripts/setup-testnet.mjs`. Enter the executable path, seller wallet directory, age identity path and seller account UUID. These are local paths and an identifier, not recovery words. The script checks local paths and creates a private configuration file. It does not create or fund wallets and does not prove the supplied account belongs to that wallet.

Record the wallet source checkout for reproducibility:

```sh
cd "$HOME/Developer/veylo-zcash-devtool"
git rev-parse HEAD
git status --short
shasum -a 256 target/release/zcash-devtool
```

Save the revision, binary digest, operating system and any source modifications in the evidence record. A commit alone does not identify a modified build. No revision is claimed as pinned until this record is captured.

## First payment

1. Start the app in testnet mode and create an invoice.
2. Sync the buyer wallet immediately before sending, avoiding an expiry based on a stale chain tip.
3. Use the checkout's exact address, amount and memo. Amounts passed to the wallet are zatoshis.
4. Keep the resulting transaction ID. Wait for the application to confirm receipt.
5. Test download access, export the pass, request a refund to a buyer-controlled shielded address, then approve it in the merchant console.
6. Sync the buyer wallet to corroborate receipt of the refund. Save both perspectives privately, publishing only selected evidence.

The server needs the seller wallet identity to sign approved refunds. Do not upload this identity to an ordinary public web host. The shipped local server is not configured for internet exposure.
