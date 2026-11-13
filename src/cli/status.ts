/**
 * `pnpm status` — where the solver's money is: BTC within Arkade (its inventory), ETH and USDC on
 * Base (gas and proceeds), the HTLC deployment, the Lightning solver it pays through, and its orders.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { erc20Abi, formatEther, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, loadDotEnv } from "../config.js";
import { openArkade } from "../arkade/wallet.js";
import { chainFor, Htlc, publicClientFor } from "../evm/htlc.js";
import { formatUsdc } from "../pricing/quote.js";
import { Store } from "../solver/store.js";

loadDotEnv();
const config = loadConfig(process.env, { arkade: true });

const arkade = await openArkade(config, { settlement: false });
try {
  const balance = await arkade.wallet.getBalance();
  console.log("Arkade (BTC inventory)");
  console.log(`  address            ${await arkade.wallet.getAddress()}`);
  console.log(`  boarding address   ${await arkade.wallet.getBoardingAddress()}   (onchain BTC to board)`);
  console.log(`  available          ${balance.available} sats`);
  console.log(`  preconfirmed       ${balance.preconfirmed} sats, settled ${balance.settled} sats, recoverable ${balance.recoverable} sats`);
  console.log(`  boarding           ${balance.boarding.total} sats`);
  const market = arkade.card.markets[0];
  console.log(`  Lightning solver   ${arkade.card.name} (${arkade.card.discovery_pubkey.slice(0, 16)}…) fee ${market?.fee_bps} bps, ${market?.min_quote_amount}-${market?.max_quote_amount} sats`);
  const swaps = await arkade.client.swaps();
  if (swaps.length) {
    console.log(`  Lightning payments ${swaps.length}: ${Object.entries(swaps.reduce<Record<string, number>>((a, s) => ({ ...a, [s.outcome]: (a[s.outcome] ?? 0) + 1 }), {})).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  }
} finally {
  await arkade.close();
}

const chain = chainFor(config.base.chainId, config.base.rpcUrl);
const client = publicClientFor(chain);
console.log(`\nBase (chain ${config.base.chainId})`);
if (config.base.privateKey) {
  const address = privateKeyToAccount(config.base.privateKey).address;
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: config.base.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  console.log(`  claimer            ${address}`);
  console.log(`  ETH (gas)          ${formatEther(eth)}`);
  console.log(`  USDC (proceeds)    ${formatUnits(usdc, 6)}`);
}
if (config.base.htlc) {
  const ok = await new Htlc(client, config.base.htlc).assertDeployed().then(() => "deployed", (e: Error) => `PROBLEM: ${e.message}`);
  console.log(`  LightningHtlc      ${config.base.htlc} (${ok})`);
} else {
  console.log("  LightningHtlc      not deployed yet (pnpm deploy:htlc)");
}

const dbPath = join(config.dataDir, "solver.sqlite");
if (existsSync(dbPath)) {
  const store = new Store(dbPath);
  const orders = store.recentOrders(10);
  console.log(`\nRecent orders`);
  for (const o of orders) {
    console.log(`  ${new Date(o.createdAt * 1000).toISOString()} ${o.id.slice(0, 10)} ${o.state.padEnd(9)} ${formatUsdc(o.usdcAmount)} USDC -> ${o.invoiceSats} sats to ${o.lightningAddress}${o.note ? ` (${o.note})` : ""}`);
  }
  store.close();
}
process.exit(0);
