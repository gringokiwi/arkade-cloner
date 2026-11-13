import { decode } from "light-bolt11-decoder";

export interface DecodedInvoice {
  bolt11: string;
  /** `bc` on mainnet. */
  bech32Prefix: string;
  /** Amount in millisatoshis, absent on an amountless invoice. */
  amountMsat?: bigint;
  /** sha256 of the preimage, hex. */
  paymentHash: string;
  descriptionHash?: string;
  description?: string;
  /** Unix seconds the invoice was created. */
  timestamp: number;
  /** Seconds the invoice stays payable after `timestamp`. */
  expiry: number;
  /** Unix seconds after which the invoice can no longer be paid. */
  expiresAt: number;
}

type Section = { name: string; value?: unknown };

/** Decode a BOLT11 invoice into the fields the solver checks. */
export function decodeInvoice(bolt11: string): DecodedInvoice {
  const decoded = decode(bolt11.trim()) as { sections: Section[]; expiry?: number };
  const section = (name: string) => decoded.sections.find((s) => s.name === name)?.value;

  const paymentHash = section("payment_hash");
  if (typeof paymentHash !== "string" || !/^[0-9a-f]{64}$/.test(paymentHash)) {
    throw new Error("invoice has no valid payment hash");
  }
  const timestamp = Number(section("timestamp"));
  if (!Number.isSafeInteger(timestamp)) throw new Error("invoice has no timestamp");
  const expiry = Number(decoded.expiry ?? section("expiry") ?? 3600);

  const amount = section("amount");
  const network = section("coin_network") as { bech32?: string } | undefined;

  return {
    bolt11: bolt11.trim(),
    bech32Prefix: network?.bech32 ?? "",
    amountMsat: amount === undefined || amount === "" ? undefined : BigInt(amount as string),
    paymentHash,
    descriptionHash: typeof section("description_hash") === "string" ? (section("description_hash") as string) : undefined,
    description: typeof section("description") === "string" ? (section("description") as string) : undefined,
    timestamp,
    expiry,
    expiresAt: timestamp + expiry,
  };
}
