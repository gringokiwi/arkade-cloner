/**
 * `pnpm init:env` — create `.env` with fresh secrets for the solver: an Arkade wallet mnemonic and
 * a Base private key. Values already set are never replaced.
 */
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadDotEnv } from "../config.js";
import { setEnvValues } from "./env-file.js";

loadDotEnv();
const fresh: Record<string, string> = {};
if (!process.env.ARKADE_MNEMONIC) fresh.ARKADE_MNEMONIC = generateMnemonic(wordlist);
if (!process.env.EVM_PRIVATE_KEY) fresh.EVM_PRIVATE_KEY = generatePrivateKey();
setEnvValues(".env", fresh, ".env.example");

const key = (process.env.EVM_PRIVATE_KEY ?? fresh.EVM_PRIVATE_KEY) as `0x${string}`;
console.log(Object.keys(fresh).length ? `Wrote ${Object.keys(fresh).join(" and ")} to .env (mode 600). Back them up.` : ".env already has both secrets.");
console.log(`Solver Base account (fund it with a little ETH on Base for gas): ${privateKeyToAccount(key).address}`);
console.log("Next: `pnpm deploy:htlc`, then `pnpm status` for the Arkade address to fund with BTC.");
