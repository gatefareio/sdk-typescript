/**
 * Minimal example — list the catalog, make a paid call, check balance.
 *
 * Run with:
 *   WALLET_PRIVATE_KEY=0x... npx tsx examples/basic.ts
 *
 * Requires a wallet funded with at least the listing price in USDC on
 * Base mainnet (or Base Sepolia if you call a testnet listing).
 */

import { Gatefare } from "../src/index.js";

async function main() {
  const gf = new Gatefare({
    wallet: { privateKey: process.env.WALLET_PRIVATE_KEY! },
    spendCaps: {
      perCallUsdc: 0.50,
      perDayUsdc:  5.00,
    },
  });

  // 1. Search the catalog.
  const apis = await gf.listCatalog({ priceLimitUsdc: 0.10, limit: 5 });
  console.log(`[catalog] ${apis.length} APIs under $0.10`);
  for (const a of apis) {
    console.log(`  ${a.slug.padEnd(30)} ${a.price.padStart(8)}  ${a.name}`);
  }

  if (apis.length === 0) return;

  // 2. Check wallet balance.
  const balance = await gf.checkBalance();
  console.log(`[balance] ${balance.usdc} USDC on ${balance.network}`);

  if (balance.usdc < apis[0]!.priceUsdc) {
    console.log(`[balance] Insufficient. Top up the wallet first.`);
    return;
  }

  // 3. Make a paid call.
  const r = await gf.callApi(apis[0]!.slug);
  console.log(`[call] ${r.status} - paid ${r.paidUsdc} USDC`);
  console.log(`[call] data:`, r.data);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
