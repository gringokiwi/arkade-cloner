/**
 * Stand-ins for the two off-chain legs, so the engine can be driven deterministically:
 * a Lightning address that issues invoices whose preimages the test knows, and an Arkade
 * Lightning payer whose payments the test settles or refunds.
 */
import { createHash, randomBytes } from "node:crypto";
import type { LightningPayer, LightningQuote, PaymentStarted, PaymentState } from "../../src/arkade/lightning.js";
import type { InvoiceOptions, VerifiedInvoice } from "../../src/lightning/lnurl.js";

interface FakeInvoice {
  bolt11: string;
  sats: bigint;
  preimage: string;
  paymentHash: string;
  expiresAt: number;
}

/** A Lightning address whose invoices the test can "pay" because it knows their preimages. */
export class FakeLightningAddress {
  readonly invoices = new Map<string, FakeInvoice>();
  requests: Array<{ address: string; sats: bigint; comment?: string }> = [];

  invoiceFor = async (address: string, sats: bigint, options: InvoiceOptions): Promise<VerifiedInvoice> => {
    this.requests.push({ address, sats, comment: options.comment });
    const preimage = randomBytes(32).toString("hex");
    const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const now = Math.floor(Date.now() / 1000);
    const invoice: FakeInvoice = { bolt11: `lnbcfake${paymentHash.slice(0, 16)}`, sats, preimage, paymentHash, expiresAt: now + 86_400 };
    this.invoices.set(invoice.bolt11, invoice);
    return {
      bolt11: invoice.bolt11,
      bech32Prefix: "bc",
      amountMsat: sats * 1000n,
      amountSats: sats,
      paymentHash,
      timestamp: now,
      expiry: 86_400,
      expiresAt: invoice.expiresAt,
      lightningAddress: address,
    };
  };
}

interface FakeSwap {
  id: string;
  invoice: FakeInvoice;
  cost: bigint;
  state: PaymentState;
}

/** An Arkade Lightning payer whose payments settle or fail when the test says so. */
export class FakeLightningPayer implements LightningPayer {
  readonly swaps = new Map<string, FakeSwap>();
  private listeners = new Set<() => void>();
  feeBps = 30n;
  feeFlat = 3n;
  refundWindow = 14 * 86_400;
  balance = 10_000_000n;
  failQuotes = false;

  constructor(private readonly address: FakeLightningAddress) {}

  private invoice(bolt11: string): FakeInvoice {
    const invoice = this.address.invoices.get(bolt11);
    if (!invoice) throw new Error("unknown invoice");
    return invoice;
  }

  async quote(bolt11: string): Promise<LightningQuote> {
    if (this.failQuotes) throw new Error("SwapRefusal: pricing_unavailable");
    const invoice = this.invoice(bolt11);
    const fee = (invoice.sats * this.feeBps + 9_999n) / 10_000n + this.feeFlat;
    const now = Math.floor(Date.now() / 1000);
    return { invoiceSats: invoice.sats, costSats: invoice.sats + fee, feeSats: fee, refundLocktime: now + this.refundWindow, expiresAt: now + 900 };
  }

  async pay(bolt11: string, limits: { maxCostSats: bigint; latestRefundLocktime: number }): Promise<PaymentStarted> {
    const quote = await this.quote(bolt11);
    if (quote.costSats > limits.maxCostSats) throw new Error("MaxFeeExceeded");
    if (quote.refundLocktime > limits.latestRefundLocktime) throw new Error("refund window too long");
    if (quote.costSats > this.balance) throw new Error("InsufficientFunds");
    this.balance -= quote.costSats;
    const id = `rfq:${randomBytes(8).toString("hex")}`;
    this.swaps.set(id, { id, invoice: this.invoice(bolt11), cost: quote.costSats, state: { status: "pending", detail: "funded" } });
    return { swapId: id, costSats: quote.costSats, refundLocktime: quote.refundLocktime };
  }

  async findByPaymentHash(paymentHash: string): Promise<string | undefined> {
    const target = paymentHash.replace(/^0x/, "");
    return [...this.swaps.values()].find((s) => s.invoice.paymentHash === target)?.id;
  }

  async state(swapId: string): Promise<PaymentState> {
    return this.swaps.get(swapId)?.state ?? { status: "pending", detail: "unknown" };
  }

  async availableSats(): Promise<bigint> {
    return this.balance;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The Lightning solver paid the invoice and claimed the lockup: the preimage is public. */
  settle(swapId: string): void {
    const swap = this.swaps.get(swapId)!;
    swap.state = { status: "paid", preimage: swap.invoice.preimage };
    for (const l of this.listeners) l();
  }

  /** The Lightning solver never paid; the lockup came back. */
  refund(swapId: string): void {
    const swap = this.swaps.get(swapId)!;
    swap.state = { status: "refunded", detail: "refunded" };
    this.balance += swap.cost;
    for (const l of this.listeners) l();
  }
}
