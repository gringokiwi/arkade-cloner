/**
 * BTC spot price in USD(C), as the median of several public feeds. The solver refuses to quote
 * when too few feeds answer or when they disagree by more than `maxDeviationBps`.
 */

type FetchLike = typeof fetch;

export interface PriceSample {
  source: string;
  /** USD (or USDC) per BTC. */
  price: number;
}

export interface Price {
  /** Median of the samples, USDC per BTC. */
  usdPerBtc: number;
  /** The same price in USDC base units (6 decimals) per BTC, as an integer. */
  microUsdcPerBtc: bigint;
  samples: PriceSample[];
  fetchedAt: number;
}

const getJson = async (fetchImpl: FetchLike, url: string): Promise<any> => {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** Each feed returns USD (or USDC) per BTC. */
export const PRICE_FEEDS: Record<string, (fetchImpl: FetchLike) => Promise<number>> = {
  coinbase: async (f) => Number((await getJson(f, "https://api.coinbase.com/v2/prices/BTC-USD/spot")).data.amount),
  kraken: async (f) => {
    const body = await getJson(f, "https://api.kraken.com/0/public/Ticker?pair=XBTUSDC");
    const ticker = Object.values(body.result ?? {})[0] as { a: string[]; b: string[] } | undefined;
    if (!ticker) throw new Error("no ticker");
    return (Number(ticker.a[0]) + Number(ticker.b[0])) / 2; // mid of best ask and bid
  },
  coingecko: async (f) =>
    Number((await getJson(f, "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")).bitcoin.usd),
  bitstamp: async (f) => {
    const body = await getJson(f, "https://www.bitstamp.net/api/v2/ticker/btcusd/");
    return (Number(body.ask) + Number(body.bid)) / 2;
  },
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface PriceOracleOptions {
  sources: string[];
  minSources: number;
  maxDeviationBps: number;
  /** Reuse a price for this long. */
  cacheMs?: number;
  fetchImpl?: FetchLike;
}

export class PriceOracle {
  private cached?: Price;

  constructor(private readonly options: PriceOracleOptions) {
    for (const source of options.sources) {
      if (!PRICE_FEEDS[source]) throw new Error(`unknown price source ${source} (known: ${Object.keys(PRICE_FEEDS).join(", ")})`);
    }
  }

  async price(): Promise<Price> {
    const cacheMs = this.options.cacheMs ?? 15_000;
    if (this.cached && Date.now() - this.cached.fetchedAt < cacheMs) return this.cached;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const settled = await Promise.allSettled(
      this.options.sources.map(async (source) => ({ source, price: await PRICE_FEEDS[source]!(fetchImpl) })),
    );
    const samples = settled
      .filter((s): s is PromiseFulfilledResult<PriceSample> => s.status === "fulfilled")
      .map((s) => s.value)
      .filter((s) => Number.isFinite(s.price) && s.price > 0);
    if (samples.length < this.options.minSources) {
      throw new Error(`only ${samples.length} of ${this.options.sources.length} price feeds answered (need ${this.options.minSources})`);
    }
    const usdPerBtc = median(samples.map((s) => s.price));
    const spread = Math.max(...samples.map((s) => Math.abs(s.price - usdPerBtc) / usdPerBtc));
    if (spread * 10_000 > this.options.maxDeviationBps) {
      throw new Error(`price feeds disagree by ${(spread * 100).toFixed(2)}%: ${samples.map((s) => `${s.source}=${s.price}`).join(" ")}`);
    }
    this.cached = { usdPerBtc, microUsdcPerBtc: BigInt(Math.round(usdPerBtc * 1e6)), samples, fetchedAt: Date.now() };
    return this.cached;
  }
}

/** A fixed price, for tests and dry runs. */
export const fixedPrice = (usdPerBtc: number): { price(): Promise<Price> } => ({
  price: async () => ({
    usdPerBtc,
    microUsdcPerBtc: BigInt(Math.round(usdPerBtc * 1e6)),
    samples: [{ source: "fixed", price: usdPerBtc }],
    fetchedAt: Date.now(),
  }),
});
