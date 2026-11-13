/**
 * `pnpm check:live [sats]` — exercise every live dependency of the route without moving money:
 *
 *   1. BTC/USD price feeds
 *   2. the Lightning address: resolve it and fetch a verified invoice
 *   3. Arkade: a throwaway wallet asks the Lightning solver (over Nostr) to quote paying that
 *      invoice, and the swap client verifies the quote and derives the lockup locally
 *   4. Base: the RPC, USDC's EIP-712 domain, and the HTLC deployment when configured
 *
 * Nothing is funded: the throwaway wallet is empty, and an unpaid invoice simply expires.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { formatUnits } from "viem";
import { loadConfig, loadDotEnv } from "../config.js";
import { ArkadeLightningPayer } from "../arkade/lightning.js";
import { openArkade } from "../arkade/wallet.js";
import { chainFor, Htlc, publicClientFor, readTokenDomain } from "../evm/htlc.js";
import { invoiceForLightningAddress } from "../lightning/lnurl.js";
import { PriceOracle } from "../pricing/feeds.js";
import { formatUsdc, priceExactIn, priceExactOut } from "../pricing/quote.js";

loadDotEnv();
const config = loadConfig();
const sats = BigInt(process.argv[2] ?? "1000");
const ok = (label: string, detail: unknown) => console.log(`✔ ${label}`, detail);

// 1. price
const oracle = new PriceOracle(config.pricing);
const price = await oracle.price();
ok("price", { usdPerBtc: price.usdPerBtc, samples: price.samples });
const fees = config.pricing;
const tenUsdc = priceExactIn(10_000_000n, price.microUsdcPerBtc, fees);
ok("10 USDC buys", { invoiceSats: tenUsdc.invoiceSats, valueSats: tenUsdc.valueSats, spreadBps: fees.spreadBps });

// 2. Lightning address
const invoice = await invoiceForLightningAddress(config.payout.lightningAddress, sats, { comment: "live check (unpaid)" });
ok(`invoice from ${config.payout.lightningAddress}`, {
  amountSats: invoice.amountSats,
  paymentHash: invoice.paymentHash,
  expiresAt: new Date(invoice.expiresAt * 1000).toISOString(),
});

// 3. Arkade: quote the Lightning payment from an empty throwaway wallet
const dataDir = mkdtempSync(join(tmpdir(), "arkade-live-check-"));
const arkade = await openArkade(
  { ...config, dataDir, arkade: { ...config.arkade, mnemonic: generateMnemonic(wordlist) } },
  { settlement: false },
);
try {
  ok("Lightning solver card", {
    name: arkade.card.name,
    market: arkade.card.markets.map((m) => `${m.base_asset.id} -> ${m.quote_asset.id} fee ${m.fee_bps}bps ${m.min_quote_amount}-${m.max_quote_amount} sats`),
  });
  ok("throwaway Arkade address", await arkade.wallet.getAddress());
  const payer = new ArkadeLightningPayer(arkade);
  const quote = await payer.quote(invoice.bolt11);
  ok("Arkade -> Lightning quote (verified, not funded)", {
    invoiceSats: quote.invoiceSats,
    lockSats: quote.costSats,
    feeSats: quote.feeSats,
    refundLocktime: new Date(quote.refundLocktime * 1000).toISOString(),
    validUntil: new Date(quote.expiresAt * 1000).toISOString(),
  });
  const exact = priceExactOut(quote.invoiceSats, price.microUsdcPerBtc, fees, quote.costSats);
  ok(`USDC a payer would lock for ${quote.invoiceSats} sats`, formatUsdc(exact.usdcAmount));
} finally {
  await arkade.close();
  rmSync(dataDir, { recursive: true, force: true });
}

// 4. Base
const chain = chainFor(config.base.chainId, config.base.rpcUrl);
const client = publicClientFor(chain);
const [block, domain] = await Promise.all([client.getBlockNumber(), readTokenDomain(client, config.base.usdc)]);
ok("Base", { chainId: await client.getChainId(), block, usdc: config.base.usdc, eip712: domain });
if (config.base.htlc) {
  await new Htlc(client, config.base.htlc).assertDeployed();
  ok("LightningHtlc deployed", config.base.htlc);
}
if (config.base.privateKey) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const solver = privateKeyToAccount(config.base.privateKey).address;
  ok("solver Base account", { address: solver, eth: formatUnits(await client.getBalance({ address: solver }), 18) });
}
console.log("\nAll live dependencies answered. Nothing was funded.");
process.exit(0);
