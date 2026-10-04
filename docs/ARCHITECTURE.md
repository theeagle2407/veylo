# Architecture and trust boundaries

## Ownership

The browser creates a separate P-256 key for each purchase. The server stores its public key and signs a receipt with its Ed25519 issuer key. The receipt binds the product, version, amount, asset, purchase key, issue time and payment mode. New receipts also bind download policy and, where supplied, delivery metadata. Testnet receipts include wallet-observed payment evidence.

`receiptPayload()` in `core.mjs` defines the exact ordered JSON signature payload. Clients must preserve this encoding and optional-field rules; arbitrary JSON object serialization is not interchangeable. The current format is an application implementation, not an independently reviewed interoperability standard.

Purchase passes carry the receipt and private purchase key. Restoration verifies the issuer signature and that the private key matches the receipt. Download authorization still checks current server state, so importing an old pass does not undo a refund.

## Payment observation

The adapter serializes wallet operations and reads locally scanned wallet data. Matching requires the expected account, amount, memo reference, incoming direction and a shielded, non-change output. Duplicate matching outputs require review. A consumed output cannot issue another receipt. Confirmation requires ten blocks under the implemented counting policy.

A recent scan can be reused for ten seconds; expired failed scans cannot silently become fresh evidence. Invoice creation and refund preparation request fresh snapshots. Successful or uncertain sends invalidate cached evidence.

## Refunds

A buyer signs a destination-bound request with a single-use expiring challenge and a private reason. A request can be withdrawn only before processing; its history remains. A merchant can approve or decline a pending request. Declining does not revoke product access.

The send path rechecks request state after wallet synchronization and persists the sending state before invoking the wallet. An uncertain outcome is not automatically resent. Reconciliation requires a matching confirmed outgoing payment. This reduces duplicate-payment risk; it does not make the JSON store a transactional database.

## Boundaries

- One configured merchant and wallet; no multi-tenant seller isolation.
- Merchant approval, not escrow or guaranteed refunds.
- Purchase-backed reviews, not unique-person or Sybil-resistant reputation.
- Local wallet evidence and merchant signatures, not public proof of a shielded amount.
- Receipt policy can stop future downloads; it cannot erase already downloaded files.
- Plaintext browser keys and passes require protection against theft and script compromise.
- Local state and issuer identity must survive restarts. Multiple concurrent server processes are unsupported.
- The wallet tool is a development dependency. No claim of production custody safety is made.
