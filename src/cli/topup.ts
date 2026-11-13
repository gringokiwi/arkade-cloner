/**
 * `pnpm topup -- <sats>` — add BTC inventory to the solver's Arkade wallet over Lightning: prints an
 * invoice from the Arkade Intents Lightning receive route, then waits until the sats are claimed.
 * Keep it running until it reports `claimed`. Other ways in: send to the Arkade address, or board
 * onchain BTC at the boarding address (`pnpm status` prints both).
 */
import { loadConfig, loadDotEnv } from "../config.js";
import { openArkade } from "../arkade/wallet.js";

loadDotEnv();
const sats = BigInt(process.argv[2] ?? "0");
if (sats <= 0n) throw new Error("usage: pnpm topup -- <sats>");
const config = loadConfig(process.env, { arkade: true });
const arkade = await openArkade(config);
const request = await arkade.client.receive({ via: "lightning", amount: sats });
console.log(`Pay this invoice from any Lightning wallet (${sats} sats arrive in Arkade, after the solver's fee):\n\n${request.artifact.bolt11}\n`);
await new Promise<void>((resolve) => {
  const stop = arkade.client.onUpdate(({ swap, outcome }) => {
    if (swap.id !== request.id) return;
    console.log(`  ${new Date().toISOString()} ${outcome}`);
    if (outcome === "claimed" || outcome === "lapsed") {
      stop();
      resolve();
    }
  });
});
const balance = await arkade.wallet.getBalance();
console.log(`Arkade balance: ${balance.available} sats available`);
await arkade.close();
process.exit(0);
