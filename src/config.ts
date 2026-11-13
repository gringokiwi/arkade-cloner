import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

/** USDC on Base mainnet (Circle, native). https://developers.circle.com/stablecoins/usdc-contract-addresses */
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** USDC on Base Sepolia. */
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** The payout destination this solver was built for. */
export const DEFAULT_LIGHTNING_ADDRESS = "gringo@walletofsatoshi.com";

export interface SolverConfig {
  /** Where the solver keeps its SQLite files (wallet, swaps, orders). */
  dataDir: string;
  http: { host: string; port: number };

  arkade: {
    /** Mnemonic of the solver's Arkade wallet: its BTC inventory. */
    mnemonic: string;
    /** Operator URL. Mainnet: https://arkade.computer. */
    operatorUrl: string;
    /** `bitcoin` (mainnet). Lightning via Arkade Intents runs on mainnet only. */
    network: "bitcoin" | "mutinynet" | "signet" | "regtest";
    /** Path to a pinned Lightning solver card; defaults to the bundled beta-solver card. */
    solverCardPath?: string;
    /** Fetch the latest signed card from the card's relays at startup (falls back to the pinned one). */
    refreshSolverCard: boolean;
  };

  base: {
    rpcUrl: string;
    chainId: number;
    usdc: Address;
    /** The deployed LightningHtlc contract. */
    htlc?: Address;
    /** First block to scan for locks (the deployment block). */
    htlcDeployBlock?: bigint;
    /** Private key of the solver's Base account: HTLC claimer, and relayer of gasless locks. */
    privateKey?: Hex;
    /** Blocks a lock must be buried under before the solver pays the invoice. */
    confirmations: number;
    /** Max block range per eth_getLogs call. */
    logChunk: bigint;
  };

  payout: {
    /** Lightning address the solver pays when a request names none. */
    lightningAddress: string;
    /** Lightning addresses a request may name. `["*"]` allows any. */
    allowedLightningAddresses: string[];
    /** Optional LUD-12 comment attached to each invoice request. */
    comment: string;
  };

  pricing: {
    /** The solver's spread over the mid price, in basis points. */
    spreadBps: bigint;
    /** Lightning routing fee the quote reserves (Arkade -> Lightning solver), basis points. */
    lightningFeeBps: bigint;
    /** Flat part of that reserve, sats. */
    lightningFeeFlatSats: bigint;
    sources: string[];
    minSources: number;
    maxDeviationBps: number;
  };

  limits: {
    minPayoutSats: bigint;
    maxPayoutSats: bigint;
    /** Sats kept back from inventory and never committed to a quote. */
    inventoryReserveSats: bigint;
  };

  timing: {
    /** How long a quote may be funded for. */
    quoteTtlSeconds: number;
    /** Extra time on top of the Arkade refund window before the payer's Base refund opens. */
    timelockMarginSeconds: number;
    /** Invoices must stay valid at least this long after the quote expires. */
    invoiceSlackSeconds: number;
    pollIntervalMs: number;
  };

  features: {
    /** Submit gasless (EIP-3009) locks for payers. */
    relayAuthorizations: boolean;
    /** Hand locks the solver declines straight back to their payers (`cancel`). */
    autoRefund: boolean;
    /** Do everything except fund the Arkade payment: quote without inventory, then decline and return the USDC. */
    dryRun: boolean;
  };
}

/** Load `.env` (if present) into `process.env` without overriding what is already set. */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

type Env = Record<string, string | undefined>;

const str = (env: Env, key: string, fallback?: string): string => {
  const value = env[key]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} is not set`);
};

const optional = (env: Env, key: string): string | undefined => env[key]?.trim() || undefined;

const int = (env: Env, key: string, fallback: number): number => {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer, got ${raw}`);
  return value;
};

const big = (env: Env, key: string, fallback: bigint): bigint => {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer, got ${raw}`);
  return BigInt(raw);
};

const bool = (env: Env, key: string, fallback: boolean): boolean => {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${key} must be true or false, got ${raw}`);
};

const address = (env: Env, key: string): Address | undefined => {
  const raw = optional(env, key);
  if (raw === undefined) return undefined;
  if (!isAddress(raw)) throw new Error(`${key} is not an address: ${raw}`);
  return getAddress(raw);
};

const LIGHTNING_ADDRESS = /^[a-z0-9\-_.+]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export const normalizeLightningAddress = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!LIGHTNING_ADDRESS.test(normalized)) throw new Error(`not a Lightning address: ${value}`);
  return normalized;
};

/**
 * Read the solver's configuration from the environment.
 * Secrets (`ARKADE_MNEMONIC`, `EVM_PRIVATE_KEY`) are only required by the commands that use them;
 * pass `require` to demand them up front.
 */
export function loadConfig(env: Env = process.env, require: { arkade?: boolean; evm?: boolean } = {}): SolverConfig {
  const chainId = int(env, "BASE_CHAIN_ID", 8453);
  const defaultUsdc = chainId === 84532 ? BASE_SEPOLIA_USDC : BASE_USDC;

  const privateKeyRaw = optional(env, "EVM_PRIVATE_KEY");
  if (privateKeyRaw !== undefined && !(isHex(privateKeyRaw) && privateKeyRaw.length === 66)) {
    throw new Error("EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  }
  if (require.evm && privateKeyRaw === undefined) throw new Error("EVM_PRIVATE_KEY is not set");

  const mnemonic = optional(env, "ARKADE_MNEMONIC") ?? "";
  if (require.arkade && !mnemonic) throw new Error("ARKADE_MNEMONIC is not set");

  const lightningAddress = normalizeLightningAddress(str(env, "PAYOUT_LIGHTNING_ADDRESS", DEFAULT_LIGHTNING_ADDRESS));
  const allowed = (optional(env, "ALLOWED_LIGHTNING_ADDRESSES") ?? lightningAddress)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => (a === "*" ? a : normalizeLightningAddress(a)));

  const network = str(env, "ARKADE_NETWORK", "bitcoin");
  if (!["bitcoin", "mutinynet", "signet", "regtest"].includes(network)) throw new Error(`unknown ARKADE_NETWORK ${network}`);

  const deployBlock = optional(env, "HTLC_DEPLOY_BLOCK");

  return {
    dataDir: resolve(str(env, "DATA_DIR", "./data")),
    http: { host: str(env, "HOST", "127.0.0.1"), port: int(env, "PORT", 8080) },
    arkade: {
      mnemonic,
      operatorUrl: str(env, "ARKADE_OPERATOR_URL", "https://arkade.computer"),
      network: network as SolverConfig["arkade"]["network"],
      solverCardPath: optional(env, "ARKADE_SOLVER_CARD"),
      refreshSolverCard: bool(env, "ARKADE_REFRESH_SOLVER_CARD", true),
    },
    base: {
      // mainnet.base.org refuses eth_getLogs, which the lock watcher needs; use a provider that serves it.
      rpcUrl: str(env, "BASE_RPC_URL", chainId === 84532 ? "https://base-sepolia-rpc.publicnode.com" : "https://base-rpc.publicnode.com"),
      chainId,
      usdc: address(env, "USDC_ADDRESS") ?? defaultUsdc,
      htlc: address(env, "HTLC_ADDRESS"),
      htlcDeployBlock: deployBlock === undefined ? undefined : BigInt(deployBlock),
      privateKey: privateKeyRaw as Hex | undefined,
      confirmations: Math.max(1, int(env, "BASE_CONFIRMATIONS", 3)),
      logChunk: big(env, "BASE_LOG_CHUNK", 2_000n),
    },
    payout: {
      lightningAddress,
      allowedLightningAddresses: allowed,
      comment: str(env, "PAYOUT_COMMENT", "USDC on Base -> sats, via Arkade"),
    },
    pricing: {
      spreadBps: big(env, "SPREAD_BPS", 100n),
      lightningFeeBps: big(env, "LIGHTNING_FEE_BPS", 50n),
      lightningFeeFlatSats: big(env, "LIGHTNING_FEE_FLAT_SATS", 10n),
      sources: str(env, "PRICE_SOURCES", "coinbase,kraken,coingecko").split(",").map((s) => s.trim()),
      minSources: int(env, "PRICE_MIN_SOURCES", 2),
      maxDeviationBps: int(env, "PRICE_MAX_DEVIATION_BPS", 150),
    },
    limits: {
      minPayoutSats: big(env, "MIN_PAYOUT_SATS", 1_000n),
      maxPayoutSats: big(env, "MAX_PAYOUT_SATS", 250_000n),
      inventoryReserveSats: big(env, "INVENTORY_RESERVE_SATS", 0n),
    },
    timing: {
      quoteTtlSeconds: int(env, "QUOTE_TTL_SECONDS", 600),
      timelockMarginSeconds: int(env, "HTLC_TIMELOCK_MARGIN_SECONDS", 6 * 3600),
      invoiceSlackSeconds: int(env, "INVOICE_SLACK_SECONDS", 3600),
      pollIntervalMs: int(env, "POLL_INTERVAL_MS", 4_000),
    },
    features: {
      relayAuthorizations: bool(env, "RELAY_AUTHORIZATIONS", true),
      autoRefund: bool(env, "AUTO_REFUND", true),
      dryRun: bool(env, "DRY_RUN", false),
    },
  };
}
