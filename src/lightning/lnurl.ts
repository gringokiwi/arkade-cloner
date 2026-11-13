/**
 * Paying a Lightning address: LUD-16 (address -> LNURL-pay endpoint), LUD-06 (payRequest and
 * callback), LUD-12 (comments). The solver fetches one invoice per quote and checks it before the
 * payer is asked to lock anything against its payment hash.
 */
import { createHash } from "node:crypto";
import { normalizeLightningAddress } from "../config.js";
import { decodeInvoice, type DecodedInvoice } from "./invoice.js";

export interface PayRequest {
  address: string;
  callback: string;
  minSendableMsat: bigint;
  maxSendableMsat: bigint;
  /** The raw metadata string; the invoice's description hash must be its sha256. */
  metadata: string;
  commentAllowed: number;
}

export interface VerifiedInvoice extends DecodedInvoice {
  amountSats: bigint;
  lightningAddress: string;
}

export interface InvoiceOptions {
  comment?: string;
  /** The invoice must stay payable until at least this Unix time. */
  validUntilAtLeast?: number;
  now?: () => number;
}

type FetchLike = typeof fetch;

const unixNow = () => Math.floor(Date.now() / 1000);

async function getJson(fetchImpl: FetchLike, url: string): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} returned non-JSON (HTTP ${res.status})`);
  }
  if (typeof body !== "object" || body === null) throw new Error(`${new URL(url).host} returned an unexpected body`);
  const record = body as Record<string, unknown>;
  if (record.status === "ERROR") throw new Error(`LNURL error from ${new URL(url).host}: ${String(record.reason ?? "unknown")}`);
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return record;
}

/** LUD-16: resolve `name@domain` to its LNURL-pay parameters. */
export async function resolveLightningAddress(address: string, fetchImpl: FetchLike = fetch): Promise<PayRequest> {
  const normalized = normalizeLightningAddress(address);
  const [name, domain] = normalized.split("@") as [string, string];
  const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  const body = await getJson(fetchImpl, url);

  if (body.tag !== "payRequest") throw new Error(`${normalized} is not an LNURL-pay endpoint (tag ${String(body.tag)})`);
  const callback = String(body.callback ?? "");
  if (!callback.startsWith("https://")) throw new Error(`${normalized} has an invalid callback URL`);
  const metadata = String(body.metadata ?? "");
  let entries: unknown;
  try {
    entries = JSON.parse(metadata);
  } catch {
    throw new Error(`${normalized} returned malformed metadata`);
  }
  // LUD-16: the metadata must name the address being paid.
  const identifies =
    Array.isArray(entries) &&
    entries.some(
      (e) => Array.isArray(e) && (e[0] === "text/identifier" || e[0] === "text/email") && String(e[1]).toLowerCase() === normalized,
    );
  if (!identifies) throw new Error(`metadata from ${domain} does not identify ${normalized}`);

  const min = BigInt(String(body.minSendable ?? "0"));
  const max = BigInt(String(body.maxSendable ?? "0"));
  if (min <= 0n || max < min) throw new Error(`${normalized} advertises invalid sendable bounds`);

  return {
    address: normalized,
    callback,
    minSendableMsat: min,
    maxSendableMsat: max,
    metadata,
    commentAllowed: Number(body.commentAllowed ?? 0) || 0,
  };
}

/**
 * Check an invoice an LNURL service returned (LUD-06): mainnet, the exact amount asked for,
 * a description hash committing to the metadata, and enough time left to complete the swap.
 */
export function verifyInvoice(
  payRequest: PayRequest,
  bolt11: string,
  amountSats: bigint,
  options: InvoiceOptions = {},
): VerifiedInvoice {
  const now = (options.now ?? unixNow)();
  const invoice = decodeInvoice(bolt11);
  if (invoice.bech32Prefix !== "bc") throw new Error(`invoice is not for Bitcoin mainnet (prefix ${invoice.bech32Prefix})`);
  if (invoice.amountMsat === undefined || invoice.amountMsat !== amountSats * 1000n) {
    throw new Error(`invoice amount ${invoice.amountMsat ?? "none"} msat does not match the ${amountSats * 1000n} msat requested`);
  }
  const expectedHash = createHash("sha256").update(payRequest.metadata, "utf8").digest("hex");
  if (invoice.descriptionHash !== expectedHash) throw new Error("invoice description hash does not commit to the LNURL metadata");
  if (invoice.expiresAt <= now) throw new Error("invoice is already expired");
  if (options.validUntilAtLeast !== undefined && invoice.expiresAt < options.validUntilAtLeast) {
    throw new Error(`invoice expires at ${invoice.expiresAt}, before the required ${options.validUntilAtLeast}`);
  }
  return { ...invoice, amountSats, lightningAddress: payRequest.address };
}

/** LUD-06 callback: ask the service for an invoice of exactly `amountSats`. */
export async function requestInvoice(
  payRequest: PayRequest,
  amountSats: bigint,
  options: InvoiceOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<VerifiedInvoice> {
  const msat = amountSats * 1000n;
  if (msat < payRequest.minSendableMsat || msat > payRequest.maxSendableMsat) {
    throw new Error(
      `${payRequest.address} accepts ${payRequest.minSendableMsat / 1000n}-${payRequest.maxSendableMsat / 1000n} sats, not ${amountSats}`,
    );
  }
  const url = new URL(payRequest.callback);
  url.searchParams.set("amount", msat.toString());
  if (options.comment && payRequest.commentAllowed > 0) {
    url.searchParams.set("comment", options.comment.slice(0, payRequest.commentAllowed));
  }
  const body = await getJson(fetchImpl, url.toString());
  const pr = body.pr;
  if (typeof pr !== "string" || !pr) throw new Error(`${payRequest.address} returned no invoice`);
  return verifyInvoice(payRequest, pr, amountSats, options);
}

/** Resolve a Lightning address and fetch a verified invoice for `amountSats`. */
export async function invoiceForLightningAddress(
  address: string,
  amountSats: bigint,
  options: InvoiceOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<VerifiedInvoice> {
  const payRequest = await resolveLightningAddress(address, fetchImpl);
  return requestInvoice(payRequest, amountSats, options, fetchImpl);
}
