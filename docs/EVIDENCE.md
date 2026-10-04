# Evidence and remaining checks

## Recorded development observations

The developer supplied wallet output for these Zcash testnet operations:

| Operation | Amount | Transaction ID | Mined height |
| --- | --- | --- | --- |
| Buyer-to-seller integration transfer | 0.01000000 TAZ | `b7579bc5dd95c6f497bbbc167a223ce431b7bebf3d746eca233b70e49437e7eb` | 4442932 |
| Seller-to-buyer partial return | 0.00500000 TAZ | `017eeb29b7debe589028dd548aaef0d261c469456bed05a4e6781144c6e7b912` | 4442987 |

These two transfers were manual wallet integration checks, not the final storefront refund walkthrough. Recipient wallet output showed the received amounts. Public transaction IDs alone do not reveal or independently prove shielded recipients and amounts.

A subsequent application invoice payment returned transaction ID `9a5cbbc2cf3b7062b597e32b3b04d7fe3b60a4e2a317a01caec8a3bb0898f38d` for 0.00100000 TAZ. The developer reported the application payment and refund flow working. A complete final recording, paired refund transaction reference and independently reproducible evidence bundle remain to be assembled.

## Automated coverage

At this documentation update, the developer's local run passed 51 tests. Tests cover authorization, catalogue persistence, receipt and pass tampering, private downloads, review edits, refund withdrawal and decline, wallet parsing and confirmation, scan caching and uncertain-send recovery.

Pass-restoration tests execute the browser restore function with Web Crypto in Node. They are not a substitute for a full multi-browser usability test. Simulated payments in unit tests are not chain transactions.

## Complete the submission evidence

- Record the source revision and any local changes for both Veylo and the wallet tool.
- Record one continuous invoice, confirmed payment, gated download, refund request, merchant decision and confirmed return.
- Demonstrate recovery in a second browser and rejection of a changed pass.
- Show that simulation records do not count as testnet purchases.
- Record failures and recovery honestly; do not edit a pending transaction into apparent success.
- Publish selected receipts or logs only after removing private purchase keys, identity files and unrelated wallet history.

No external user count, retention, revenue, audit or production deployment is established by these tests.
