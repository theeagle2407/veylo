# Multi-seller testnet flow

Registered sellers can publish downloadable products, archive their products, publish release notices, view their own purchase totals and refund requests, and approve or decline refunds. Existing primary-store purchases and receipt signatures are preserved.

A seller's paired local connector generates invoice addresses and scans its wallet. The backend requests only outputs matching that store's invoice and refund references. It validates account, amount, direction, shielded pool, reference and confirmation count before issuing a receipt. Ten confirmations are required. The platform signs receipts using its existing signing key; this release does not introduce independent signing keys for each seller.

The backend trusts an authenticated seller connector to report wallet evidence. This is not independently verified shielded-payment proof or a trustless marketplace. A malicious seller or stolen connector credential can misreport that seller's evidence. Refunds remain seller-approved, with no escrow or guarantee. This integration is for the supplied Zcash testnet wallet.

## Start a seller connector

Install this update on the application host and any computer running the seller connector. Existing pairing settings in ~/.veylo-connector/config.json are preserved.

1. Stop the old connector with Ctrl+C.
2. From the Veylo folder run `python3 scripts/enable-seller-refunds.py` and enter the local path to the correct wallet's .age identity. Only its path is saved locally; its contents are never uploaded.
3. Run `node scripts/seller-connector.mjs` and leave it running.
4. Open the seller workspace and refresh status. Choose Products → Add product to upload a file and publish.

A paired store is bound to its first reported wallet account. This prevents switching the account while existing purchases still need verification or refunds. Wallet migration is not implemented.

## Refund approval

The buyer submits a signed request with a reason and refund destination. The seller chooses Approve & send refund in Refunds & updates. The connector displays the exact amount, destination and reference. Type SEND to authorize it locally. Network fees are additional.

The connector writes an operation journal before sending. The backend claims send jobs once; retries return or reconcile the recorded outcome, rather than sending again. If a send times out, is declined in the terminal, or its outcome is uncertain, the request stays pending investigation. Do not manually repeat it. The current conservative recovery flow does not automatically reopen failed or declined terminal attempts.

The connector uses ~/.veylo-connector/operations.json and a running.lock file. Preserve the journal. If the connector crashes, inspect the process ID in the lock before removing the stale lock. Never run two connector processes against the same wallet. Keep the connector configuration, journal, wallet database and identity private.

## Availability and limits

The existing Vercel proxy, Cloudflare tunnel and application host must remain online. A seller connector must also remain online for invoice creation and wallet scans. Slow initial scans can cause a checkout status timeout; retry verification without sending a second payment. This does not turn the current hosting arrangement into an always-on service.

The application still uses one process and local JSON persistence. It is not a horizontally scaled or audited production payment service. Disconnecting the connector cannot cancel an already submitted blockchain transaction. Successful refunds end future gated downloads, not access to files already downloaded.

## Validation

60 automated tests passed, including an HTTP test with simulated wallet responses and a complete remote-wallet adapter test. Coverage includes publication ownership, private dashboards, cross-seller refund rejection, ten-confirmation receipts, refund reconciliation, local approval, operation replay and interrupted-send recovery. These tests do not replace a live payment and refund with the upgraded connector. The earlier acceptance record documents the original single-wallet flow.
