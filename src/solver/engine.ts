/**
 * The solver. One order per quote:
 *
 *   quote   price the USDC, fetch an invoice from the Lightning address, and have the Arkade
 *           Lightning solver quote paying it. The payer gets the invoice's payment hash, the
 *           HTLC terms, and an EIP-3009 authorization to sign.
 *   lock    the payer's USDC lands in the HTLC on Base under that payment hash.
 *   pay     the solver funds an Arkade lockup; the Lightning solver pays the invoice and claims
 *           the lockup with the preimage.
 *   claim   the solver takes the USDC from the HTLC with that preimage.
 *
 * The payment hash links all three contracts (Base HTLC, Arkade lockup, Lightning HTLCs), so the
 * USDC moves only if the Lightning address was paid. Anything the solver declines before paying is
 * handed straight back (`cancel`); if the solver disappears, the payer refunds at the timelock.
 */
import { createHash } from "node:crypto";
import { erc20Abi, getAddress, isAddress, verifyTypedData, type Address, type Hex } from "viem";
import { normalizeLightningAddress, type SolverConfig } from "../config.js";
import type { LightningPayer } from "../arkade/lightning.js";
import { Htlc, HtlcStatus, receiveAuthorization, receiveAuthorizationJson, swapIdOf, type HtlcTerms, type LockedEvent, type TokenDomain } from "../evm/htlc.js";
import type { InvoiceOptions, VerifiedInvoice } from "../lightning/lnurl.js";
import { log } from "../log.js";
import type { Price } from "../pricing/feeds.js";
import { priceExactIn, priceExactOut, usdcToSats, type Pricing } from "../pricing/quote.js";
import { OPEN_ORDER_STATES, type LockRecord, type Order, type Store } from "./store.js";

/** The route this solver serves, in the RFQ `pair` spelling (`<from>-><to>`). */
export const PAIR = "base:USDC->lightning:BTC";
/** The swap client keeps retrying an Arkade refund this long past `refund_locktime`; the
 * preimage can surface until then, so the Base timelock must clear it. */
export const ARKADE_REFUND_RETRY_SECONDS = 7200;
const MAX_PAY_ATTEMPTS = 3;
/** Stop trying to pay an invoice this close to its expiry. */
const INVOICE_PAY_MARGIN_SECONDS = 300;
/** Locks without a quote are handed back only from this size (smaller ones can refund themselves). */
const MIN_UNSOLICITED_RETURN = 500_000n; // 0.5 USDC
/** A claim or hand-back with no receipt after this long was dropped; send it again. */
const RESEND_AFTER_SECONDS = 300;

export type RefusalReason =
  | "unsupported_pair"
  | "unsupported_payload"
  | "amount_out_of_range"
  | "exposure_cap"
  | "invoice_expired"
  | "quote_conflict"
  | "pricing_unavailable"
  | "rate_limited";

/** An `rfq_refusal`: the solver declines before anything is committed. */
export class Refusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toMessage(rfqId: string) {
    return { v: 1, type: "rfq_refusal", rfq_id: rfqId, reason: this.reason, message: this.message, ...this.detail };
  }
}

/** An HTTP-level failure of a non-RFQ endpoint. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RfqRequest {
  v: 1;
  type: "rfq_request";
  rfq_id: string;
  pair: string;
  amount_side: "from" | "to";
  amount: string;
  profile: { refund_address: string; lightning_address?: string };
}

/** Parse a request strictly, as the reference solver does: unknown or missing fields refuse it. */
export function parseRfqRequest(body: unknown): RfqRequest {
  const fail = (message: string, field?: string): never => {
    throw new Refusal("unsupported_payload", message, field ? { field } : {});
  };
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail("the request must be a JSON object");
  const b = body as Record<string, unknown>;
  const allowed = ["v", "type", "rfq_id", "pair", "amount_side", "amount", "profile"];
  for (const key of Object.keys(b)) if (!allowed.includes(key)) fail(`unknown field ${key}`, key);
  if (b.v !== 1) fail("v must be 1", "v");
  if (b.type !== "rfq_request") fail("type must be rfq_request", "type");
  if (typeof b.rfq_id !== "string" || !/^[0-9a-f]{64}$/.test(b.rfq_id)) fail("rfq_id must be 32 bytes of lowercase hex", "rfq_id");
  if (b.pair !== PAIR) throw new Refusal("unsupported_pair", `this solver serves ${PAIR}`, { field: "pair" });
  if (b.amount_side !== "from" && b.amount_side !== "to") fail("amount_side must be from or to", "amount_side");
  if (typeof b.amount !== "string" || !/^[1-9]\d*$/.test(b.amount)) fail("amount must be a canonical decimal string", "amount");
  const profile = b.profile as Record<string, unknown> | undefined;
  if (typeof profile !== "object" || profile === null) fail("profile is required", "profile");
  for (const key of Object.keys(profile!)) {
    if (!["refund_address", "lightning_address"].includes(key)) fail(`unknown field profile.${key}`, `profile.${key}`);
  }
  if (typeof profile!.refund_address !== "string" || !isAddress(profile!.refund_address)) {
    fail("profile.refund_address must be the payer's Base address", "profile.refund_address");
  }
  if (profile!.lightning_address !== undefined && typeof profile!.lightning_address !== "string") {
    fail("profile.lightning_address must be a string", "profile.lightning_address");
  }
  return b as unknown as RfqRequest;
}

export interface EngineDeps {
  config: SolverConfig;
  store: Store;
  /** The HTLC, driven by the solver's Base account (the claimer). */
  htlc: Htlc;
  tokenDomain: TokenDomain;
  lightning: LightningPayer;
  prices: { price(): Promise<Price> };
  invoiceFor(lightningAddress: string, sats: bigint, options: InvoiceOptions): Promise<VerifiedInvoice>;
  /** Payout bounds of the Lightning route (the Lightning solver card's), sats. */
  routeBounds?: { min: bigint; max: bigint };
  now?: () => number;
}

const unixNow = () => Math.floor(Date.now() / 1000);
const roundUp = (value: number, step: number) => Math.ceil(value / step) * step;
const sha256Hex = (hex: string) => `0x${createHash("sha256").update(Buffer.from(hex.replace(/^0x/, ""), "hex")).digest("hex")}`;
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class SolverEngine {
  readonly claimer: Address;
  readonly usdc: Address;
  private ticking?: Promise<void>;
  private again = false;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private readonly relaying = new Set<string>();
  private readonly blockTimes = new Map<bigint, number>();

  constructor(private readonly deps: EngineDeps) {
    if (!deps.htlc.walletClient) throw new Error("the engine needs the solver's Base wallet");
    this.claimer = getAddress(deps.htlc.walletClient.account.address);
    this.usdc = getAddress(deps.config.base.usdc);
  }

  private now() {
    return (this.deps.now ?? unixNow)();
  }

  // ---------------------------------------------------------------- quoting

  /** Answer an `rfq_request` with an `rfq_quote`, or throw a {@link Refusal}. */
  async quote(body: unknown) {
    const request = parseRfqRequest(body);
    const { config, store } = this.deps;
    if (store.getOrder(request.rfq_id)) throw new Refusal("quote_conflict", "this rfq_id was already quoted");

    let destination: string;
    try {
      destination = normalizeLightningAddress(request.profile.lightning_address ?? config.payout.lightningAddress);
    } catch {
      throw new Refusal("unsupported_payload", "profile.lightning_address is not a Lightning address", { field: "profile.lightning_address" });
    }
    const allowed = config.payout.allowedLightningAddresses;
    if (!allowed.includes("*") && !allowed.includes(destination)) {
      throw new Refusal("unsupported_payload", `this solver only pays ${allowed.join(", ")}`, {
        error_code: "destination_not_allowed",
        field: "profile.lightning_address",
      });
    }

    let price: Price;
    try {
      price = await this.deps.prices.price();
    } catch (err) {
      throw new Refusal("pricing_unavailable", `no price: ${errorMessage(err)}`);
    }
    const fees = config.pricing;
    const amount = BigInt(request.amount);
    let pricing: Pricing =
      request.amount_side === "from" ? priceExactIn(amount, price.microUsdcPerBtc, fees) : priceExactOut(amount, price.microUsdcPerBtc, fees);
    this.checkBounds(pricing.invoiceSats);
    await this.checkInventory(pricing.budgetSats);

    const now = this.now();
    const validUntil = now + config.timing.quoteTtlSeconds;
    const invoiceOptions: InvoiceOptions = {
      comment: config.payout.comment,
      validUntilAtLeast: validUntil + config.timing.invoiceSlackSeconds,
      now: () => this.now(),
    };
    let invoice = await this.fetchInvoice(destination, pricing.invoiceSats, invoiceOptions);
    let route = await this.quoteRoute(invoice.bolt11);

    if (request.amount_side === "from" && route.costSats > pricing.budgetSats) {
      // The fee reserve undershot the Lightning solver's fee: shrink the invoice once.
      pricing = { ...pricing, invoiceSats: pricing.invoiceSats - (route.costSats - pricing.budgetSats) };
      this.checkBounds(pricing.invoiceSats);
      invoice = await this.fetchInvoice(destination, pricing.invoiceSats, invoiceOptions);
      route = await this.quoteRoute(invoice.bolt11);
      if (route.costSats > pricing.budgetSats) throw new Refusal("pricing_unavailable", "the Lightning fee exceeds the spread");
    }
    if (request.amount_side === "to") {
      // Price exact-out on the real Arkade cost rather than the reserve.
      pricing = priceExactOut(pricing.invoiceSats, price.microUsdcPerBtc, fees, route.costSats);
    }

    // The payer's refund must open after the last moment the preimage can surface: the Arkade
    // refund locktime of the payment (quoted now, re-quoted at fill), its retry window, a margin.
    const timelock = roundUp(
      route.refundLocktime + config.timing.quoteTtlSeconds + ARKADE_REFUND_RETRY_SECONDS + config.timing.timelockMarginSeconds,
      60,
    );

    const order: Order = {
      id: request.rfq_id,
      state: "quoted",
      createdAt: now,
      updatedAt: now,
      amountSide: request.amount_side,
      usdcAmount: pricing.usdcAmount,
      invoiceSats: pricing.invoiceSats,
      valueSats: pricing.valueSats,
      microUsdcPerBtc: price.microUsdcPerBtc,
      lightningAddress: destination,
      invoice: invoice.bolt11,
      paymentHash: `0x${invoice.paymentHash}`,
      invoiceExpiresAt: invoice.expiresAt,
      validUntil,
      timelock,
      refunder: getAddress(request.profile.refund_address),
      quotedCostSats: route.costSats,
      quotedRefundLocktime: route.refundLocktime,
    };
    store.insertOrder(order);
    log.info("quoted", {
      id: order.id.slice(0, 12),
      usdc: order.usdcAmount,
      sats: order.invoiceSats,
      to: destination,
      cost: route.costSats,
      price: price.usdPerBtc,
    });
    return this.quoteMessage(order);
  }

  private checkBounds(invoiceSats: bigint) {
    const { minPayoutSats, maxPayoutSats } = this.deps.config.limits;
    const min = this.deps.routeBounds && this.deps.routeBounds.min > minPayoutSats ? this.deps.routeBounds.min : minPayoutSats;
    const max = this.deps.routeBounds && this.deps.routeBounds.max < maxPayoutSats ? this.deps.routeBounds.max : maxPayoutSats;
    if (invoiceSats < min || invoiceSats > max) {
      throw new Refusal("amount_out_of_range", `the payout must be between ${min} and ${max} sats, got ${invoiceSats}`, {
        actual: Number(invoiceSats),
        limit: Number(invoiceSats < min ? min : max),
        unit: "sats",
      });
    }
  }

  /** Sats free for a new quote: spendable BTC minus the reserve and what open quotes may use. */
  async spendableSats(): Promise<bigint> {
    const now = this.now();
    const committed = this.deps.store
      .ordersIn(["quoted", "locked"])
      .filter((o) => o.state === "locked" || o.validUntil >= now)
      .reduce((sum, o) => sum + o.quotedCostSats, 0n);
    return (await this.deps.lightning.availableSats()) - this.deps.config.limits.inventoryReserveSats - committed;
  }

  private async checkInventory(neededSats: bigint) {
    if (this.deps.config.features.dryRun) return;
    const spendable = await this.spendableSats();
    if (spendable < neededSats) {
      throw new Refusal("exposure_cap", "not enough BTC inventory for this amount right now", {
        error_code: "insufficient_inventory",
        limit: Number(spendable > 0n ? spendable : 0n),
        unit: "sats",
      });
    }
  }

  private async fetchInvoice(destination: string, sats: bigint, options: InvoiceOptions): Promise<VerifiedInvoice> {
    try {
      return await this.deps.invoiceFor(destination, sats, options);
    } catch (err) {
      throw new Refusal("pricing_unavailable", `could not get an invoice from ${destination}: ${errorMessage(err)}`, {
        error_code: "destination_unavailable",
      });
    }
  }

  private async quoteRoute(bolt11: string) {
    try {
      return await this.deps.lightning.quote(bolt11);
    } catch (err) {
      throw new Refusal("pricing_unavailable", `the Arkade -> Lightning route did not quote: ${errorMessage(err)}`, {
        error_code: "route_unavailable",
      });
    }
  }

  termsOf(order: Order): HtlcTerms {
    return {
      paymentHash: order.paymentHash,
      token: this.usdc,
      refunder: order.refunder,
      claimer: this.claimer,
      amount: order.usdcAmount,
      timelock: BigInt(order.timelock),
    };
  }

  private quoteMessage(order: Order) {
    const terms = this.termsOf(order);
    const htlc = this.deps.htlc.address;
    return {
      v: 1,
      type: "rfq_quote",
      rfq_id: order.id,
      pair: PAIR,
      from_amount: order.usdcAmount.toString(),
      to_amount: Number(order.invoiceSats),
      solver_pubkey: this.claimer,
      valid_until: order.validUntil,
      refund_locktime: order.timelock,
      profile: {
        chain_id: this.deps.config.base.chainId,
        htlc_address: htlc,
        token: this.usdc,
        claimer: this.claimer,
        refunder: order.refunder,
        amount: order.usdcAmount.toString(),
        payment_hash: order.paymentHash,
        timelock: order.timelock,
        swap_id: swapIdOf(terms),
        invoice: order.invoice,
        invoice_expires_at: order.invoiceExpiresAt,
        lightning_address: order.lightningAddress,
        authorization: {
          kind: "eip3009_receive_with_authorization",
          typed_data: receiveAuthorizationJson(this.deps.tokenDomain, htlc, terms, 0n, BigInt(order.validUntil)),
          submit: `/v1/rfq/${order.id}/authorization`,
        },
      },
    };
  }

  // ---------------------------------------------------------------- gasless locks

  /** Submit the payer's signed EIP-3009 authorization for an open quote. */
  async relayAuthorization(id: string, body: unknown): Promise<{ tx_hash: Hex }> {
    if (!this.deps.config.features.relayAuthorizations) throw new HttpError(403, "this solver does not relay authorizations");
    const order = this.deps.store.getOrder(id);
    if (!order) throw new HttpError(404, "unknown rfq_id");
    if (order.state !== "quoted") throw new HttpError(409, `the order is ${order.state}`);
    if (this.now() >= order.validUntil) throw new HttpError(409, "the quote has expired");
    const signature = (body as { signature?: unknown } | null)?.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new HttpError(400, "signature must be 65 bytes of hex");
    if (this.relaying.has(id) || order.relayTx) throw new HttpError(409, "a lock for this quote is already being submitted");

    const terms = this.termsOf(order);
    const auth = { validAfter: 0n, validBefore: BigInt(order.validUntil), signature: signature as Hex };
    const typed = receiveAuthorization(this.deps.tokenDomain, this.deps.htlc.address, terms, auth.validAfter, auth.validBefore);
    const valid = await verifyTypedData({ address: order.refunder, ...typed, signature: auth.signature }).catch(() => false);
    if (!valid) throw new HttpError(400, `the signature is not ${order.refunder}'s authorization for this quote`);
    const balance = await this.deps.htlc.publicClient.readContract({
      address: this.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [order.refunder],
    });
    if (balance < terms.amount) throw new HttpError(400, `${order.refunder} holds ${balance} USDC base units, needs ${terms.amount}`);

    this.relaying.add(id);
    try {
      const txHash = await this.deps.htlc.lockWithAuthorization(terms, auth);
      // The loop may have moved the order on meanwhile: record the tx on the latest row only.
      this.update(order, { relayTx: txHash });
      log.info("relayed gasless lock", { id: id.slice(0, 12), tx: txHash });
      return { tx_hash: txHash };
    } catch (err) {
      throw new HttpError(400, `the lock did not go through: ${errorMessage(err)}`);
    } finally {
      this.relaying.delete(id);
    }
  }

  // ---------------------------------------------------------------- the loop

  start(): void {
    const interval = this.deps.config.timing.pollIntervalMs;
    this.timer = setInterval(() => void this.tick(), interval);
    this.unsubscribe = this.deps.lightning.onChange(() => void this.tick());
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.ticking;
  }

  /** One pass: read new locks, then move every open order and every lock to hand back. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  private async pass(): Promise<void> {
    try {
      await this.scanLocks();
    } catch (err) {
      log.warn("lock scan failed", { err: errorMessage(err) });
    }
    for (const order of this.deps.store.ordersIn(OPEN_ORDER_STATES)) {
      try {
        await this.advance(order);
      } catch (err) {
        log.error("order step failed", { id: order.id.slice(0, 12), state: order.state, err: errorMessage(err) });
      }
    }
    try {
      await this.returnLocks();
    } catch (err) {
      log.warn("returning locks failed", { err: errorMessage(err) });
    }
  }

  private async scanLocks(): Promise<void> {
    const { config, store, htlc } = this.deps;
    const head = await htlc.publicClient.getBlockNumber({ cacheTime: 0 });
    const confirmations = BigInt(config.base.confirmations);
    if (head + 1n < confirmations) return;
    const safeHead = head - confirmations + 1n;
    const cursor = store.get("scan.nextBlock");
    let from = cursor ? BigInt(cursor) : (config.base.htlcDeployBlock ?? safeHead);
    while (from <= safeHead) {
      const to = from + config.base.logChunk - 1n < safeHead ? from + config.base.logChunk - 1n : safeHead;
      for (const event of await htlc.lockedEvents(from, to, this.claimer)) await this.onLock(event);
      store.set("scan.nextBlock", (to + 1n).toString());
      from = to + 1n;
    }
  }

  private async blockTime(blockNumber: bigint): Promise<number> {
    let time = this.blockTimes.get(blockNumber);
    if (time === undefined) {
      time = Number((await this.deps.htlc.publicClient.getBlock({ blockNumber })).timestamp);
      this.blockTimes.set(blockNumber, time);
      if (this.blockTimes.size > 1000) this.blockTimes.delete(this.blockTimes.keys().next().value!);
    }
    return time;
  }

  /** A `Locked` event naming this solver: match it to its quote and accept or decline it. */
  private async onLock(event: LockedEvent): Promise<void> {
    const { store } = this.deps;
    if (store.getLock(event.swapId)) return;
    const now = this.now();
    const order = store.getOrderByPaymentHash(event.paymentHash);
    const record: LockRecord = {
      swapId: event.swapId,
      orderId: order?.id,
      status: "accepted",
      paymentHash: event.paymentHash,
      token: event.token,
      refunder: event.refunder,
      claimer: event.claimer,
      amount: event.amount,
      timelock: Number(event.timelock),
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      blockTime: await this.blockTime(event.blockNumber),
      createdAt: now,
      updatedAt: now,
    };
    const decline = (reason: string) => {
      store.saveLock({ ...record, status: "rejected", reason });
      log.warn("declined a lock", { swapId: event.swapId.slice(0, 12), reason });
    };

    if (getAddress(event.token) !== this.usdc) return decline("the lock is not USDC");
    if (!order) return decline("no quote has this payment hash");
    if (order.state !== "quoted" && order.state !== "expired") return decline(`the order is already ${order.state}`);
    if (event.amount < order.usdcAmount) return decline(`the lock carries ${event.amount}, below the quoted ${order.usdcAmount}`);
    if (record.timelock < order.timelock) return decline(`the timelock ${record.timelock} is before the quoted ${order.timelock}`);
    if (record.blockTime > order.validUntil) {
      const late = await this.lateLockAcceptable(order, event.amount);
      if (!late.ok) return decline(`the lock landed after the quote expired: ${late.reason}`);
    }

    store.saveLock(record);
    this.update(order, {
      state: "locked",
      swapId: event.swapId,
      lockAmount: event.amount,
      lockTimelock: record.timelock,
      lockTx: event.txHash,
      ...(order.valueSats !== undefined ? { valueSats: order.valueSats } : {}),
    });
    log.info("lock accepted", { id: order.id.slice(0, 12), usdc: event.amount, tx: event.txHash });
  }

  /** A lock after `valid_until` is honoured only if the USDC still covers the payment at today's price. */
  private async lateLockAcceptable(order: Order, amount: bigint): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.now() + INVOICE_PAY_MARGIN_SECONDS * 2 > order.invoiceExpiresAt) return { ok: false, reason: "the invoice is about to expire" };
    try {
      const price = await this.deps.prices.price();
      const value = usdcToSats(amount, price.microUsdcPerBtc);
      const budget = (value * (10_000n - this.deps.config.pricing.spreadBps)) / 10_000n;
      if (budget < order.quotedCostSats) return { ok: false, reason: "the price moved against the quote" };
      if (value < order.valueSats) order.valueSats = value;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `no price: ${errorMessage(err)}` };
    }
  }

  private async advance(order: Order): Promise<void> {
    const now = this.now();
    switch (order.state) {
      case "quoted":
        if (now > order.validUntil) this.update(order, { state: "expired" });
        return;
      case "expired":
        if (now > order.invoiceExpiresAt) this.update(order, { state: "cancelled", note: "the quote expired unfunded" });
        return;
      case "locked":
        return this.pay(order);
      case "paying":
        return this.followPayment(order);
      case "paid":
        return this.claim(order);
      default:
        return;
    }
  }

  /** Apply `changes` onto the latest stored row (another writer may have added fields), then mirror it. */
  private update(order: Order, changes: Partial<Order>): void {
    const latest = this.deps.store.getOrder(order.id) ?? order;
    Object.assign(latest, changes, { updatedAt: this.now() });
    this.deps.store.saveOrder(latest);
    Object.assign(order, latest);
  }

  private lockTerms(order: Order): HtlcTerms {
    const lock = order.swapId ? this.deps.store.getLock(order.swapId) : undefined;
    if (!lock) throw new Error(`order ${order.id} has no lock`);
    return {
      paymentHash: lock.paymentHash,
      token: lock.token,
      refunder: lock.refunder,
      claimer: lock.claimer,
      amount: lock.amount,
      timelock: BigInt(lock.timelock),
    };
  }

  /** Decline an order whose invoice was never paid, and queue its lock to go back to the payer. */
  private decline(order: Order, reason: string): void {
    this.update(order, { state: "cancelled", note: reason });
    const lock = order.swapId ? this.deps.store.getLock(order.swapId) : undefined;
    if (lock && lock.status === "accepted") this.deps.store.saveLock({ ...lock, status: "rejected", reason, updatedAt: this.now() });
    log.warn("order declined; the USDC goes back to the payer", { id: order.id.slice(0, 12), reason });
  }

  /** The lock is in: pay the invoice out of Arkade. */
  private async pay(order: Order): Promise<void> {
    const { htlc, lightning, config } = this.deps;
    const status = await htlc.status(order.swapId!);
    if (status !== HtlcStatus.Locked) {
      // The lock vanished (reorg) or was settled behind our back; nothing was paid yet.
      if (status === HtlcStatus.None) {
        const lock = this.deps.store.getLock(order.swapId!);
        if (lock) this.deps.store.saveLock({ ...lock, status: "returned", reason: "the lock is gone (reorg?)", updatedAt: this.now() });
        this.update(order, { state: this.now() > order.validUntil ? "expired" : "quoted", swapId: undefined, note: "the lock disappeared" });
      } else {
        this.update(order, { state: "cancelled", note: "the lock was settled before the solver paid" });
      }
      return;
    }

    const existing = await lightning.findByPaymentHash(order.paymentHash);
    if (existing) {
      this.update(order, { state: "paying", arkadeSwapId: existing });
      return this.followPayment(order);
    }
    if (this.now() + INVOICE_PAY_MARGIN_SECONDS >= order.invoiceExpiresAt) return this.decline(order, "the invoice expired before it could be paid");

    const latestRefundLocktime = order.lockTimelock! - ARKADE_REFUND_RETRY_SECONDS - Math.floor(config.timing.timelockMarginSeconds / 2);
    if (config.features.dryRun) {
      // Rehearse the payment without funding it, then hand the USDC back.
      const route = await lightning.quote(order.invoice).catch((err: unknown) => err as Error);
      const verdict =
        route instanceof Error
          ? `the route did not quote: ${route.message}`
          : route.costSats > order.valueSats
            ? `the payment would cost ${route.costSats} sats, over the ${order.valueSats} sat value`
            : route.refundLocktime > latestRefundLocktime
              ? "the Arkade refund window would end after the payer's timelock allows"
              : `would lock ${route.costSats} sats in Arkade to pay ${route.invoiceSats} sats`;
      return this.decline(order, `dry run: ${verdict}`);
    }
    // Mark first: if the process dies inside pay(), the next pass finds the swap by payment hash.
    this.update(order, { state: "paying", payAttempts: (order.payAttempts ?? 0) + 1 });
    try {
      const started = await lightning.pay(order.invoice, { maxCostSats: order.valueSats, latestRefundLocktime });
      this.update(order, { arkadeSwapId: started.swapId, arkadeCostSats: started.costSats, arkadeRefundLocktime: started.refundLocktime });
      log.info("paying the invoice via Arkade", { id: order.id.slice(0, 12), sats: order.invoiceSats, lock: started.costSats, swap: started.swapId });
    } catch (err) {
      // Only a lookup that answers "no swap" proves nothing was funded. If the lookup fails too, stay
      // in `paying`: the next pass looks again, and never hands back USDC for an invoice in flight.
      let funded: string | undefined;
      try {
        funded = await lightning.findByPaymentHash(order.paymentHash);
      } catch (lookupErr) {
        this.update(order, { note: `pay failed (${errorMessage(err)}) and the lookup failed (${errorMessage(lookupErr)}); re-checking` });
        return;
      }
      if (funded) {
        this.update(order, { arkadeSwapId: funded });
        return;
      }
      if ((order.payAttempts ?? 0) < MAX_PAY_ATTEMPTS) {
        this.update(order, { state: "locked", note: `pay attempt ${order.payAttempts} failed: ${errorMessage(err)}` });
        log.warn("pay attempt failed; will retry", { id: order.id.slice(0, 12), err: errorMessage(err) });
        return;
      }
      this.decline(order, `could not pay the invoice: ${errorMessage(err)}`);
    }
  }

  /** The Arkade lockup is funded: wait for the Lightning solver to pay and reveal the preimage. */
  private async followPayment(order: Order): Promise<void> {
    const { lightning } = this.deps;
    if (!order.arkadeSwapId) {
      const found = await lightning.findByPaymentHash(order.paymentHash);
      if (found) this.update(order, { arkadeSwapId: found });
      else return this.update(order, { state: "locked", note: "the payment never started; retrying" });
    }
    const state = await lightning.state(order.arkadeSwapId!);
    switch (state.status) {
      case "paid": {
        const preimage = `0x${state.preimage}` as Hex;
        if (sha256Hex(preimage) !== order.paymentHash.toLowerCase()) {
          log.error("the payment's preimage does not match the invoice", { id: order.id.slice(0, 12) });
          return;
        }
        this.update(order, { state: "paid", preimage });
        log.info("invoice paid; claiming the USDC", { id: order.id.slice(0, 12), to: order.lightningAddress });
        return this.claim(order);
      }
      case "refunded":
        return this.decline(order, "the Lightning payment failed and the Arkade lockup came back");
      case "failed":
        if (order.note !== state.detail) {
          log.warn("the Arkade swap reports a failure; still watching for the preimage", { id: order.id.slice(0, 12), detail: state.detail });
          this.update(order, { note: state.detail });
        }
        return;
      case "pending":
        if (state.detail.startsWith("needs recovery")) await lightning.recover?.(order.arkadeSwapId!);
        if (order.lockTimelock && this.now() > order.lockTimelock - 3600) {
          log.error("the payer's refund opens within the hour and the invoice is still unpaid", { id: order.id.slice(0, 12) });
        }
        return;
    }
  }

  /** Take the USDC with the preimage. */
  private async claim(order: Order): Promise<void> {
    const { htlc } = this.deps;
    if (order.claimTx) {
      const receipt = await htlc.publicClient.getTransactionReceipt({ hash: order.claimTx }).catch(() => undefined);
      if (receipt?.status === "success") return this.settle(order);
      if (!receipt && this.now() - (order.claimSentAt ?? 0) < RESEND_AFTER_SECONDS) return; // still pending
    }
    const status = await htlc.status(order.swapId!);
    if (status === HtlcStatus.Claimed) return this.settle(order);
    if (status === HtlcStatus.Refunded) {
      this.update(order, { state: "settled", note: "LOSS: the invoice was paid but the lock went back to the payer" });
      log.error("the lock was refunded after the invoice was paid", { id: order.id.slice(0, 12) });
      return;
    }
    const hash = await htlc.claim(this.lockTerms(order), order.preimage!);
    this.update(order, { claimTx: hash, claimSentAt: this.now() });
    log.info("claim submitted", { id: order.id.slice(0, 12), tx: hash });
    const receipt = await htlc.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }).catch(() => undefined);
    if (receipt?.status === "success") this.settle(order);
  }

  private settle(order: Order): void {
    this.update(order, { state: "settled" });
    const lock = this.deps.store.getLock(order.swapId!);
    if (lock) this.deps.store.saveLock({ ...lock, status: "claimed", updatedAt: this.now() });
    log.info("settled", { id: order.id.slice(0, 12), usdc: order.lockAmount, sats: order.invoiceSats, to: order.lightningAddress });
  }

  /** Hand declined locks back to their payers with `cancel`. */
  private async returnLocks(): Promise<void> {
    if (!this.deps.config.features.autoRefund) return;
    const { htlc, store } = this.deps;
    for (const lock of store.locksIn(["rejected", "cancelling"])) {
      try {
        await this.returnLock(lock);
      } catch (err) {
        log.warn("could not hand a lock back yet", { swapId: lock.swapId.slice(0, 12), err: errorMessage(err) });
      }
    }
  }

  private async returnLock(lock: LockRecord): Promise<void> {
    const { htlc, store } = this.deps;
    if (lock.status === "cancelling" && lock.cancelTx) {
      const receipt = await htlc.publicClient.getTransactionReceipt({ hash: lock.cancelTx }).catch(() => undefined);
      if (receipt?.status === "success") return store.saveLock({ ...lock, status: "returned", updatedAt: this.now() });
      if (!receipt && this.now() - (lock.cancelSentAt ?? 0) < RESEND_AFTER_SECONDS) return; // still pending
    }
    // Never hand back a lock whose order is being paid or was paid.
    const order = lock.orderId ? store.getOrder(lock.orderId) : undefined;
    if (order?.swapId === lock.swapId && ["locked", "paying", "paid", "settled"].includes(order.state)) {
      log.error("refusing to return a lock that funds a live order", { swapId: lock.swapId.slice(0, 12) });
      return;
    }
    // Not ours to touch, or not worth the gas: its payer refunds it at the timelock.
    if (getAddress(lock.token) !== this.usdc || (!order && lock.amount < MIN_UNSOLICITED_RETURN)) {
      return store.saveLock({ ...lock, status: "ignored", updatedAt: this.now() });
    }
    const status = await htlc.status(lock.swapId);
    if (status !== HtlcStatus.Locked) {
      return store.saveLock({ ...lock, status: status === HtlcStatus.Claimed ? "claimed" : "returned", updatedAt: this.now() });
    }
    const terms: HtlcTerms = { ...lock, timelock: BigInt(lock.timelock) };
    const hash = await htlc.cancel(terms);
    store.saveLock({ ...lock, status: "cancelling", cancelTx: hash, cancelSentAt: this.now(), updatedAt: this.now() });
    log.info("handing a lock back to its payer", { swapId: lock.swapId.slice(0, 12), tx: hash, reason: lock.reason });
  }

  // ---------------------------------------------------------------- reads

  /** An `rfq_status` for one order, or undefined. */
  status(id: string) {
    const order = this.deps.store.getOrder(id);
    if (!order) return undefined;
    const lock = order.swapId ? this.deps.store.getLock(order.swapId) : this.deps.store.locksForOrder(id)[0];
    return {
      v: 1,
      type: "rfq_status",
      rfq_id: id,
      state: order.state,
      updated_at: order.updatedAt,
      profile: {
        usdc_amount: order.usdcAmount.toString(),
        sats: Number(order.invoiceSats),
        lightning_address: order.lightningAddress,
        payment_hash: order.paymentHash,
        invoice: order.invoice,
        valid_until: order.validUntil,
        timelock: order.timelock,
        relay_tx: order.relayTx,
        lock_tx: order.lockTx ?? lock?.txHash,
        swap_id: order.swapId ?? lock?.swapId,
        arkade_swap_id: order.arkadeSwapId,
        // the receipt: the preimage proves the Lightning address was paid
        preimage: order.state === "paid" || order.state === "settled" ? order.preimage : undefined,
        claim_tx: order.claimTx,
        lock_status: lock?.status,
        return_tx: lock?.cancelTx,
        note: order.note ?? lock?.reason,
      },
    };
  }
}
