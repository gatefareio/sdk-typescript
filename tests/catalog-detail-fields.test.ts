// Regression for v0.1.1: getApi must surface publisher.reputation and
// sampleResponse end-to-end. Previous v0.1.0 silently dropped both,
// leaving SDK consumers unable to make trust decisions before paying
// — exactly the use case the backend's BACKLOG #46/#47 features were
// built for.

import { describe, it, expect } from "vitest";
import { getApi } from "../src/catalog.js";

const BASE = "https://example-gatefare";

function mockFetch(map: Record<string, () => Response>): typeof fetch {
  return async (input: any) => {
    const url = String(input);
    const f = map[url];
    if (!f) throw new Error(`Unmocked URL: ${url}`);
    return f();
  };
}

const SAMPLE_DETAIL = {
  slug: "weather-now",
  urlName: "weather-now",
  handle: "alice",
  name: "Weather Now",
  description: "Real-time weather.",
  price: "$0.01",
  network: "eip155:8453",
  networkName: "Base",
  testnet: false,
  proxyUrl: "/p/alice/weather-now",
  categories: ["weather"],
  tags: ["realtime"],
  publisher: {
    handle: "alice",
    displayName: "Alice",
    verificationTier: null,
    reputation: {
      tenureMonths: 8,
      established: true,
      lifetimeSuccessCalls: 1_250_000,
      topContributor: true,
      averageRating: 4.7,
      reviewCount: 42,
      highlyRated: true,
      activeApis: 3,
      computedAt: 1_716_000_000_000,
    },
  },
  sampleResponse: '{"temperature_c": 21.3, "conditions": "sunny"}',
};

describe("getApi — detail-only fields v0.1.1", () => {
  it("surfaces publisher.reputation when present on the wire", async () => {
    const fetchImpl = mockFetch({
      [`${BASE}/api/catalog/weather-now`]: () =>
        new Response(JSON.stringify(SAMPLE_DETAIL), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const api = await getApi({ baseUrl: BASE, fetch: fetchImpl }, "weather-now");
    expect(api).not.toBeNull();
    expect(api!.publisher).toBeDefined();
    expect(api!.publisher!.handle).toBe("alice");
    expect(api!.publisher!.reputation?.established).toBe(true);
    expect(api!.publisher!.reputation?.topContributor).toBe(true);
    expect(api!.publisher!.reputation?.highlyRated).toBe(true);
    expect(api!.publisher!.reputation?.activeApis).toBe(3);
  });

  it("surfaces sampleResponse when present on the wire", async () => {
    const fetchImpl = mockFetch({
      [`${BASE}/api/catalog/weather-now`]: () =>
        new Response(JSON.stringify(SAMPLE_DETAIL), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const api = await getApi({ baseUrl: BASE, fetch: fetchImpl }, "weather-now");
    expect(api!.sampleResponse).toBe('{"temperature_c": 21.3, "conditions": "sunny"}');
  });

  it("leaves publisher + sampleResponse undefined for legacy listings", async () => {
    const legacy = {
      ...SAMPLE_DETAIL,
      publisher: undefined,
      sampleResponse: null,
    };
    const fetchImpl = mockFetch({
      [`${BASE}/api/catalog/legacy`]: () =>
        new Response(JSON.stringify(legacy), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const api = await getApi({ baseUrl: BASE, fetch: fetchImpl }, "legacy");
    expect(api!.publisher).toBeUndefined();
    expect(api!.sampleResponse).toBeUndefined();
  });
});
