# Veylo

**Private purchases. Proof of ownership. A way back when something goes wrong.**

Veylo is a digital storefront built around a simple question: after a shielded payment, how does a buyer prove their purchase without opening a customer account?

Each purchase gets its own browser-generated key and a merchant-signed receipt. Together they let the buyer download their product, recover access in another browser, publish a purchase-backed review, and request a refund. The merchant can provide continuing service without collecting a buyer email address.

The working integration uses **Zcash testnet**. Payments and approved refunds are sent through a local `zcash-devtool` wallet. A separate simulation mode supports a quick product walkthrough without funds.

## Intended users and product hypothesis

Veylo targets independent creators selling downloadable assets to buyers who want purchase access without an email account. The first use cases are design assets, templates, audio packs and practical digital tools. The newer implementation supports independent seller accounts, seller-owned products and paired local wallet connectors.

The hypothesis is that a portable purchase credential can support delivery, updates and refunds without requiring a shared customer identity. The next validation step is independent buyers completing purchase, recovery and refund tasks, with time to completion, recovery success and seller support effort recorded. Demand and willingness to pay remain unvalidated. A future hosted merchant service is a business hypothesis, not an operating revenue model.

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

Sellers can register independent stores, publish their own products and pair local wallet connectors. The platform remains a prototype with explicit seller trust boundaries. Refunds require merchant approval. Veylo cannot reverse a payment or force reimbursement.

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

See [Testnet setup](docs/TESTNET.md) and the preserved [NU7 wallet source and build instructions](tools/nu7-wallet/README.md). The tested candidate uses testnet branch `77190ad9`. Configure a compatible seller wallet executable; the original unpatched CLI rejected payments after the testnet upgrade. Existing wallet paths and account configuration remain local.

```sh
node scripts/setup-testnet.mjs
VEYLO_PAYMENT_MODE=testnet node --env-file=.env.testnet server.mjs
```

Existing configuration is preserved. The application binds to loopback: these commands are for local evaluation, not a public hosting configuration.

Before sending from the buyer wallet, sync it. Use the exact address, amount and memo from the checkout. Veylo waits for **ten confirmations** before issuing the receipt. Checkout checks automatically while the page is visible; network or wallet errors remain pending rather than being reported as payment success.

## Why the purchase pass matters

A shielded transfer and a continuing customer relationship solve different problems. Veylo connects them through a purchase-specific credential rather than an email account or a reusable customer wallet identity.

The buyer signs purpose-specific requests. Refund authorization includes the destination and reason; download and status requests use separate challenges. A copied transaction ID is not sufficient to access a product or request a refund.

The receipt is a **merchant attestation**, not a zero-knowledge proof or an independently verifiable guarantee of payment. Zcash provides transaction privacy; Veylo provides the application-level ownership and service workflow. See [Architecture and trust boundaries](docs/ARCHITECTURE.md).

## Validation

The public source revision `ab61ef3` was checked on 9 October 2026 and passed **60 automated tests** covering receipt tampering, request replay, destination substitution, downloads, pass restoration, refund decisions, payment matching, uncertain sends, persistence and checkout polling. Run `npm test` on your checkout to verify its current result.

The complete Contour acceptance flow used shielded testnet payments, not simulated transfers:

| Observed result | Evidence |
| --- | --- |
| Purchase receipt issued at ten confirmations | Payment `ce9c527d338d779bdf7040b7b143f0fafe5d535f36e3ad27359fa1dfe97d110c`, mined at height 4465443 |
| Seller-approved refund recorded at ten confirmations | Refund `3b4a46657c870389c14e7dcf296fe8255c74bf6b3a5907bbb59e210cdd596a19` |
| Product download, pass export and browser restoration | Builder-run acceptance checks |
| Further downloads blocked after completed refund | Builder-run acceptance check |

See [Acceptance record](docs/ACCEPTANCE.md) for the recorded wallet evidence and [wallet reproduction source](tools/nu7-wallet/README.md) for the exact source, lockfile and build recipe. A public transaction identifier alone cannot reveal or independently verify shielded amounts and memos; Veylo matches decrypted output evidence in the merchant wallet. The builder performed the manual checks; they have not been independently replicated.

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
| `seller-accounts.mjs` | Seller registration, sessions and store ownership |
| `connector-jobs.mjs`, `connector-runner.mjs` | Seller wallet jobs, observations and refund execution |
| `server.mjs` | HTTP routes, seller sessions and local persistence |
| `public/` | Buyer and merchant interface |
| `test/` | Automated behavioural and adversarial tests |
| `tools/nu7-wallet/` | Preserved upstream wallet source, local protocol patch, licenses and locked build recipe |

## Deployment and security boundaries

The prototype runs one server process with local JSON persistence. Merchant signing state and wallet access stay on that host. Browser purchase keys and exported passes are currently plaintext. A stolen pass can authorize actions for its purchase.

The merchant can link a request to its purchase. IP addresses, timing, public review content and other application metadata can reveal information. Veylo does not promise anonymity against every observer.

Confirmed transactions are not continuously revalidated for later chain reorganizations. The wallet adapter depends on developer-tool output. The repository preserves the tested NU7 source and locked build recipe; independent reproduction and a reviewed wallet interface remain necessary before wider distribution. Public deployment requires a separate review of authentication, HTTPS, storage, wallet isolation and recovery. Do not expose the local signing service directly to the internet.

Included products are demonstration content committed to this repository. Their files are not confidential merely because application downloads are gated. A merchant's actual paid files must remain outside a public repository.

## Next milestones

- Independently reproduce the preserved wallet build and complete a fresh acceptance run.
- Publish a complete purchase-to-refund screen recording with confirmation waits clearly disclosed.
- Validate purchase-pass recovery and refund expectations with independent users.
- Seller connectors separate their local wallet signing from the web process; review this trust boundary and replace single-process storage before production use.

## Evaluation

See the [judge walkthrough](docs/JUDGE-WALKTHROUGH.md) and [multi-seller setup and trust boundaries](docs/MULTI-SELLER.md). New sellers use a paired local connector; its wallet reports are trusted by the platform. Refunds require local SEND approval. The public prototype depends on the backend and tunnel remaining online.
