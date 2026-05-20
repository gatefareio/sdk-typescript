// EIP-3009 transferWithAuthorization signing + X-Payment header
// construction. This is the heart of the paid-call flow: we mirror
// the same x402 v2 schema that Gatefare's facilitator validates,
// keeping the SDK protocol-compliant with the marketplace it talks to.
//
// Important: this module does NOT touch the network. It produces a
// signed authorization payload that the caller (payment.callApi)
// attaches to the second HTTP request. Keeping it pure makes the
// signing logic trivially testable without mocking RPCs.

import {
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  parseUnits,
  stringToHex,
  toBytes,
  type Address,
  type Hex,
} from "viem";

import type { GatefareNetwork } from "./types.js";
import type { WalletState } from "./wallet.js";

const USDC_BY_NETWORK: Record<GatefareNetwork, { address: Address; name: string; version: string; chainId: number }> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    name: "USD Coin",
    version: "2",
    chainId: 8453,
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
    name: "USDC",
    version: "2",
    chainId: 84532,
  },
};

/** The fields the facilitator expects when verifying our EIP-3009
 *  transferWithAuthorization. Matches the x402 v2 wire format. */
export interface PaymentRequirements {
  /** USDC amount as a string in atomic units (6-decimal micros). */
  value: string;
  /** Split contract address (the publisher's 90% / platform 10% sink). */
  payTo: Address;
  /** Network identifier. */
  network: GatefareNetwork;
  /** Resource URL the buyer is paying to access — proxy URL on Gatefare. */
  resource: string;
}

export interface SignedAuthorization {
  /** base64-encoded JSON body suitable for the X-Payment header. */
  xPaymentHeader: string;
  /** Atomic-unit value signed. */
  valueMicros: bigint;
  /** Random 32-byte nonce used as the EIP-3009 nonce. */
  nonceHex: Hex;
  /** UNIX timestamp the signature expires at (5 minutes from issue). */
  validBeforeSec: number;
}

/** Random 32-byte hex nonce. */
function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  // Use Web Crypto when available (Node 20+ has it on globalThis).
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Node fallback: dynamic import is async, but we can avoid it
    // because Node 20+ exposes Web Crypto by default. The fallback
    // would only matter on ancient runtimes which we explicitly
    // unsupported (engines.node >= 20).
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/**
 * Sign an EIP-3009 transferWithAuthorization for the given payment
 * requirements and return the X-Payment header value the resource
 * server expects.
 *
 * The wire format mirrors x402 v2 "exact" scheme:
 *
 *   {
 *     "x402Version": 2,
 *     "scheme": "exact",
 *     "network": "eip155:8453",
 *     "payload": {
 *       "signature": "0x...",
 *       "authorization": {
 *         "from": "0x...",
 *         "to": "0x...",
 *         "value": "10000",
 *         "validAfter": "0",
 *         "validBefore": "1716000300",
 *         "nonce": "0x..."
 *       }
 *     }
 *   }
 *
 * Validity window: 5 minutes from issue. Long enough to cover the
 * facilitator's verify+settle round trip, short enough that a stolen
 * authorization expires before an attacker can exploit it at scale.
 */
export async function signEip3009Authorization(
  wallet: WalletState,
  req: PaymentRequirements,
  opts: { now?: () => number } = {},
): Promise<SignedAuthorization> {
  const usdc = USDC_BY_NETWORK[req.network];
  if (!usdc) throw new Error(`No USDC contract known for ${req.network}`);

  const now = opts.now ? opts.now() : Date.now();
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(now / 1000) + 300); // 5 minutes
  const nonce = randomNonce();
  const valueMicros = BigInt(req.value);

  // EIP-712 typed data for transferWithAuthorization. Keep field order
  // exactly as defined in EIP-3009 — order matters for the struct hash.
  const signature = await wallet.account.signTypedData({
    domain: {
      name: usdc.name,
      version: usdc.version,
      chainId: usdc.chainId,
      verifyingContract: usdc.address,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: wallet.account.address,
      to: req.payTo,
      value: valueMicros,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: req.network,
    payload: {
      signature,
      authorization: {
        from: wallet.account.address,
        to: req.payTo,
        value: valueMicros.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  // base64 (URL-safe NOT required by x402, but stays ASCII-safe
  // through arbitrary HTTP middlewares). Standard padding.
  const json = JSON.stringify(payload);
  const xPaymentHeader = Buffer.from(json, "utf8").toString("base64");

  return {
    xPaymentHeader,
    valueMicros,
    nonceHex: nonce,
    validBeforeSec: Number(validBefore),
  };
}

// Helpers used by tests + the unsigned-payload constructor below. The
// exports below are intentionally narrow — most callers should reach
// for signEip3009Authorization, not these primitives.

/** Convert a decimal USDC amount ("0.10", "1.5") to atomic micros. */
export function usdcToMicros(amount: string | number): bigint {
  return parseUnits(typeof amount === "number" ? amount.toFixed(6) : amount, 6);
}

/** keccak256 of an arbitrary string (handy for tests + assertions). */
export function hashString(s: string): Hex {
  return keccak256(toBytes(s));
}

// Re-export a handful of viem types for downstream encoders.
export type { Hex } from "viem";

// Intentionally unused-but-exported helpers — keep them so future
// expansion (e.g. a manual signing path) does not require breaking
// the module's surface.
export { encodeAbiParameters, hexToBytes, stringToHex };
