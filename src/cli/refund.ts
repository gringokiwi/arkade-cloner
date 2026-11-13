/**
 * `pnpm refund -- <lock tx hash>` — take back a lock whose invoice was never paid, once its timelock
 * has passed. Reads the terms from the lock transaction itself, so it needs nothing from the solver.
 * Anyone may submit it; the USDC always goes to the refunder. Uses PAYER_PRIVATE_KEY for gas.
 */
import { isHex, parseEventLogs, type Hex } from "viem";
import { loadConfig, loadDotEnv } from "../config.js";
import { chainFor, Htlc, HtlcStatus, lightningHtlcAbi, publicClientFor, walletClientFor } from "../evm/htlc.js";

loadDotEnv();
const txHash = process.argv[2];
if (!txHash || !isHex(txHash) || txHash.length !== 66) throw new Error("usage: pnpm refund -- <lock transaction hash>");
const key = process.env.PAYER_PRIVATE_KEY ?? process.env.EVM_PRIVATE_KEY;
if (!key) throw new Error("set PAYER_PRIVATE_KEY (any funded Base key can submit the refund)");
const config = loadConfig();
const chain = chainFor(config.base.chainId, config.base.rpcUrl);
const client = publicClientFor(chain);

const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
const [locked] = parseEventLogs({ abi: lightningHtlcAbi, eventName: "Locked", logs: receipt.logs });
if (!locked) throw new Error("that transaction locked nothing in a LightningHtlc");
const htlc = new Htlc(client, locked.address, walletClientFor(chain, key as Hex));
const terms = { ...locked.args };
const status = await htlc.status(terms.swapId);
if (status !== HtlcStatus.Locked) {
  console.log(status === HtlcStatus.Claimed ? "Already claimed: the invoice was paid." : "Already refunded.");
  process.exit(0);
}
const now = (await client.getBlock()).timestamp;
if (now < terms.timelock) {
  console.log(`The refund opens at ${new Date(Number(terms.timelock) * 1000).toISOString()} (${Number(terms.timelock - now)} s from now).`);
  process.exit(1);
}
const hash = await htlc.refund(terms);
await client.waitForTransactionReceipt({ hash });
console.log(`Refunded ${terms.amount} base units to ${terms.refunder}: ${hash}`);
