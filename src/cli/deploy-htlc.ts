/**
 * `pnpm deploy:htlc` — deploy LightningHtlc to Base from EVM_PRIVATE_KEY and record its address
 * and block in `.env`. One deployment serves every swap; it has no owner and no upgrade path.
 */
import { formatEther } from "viem";
import { loadConfig, loadDotEnv } from "../config.js";
import { chainFor, deployHtlc, publicClientFor, walletClientFor } from "../evm/htlc.js";
import { setEnvValues } from "./env-file.js";

loadDotEnv();
const config = loadConfig(process.env, { evm: true });
const chain = chainFor(config.base.chainId, config.base.rpcUrl);
const client = publicClientFor(chain);
const wallet = walletClientFor(chain, config.base.privateKey!);
const balance = await client.getBalance({ address: wallet.account.address });
console.log(`Deploying LightningHtlc to chain ${config.base.chainId} from ${wallet.account.address} (${formatEther(balance)} ETH)…`);
if (balance === 0n) throw new Error("the deployer has no ETH for gas");
const { address, blockNumber, txHash } = await deployHtlc(client, wallet);
console.log(`LightningHtlc deployed at ${address} in block ${blockNumber} (tx ${txHash})`);
setEnvValues(".env", { HTLC_ADDRESS: address, HTLC_DEPLOY_BLOCK: blockNumber.toString() }, ".env.example");
console.log("Saved HTLC_ADDRESS and HTLC_DEPLOY_BLOCK to .env");
