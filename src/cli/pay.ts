/**
 * `pnpm pay -- --usdc 10` — the payer's side, from a terminal.
 *
 * Asks the solver for a quote, checks every term locally (the HTLC bytecode, the swap id, the
 * invoice's hash and amount, and that the invoice commits to the Lightning address's own LNURL
 * metadata), then funds it with one gasless EIP-3009 signature, or with `--direct`, an approve and
 * a lock paid from the payer's own ETH. Follows the order until the Lightning address is paid and
 * checks the preimage receipt.
 *
 *   --usdc <amount> | --sats <n>   what to send, or what the Lightning address should receive
 *   --to <name@domain>             payout Lightning address (when the solver allows another)
 *   --solver <url>                 default $SOLVER_URL or http://127.0.0.1:8080
 *   --direct                       lock with your own transaction instead of a signature
 *
 * Env: PAYER_PRIVATE_KEY — the Base account holding the USDC.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { getAddress, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, loadDotEnv } from "../config.js";
import { chainFor, Htlc, publicClientFor, readTokenDomain, receiveAuthorization, swapIdOf, walletClientFor, type HtlcTerms } from "../evm/htlc.js";
import { decodeInvoice } from "../lightning/invoice.js";
import { resolveLightningAddress } from "../lightning/lnurl.js";
import { formatUsdc, parseUsdc } from "../pricing/quote.js";
import { PAIR } from "../solver/engine.js";

loadDotEnv();
const { values } = parseArgs({
  options: {
    usdc: { type: "string" },
    sats: { type: "string" },
    to: { type: "string" },
    solver: { type: "string" },
    direct: { type: "boolean", default: false },
  },
});
const key = process.env.PAYER_PRIVATE_KEY;
if (!key || !isHex(key) || key.length !== 66) throw new Error("set PAYER_PRIVATE_KEY to the Base key holding the USDC");
if (!values.usdc === !values.sats) throw new Error("pass exactly one of --usdc or --sats");
const solver = (values.solver ?? process.env.SOLVER_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const config = loadConfig();
const account = privateKeyToAccount(key as Hex);

const call = async (path: string, body?: unknown) => {
  const res = await fetch(`${solver}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, body: (await res.json()) as any };
};

const info = (await call("/v1/info")).body;
if (info.chain_id !== config.base.chainId) throw new Error(`the solver is on chain ${info.chain_id}, your BASE_CHAIN_ID is ${config.base.chainId}`);
const chain = chainFor(config.base.chainId, config.base.rpcUrl);
const client = publicClientFor(chain);

// 1. quote
const rfqId = randomBytes(32).toString("hex");
const side = values.usdc ? "from" : "to";
const amount = values.usdc ? parseUsdc(values.usdc) : BigInt(values.sats!);
const { body: quote } = await call("/v1/swap", {
  v: 1,
  type: "rfq_request",
  rfq_id: rfqId,
  pair: PAIR,
  amount_side: side,
  amount: amount.toString(),
  profile: { refund_address: account.address, ...(values.to ? { lightning_address: values.to } : {}) },
});
if (quote.type !== "rfq_quote") throw new Error(`declined: ${quote.reason} ${quote.message ?? ""}`);
const p = quote.profile;

// 2. check every term locally: derive, never accept
const now = Math.floor(Date.now() / 1000);
const terms: HtlcTerms = {
  paymentHash: p.payment_hash,
  token: getAddress(p.token),
  refunder: account.address,
  claimer: getAddress(p.claimer),
  amount: BigInt(quote.from_amount),
  timelock: BigInt(p.timelock),
};
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`quote check failed: ${what}`);
};
check(quote.rfq_id === rfqId && quote.pair === PAIR, "the quote answers another request");
check(getAddress(p.refunder) === account.address, "refunds would go to someone else");
check(terms.token === getAddress(config.base.usdc), "the token is not USDC");
check(terms.claimer === getAddress(info.claimer), "the claimer is not the solver");
check(BigInt(p.amount) === terms.amount && (side !== "from" || terms.amount === amount), "the USDC amount differs");
check(swapIdOf(terms) === p.swap_id, "the swap id does not match the terms");
check(quote.valid_until > now, "the quote already expired");
check(Number(terms.timelock) > now && Number(terms.timelock) < now + 45 * 86_400, "the refund timelock is out of range");
await new Htlc(client, getAddress(p.htlc_address)).assertDeployed();
const invoice = decodeInvoice(p.invoice);
check(`0x${invoice.paymentHash}` === p.payment_hash, "the invoice pays another hash");
check(invoice.amountMsat === BigInt(quote.to_amount) * 1000n && (side !== "to" || BigInt(quote.to_amount) === amount), "the invoice amount differs");
check(invoice.bech32Prefix === "bc" && invoice.expiresAt > quote.valid_until, "the invoice is for another network or expires too soon");
const lnurl = await resolveLightningAddress(p.lightning_address);
check(
  invoice.descriptionHash === createHash("sha256").update(lnurl.metadata, "utf8").digest("hex"),
  `the invoice was not issued for ${p.lightning_address}`,
);
check(!values.to || p.lightning_address === values.to.toLowerCase(), "the payout address differs");

console.log(`Quote ${rfqId.slice(0, 12)}: lock ${formatUsdc(terms.amount)} USDC -> ${quote.to_amount} sats to ${p.lightning_address}`);
console.log(`  payment hash ${p.payment_hash}`);
console.log(`  refund opens ${new Date(Number(terms.timelock) * 1000).toISOString()} if the invoice is never paid`);

// 3. fund
if (values.direct) {
  const htlc = new Htlc(client, getAddress(p.htlc_address), walletClientFor(chain, key as Hex));
  const tx = await htlc.lock(terms);
  console.log(`Locked with your own transaction: ${tx}`);
} else {
  const domain = await readTokenDomain(client, terms.token);
  const signature = await account.signTypedData(receiveAuthorization(domain, getAddress(p.htlc_address), terms, 0n, BigInt(quote.valid_until)));
  const relay = await call(`/v1/rfq/${rfqId}/authorization`, { signature });
  if (!relay.ok) throw new Error(`the solver did not submit the lock: ${relay.body.error}`);
  console.log(`Signed; the solver submitted the lock: ${relay.body.tx_hash}`);
}

// 4. follow
let last = "";
for (;;) {
  const { body: status } = await call(`/v1/rfq/${rfqId}`);
  if (status.state !== last) {
    last = status.state;
    console.log(`  ${new Date().toISOString()} ${status.state}${status.profile.note ? ` (${status.profile.note})` : ""}`);
  }
  if (status.state === "settled") {
    const preimage = status.profile.preimage as string;
    const proof = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}` === p.payment_hash;
    console.log(proof ? `Paid. Proof of payment (preimage): ${preimage}` : "Settled, but the preimage does not match!");
    break;
  }
  if (status.state === "cancelled" || status.state === "expired") {
    console.log(`Not paid. Your USDC ${status.profile.return_tx ? `was returned in ${status.profile.return_tx}` : "is returned by the solver or refundable at the timelock"}.`);
    break;
  }
  await new Promise((r) => setTimeout(r, 3_000));
}
