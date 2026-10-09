# Veylo submission brief

## Product

Veylo lets digital creators sell with shielded Zcash payments and provide continuing service through a purchase-specific credential. Buyers can download, restore access, receive product updates, leave a purchase-backed review and request a refund without creating a named customer account.

The initial customer is an independent creator selling design assets, templates or audio packs to buyers who prefer not to provide an email address. The marketplace demonstrates the workflow; the underlying product opportunity is private purchase access and continuing customer service.

## Insight and differentiation

A private payment does not by itself establish how a buyer will recover a download or request support later. Veylo gives each purchase a separate browser-generated key and a signed receipt. A buyer proves control of that purchase instead of signing into a shared customer profile.

Shielded checkout and refunds already exist in the Zcash ecosystem. CipherPay, for example, offers hosted checkout, merchant integrations and a refund API. Veylo must compete on the complete purchase lifecycle, portable access and the experience of buyers and creators. We do not claim to have invented private payments, refunds, cryptographic receipts or capability-based access.

## What was built

- A digital catalogue, product details, purchase totals and public purchase-backed reviews.
- Purchase-specific testnet invoices and confirmation-based receipt issuance.
- Signed download authorization, portable purchase passes and browser restoration.
- Product updates, buyer-initiated refund requests, private status, withdrawal and seller decisions.
- Independent seller accounts and seller-scoped product management.
- A paired local wallet connector. Seller refunds require local approval of the amount, destination and reference before sending.
- Durable handling of uncertain sends and receipt recovery after a later duplicate payment.

The developer's newer source copy passed 61 automated tests on 9 October 2026. The public GitHub copy reviewed that day contained only 54 tests and lacked the newer seller modules. The submitted commit must contain the working version, and its test result must be recorded after publication.

## Business hypothesis

The first offering is a storefront for creators who already have an audience, reducing dependence on marketplace discovery. A future paid merchant service could charge for hosted storefronts, storage and support tools while buyers retain account-free purchase access. This is a proposed model, not existing revenue or demonstrated willingness to pay. Free prototype hosting is not evidence of sustainable operating economics.

The first distribution experiment would be creator-owned product links. Measure setup completion, completed purchases, pass recovery and seller support effort before expanding into more product categories. We have not established independent demand, merchant adoption or paid revenue.

## Evidence and boundaries

See ACCEPTANCE.md for the recorded Contour testnet purchase and refund. A second seller flow was reported working by the builder; add its refund transaction and confirmation record only from the actual saved state.

Zcash provides shielded transaction privacy. Veylo's receipt is an application issuer attestation, not a zero-knowledge proof of payment. The platform trusts the paired seller connector's wallet reports. Public reviews verify purchase authorization, not a unique person or objective seller honesty.

Refunds require seller approval. They are new transfers, not reversals or guaranteed reimbursement. Blocking later downloads does not erase previously downloaded files. Passes contain plaintext private keys. The application can link actions within one purchase and observe network metadata.

The public prototype uses a Vercel proxy to a Cloudflare tunnel and a backend on the builder's computer. It depends on that computer, network and processes staying available. It is not a standalone serverless wallet backend or a production deployment.

## Sources

- Official campaign: https://colosseum.com/worldsfair
- Submission guidance and evaluation: https://colosseum.com/hackathon
- Official rules: https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf
- Announced Zcash track: https://forum.zcashcommunity.com/t/grant-proposal-colosseum-hackathon-zcash-track/57405
- Existing checkout product: https://www.cipherpay.app/en/docs
- Existing refund API: https://github.com/atmospherelabs-dev/cipherpay-api

The rules state an end time of 12 October 2026 at 11:59 PM Pacific, equivalent to 13 October at 7:59 AM in Lagos. Submit earlier and verify the portal's current deadline.
