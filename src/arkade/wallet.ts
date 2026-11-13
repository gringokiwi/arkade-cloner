/**
 * The solver's Arkade side: one wallet (its BTC inventory) and one swap client, both on SQLite so
 * a restarted solver resumes every swap in flight. Lightning payments go through Arkade Intents:
 * the swap client asks the Lightning solver for a quote over Nostr, funds an Arkade lockup, and the
 * Lightning solver claims it with the invoice preimage after paying the invoice.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configureEventSource, MnemonicIdentity, Wallet } from "@arkade-os/sdk";
import { SQLiteContractRepository, SQLiteWalletRepository } from "@arkade-os/sdk/repositories/sqlite";
import { verifyCardSig } from "@arkade-os/solver-discovery";
import { createSwapClient, type SwapClient } from "@arkade-os/swap";
import { createNodeSqlExecutor, type NodeSqlExecutor } from "@arkade-os/swap/node";
import { SQLiteAssetSwapRepository } from "@arkade-os/swap/repositories/sqlite";
import { EventSource } from "eventsource";
import { SimplePool } from "nostr-tools/pool";
import type { SolverConfig } from "../config.js";
import { log } from "../log.js";
import bundledCard from "./beta-solver.card.json" with { type: "json" };

export type SolverCard = typeof bundledCard;

/** Nostr kind of a solver's signed card (Arkade Intents discovery). */
const CARD_KIND = 38859;

/**
 * The pinned Lightning solver card. When `refresh` is on, fetch the solver's latest signed card from
 * its relays and use it if it verifies and keeps the same key; otherwise keep the pinned one.
 */
export async function loadSolverCard(config: SolverConfig["arkade"]): Promise<SolverCard> {
  const pinned: SolverCard = config.solverCardPath ? JSON.parse(readFileSync(config.solverCardPath, "utf8")) : bundledCard;
  if (!(await verifyCardSig(pinned as never))) throw new Error("the pinned solver card's signature does not verify");
  if (!config.refreshSolverCard) return pinned;

  const relays = pinned.transports.nostr.relays;
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      relays,
      { kinds: [CARD_KIND], authors: [pinned.discovery_pubkey], "#d": [config.network] },
      { maxWait: 6_000 },
    );
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) return pinned;
    const card = JSON.parse(latest.content) as SolverCard;
    if (card.discovery_pubkey !== pinned.discovery_pubkey || !(await verifyCardSig(card as never))) {
      log.warn("ignoring a solver card that does not verify against the pinned key");
      return pinned;
    }
    return card;
  } catch (err) {
    log.warn("could not refresh the solver card; using the pinned one", { err });
    return pinned;
  } finally {
    pool.close(relays);
  }
}

export interface ArkadeSide {
  network: SolverConfig["arkade"]["network"];
  wallet: Wallet;
  client: SwapClient;
  repository: SQLiteAssetSwapRepository;
  card: SolverCard;
  close(): Promise<void>;
}

const MAINNET_OPERATOR = "https://arkade.computer";

/** Open the solver's wallet and swap client. Resumes swaps in progress (`client.ready`). */
export async function openArkade(config: SolverConfig, options: { settlement?: boolean } = {}): Promise<ArkadeSide> {
  if (!config.arkade.mnemonic) throw new Error("ARKADE_MNEMONIC is not set");
  configureEventSource((url) => new EventSource(url) as never);
  mkdirSync(config.dataDir, { recursive: true });

  // One executor per database file, open for the life of the process.
  const walletDb: NodeSqlExecutor = createNodeSqlExecutor(join(config.dataDir, `arkade-wallet-${config.arkade.network}.sqlite`));
  const swapDb: NodeSqlExecutor = createNodeSqlExecutor(join(config.dataDir, `arkade-swaps-${config.arkade.network}.sqlite`));

  const isMainnet = config.arkade.network === "bitcoin";
  const wallet = await Wallet.create({
    identity: MnemonicIdentity.fromMnemonic(config.arkade.mnemonic, { isMainnet }),
    service:
      isMainnet && config.arkade.operatorUrl.replace(/\/$/, "") === MAINNET_OPERATOR
        ? { network: "bitcoin" }
        : { operatorUrl: config.arkade.operatorUrl },
    storage: {
      walletRepository: new SQLiteWalletRepository(walletDb),
      contractRepository: new SQLiteContractRepository(walletDb),
    },
    // A long-running solver keeps automatic settlement on: it also renews expiring outputs.
    ...(options.settlement === false ? { settlementConfig: false as const } : {}),
  });

  const card = await loadSolverCard(config.arkade);
  const repository = new SQLiteAssetSwapRepository(swapDb);
  const client = createSwapClient({
    wallet,
    repository,
    discovery: { localCards: [{ card: card as never, network: config.arkade.network }] },
  });
  await client.ready;

  return {
    network: config.arkade.network,
    wallet,
    client,
    repository,
    card,
    close: async () => {
      await client[Symbol.asyncDispose]();
      await wallet.dispose();
      await walletDb.close();
      await swapDb.close();
    },
  };
}
