/**
 * LightningHtlc against a local EVM: lock, gasless lock, claim, refund, and the attacks the
 * swap-id nonce and the status machine must stop.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { BaseError, ContractFunctionRevertedError, erc20Abi, getAddress, type Address, type Hex } from "viem";
import {
  deployHtlc,
  Htlc,
  HtlcStatus,
  lightningHtlcAbi,
  readTokenDomain,
  receiveAuthorization,
  swapIdOf,
  walletClientFor,
  type HtlcTerms,
} from "../src/evm/htlc.js";
import { deployMockUsdc, devKey, startLocalChain, type LocalChain } from "./support/evm.js";

const newPreimage = () => {
  const preimage = `0x${randomBytes(32).toString("hex")}` as Hex;
  const paymentHash = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}` as Hex;
  return { preimage, paymentHash };
};

/** The custom error name a write reverted with. */
const revertName = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof BaseError) {
      const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        // custom errors by name; `require(cond, "message")` (Error(string)) by its message
        const name = revert.data?.errorName;
        return name && name !== "Error" ? name : (revert.reason ?? "reverted");
      }
    }
    return (err as Error).message;
  }
  return "no revert";
};

describe("LightningHtlc", () => {
  let local: LocalChain;
  let usdc: Address;
  let htlcAddress: Address;
  const payerKey = devKey(1);
  const solverKey = devKey(2);
  const attackerKey = devKey(3);
  let payer: Address;
  let solver: Address;
  let attacker: Address;

  const balance = (who: Address) =>
    local.publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  const terms = async (overrides: Partial<HtlcTerms> = {}): Promise<HtlcTerms & { preimage: Hex }> => {
    const { preimage, paymentHash } = newPreimage();
    return {
      preimage,
      paymentHash,
      token: usdc,
      refunder: payer,
      claimer: solver,
      amount: 25_000_000n,
      timelock: (await local.now()) + 3600n,
      ...overrides,
    };
  };

  before(async () => {
    local = await startLocalChain();
    payer = walletClientFor(local.chain, payerKey).account.address;
    solver = walletClientFor(local.chain, solverKey).account.address;
    attacker = walletClientFor(local.chain, attackerKey).account.address;
    usdc = await deployMockUsdc(local, devKey(0), [[payer, 1_000_000_000n]]);
    ({ address: htlcAddress } = await deployHtlc(local.publicClient, walletClientFor(local.chain, devKey(0))));
  });

  after(async () => local?.stop());

  const as = (key: Hex) => new Htlc(local.publicClient, htlcAddress, walletClientFor(local.chain, key));

  it("is the repository's bytecode", async () => {
    await as(solverKey).assertDeployed();
  });

  it("computes swap ids exactly as the contract does", async () => {
    const t = await terms();
    const onChain = await local.publicClient.readContract({
      address: htlcAddress,
      abi: lightningHtlcAbi,
      functionName: "swapIdOf",
      args: [t.paymentHash, t.token, t.refunder, t.claimer, t.amount, t.timelock],
    });
    assert.equal(onChain, swapIdOf(t));
  });

  it("locks, emits the terms, and pays the claimer only for the right preimage", async () => {
    const t = await terms();
    const before = await balance(payer);
    const hash = await as(payerKey).lock(t);
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(await balance(payer), before - t.amount);
    assert.equal(await balance(htlcAddress), t.amount);

    const [event] = await as(solverKey).lockedEvents(receipt.blockNumber, receipt.blockNumber, solver);
    assert.ok(event);
    assert.equal(event.swapId, swapIdOf(t));
    assert.equal(event.paymentHash, t.paymentHash);
    assert.equal(event.refunder, getAddress(payer));
    assert.equal(event.amount, t.amount);
    assert.equal(event.timelock, t.timelock);
    assert.equal(await as(solverKey).status(event.swapId), HtlcStatus.Locked);

    // a wrong preimage hashes to another swap id
    assert.equal(await revertName(as(solverKey).claim(t, `0x${"11".repeat(32)}`)), "SwapNotLocked");
    // the payer cannot refund early
    assert.equal(await revertName(as(payerKey).refund(t)), "TimelockNotReached");

    // anyone may submit the claim, and the tokens always go to the claimer
    const claimHash = await as(attackerKey).claim(t, t.preimage);
    await local.publicClient.waitForTransactionReceipt({ hash: claimHash });
    assert.equal(await balance(solver), t.amount);
    assert.equal(await balance(attacker), 0n);
    assert.equal(await as(solverKey).status(event.swapId), HtlcStatus.Claimed);

    // settled swaps cannot be claimed, refunded or re-opened
    assert.equal(await revertName(as(solverKey).claim(t, t.preimage)), "SwapNotLocked");
    await local.increaseTime(7200);
    assert.equal(await revertName(as(payerKey).refund(t)), "SwapNotLocked");
    assert.equal(await revertName(as(payerKey).lock(t)), "InvalidTimelock");
  });

  it("refunds the payer once the timelock passes", async () => {
    const t = await terms();
    await local.publicClient.waitForTransactionReceipt({ hash: await as(payerKey).lock(t) });
    const before = await balance(payer);
    await local.increaseTime(3601);
    // anyone may submit the refund; the tokens go to the refunder
    await local.publicClient.waitForTransactionReceipt({ hash: await as(attackerKey).refund(t) });
    assert.equal(await balance(payer), before + t.amount);
    assert.equal(await as(solverKey).status(swapIdOf(t)), HtlcStatus.Refunded);
    assert.equal(await revertName(as(solverKey).claim(t, t.preimage)), "SwapNotLocked");
  });

  it("lets only the claimer cancel, returning the tokens at once", async () => {
    const t = await terms();
    await local.publicClient.waitForTransactionReceipt({ hash: await as(payerKey).lock(t) });
    const before = await balance(payer);
    assert.equal(await revertName(as(attackerKey).cancel(t)), "NotClaimer");
    assert.equal(await revertName(as(payerKey).cancel(t)), "NotClaimer");
    await local.publicClient.waitForTransactionReceipt({ hash: await as(solverKey).cancel(t) });
    assert.equal(await balance(payer), before + t.amount);
    assert.equal(await as(solverKey).status(swapIdOf(t)), HtlcStatus.Refunded);
    assert.equal(await revertName(as(solverKey).claim(t, t.preimage)), "SwapNotLocked");
  });

  it("locks with a gasless EIP-3009 authorization that binds every term", async () => {
    const t = await terms();
    const domain = await readTokenDomain(local.publicClient, usdc);
    assert.equal(domain.name, "USD Coin");
    assert.equal(domain.version, "2");
    const now = await local.now();
    const validAfter = 0n;
    const validBefore = now + 600n;
    const payerWallet = walletClientFor(local.chain, payerKey);
    const signature = await payerWallet.signTypedData(receiveAuthorization(domain, htlcAddress, t, validAfter, validBefore));
    const auth = { validAfter, validBefore, signature };

    // a relayer cannot redirect the claim to itself or change any other term
    for (const tampered of [{ claimer: attacker }, { amount: t.amount + 1n }, { timelock: t.timelock + 1n }, { paymentHash: newPreimage().paymentHash }]) {
      const reason = await revertName(as(attackerKey).lockWithAuthorization({ ...t, ...tampered }, auth));
      assert.match(reason, /invalid signature/, `tampered ${Object.keys(tampered)[0]} must fail, got ${reason}`);
    }

    const payerBefore = await balance(payer);
    const ethBefore = await local.publicClient.getBalance({ address: payer });
    const hash = await as(solverKey).lockWithAuthorization(t, auth);
    await local.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(await balance(payer), payerBefore - t.amount);
    assert.equal(await local.publicClient.getBalance({ address: payer }), ethBefore, "the payer spends no gas");
    assert.equal(await as(solverKey).status(swapIdOf(t)), HtlcStatus.Locked);

    // the same authorization cannot be used twice
    assert.equal(await revertName(as(solverKey).lockWithAuthorization(t, auth)), "SwapExists");
  });

  it("refuses an expired authorization and a timelock in the past", async () => {
    const t = await terms();
    const domain = await readTokenDomain(local.publicClient, usdc);
    const now = await local.now();
    const payerWallet = walletClientFor(local.chain, payerKey);
    const signature = await payerWallet.signTypedData(receiveAuthorization(domain, htlcAddress, t, 0n, now - 1n));
    assert.match(await revertName(as(solverKey).lockWithAuthorization(t, { validAfter: 0n, validBefore: now - 1n, signature })), /expired/);
    assert.equal(await revertName(as(payerKey).lock({ ...t, timelock: now - 10n })), "InvalidTimelock");
  });
});
