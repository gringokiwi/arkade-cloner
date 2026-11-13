/**
 * A throwaway local EVM for tests: a Hardhat node (chain id 8453) on a free port, optionally
 * forking Base mainnet, plus the helpers the tests use to move its clock.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, http, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { chainFor, walletClientFor } from "../../src/evm/htlc.js";
import { mockUsdcAbi, mockUsdcBytecode } from "./mock-usdc.generated.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

/** The private key of Hardhat's funded dev account `index`. */
export const devKey = (index: number): Hex => {
  const key = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!key) throw new Error("no key");
  return `0x${Buffer.from(key).toString("hex")}`;
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

export interface LocalChain {
  rpcUrl: string;
  chain: Chain;
  publicClient: PublicClient<Transport, Chain>;
  /** Advance the chain clock by `seconds` and mine a block. */
  increaseTime(seconds: number): Promise<void>;
  mine(blocks?: number): Promise<void>;
  /** Latest block timestamp. */
  now(): Promise<bigint>;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

export async function startLocalChain(options: { forkUrl?: string; forkBlock?: bigint } = {}): Promise<LocalChain> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };
  if (options.forkUrl) env.FORK_URL = options.forkUrl;
  if (options.forkBlock !== undefined) env.FORK_BLOCK = options.forkBlock.toString();
  const child: ChildProcess = spawn(
    join(root, "node_modules", ".bin", "hardhat"),
    ["--config", join(root, "test", "hardhat.config.cjs"), "node", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hardhat node did not start:\n${output}`)), 90_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Started HTTP and WebSocket JSON-RPC server")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`hardhat node exited (${code}):\n${output}`));
    });
  });
  child.removeAllListeners("exit");

  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = chainFor(8453, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 });
  const rpc = <T>(method: string, params: unknown[] = []) =>
    publicClient.request({ method: method as never, params: params as never }) as Promise<T>;

  return {
    rpcUrl,
    chain,
    publicClient,
    rpc,
    increaseTime: async (seconds) => {
      await rpc("evm_increaseTime", [seconds]);
      await rpc("evm_mine");
    },
    mine: async (blocks = 1) => {
      for (let i = 0; i < blocks; i++) await rpc("evm_mine");
    },
    now: async () => (await publicClient.getBlock()).timestamp,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

/** Deploy the test token and mint `amount` to each holder. */
export async function deployMockUsdc(local: LocalChain, deployerKey: Hex, holders: Array<[Address, bigint]>): Promise<Address> {
  const wallet = walletClientFor(local.chain, deployerKey);
  const hash = await wallet.deployContract({ abi: mockUsdcAbi, bytecode: mockUsdcBytecode });
  const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress!;
  for (const [holder, amount] of holders) {
    const tx = await wallet.writeContract({ address, abi: mockUsdcAbi, functionName: "mint", args: [holder, amount] });
    await local.publicClient.waitForTransactionReceipt({ hash: tx });
  }
  return address;
}
