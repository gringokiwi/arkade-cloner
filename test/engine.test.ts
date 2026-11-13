/**
 * The solver engine end to end on a local chain: a real LightningHtlc and an EIP-3009 token, with
 * the Lightning address and the Arkade Lightning payment replaced by fakes the test controls.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { erc20Abi, type Address, type Hex } from "viem";
import { loadConfig } from "../src/config.js";
import { deployHtlc, Htlc, HtlcStatus, readTokenDomain, walletClientFor, type HtlcTerms } from "../src/evm/htlc.js";
import { fixedPrice } from "../src/pricing/feeds.js";
import { HttpError, PAIR, Refusal, SolverEngine } from "../src/solver/engine.js";
import { Store } from "../src/solver/store.js";
import { deployMockUsdc, devKey, startLocalChain, type LocalChain } from "./support/evm.js";
import { FakeLightningAddress, FakeLightningPayer } from "./support/fakes.js";

const rfqId = () => randomBytes(32).toString("hex");
const sha256 = (hex: string) => `0x${createHash("sha256").update(Buffer.from(hex.replace(/^0x/, ""), "hex")).digest("hex")}`;

describe("solver engine", () => {
  let local: LocalChain;
  let usdc: Address;
  let htlcAddress: Address;
  let deployBlock: bigint;
  const payerKey = devKey(1);
  let payer: Address;
  /** Engines read time through this, so it can follow the chain when a test moves the clock. */
  let clockOffset = 0;
  const now = () => Math.floor(Date.now() / 1000) + clockOffset;

  const usdcBalance = (who: Address) =>
    local.publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  before(async () => {
    local = await startLocalChain();
    payer = walletClientFor(local.chain, payerKey).account.address;
    usdc = await deployMockUsdc(local, devKey(0), [[payer, 1_000_000_000n]]);
    ({ address: htlcAddress, blockNumber: deployBlock } = await deployHtlc(local.publicClient, walletClientFor(local.chain, devKey(0))));
  });

  after(async () => local?.stop());

  /** A solver with its own claimer key, so tests never see each other's locks. */
  const setup = async (claimerIndex: number, env: Record<string, string> = {}, store = new Store(":memory:")) => {
    const address = new FakeLightningAddress();
    const lightning = new FakeLightningPayer(address);
    const config = loadConfig({
      BASE_CHAIN_ID: "8453",
      BASE_RPC_URL: local.rpcUrl,
      USDC_ADDRESS: usdc,
      HTLC_ADDRESS: htlcAddress,
      HTLC_DEPLOY_BLOCK: deployBlock.toString(),
      EVM_PRIVATE_KEY: devKey(claimerIndex),
      BASE_CONFIRMATIONS: "2",
      SPREAD_BPS: "100",
      LIGHTNING_FEE_BPS: "50",
      LIGHTNING_FEE_FLAT_SATS: "10",
      MIN_PAYOUT_SATS: "1000",
      MAX_PAYOUT_SATS: "250000",
      ...env,
    });
    const htlc = new Htlc(local.publicClient, htlcAddress, walletClientFor(local.chain, devKey(claimerIndex)));
    const engine = new SolverEngine({
      config,
      store,
      htlc,
      tokenDomain: await readTokenDomain(local.publicClient, usdc),
      lightning,
      prices: fixedPrice(100_000),
      invoiceFor: address.invoiceFor,
      now,
    });
    return { engine, store, lightning, address, config, claimer: htlc.walletClient!.account.address };
  };

  const request = (id: string, side: "from" | "to", amount: string, profile: Record<string, unknown> = {}) => ({
    v: 1,
    type: "rfq_request",
    rfq_id: id,
    pair: PAIR,
    amount_side: side,
    amount,
    profile: { refund_address: payer, ...profile },
  });

  const termsOf = (quote: Awaited<ReturnType<SolverEngine["quote"]>>): HtlcTerms => ({
    paymentHash: quote.profile.payment_hash as Hex,
    token: quote.profile.token,
    refunder: quote.profile.refunder,
    claimer: quote.profile.claimer,
    amount: BigInt(quote.profile.amount),
    timelock: BigInt(quote.profile.timelock),
  });

  const payerHtlc = () => new Htlc(local.publicClient, htlcAddress, walletClientFor(local.chain, payerKey));

  it("quotes exact-in: 25 USDC at $100k, 1% spread, fee reserve", async () => {
    const { engine, address } = await setup(10);
    const quote = await engine.quote(request(rfqId(), "from", "25000000"));
    // 25 USDC = 25,000 sats at mid; 1% spread leaves 24,750; the invoice plus a 0.5% + 10 sat reserve fits in that
    assert.equal(quote.from_amount, "25000000");
    assert.equal(quote.to_amount, 24_616);
    assert.equal(address.requests[0]?.address, "gringo@walletofsatoshi.com");
    assert.equal(address.requests[0]?.sats, 24_616n);
    assert.equal(quote.profile.lightning_address, "gringo@walletofsatoshi.com");
    // the payer's refund opens after the Arkade refund window (14 days in the fake) plus margins
    assert.ok(quote.profile.timelock > now() + 14 * 86_400);
    assert.equal(quote.profile.authorization.typed_data.message.nonce, quote.profile.swap_id);
  });

  it("refuses requests it cannot or will not serve", async () => {
    const { engine, lightning } = await setup(11);
    const refusal = async (body: unknown) => {
      try {
        await engine.quote(body);
      } catch (err) {
        assert.ok(err instanceof Refusal, String(err));
        return err;
      }
      assert.fail("expected a refusal");
    };
    assert.equal((await refusal({ ...request(rfqId(), "from", "1000000"), pair: "arkade:BTC->lightning:BTC" })).reason, "unsupported_pair");
    assert.equal((await refusal({ ...request(rfqId(), "from", "1000000"), extra: 1 })).reason, "unsupported_payload");
    assert.equal((await refusal(request(rfqId(), "from", "100000"))).reason, "amount_out_of_range"); // 0.10 USDC
    assert.equal((await refusal(request(rfqId(), "to", "300000"))).reason, "amount_out_of_range"); // over the max
    const other = await refusal(request(rfqId(), "from", "5000000", { lightning_address: "someone@example.com" }));
    assert.equal(other.reason, "unsupported_payload");
    assert.equal(other.detail.error_code, "destination_not_allowed");
    lightning.balance = 1_000n;
    assert.equal((await refusal(request(rfqId(), "from", "5000000"))).reason, "exposure_cap");
    lightning.balance = 10_000_000n;
    lightning.failQuotes = true;
    assert.equal((await refusal(request(rfqId(), "from", "5000000"))).reason, "pricing_unavailable");
    lightning.failQuotes = false;
    const id = rfqId();
    await engine.quote(request(id, "from", "5000000"));
    assert.equal((await refusal(request(id, "from", "5000000"))).reason, "quote_conflict");
  });

  it("settles a gasless order: signature -> lock -> Lightning paid -> USDC claimed", async () => {
    const { engine, store, lightning, claimer } = await setup(12);
    const id = rfqId();
    const quote = await engine.quote(request(id, "from", "25000000"));

    // The payer's wallet signs the typed data from the quote (as eth_signTypedData_v4 would).
    const signature = await local.rpc<Hex>("eth_signTypedData_v4", [payer, JSON.stringify(quote.profile.authorization.typed_data)]);
    await assert.rejects(engine.relayAuthorization(id, { signature: `0x${"11".repeat(65)}` }), (e: unknown) => e instanceof HttpError && e.status === 400);
    const payerEth = await local.publicClient.getBalance({ address: payer });
    const payerUsdc = await usdcBalance(payer);
    const { tx_hash } = await engine.relayAuthorization(id, { signature });
    assert.equal((await local.publicClient.waitForTransactionReceipt({ hash: tx_hash })).status, "success");
    assert.equal(await local.publicClient.getBalance({ address: payer }), payerEth, "the payer paid no gas");
    assert.equal(await usdcBalance(payer), payerUsdc - 25_000_000n);

    await engine.tick();
    assert.equal(store.getOrder(id)?.state, "quoted", "one confirmation is not enough");
    await local.mine(1);
    await engine.tick();
    const paying = store.getOrder(id)!;
    assert.equal(paying.state, "paying");
    assert.ok(paying.arkadeSwapId);

    // The Lightning solver pays gringo's invoice and reveals the preimage.
    lightning.settle(paying.arkadeSwapId!);
    await engine.tick();
    const settled = store.getOrder(id)!;
    assert.equal(settled.state, "settled");
    assert.equal(await usdcBalance(claimer), 25_000_000n);
    assert.equal(await usdcBalance(htlcAddress), 0n);

    const status = engine.status(id)!;
    assert.equal(status.state, "settled");
    assert.equal(sha256(status.profile.preimage!), quote.profile.payment_hash, "the receipt is the invoice preimage");
  });

  it("hands the USDC straight back when the Lightning payment fails", async () => {
    const { engine, store, lightning } = await setup(13);
    const id = rfqId();
    const quote = await engine.quote(request(id, "to", "10000")); // exact-out: gringo receives 10,000 sats
    assert.equal(quote.to_amount, 10_000);
    const before = await usdcBalance(payer);
    await local.publicClient.waitForTransactionReceipt({ hash: await payerHtlc().lock(termsOf(quote)) });
    await local.mine(1);
    await engine.tick();
    const order = store.getOrder(id)!;
    assert.equal(order.state, "paying");

    lightning.refund(order.arkadeSwapId!);
    await engine.tick(); // declines and submits cancel()
    await engine.tick(); // sees the cancel confirmed
    assert.equal(store.getOrder(id)?.state, "cancelled");
    assert.equal(store.getLock(order.swapId!)?.status, "returned");
    assert.equal(await usdcBalance(payer), before, "the payer has every unit back");
    assert.equal(await payerHtlc().status(order.swapId!), HtlcStatus.Refunded);
  });

  it("returns underpaid and unsolicited locks", async () => {
    const { engine, store, claimer } = await setup(14);
    const id = rfqId();
    const quote = await engine.quote(request(id, "from", "20000000"));
    const before = await usdcBalance(payer);
    const short = { ...termsOf(quote), amount: 19_000_000n };
    await local.publicClient.waitForTransactionReceipt({ hash: await payerHtlc().lock(short) });
    const stray: HtlcTerms = { ...short, paymentHash: sha256(randomBytes(32).toString("hex")) as Hex, amount: 1_000_000n, claimer };
    await local.publicClient.waitForTransactionReceipt({ hash: await payerHtlc().lock(stray) });
    await local.mine(1);
    await engine.tick();
    await engine.tick();
    assert.equal(store.getOrder(id)?.state, "quoted", "an underpaid lock does not fund the order");
    assert.equal(await usdcBalance(payer), before, "both locks came back");
  });

  it("resumes after a restart and still settles", async () => {
    const store = new Store(":memory:");
    const first = await setup(15, {}, store);
    const id = rfqId();
    const quote = await first.engine.quote(request(id, "from", "3000000"));
    await local.publicClient.waitForTransactionReceipt({ hash: await payerHtlc().lock(termsOf(quote)) });
    await local.mine(1);
    await first.engine.tick();
    const swapId = store.getOrder(id)!.arkadeSwapId!;
    await first.engine.stop();

    // A new process over the same database; the Arkade side remembers the payment.
    const second = await setup(15, {}, store);
    second.lightning.swaps.set(swapId, first.lightning.swaps.get(swapId)!);
    second.lightning.settle(swapId);
    await second.engine.tick();
    assert.equal(store.getOrder(id)?.state, "settled");
  });

  it("expires unfunded quotes, and honours a late lock only at a price that still covers it", async () => {
    const { engine, store, lightning } = await setup(16, { QUOTE_TTL_SECONDS: "60" });
    const id = rfqId();
    const quote = await engine.quote(request(id, "from", "8000000"));
    clockOffset += 120;
    await local.increaseTime(120);
    await engine.tick();
    assert.equal(store.getOrder(id)?.state, "expired");

    await local.publicClient.waitForTransactionReceipt({ hash: await payerHtlc().lock(termsOf(quote)) });
    await local.mine(1);
    await engine.tick();
    const order = store.getOrder(id)!;
    assert.equal(order.state, "paying", "the price has not moved, so the late lock is honoured");
    lightning.settle(order.arkadeSwapId!);
    await engine.tick();
    assert.equal(store.getOrder(id)?.state, "settled");
  });
});
