import { describe, it, expect } from "vitest";
import { listCatalog, getApi } from "../src/catalog.js";
import { GatefareApiError } from "../src/types.js";

const BASE_URL = "https://example-gatefare";

/** Minimal fetch mock — accepts a response factory keyed by URL. */
function mockFetch(routes: Record<string, () => Response>): typeof fetch {
  return async (input: any) => {
    const url = String(input);
    const factory = routes[url];
    if (!factory) {
      throw new Error(`Unmocked URL: ${url}`);
    }
    return factory();
  };
}

const sampleCatalogBody = {
  apis: [
    {
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
    },
    {
      slug: "ai-image",
      urlName: "ai-image",
      handle: "bob",
      name: "AI Image",
      description: "Generate images.",
      price: "$1.00",
      network: "eip155:8453",
      networkName: "Base",
      testnet: false,
      proxyUrl: "/p/bob/ai-image",
      categories: ["ai"],
      tags: ["images"],
    },
  ],
};

describe("listCatalog", () => {
  it("returns parsed APIs from /api/catalog", async () => {
    const fetchImpl = mockFetch({
      [`${BASE_URL}/api/catalog`]: () =>
        new Response(JSON.stringify(sampleCatalogBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const apis = await listCatalog({ baseUrl: BASE_URL, fetch: fetchImpl });
    expect(apis).toHaveLength(2);
    expect(apis[0]?.slug).toBe("weather-now");
    expect(apis[0]?.priceUsdc).toBe(0.01);
    expect(apis[1]?.priceUsdc).toBe(1.0);
  });

  it("filters by priceLimitUsdc (defensive client-side belt)", async () => {
    const fetchImpl = mockFetch({
      // Server is now called with both q + price_max in the wire URL.
      [`${BASE_URL}/api/catalog?q=weather&price_max=0.5`]: () =>
        new Response(JSON.stringify(sampleCatalogBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const apis = await listCatalog(
      { baseUrl: BASE_URL, fetch: fetchImpl },
      { query: "weather", priceLimitUsdc: 0.5 },
    );
    expect(apis).toHaveLength(1);
    expect(apis[0]?.slug).toBe("weather-now");
  });

  it("translates SDK params to server wire names (per_page, price_max)", async () => {
    let calledUrl = "";
    const fetchImpl: typeof fetch = async (input: any) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ apis: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await listCatalog(
      { baseUrl: BASE_URL, fetch: fetchImpl },
      {
        category: "weather",
        tag: "realtime",
        includeTestnet: true,
        limit: 5,
        priceLimitUsdc: 0.25,
      },
    );
    expect(calledUrl).toContain("category=weather");
    expect(calledUrl).toContain("tag=realtime");
    expect(calledUrl).toContain("includeTestnet=1");
    // SDK's `limit` maps to the server's `per_page`.
    expect(calledUrl).toContain("per_page=5");
    expect(calledUrl).not.toContain("limit=");
    // SDK's `priceLimitUsdc` maps to the server's `price_max`.
    expect(calledUrl).toContain("price_max=0.25");
  });

  it("caps limit at 50 to match server's per_page ceiling", async () => {
    let calledUrl = "";
    const fetchImpl: typeof fetch = async (input: any) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ apis: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await listCatalog({ baseUrl: BASE_URL, fetch: fetchImpl }, { limit: 999 });
    expect(calledUrl).toContain("per_page=50");
  });

  it("client-side slice enforces limit even if the server ignored per_page", async () => {
    const fetchImpl = mockFetch({
      [`${BASE_URL}/api/catalog?per_page=2`]: () =>
        new Response(JSON.stringify(sampleCatalogBody), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const apis = await listCatalog({ baseUrl: BASE_URL, fetch: fetchImpl }, { limit: 2 });
    expect(apis).toHaveLength(2);
  });

  it("throws GatefareApiError on non-2xx", async () => {
    const fetchImpl = mockFetch({
      [`${BASE_URL}/api/catalog`]: () =>
        new Response("oops", { status: 500, statusText: "Internal Server Error" }),
    });
    await expect(listCatalog({ baseUrl: BASE_URL, fetch: fetchImpl })).rejects.toThrow(GatefareApiError);
  });
});

describe("getApi", () => {
  it("returns the parsed API on 200", async () => {
    const fetchImpl = mockFetch({
      [`${BASE_URL}/api/catalog/weather-now`]: () =>
        new Response(JSON.stringify(sampleCatalogBody.apis[0]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const api = await getApi({ baseUrl: BASE_URL, fetch: fetchImpl }, "weather-now");
    expect(api).not.toBeNull();
    expect(api!.slug).toBe("weather-now");
  });

  it("returns null on 404 (rather than throwing)", async () => {
    const fetchImpl = mockFetch({
      [`${BASE_URL}/api/catalog/unknown`]: () =>
        new Response(JSON.stringify({ error: "API not found" }), { status: 404 }),
    });
    const api = await getApi({ baseUrl: BASE_URL, fetch: fetchImpl }, "unknown");
    expect(api).toBeNull();
  });

  it("throws GatefareApiError on other non-2xx", async () => {
    const fetchImpl = mockFetch({
      [`${BASE_URL}/api/catalog/broken`]: () => new Response("err", { status: 500 }),
    });
    await expect(getApi({ baseUrl: BASE_URL, fetch: fetchImpl }, "broken")).rejects.toThrow(GatefareApiError);
  });
});
