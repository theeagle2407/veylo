# Veylo

**Private purchases. Proof of ownership. A way back when something goes wrong.**

Veylo is a digital storefront built around a simple question: after a shielded payment, how does a buyer prove their purchase without opening a customer account?

Each purchase gets its own browser-generated key and a merchant-signed receipt. Together they let the buyer download their product, recover access in another browser, publish a purchase-backed review, and request a refund. The merchant can provide continuing service without collecting a buyer email address.

The working integration uses **Zcash testnet**. Payments and approved refunds are sent through a local `zcash-devtool` wallet. A separate simulation mode supports a quick product walkthrough without funds.

## What works

| Buyer | Merchant |
| --- | --- |
| Browse products and inspect purchase totals and reviews | Publish products with private downloadable files |
| Pay a purchase-specific invoice | Confirm shielded receipts through the seller wallet |
| Download with proof of purchase | Publish product-specific updates |
| Export and restore a portable purchase pass | Review private refund requests |
| Request a refund and follow its progress | Approve or decline with an explanation |
| Withdraw an unprocessed request to correct it | Reconcile uncertain sends without automatically paying twice |
| Leave or edit one public review per purchase | Archive products while preserving existing purchases |

This is a **single-merchant storefront**, not an open marketplace with independent seller accounts. Refunds require merchant approval. Veylo cannot reverse a payment or force reimbursement.

## Run a local walkthrough

Requires Node.js 22 or newer. The application uses Node built-ins and browser Web Crypto; no npm dependencies need installation.

```sh
npm run check
npm test
npm run dev
```

Open **http://localhost:3002**. Start in **Browse**. The terminal prints the access code for **Seller console**. This default mode simulates payments; it does not move ZEC.

1. Select a product and complete a simulated purchase.
2. Download the purchased file and export its purchase pass.
3. Request a refund from the purchase detail view.
4. Open Seller console and approve or decline the request.
5. Return to the purchase to inspect its updated status. A completed refund ends download access for purchases under the current policy.
6. Restore the exported pass in another browser on the same application origin. Restoration checks the receipt signature and purchase key; it does not bypass a completed refund.

The pass contains a private key. Keep it private, like a credential.

## Run with Zcash testnet

See [Testnet setup](docs/TESTNET.md). The setup script accepts local wallet paths and an account UUID rather than embedding the original developer's account.

```sh
node scripts/setup-testnet.mjs
node --env-file=.env.testnet server.mjs
```

Existing configuration is preserved. The application binds to loopback: these commands are for local evaluation, not a public hosting configuration.

Before sending from the buyer wallet, sync it. Use the exact address, amount and memo from the checkout. Veylo waits for **ten confirmations** before issuing the receipt. Checkout checks automatically while the page is visible; network or wallet errors remain pending rather than being reported as payment success.

## Why the purchase pass matters

A shielded transfer and a continuing customer relationship solve different problems. Veylo connects them through a purchase-specific credential rather than an email account or a reusable customer wallet identity.

The buyer signs purpose-specific requests. Refund authorization includes the destination and reason; download and status requests use separate challenges. A copied transaction ID is not sufficient to access a product or request a refund.

The receipt is a **merchant attestation**, not a zero-knowledge proof or an independently verifiable guarantee of payment. Zcash provides transaction privacy; Veylo provides the application-level ownership and service workflow. See [Architecture and trust boundaries](docs/ARCHITECTURE.md).

## Validation

The current suite contains **51 passing automated tests** covering receipt tampering, request replay, destination substitution, downloads, pass restoration, refund decisions, payment matching, uncertain sends, persistence and checkout polling.

Development testing also completed shielded testnet transfers in both directions. That evidence is distinct from simulation tests. See [Evidence and remaining checks](docs/EVIDENCE.md) for recorded transaction references and the limits of what they establish.

No production audit, merchant adoption or independent user study has been completed. Test counts are engineering evidence, not user traction.

## Repository map

| File | Responsibility |
| --- | --- |
| `core.mjs` | Purchase receipts, authorization challenges, refunds and reviews |
| `payments.mjs` | Invoice matching, confirmation thresholds and refund reconciliation |
| `wallet.mjs` | Local wallet execution, output parsing and scan caching |
| `merchant.mjs`, `catalog.mjs` | Merchant catalogue and product lifecycle |
| `downloads.mjs` | Purchase-authorized delivery |
| `monitor.mjs` | Background reconciliation of pending refunds |
| `server.mjs` | HTTP routes, seller sessions and local persistence |
| `public/` | Buyer and merchant interface |
| `test/` | Automated behavioural and adversarial tests |

## Deployment and security boundaries

The prototype runs one server process with local JSON persistence. Merchant signing state and wallet access stay on that host. Browser purchase keys and exported passes are currently plaintext. A stolen pass can authorize actions for its purchase.

The merchant can link a request to its purchase. IP addresses, timing, public review content and other application metadata can reveal information. Veylo does not promise anonymity against every observer.

Confirmed transactions are not continuously revalidated for later chain reorganizations. The wallet adapter depends on developer-tool output and needs a pinned, reproducible build before wider distribution. Public deployment requires a separate review of authentication, HTTPS, storage, wallet isolation and recovery. Do not expose the local signing service directly to the internet.

Included products are demonstration content committed to this repository. Their files are not confidential merely because application downloads are gated. A merchant's actual paid files must remain outside a public repository.

## Next milestones

- Record and reproduce the exact wallet build used for the testnet demonstration.
- Package a complete purchase-to-refund walkthrough with both wallet perspectives.
- Validate purchase-pass recovery and refund expectations with independent users.
- Separate wallet signing from the web process and replace single-process storage before public operation.
