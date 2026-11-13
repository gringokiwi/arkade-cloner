/**
 * The solver's own records, in SQLite (`node:sqlite`): orders (one per quote), the locks it has
 * seen on Base, and a few cursors. Every state change is written before the solver acts on it, so
 * a restart resumes where the last process stopped.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OrderState =
  /** Quoted; waiting for the payer's lock on Base. */
  | "quoted"
  /** No lock arrived in time. A late lock may still be accepted if the price allows. */
  | "expired"
  /** A matching lock landed on Base; the invoice is about to be paid. */
  | "locked"
  /** The Arkade lockup is funded; the Lightning solver is paying the invoice. */
  | "paying"
  /** The invoice is paid and the preimage known; the USDC claim is in flight. */
  | "paid"
  /** USDC claimed. Done. */
  | "settled"
  /** Declined or failed before the invoice was paid; the lock is handed back to the payer. */
  | "cancelled";

export const OPEN_ORDER_STATES: readonly OrderState[] = ["quoted", "expired", "locked", "paying", "paid"];

export interface Order {
  /** The payer's `rfq_id`. */
  id: string;
  state: OrderState;
  createdAt: number;
  updatedAt: number;
  amountSide: "from" | "to";
  /** USDC base units the lock must carry. */
  usdcAmount: bigint;
  /** Sats the Lightning address receives. */
  invoiceSats: bigint;
  /** What `usdcAmount` was worth at the quote's mid price, sats: the most the solver will spend. */
  valueSats: bigint;
  microUsdcPerBtc: bigint;
  lightningAddress: string;
  invoice: string;
  /** sha256 of the invoice preimage, 0x-prefixed. */
  paymentHash: `0x${string}`;
  invoiceExpiresAt: number;
  /** The lock must land by this time (Unix seconds). */
  validUntil: number;
  /** The HTLC timelock the payer must use (at least). */
  timelock: number;
  /** The payer's Base address: the HTLC refunder. */
  refunder: `0x${string}`;
  /** Arkade -> Lightning cost when quoted, sats. */
  quotedCostSats: bigint;
  quotedRefundLocktime: number;
  /** The gasless lock the solver relayed, if any. */
  relayTx?: `0x${string}`;
  /** The accepted lock. */
  swapId?: `0x${string}`;
  lockAmount?: bigint;
  lockTimelock?: number;
  lockTx?: `0x${string}`;
  /** The Arkade swap paying the invoice. */
  arkadeSwapId?: string;
  arkadeCostSats?: bigint;
  arkadeRefundLocktime?: number;
  payAttempts?: number;
  /** The invoice preimage, 0x-prefixed, once the invoice is paid. */
  preimage?: `0x${string}`;
  claimTx?: `0x${string}`;
  claimSentAt?: number;
  note?: string;
}

export type LockStatus =
  /** Matched an order and funds it. */
  | "accepted"
  /** Will be handed back to the payer (declined, failed, or no matching quote). */
  | "rejected"
  /** The hand-back (`cancel`) is in flight. */
  | "cancelling"
  /** Back with the payer. */
  | "returned"
  /** Claimed by the solver. */
  | "claimed"
  /** Not USDC, or too small to be worth the gas: left for its payer to refund at the timelock. */
  | "ignored";

export interface LockRecord {
  swapId: `0x${string}`;
  orderId?: string;
  status: LockStatus;
  reason?: string;
  paymentHash: `0x${string}`;
  token: `0x${string}`;
  refunder: `0x${string}`;
  claimer: `0x${string}`;
  amount: bigint;
  timelock: number;
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockTime: number;
  cancelTx?: `0x${string}`;
  cancelSentAt?: number;
  createdAt: number;
  updatedAt: number;
}

const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? { $bigint: value.toString() } : value);
const reviver = (_key: string, value: unknown) =>
  value && typeof value === "object" && "$bigint" in value && Object.keys(value).length === 1
    ? BigInt((value as { $bigint: string }).$bigint)
    : value;
const encode = (value: unknown) => JSON.stringify(value, replacer);
const decode = <T>(text: string): T => JSON.parse(text, reviver) as T;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        payment_hash TEXT NOT NULL UNIQUE,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_state ON orders (state);
      CREATE TABLE IF NOT EXISTS locks (
        swap_id TEXT PRIMARY KEY,
        order_id TEXT,
        status TEXT NOT NULL,
        payment_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS locks_status ON locks (status);
      CREATE INDEX IF NOT EXISTS locks_order ON locks (order_id);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  insertOrder(order: Order): void {
    this.db
      .prepare("INSERT INTO orders (id, state, payment_hash, updated_at, data) VALUES (?, ?, ?, ?, ?)")
      .run(order.id, order.state, order.paymentHash.toLowerCase(), order.updatedAt, encode(order));
  }

  saveOrder(order: Order): void {
    this.db
      .prepare("UPDATE orders SET state = ?, updated_at = ?, data = ? WHERE id = ?")
      .run(order.state, order.updatedAt, encode(order), order.id);
  }

  getOrder(id: string): Order | undefined {
    const row = this.db.prepare("SELECT data FROM orders WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? decode<Order>(row.data) : undefined;
  }

  getOrderByPaymentHash(paymentHash: string): Order | undefined {
    const row = this.db.prepare("SELECT data FROM orders WHERE payment_hash = ?").get(paymentHash.toLowerCase()) as
      | { data: string }
      | undefined;
    return row ? decode<Order>(row.data) : undefined;
  }

  ordersIn(states: readonly OrderState[]): Order[] {
    const placeholders = states.map(() => "?").join(",");
    return (
      this.db.prepare(`SELECT data FROM orders WHERE state IN (${placeholders}) ORDER BY updated_at`).all(...states) as Array<{
        data: string;
      }>
    ).map((r) => decode<Order>(r.data));
  }

  recentOrders(limit = 50): Order[] {
    return (this.db.prepare("SELECT data FROM orders ORDER BY updated_at DESC LIMIT ?").all(limit) as Array<{ data: string }>).map(
      (r) => decode<Order>(r.data),
    );
  }

  saveLock(lock: LockRecord): void {
    this.db
      .prepare(
        `INSERT INTO locks (swap_id, order_id, status, payment_hash, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (swap_id) DO UPDATE SET order_id = excluded.order_id, status = excluded.status,
           updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(lock.swapId.toLowerCase(), lock.orderId ?? null, lock.status, lock.paymentHash.toLowerCase(), lock.updatedAt, encode(lock));
  }

  getLock(swapId: string): LockRecord | undefined {
    const row = this.db.prepare("SELECT data FROM locks WHERE swap_id = ?").get(swapId.toLowerCase()) as { data: string } | undefined;
    return row ? decode<LockRecord>(row.data) : undefined;
  }

  locksIn(statuses: readonly LockStatus[]): LockRecord[] {
    const placeholders = statuses.map(() => "?").join(",");
    return (
      this.db.prepare(`SELECT data FROM locks WHERE status IN (${placeholders}) ORDER BY updated_at`).all(...statuses) as Array<{
        data: string;
      }>
    ).map((r) => decode<LockRecord>(r.data));
  }

  locksForOrder(orderId: string): LockRecord[] {
    return (this.db.prepare("SELECT data FROM locks WHERE order_id = ?").all(orderId) as Array<{ data: string }>).map((r) =>
      decode<LockRecord>(r.data),
    );
  }

  get(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
