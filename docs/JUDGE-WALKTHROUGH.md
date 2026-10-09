# Evaluate Veylo

Public prototype: https://veylo-steel.vercel.app/

## Buyer walkthrough

1. Browse and open a product's details.
2. Start checkout. Use a compatible Zcash testnet wallet and the exact invoice address, amount and memo. Never use mainnet funds.
3. Wait for payment detection and ten confirmations. Keep the browser's saved checkout; do not send again if verification is temporarily unavailable.
4. Download the product and export the purchase pass. The pass includes a private purchase key and must remain private.
5. Restore the pass in a separate browser at the same website origin and verify download access.
6. Request a refund with a reason and a testnet receiving address you control. Follow its private status.
7. After seller approval and a confirmed payout, verify that further downloads are blocked under the receipt policy.

## Seller walkthrough

1. Register a seller account and create the store profile.
2. Follow the in-app wallet guide, select the compatible local testnet wallet and pair the connector.
3. Keep the connector running. It reports wallet observations; it does not upload the wallet's seed or identity file.
4. Publish a product with its downloadable asset and price.
5. Inspect the purchase and refund request in the seller console.
6. Approve the request in the console, then review the exact destination, amount and reference in the local connector before entering SEND.
7. Follow confirmation and reconciliation. Never manually repeat an uncertain payout.

## Short offline evaluation

Use the product-demo recording if the live host is unavailable. Local simulation is available through npm run dev for a walkthrough without funds. Simulation results are not blockchain payment evidence.

## Important distinctions

- Cancelling checkout preserves history; it cannot cancel a submitted blockchain transfer.
- A purchase pass authorizes one purchase. It is not a Zcash wallet recovery phrase.
- A signed receipt is an issuer attestation. Shielded amounts cannot be checked using a transaction ID alone.
- Sellers decide refunds. Veylo provides the authorization and payout workflow, without escrow or reimbursement guarantees.
- Public review counts represent purchases, not unique people.
