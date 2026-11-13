/**
 * The HTLC against the real USDC contract on a fork of Base mainnet: Circle's FiatToken checks
 * the EIP-3009 authorization the payer signs. Runs only with FORK_URL set, e.g.
 *
 *   FORK_URL=https://mainnet.base.org pnpm test
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { encodeAbiParameters, erc20Abi, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { BASE_USDC } from "../src/config.js";
import { deployHtlc, Htlc, HtlcStatus, readTokenDomain, receiveAuthorization, swapIdOf, walletClientFor, type HtlcTerms } from "../src/evm/htlc.js";
import { devKey, startLocalChain, type LocalChain } from "./support/evm.js";

const forkUrl = process.env.FORK_URL;

describe("LightningHtlc with real USDC on a Base fork", { skip: forkUrl ? false : "set FORK_URL to run" }, () => {
  let local: LocalChain;
  let htlcAddress: Address;
  const payerKey = devKey(1);
  const solverKey = devKey(2);
  let payer: Address;
  let solver: Address;

  const balance = (who: Address) =>
    local.publicClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  /** FiatToken keeps balances in the mapping at slot 9 (`balanceAndBlacklistStates` since v2.2). */
  const setUsdcBalance = async (who: Address, amount: bigint) => {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
    await local.rpc("hardhat_setStorageAt", [BASE_USDC, slot, pad(toHex(amount), { size: 32 })]);
  };

  before(async () => {
    local = await startLocalChain({ forkUrl });
    payer = walletClientFor(local.chain, payerKey).account.address;
    solver = walletClientFor(local.chain, solverKey).account.address;
    await setUsdcBalance(payer, 50_000_000n);
    ({ address: htlcAddress } = await deployHtlc(local.publicClient, walletClientFor(local.chain, devKey(0))));
  });

  after(async () => local?.stop());

  it("locks real USDC with a gasless authorization and pays the solver for the preimage", async () => {
    assert.equal(await balance(payer), 50_000_000n, "the fork gave the payer USDC");
    const domain = await readTokenDomain(local.publicClient, BASE_USDC);
    assert.deepEqual([domain.name, domain.version, domain.chainId], ["USD Coin", "2", 8453]);

    const preimage = `0x${randomBytes(32).toString("hex")}` as Hex;
    const paymentHash = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}` as Hex;
    const now = await local.now();
    const terms: HtlcTerms = { paymentHash, token: BASE_USDC, refunder: payer, claimer: solver, amount: 12_345_678n, timelock: now + 15n * 86_400n };
    const signature = await walletClientFor(local.chain, payerKey).signTypedData(receiveAuthorization(domain, htlcAddress, terms, 0n, now + 600n));

    const solverHtlc = new Htlc(local.publicClient, htlcAddress, walletClientFor(local.chain, solverKey));
    const lockTx = await solverHtlc.lockWithAuthorization(terms, { validAfter: 0n, validBefore: now + 600n, signature });
    assert.equal((await local.publicClient.waitForTransactionReceipt({ hash: lockTx })).status, "success");
    assert.equal(await balance(payer), 50_000_000n - terms.amount);
    assert.equal(await solverHtlc.status(swapIdOf(terms)), HtlcStatus.Locked);

    const claimTx = await solverHtlc.claim(terms, preimage);
    assert.equal((await local.publicClient.waitForTransactionReceipt({ hash: claimTx })).status, "success");
    assert.equal(await balance(solver), terms.amount);
    assert.equal(await solverHtlc.status(swapIdOf(terms)), HtlcStatus.Claimed);
  });
});
