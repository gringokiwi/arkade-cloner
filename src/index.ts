/**
 * `pnpm start` — run the solver: the HTTP API, the Base watcher and the Arkade payer.
 *
 * Needs ARKADE_MNEMONIC (the BTC inventory), EVM_PRIVATE_KEY (the Base claimer, with a little ETH
 * for gas) and HTLC_ADDRESS (from `pnpm deploy:htlc`). See README.md.
 */
import { join } from "node:path";
import { loadConfig, loadDotEnv } from "./config.js";
import { createApi } from "./api/server.js";
import { ArkadeLightningPayer } from "./arkade/lightning.js";
import { openArkade } from "./arkade/wallet.js";
import { chainFor, Htlc, publicClientFor, readTokenDomain, walletClientFor } from "./evm/htlc.js";
import { invoiceForLightningAddress } from "./lightning/lnurl.js";
import { log } from "./log.js";
import { PriceOracle } from "./pricing/feeds.js";
import { PAIR, SolverEngine } from "./solver/engine.js";
import { Store } from "./solver/store.js";

loadDotEnv();
const config = loadConfig(process.env, { arkade: true, evm: true });
if (!config.base.htlc) {
  throw new Error("HTLC_ADDRESS is not set. Deploy the contract with `pnpm deploy:htlc` and add the address to .env");
}

const chain = chainFor(config.base.chainId, config.base.rpcUrl);
const publicClient = publicClientFor(chain);
const htlc = new Htlc(publicClient, config.base.htlc, walletClientFor(chain, config.base.privateKey!));
await htlc.assertDeployed();
const tokenDomain = await readTokenDomain(publicClient, config.base.usdc);

const arkade = await openArkade(config);
const lightning = new ArkadeLightningPayer(arkade);
const market = arkade.card.markets.find((m) => m.quote_asset.id.startsWith("bolt11:"));
const prices = new PriceOracle(config.pricing);
const store = new Store(join(config.dataDir, "solver.sqlite"));

const engine = new SolverEngine({
  config,
  store,
  htlc,
  tokenDomain,
  lightning,
  prices,
  invoiceFor: invoiceForLightningAddress,
  routeBounds: market ? { min: BigInt(market.min_quote_amount), max: BigInt(market.max_quote_amount) } : undefined,
});

const info = async () => {
  const [price, inventory] = await Promise.all([prices.price().catch(() => undefined), engine.spendableSats().catch(() => undefined)]);
  return {
    solver: "arkade-usdc-lightning-solver",
    pair: PAIR,
    route: {
      from: `eip155:${config.base.chainId}/erc20:${config.base.usdc.toLowerCase()}`,
      via: `arkade:${config.arkade.network}/slip44:0`,
      to: `bolt11:${config.arkade.network}/slip44:0`,
    },
    chain_id: config.base.chainId,
    token: config.base.usdc,
    htlc_address: config.base.htlc,
    claimer: engine.claimer,
    lightning_address: config.payout.lightningAddress,
    allowed_lightning_addresses: config.payout.allowedLightningAddresses,
    spread_bps: Number(config.pricing.spreadBps),
    lightning_fee_reserve: { bps: Number(config.pricing.lightningFeeBps), flat_sats: Number(config.pricing.lightningFeeFlatSats) },
    min_payout_sats: Number(market && BigInt(market.min_quote_amount) > config.limits.minPayoutSats ? market.min_quote_amount : config.limits.minPayoutSats),
    max_payout_sats: Number(market && BigInt(market.max_quote_amount) < config.limits.maxPayoutSats ? market.max_quote_amount : config.limits.maxPayoutSats),
    quote_ttl_seconds: config.timing.quoteTtlSeconds,
    confirmations: config.base.confirmations,
    relay_authorizations: config.features.relayAuthorizations,
    price: price ? { usd_per_btc: price.usdPerBtc, sources: price.samples.map((s) => s.source) } : null,
    inventory_sats: inventory === undefined ? null : Number(inventory > 0n ? inventory : 0n),
    lightning_solver: { name: arkade.card.name, discovery_pubkey: arkade.card.discovery_pubkey, fee_bps: market?.fee_bps },
  };
};

const server = createApi(engine, { info });
server.listen(config.http.port, config.http.host);
engine.start();

const balance = await arkade.wallet.getBalance();
log.info("solver running", {
  api: `http://${config.http.host}:${config.http.port}`,
  pays: config.payout.lightningAddress,
  arkadeAddress: await arkade.wallet.getAddress(),
  arkadeSats: balance.available,
  claimer: engine.claimer,
  htlc: config.base.htlc,
  lightningSolver: arkade.card.name,
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: stopping`);
  server.close();
  await engine.stop();
  await arkade.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
