// Wallet helpers — wraps viem's in-process account so callers don't
// have to import viem themselves. Read-only (catalog-only) usage is
// possible without a wallet; the moment a paid call is attempted, the
// SDK demands a configured wallet.

import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import type { GatefareNetwork } from "./types.js";

const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

const USDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface WalletState {
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  network: GatefareNetwork;
}

function chainFor(network: GatefareNetwork) {
  if (network === "eip155:8453") return base;
  if (network === "eip155:84532") return baseSepolia;
  // Should never happen at the type level; runtime defense.
  throw new Error(`Unsupported network: ${network as string}`);
}

function usdcAddressFor(network: GatefareNetwork): Address {
  if (network === "eip155:8453") return USDC_BASE_MAINNET;
  if (network === "eip155:84532") return USDC_BASE_SEPOLIA;
  throw new Error(`No USDC address known for network ${network as string}`);
}

/** Build a wallet state from a raw private key. The key must be a
 *  0x-prefixed 32-byte hex string. We do NOT validate strength here —
 *  the caller is responsible for sourcing keys safely (env var, KMS,
 *  hardware signer). */
export function createWalletState(
  rawKey: string,
  network: GatefareNetwork,
): WalletState {
  const key = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const chain = chainFor(network);
  // PublicClient is typed against the chain, but our public surface
  // works across both Base mainnet + Sepolia without distinguishing.
  // Cast through unknown to satisfy the cross-chain type union.
  const publicClient = createPublicClient({
    chain,
    transport: http(),
  }) as unknown as PublicClient;
  return { account, publicClient, network };
}

/** Read the USDC balance for the wallet's address. */
export async function readUsdcBalance(state: WalletState): Promise<{
  micros: bigint;
  usdc: number;
}> {
  const micros = (await state.publicClient.readContract({
    address: usdcAddressFor(state.network),
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [state.account.address],
  })) as bigint;
  // USDC is 6-decimal. We surface a Number too for ergonomics, but
  // micros stays as the canonical source of truth — Number runs out
  // of precision past ~$9 trillion which we are not going to ever
  // hit, but the bigint costs nothing extra.
  const usdc = Number(micros) / 1_000_000;
  return { micros, usdc };
}
