import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseAbiParameters,
  parseSignature,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { lightningHtlcAbi, lightningHtlcBytecode, lightningHtlcDeployedBytecode } from "./lightning-htlc.generated.js";

export { lightningHtlcAbi, lightningHtlcBytecode, lightningHtlcDeployedBytecode };

/** The terms a LightningHtlc swap commits to; its id is their hash. */
export interface HtlcTerms {
  /** sha256 of the Lightning preimage: the invoice's payment hash. */
  paymentHash: Hex;
  token: Address;
  /** Who gets the tokens back after `timelock`: the payer. */
  refunder: Address;
  /** Who gets the tokens with the preimage: the solver. */
  claimer: Address;
  amount: bigint;
  /** Unix seconds from which the refund path opens. */
  timelock: bigint;
}

export interface LockedEvent extends HtlcTerms {
  swapId: Hex;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export const HtlcStatus = { None: 0, Locked: 1, Claimed: 2, Refunded: 3 } as const;
export type HtlcStatusValue = (typeof HtlcStatus)[keyof typeof HtlcStatus];

/** `keccak256(abi.encode(paymentHash, token, refunder, claimer, amount, timelock))`, as the contract computes it. */
export const swapIdOf = (t: HtlcTerms): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, address, address, uint256, uint256"), [
      t.paymentHash,
      t.token,
      t.refunder,
      t.claimer,
      t.amount,
      t.timelock,
    ]),
  );

/** A viem chain for Base (or Base Sepolia), pointed at `rpcUrl`. Other ids get a minimal definition. */
export function chainFor(chainId: number, rpcUrl: string): Chain {
  const known = chainId === base.id ? base : chainId === baseSepolia.id ? baseSepolia : undefined;
  if (known) return { ...known, rpcUrls: { default: { http: [rpcUrl] } } } as Chain;
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export const publicClientFor = (chain: Chain): PublicClient<Transport, Chain> =>
  createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { retryCount: 3, timeout: 20_000 }) });

export const walletClientFor = (chain: Chain, privateKey: Hex): WalletClient<Transport, Chain, Account> =>
  createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport: http(chain.rpcUrls.default.http[0], { retryCount: 3, timeout: 20_000 }),
  });

/** The EIP-712 domain of an EIP-3009 token, read from the token itself. */
export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

const versionAbi = [
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export async function readTokenDomain(client: PublicClient<Transport, Chain>, token: Address): Promise<TokenDomain> {
  const [name, version] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: token, abi: versionAbi, functionName: "version" }),
  ]);
  return { name, version, chainId: client.chain.id, verifyingContract: getAddress(token) };
}

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * The EIP-3009 authorization a payer signs to fund a swap without gas: it lets the HTLC pull
 * `amount` from the payer, and its nonce is the swap id, so the signature is only good for
 * exactly these terms.
 */
export function receiveAuthorization(domain: TokenDomain, htlc: Address, terms: HtlcTerms, validAfter: bigint, validBefore: bigint) {
  return {
    domain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: terms.refunder,
      to: htlc,
      value: terms.amount,
      validAfter,
      validBefore,
      nonce: swapIdOf(terms),
    },
  };
}

/** The same authorization as `eth_signTypedData_v4` JSON (what a browser wallet signs). */
export function receiveAuthorizationJson(domain: TokenDomain, htlc: Address, terms: HtlcTerms, validAfter: bigint, validBefore: bigint) {
  const typed = receiveAuthorization(domain, htlc, terms, validAfter, validBefore);
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...typed.types,
    },
    domain: typed.domain,
    primaryType: typed.primaryType,
    message: {
      ...typed.message,
      value: typed.message.value.toString(),
      validAfter: typed.message.validAfter.toString(),
      validBefore: typed.message.validBefore.toString(),
    },
  };
}

export interface Authorization {
  validAfter: bigint;
  validBefore: bigint;
  signature: Hex;
}

/** Read and drive one deployed LightningHtlc. */
export class Htlc {
  constructor(
    readonly publicClient: PublicClient<Transport, Chain>,
    readonly address: Address,
    readonly walletClient?: WalletClient<Transport, Chain, Account>,
  ) {}

  private get wallet(): WalletClient<Transport, Chain, Account> {
    if (!this.walletClient) throw new Error("this Htlc has no wallet");
    return this.walletClient;
  }

  /** Throws unless `address` holds this repository's LightningHtlc bytecode. */
  async assertDeployed(): Promise<void> {
    const code = await this.publicClient.getCode({ address: this.address });
    if (!code || code === "0x") throw new Error(`no contract at ${this.address}`);
    if (code.toLowerCase() !== lightningHtlcDeployedBytecode.toLowerCase()) {
      throw new Error(`the contract at ${this.address} is not this repository's LightningHtlc`);
    }
  }

  async status(swapId: Hex): Promise<HtlcStatusValue> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: lightningHtlcAbi,
      functionName: "swaps",
      args: [swapId],
    })) as HtlcStatusValue;
  }

  /** `Locked` events naming `claimer`, in block order. */
  async lockedEvents(fromBlock: bigint, toBlock: bigint, claimer?: Address): Promise<LockedEvent[]> {
    const logs = await this.publicClient.getContractEvents({
      address: this.address,
      abi: lightningHtlcAbi,
      eventName: "Locked",
      args: claimer ? { claimer } : undefined,
      fromBlock,
      toBlock,
      strict: true,
    });
    return logs.map((l) => ({
      swapId: l.args.swapId,
      paymentHash: l.args.paymentHash,
      claimer: getAddress(l.args.claimer),
      token: getAddress(l.args.token),
      refunder: getAddress(l.args.refunder),
      amount: l.args.amount,
      timelock: l.args.timelock,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
    }));
  }

  /** Pay the claimer by revealing the preimage. Simulated first, so a doomed claim costs no gas. */
  async claim(terms: HtlcTerms, preimage: Hex): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      account: this.wallet.account,
      address: this.address,
      abi: lightningHtlcAbi,
      functionName: "claim",
      args: [preimage, terms.token, terms.refunder, terms.claimer, terms.amount, terms.timelock],
    });
    return this.wallet.writeContract(request);
  }

  /** Return the tokens to the refunder; only valid from `timelock` on. Anyone may submit it. */
  async refund(terms: HtlcTerms): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      account: this.wallet.account,
      address: this.address,
      abi: lightningHtlcAbi,
      functionName: "refund",
      args: [terms.paymentHash, terms.token, terms.refunder, terms.claimer, terms.amount, terms.timelock],
    });
    return this.wallet.writeContract(request);
  }

  /** Claimer only: hand a swap straight back to its refunder (the solver declining an order). */
  async cancel(terms: HtlcTerms): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      account: this.wallet.account,
      address: this.address,
      abi: lightningHtlcAbi,
      functionName: "cancel",
      args: [terms.paymentHash, terms.token, terms.refunder, terms.claimer, terms.amount, terms.timelock],
    });
    return this.wallet.writeContract(request);
  }

  /** Submit a payer's signed EIP-3009 authorization (the gasless lock). */
  async lockWithAuthorization(terms: HtlcTerms, auth: Authorization): Promise<Hex> {
    const { r, s, v, yParity } = parseSignature(auth.signature);
    const vNumber = Number(v ?? BigInt(yParity + 27));
    const { request } = await this.publicClient.simulateContract({
      account: this.wallet.account,
      address: this.address,
      abi: lightningHtlcAbi,
      functionName: "lockWithAuthorization",
      args: [
        terms.paymentHash,
        terms.token,
        terms.refunder,
        terms.claimer,
        terms.amount,
        terms.timelock,
        auth.validAfter,
        auth.validBefore,
        vNumber,
        r,
        s,
      ],
    });
    return this.wallet.writeContract(request);
  }

  /** The payer's own lock: approve, then lock. The wallet's account must be `terms.refunder`. */
  async lock(terms: HtlcTerms): Promise<Hex> {
    if (getAddress(this.wallet.account.address) !== getAddress(terms.refunder)) throw new Error("lock() must come from the refunder");
    const allowance = await this.publicClient.readContract({
      address: terms.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [terms.refunder, this.address],
    });
    if (allowance < terms.amount) {
      const approveHash = await this.wallet.writeContract({
        address: terms.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.address, terms.amount],
      });
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
    const { request } = await this.publicClient.simulateContract({
      account: this.wallet.account,
      address: this.address,
      abi: lightningHtlcAbi,
      functionName: "lock",
      args: [terms.paymentHash, terms.token, terms.claimer, terms.amount, terms.timelock],
    });
    return this.wallet.writeContract(request);
  }
}

/** Deploy a LightningHtlc from `wallet`; resolves once mined. */
export async function deployHtlc(
  publicClient: PublicClient<Transport, Chain>,
  wallet: WalletClient<Transport, Chain, Account>,
): Promise<{ address: Address; blockNumber: bigint; txHash: Hex }> {
  const txHash = await wallet.deployContract({ abi: lightningHtlcAbi, bytecode: lightningHtlcBytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deployment failed: ${txHash}`);
  return { address: getAddress(receipt.contractAddress), blockNumber: receipt.blockNumber, txHash };
}
