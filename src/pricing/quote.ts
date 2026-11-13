/**
 * USDC <-> sats arithmetic. Every amount is an integer in base units: USDC has 6 decimals, BTC is
 * counted in sats, and the price is micro-USDC per BTC. Rounding always favours the solver by at
 * most one unit, so a quote never promises more than the USDC is worth.
 */

export const SATS_PER_BTC = 100_000_000n;
const BPS = 10_000n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface FeeSchedule {
  /** The solver's margin over mid, basis points. */
  spreadBps: bigint;
  /** Reserve for the Arkade -> Lightning routing fee, basis points of the invoice. */
  lightningFeeBps: bigint;
  /** Flat part of that reserve, sats. */
  lightningFeeFlatSats: bigint;
}

export interface Pricing {
  /** USDC base units the payer locks. */
  usdcAmount: bigint;
  /** Sats the Lightning address receives: the invoice amount. */
  invoiceSats: bigint;
  /** What `usdcAmount` is worth at the mid price, in sats. */
  valueSats: bigint;
  /** The most the solver spends from Arkade on this order, Lightning fee included. */
  budgetSats: bigint;
  microUsdcPerBtc: bigint;
}

/** The mid-price value of `usdc` in sats, rounded down. */
export const usdcToSats = (usdc: bigint, microUsdcPerBtc: bigint): bigint => (usdc * SATS_PER_BTC) / microUsdcPerBtc;

/** The USDC needed to be worth `sats` at the mid price, rounded up. */
export const satsToUsdc = (sats: bigint, microUsdcPerBtc: bigint): bigint => ceilDiv(sats * microUsdcPerBtc, SATS_PER_BTC);

/** The Lightning fee reserved for an invoice of `invoiceSats`. */
export const lightningFeeReserve = (invoiceSats: bigint, fees: FeeSchedule): bigint =>
  ceilDiv(invoiceSats * fees.lightningFeeBps, BPS) + fees.lightningFeeFlatSats;

/** The largest invoice whose amount plus fee reserve fits in `budgetSats`. */
export function largestInvoiceWithin(budgetSats: bigint, fees: FeeSchedule): bigint {
  if (budgetSats <= fees.lightningFeeFlatSats) return 0n;
  let invoice = ((budgetSats - fees.lightningFeeFlatSats) * BPS) / (BPS + fees.lightningFeeBps);
  while (invoice > 0n && invoice + lightningFeeReserve(invoice, fees) > budgetSats) invoice -= 1n;
  while (invoice + 1n + lightningFeeReserve(invoice + 1n, fees) <= budgetSats) invoice += 1n;
  return invoice;
}

/** Exact-in: the payer fixes the USDC amount; returns the sats the Lightning address receives. */
export function priceExactIn(usdcAmount: bigint, microUsdcPerBtc: bigint, fees: FeeSchedule): Pricing {
  if (usdcAmount <= 0n) throw new Error("amount must be positive");
  const valueSats = usdcToSats(usdcAmount, microUsdcPerBtc);
  const budgetSats = (valueSats * (BPS - fees.spreadBps)) / BPS;
  const invoiceSats = largestInvoiceWithin(budgetSats, fees);
  return { usdcAmount, invoiceSats, valueSats, budgetSats, microUsdcPerBtc };
}

/**
 * Exact-out: the payer fixes what the Lightning address receives; returns the USDC to lock.
 * `costSats` is the actual Arkade cost when already quoted, else the fee reserve is assumed.
 */
export function priceExactOut(
  invoiceSats: bigint,
  microUsdcPerBtc: bigint,
  fees: FeeSchedule,
  costSats: bigint = invoiceSats + lightningFeeReserve(invoiceSats, fees),
): Pricing {
  if (invoiceSats <= 0n) throw new Error("amount must be positive");
  if (costSats < invoiceSats) throw new Error("cost cannot be below the invoice amount");
  const needed = ceilDiv(costSats * BPS, BPS - fees.spreadBps);
  const usdcAmount = satsToUsdc(needed, microUsdcPerBtc);
  const valueSats = usdcToSats(usdcAmount, microUsdcPerBtc);
  const budgetSats = (valueSats * (BPS - fees.spreadBps)) / BPS;
  return { usdcAmount, invoiceSats, valueSats, budgetSats, microUsdcPerBtc };
}

/** Format USDC base units as a decimal string, e.g. 12345678n -> "12.345678". */
export const formatUsdc = (usdc: bigint): string => {
  const whole = usdc / 1_000_000n;
  const frac = (usdc % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
};

/** Parse a decimal USDC string into base units, e.g. "12.5" -> 12500000n. */
export const parseUsdc = (value: string): bigint => {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error(`not a USDC amount: ${value}`);
  return BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
};
