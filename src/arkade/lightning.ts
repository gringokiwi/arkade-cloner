/**
 * Paying a Lightning invoice out of the solver's Arkade BTC, through Arkade Intents.
 *
 * `pay` quotes the route `arkade:bitcoin/slip44:0 -> bolt11:bitcoin/slip44:0` with the Lightning
 * solver, checks the cost and the refund window against the caller's limits, then accepts: the
 * swap client persists the swap and funds an Arkade lockup locked to the invoice's payment hash.
 * The Lightning solver pays the invoice, learns the preimage, and claims the lockup with it; the
 * claim's witness puts the preimage on the swap record (`settlementPreimageHex`), and that
 * preimage is what releases the payer's USDC on Base.
 */
import { createHash } from "node:crypto";
import { btcOn, SwapDriveRefusedError, type Swap } from "@arkade-os/swap";
import type { ArkadeSide } from "./wallet.js";

export interface LightningQuote {
  /** The invoice amount: what the Lightning address receives. */
  invoiceSats: bigint;
  /** What the solver locks within Arkade: invoice plus routing fee. */
  costSats: bigint;
  feeSats: bigint;
  /** Unix seconds when an unpaid lockup can be refunded. */
  refundLocktime: number;
  /** Unix seconds the quote can be accepted until. */
  expiresAt: number;
}

export interface PaymentStarted {
  swapId: string;
  costSats: bigint;
  refundLocktime: number;
}

export type PaymentState =
  | { status: "pending"; detail: string }
  | { status: "paid"; preimage: string }
  | { status: "refunded"; detail: string }
  | { status: "failed"; detail: string };

/** What the solver engine needs from a Lightning payment backend. */
export interface LightningPayer {
  quote(bolt11: string): Promise<LightningQuote>;
  /** Fund the payment. Throws (before any value moves) when the quote breaks a limit. */
  pay(bolt11: string, limits: { maxCostSats: bigint; latestRefundLocktime: number }): Promise<PaymentStarted>;
  /** A payment already started for this payment hash, if any (crash recovery). */
  findByPaymentHash(paymentHash: string): Promise<string | undefined>;
  state(swapId: string): Promise<PaymentState>;
  /** Sats the solver can spend now. */
  availableSats(): Promise<bigint>;
  /** Called whenever a payment's state may have changed. */
  onChange(listener: () => void): () => void;
  /** Settle a swept lockup back into the wallet (`needs_recovery`), if the backend can. */
  recover?(swapId: string): Promise<void>;
}

const sha256Hex = (hex: string) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const strip0x = (hex: string) => hex.replace(/^0x/, "").toLowerCase();

export class ArkadeLightningPayer implements LightningPayer {
  private readonly btc;

  constructor(private readonly arkade: ArkadeSide) {
    this.btc = btcOn("arkade", arkade.network);
  }

  async quote(bolt11: string): Promise<LightningQuote> {
    const quote = await this.arkade.client.quote({ give: this.btc, to: bolt11 });
    if (quote.refundLocktime === undefined) throw new Error("the Lightning quote carries no refund locktime");
    return {
      invoiceSats: quote.take.amount,
      costSats: quote.give.amount,
      feeSats: quote.fee.amount,
      refundLocktime: quote.refundLocktime,
      expiresAt: quote.expiresAt,
    };
  }

  async pay(bolt11: string, limits: { maxCostSats: bigint; latestRefundLocktime: number }): Promise<PaymentStarted> {
    const quote = await this.arkade.client.quote({ give: this.btc, to: bolt11 });
    if (quote.give.amount > limits.maxCostSats) {
      throw new Error(`paying the invoice costs ${quote.give.amount} sats, over the ${limits.maxCostSats} sat limit`);
    }
    if (quote.refundLocktime === undefined || quote.refundLocktime > limits.latestRefundLocktime) {
      throw new Error(`the Arkade refund window (${quote.refundLocktime}) ends after ${limits.latestRefundLocktime}`);
    }
    // accept() persists the swap and its secrets, then funds the lockup.
    const swap = await this.arkade.client.accept(quote);
    return { swapId: swap.id, costSats: swap.give.amount, refundLocktime: swap.refundLocktime ?? quote.refundLocktime };
  }

  async findByPaymentHash(paymentHash: string): Promise<string | undefined> {
    const target = strip0x(paymentHash);
    const swaps = await this.arkade.client.swaps({ family: "rfq" });
    return swaps.find((s) => s.lock?.hash && strip0x(s.lock.hash) === target)?.id;
  }

  async state(swapId: string): Promise<PaymentState> {
    const swaps = await this.arkade.client.swaps({ family: "rfq" });
    const swap: Swap | undefined = swaps.find((s) => s.id === swapId);
    if (!swap) return { status: "pending", detail: "unknown to the swap client" };
    switch (swap.outcome) {
      case "paid": {
        const record = (await this.arkade.repository.getSwapRecord(swapId)) as { settlementPreimageHex?: string } | undefined;
        const preimage = record?.settlementPreimageHex;
        if (!preimage) return { status: "pending", detail: "paid; waiting for the preimage on the record" };
        // Never trust a preimage that does not open the lock.
        if (!swap.lock?.hash || sha256Hex(preimage) !== strip0x(swap.lock.hash)) {
          return { status: "failed", detail: "the settlement preimage does not match the payment hash" };
        }
        return { status: "paid", preimage: strip0x(preimage) };
      }
      case "refunded":
        return { status: "refunded", detail: "the Lightning solver never paid; the lockup came back" };
      case "cancelled":
        // accept() could not fund the lockup in time: nothing left the wallet, so nothing was paid.
        return { status: "refunded", detail: "the lockup was never funded" };
      case "failed":
        return { status: "failed", detail: swap.failure ?? swap.outcome };
      case "needs_recovery":
        return { status: "pending", detail: `needs recovery: ${swap.blockedReason ?? "swept"}` };
      default:
        return { status: "pending", detail: swap.outcome };
    }
  }

  async availableSats(): Promise<bigint> {
    const balance = await this.arkade.wallet.getBalance();
    return BigInt(balance.available);
  }

  onChange(listener: () => void): () => void {
    return this.arkade.client.onUpdate(() => listener());
  }

  async recover(swapId: string): Promise<void> {
    try {
      await this.arkade.client.recover(swapId as `rfq:${string}`);
    } catch (err) {
      // A blocked swap (nothing swept) refuses recovery; it resumes when the cause clears.
      if (!(err instanceof SwapDriveRefusedError)) throw err;
    }
  }
}
