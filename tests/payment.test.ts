import { describe, it, expect } from "vitest";
import { signEip3009Authorization, usdcToMicros } from "../src/payment.js";
import { createWalletState } from "../src/wallet.js";

// A throwaway private key just for tests. Generated once and pinned —
// signatures must be deterministic given the same inputs.
const TEST_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

describe("signEip3009Authorization", () => {
  it("produces a base64-encoded X-Payment payload with the right structure", async () => {
    const wallet = createWalletState(TEST_KEY, "eip155:84532");
    const signed = await signEip3009Authorization(
      wallet,
      {
        value: "10000",                                                          // $0.01 in micros
        payTo: "0x0000000000000000000000000000000000000001",
        network: "eip155:84532",
        resource: "https://gatefare.io/p/alice/weather-now",
      },
      { now: () => 1_716_000_000_000 },
    );

    expect(signed.valueMicros).toBe(10_000n);
    expect(signed.nonceHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.validBeforeSec).toBe(1_716_000_300);

    // Decode and check the wire format.
    const payload = JSON.parse(Buffer.from(signed.xPaymentHeader, "base64").toString("utf8"));
    expect(payload.x402Version).toBe(2);
    expect(payload.scheme).toBe("exact");
    expect(payload.network).toBe("eip155:84532");
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(payload.payload.authorization.value).toBe("10000");
    expect(payload.payload.authorization.validBefore).toBe("1716000300");
    expect(payload.payload.authorization.nonce).toBe(signed.nonceHex);
  });

  it("uses the address derived from the private key (not a placeholder)", async () => {
    const wallet = createWalletState(TEST_KEY, "eip155:8453");
    const signed = await signEip3009Authorization(
      wallet,
      {
        value: "1000000",
        payTo: "0x0000000000000000000000000000000000000001",
        network: "eip155:8453",
        resource: "https://gatefare.io/p/foo/bar",
      },
    );
    const payload = JSON.parse(Buffer.from(signed.xPaymentHeader, "base64").toString("utf8"));
    expect(payload.payload.authorization.from.toLowerCase()).toBe(wallet.account.address.toLowerCase());
  });
});

describe("usdcToMicros", () => {
  it("converts decimal + integer USDC values to 6-decimal atomic units", () => {
    expect(usdcToMicros(1).toString()).toBe("1000000");
    expect(usdcToMicros("0.01").toString()).toBe("10000");
    expect(usdcToMicros("0.000001").toString()).toBe("1");
    expect(usdcToMicros("1234.56").toString()).toBe("1234560000");
  });
});
