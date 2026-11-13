import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatUsdc,
  largestInvoiceWithin,
  lightningFeeReserve,
  parseUsdc,
  priceExactIn,
  priceExactOut,
  satsToUsdc,
  usdcToSats,
  type FeeSchedule,
} from "../src/pricing/quote.js";

const fees: FeeSchedule = { spreadBps: 100n, lightningFeeBps: 50n, lightningFeeFlatSats: 10n };
const at = (usdPerBtc: number) => BigInt(Math.round(usdPerBtc * 1e6));

describe("pricing", () => {
  it("converts at the mid price, rounding against the payer by at most one unit", () => {
    assert.equal(usdcToSats(1_000_000n, at(100_000)), 1_000n); // $1 = 1,000 sats at $100k
    assert.equal(satsToUsdc(1_000n, at(100_000)), 1_000_000n);
    assert.equal(usdcToSats(1n, at(68_780)), 0n); // 0.000001 USDC is worth 0.0015 sats -> 0
    assert.equal(usdcToSats(1_000n, at(68_780)), 1n); // 0.001 USDC is worth 1.45 sats -> 1
    assert.equal(satsToUsdc(1n, at(68_780)), 688n); // 1 sat costs 0.0006878 USDC -> rounded up
  });

  it("prices exact-in: spread, then the largest invoice whose fee reserve still fits", () => {
    const p = priceExactIn(25_000_000n, at(100_000), fees);
    assert.equal(p.valueSats, 25_000n);
    assert.equal(p.budgetSats, 24_750n);
    assert.equal(p.invoiceSats, 24_616n);
    assert.ok(p.invoiceSats + lightningFeeReserve(p.invoiceSats, fees) <= p.budgetSats);
    assert.ok(p.invoiceSats + 1n + lightningFeeReserve(p.invoiceSats + 1n, fees) > p.budgetSats);
  });

  it("prices exact-out so the USDC always covers the cost plus the spread", () => {
    for (const price of [20_000, 68_817.37, 100_000, 250_000.5]) {
      for (const sats of [1_000n, 7_150n, 24_616n, 199_999n]) {
        const cost = sats + lightningFeeReserve(sats, fees);
        const p = priceExactOut(sats, at(price), fees);
        assert.equal(p.invoiceSats, sats);
        assert.ok(p.budgetSats >= cost, `budget ${p.budgetSats} < cost ${cost} at ${price}`);
        // and not by more than a sat's worth of USDC rounding
        const tighter = priceExactOut(sats, at(price), fees, cost);
        assert.equal(tighter.usdcAmount, p.usdcAmount);
      }
    }
  });

  it("round-trips exact-in through exact-out within rounding", () => {
    for (const usdc of [1_000_000n, 5_000_000n, 25_000_000n, 137_123_456n]) {
      const inQuote = priceExactIn(usdc, at(68_817.37), fees);
      const outQuote = priceExactOut(inQuote.invoiceSats, at(68_817.37), fees);
      assert.ok(outQuote.usdcAmount <= usdc, "exact-out never asks for more than exact-in paid");
    }
  });

  it("finds the largest invoice within a budget", () => {
    assert.equal(largestInvoiceWithin(10n, fees), 0n);
    for (const budget of [11n, 100n, 1_005n, 50_000n, 400_000n]) {
      const x = largestInvoiceWithin(budget, fees);
      assert.ok(x + lightningFeeReserve(x, fees) <= budget);
      assert.ok(x + 1n + lightningFeeReserve(x + 1n, fees) > budget);
    }
  });

  it("parses and formats USDC", () => {
    assert.equal(parseUsdc("12.5"), 12_500_000n);
    assert.equal(parseUsdc("0.000001"), 1n);
    assert.equal(formatUsdc(12_345_678n), "12.345678");
    assert.throws(() => parseUsdc("1.0000001"));
    assert.throws(() => parseUsdc("-1"));
  });
});
