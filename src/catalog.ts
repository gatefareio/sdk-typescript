// Catalog reads against /api/catalog and /api/catalog/:slug.
//
// These endpoints are public on Gatefare — no auth required. We
// optionally attach a PAT for higher rate limits, but unauthenticated
// callers also get useful headroom (the public limiter is generous
// enough for typical agent traffic).

import { GatefareApiError, type CatalogApi, type CatalogQuery } from "./types.js";

interface CatalogContext {
  baseUrl: string;
  fetch: typeof fetch;
  personalAccessToken?: string;
}

interface RawCatalogApi {
  slug: string;
  urlName: string | null;
  handle: string | null;
  name: string;
  description: string;
  price: string;
  network: string;
  networkName: string;
  testnet: boolean;
  proxyUrl: string;
  categories?: string[];
  tags?: string[];
}

/** Parse "$0.10" or "0.10" into a number. NaN-safe (returns 0). */
function parsePriceUsdc(price: string): number {
  const m = /^\$?(\d+(?:\.\d+)?)$/.exec(price.trim());
  return m && m[1] ? parseFloat(m[1]) : 0;
}

function rawToCatalogApi(r: RawCatalogApi): CatalogApi {
  // Network is stored as eip155:<chainId>. Cast through `unknown` so
  // we accept future networks without dropping them; downstream code
  // gates on testnet flag rather than the literal union.
  const network = r.network as CatalogApi["network"];
  return {
    slug: r.slug,
    urlName: r.urlName ?? null,
    handle: r.handle ?? null,
    name: r.name,
    description: r.description ?? "",
    price: r.price,
    priceUsdc: parsePriceUsdc(r.price),
    network,
    networkName: r.networkName,
    testnet: !!r.testnet,
    proxyUrl: r.proxyUrl,
    categories: r.categories ?? [],
    tags: r.tags ?? [],
  };
}

function buildQueryString(q: CatalogQuery | undefined): string {
  if (!q) return "";
  const parts: string[] = [];
  // Server wire names — confirmed against the live /api/catalog
  // handler:
  //   q          — full-text query
  //   category   — category slug filter
  //   tag        — tag filter
  //   price_max  — server-side price ceiling (USDC, decimal)
  //   per_page   — page size, server caps at 50
  //   includeTestnet — flag
  // We translate the SDK's friendlier parameter names to these wire
  // names. SDK consumers don't need to learn server internals.
  if (q.query) parts.push(`q=${encodeURIComponent(q.query)}`);
  if (q.category) parts.push(`category=${encodeURIComponent(q.category)}`);
  if (q.tag) parts.push(`tag=${encodeURIComponent(q.tag)}`);
  if (q.priceLimitUsdc !== undefined && Number.isFinite(q.priceLimitUsdc)) {
    parts.push(`price_max=${encodeURIComponent(String(q.priceLimitUsdc))}`);
  }
  if (q.includeTestnet) parts.push("includeTestnet=1");
  if (q.limit !== undefined) {
    // Server caps per_page at 50; we cap further at the SDK level so
    // a buggy consumer asking for 1000 doesn't trigger a 400.
    const capped = Math.max(1, Math.min(50, q.limit));
    parts.push(`per_page=${capped}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function authHeader(pat?: string): Record<string, string> {
  return pat ? { Authorization: `Bearer ${pat}` } : {};
}

/** Search the public catalog. */
export async function listCatalog(
  ctx: CatalogContext,
  query?: CatalogQuery,
): Promise<CatalogApi[]> {
  const url = `${ctx.baseUrl}/api/catalog${buildQueryString(query)}`;
  const r = await ctx.fetch(url, { headers: authHeader(ctx.personalAccessToken) });
  if (!r.ok) {
    throw new GatefareApiError(r.status, null, `Catalog request failed: ${r.status} ${r.statusText}`);
  }
  const body = await r.json() as { apis?: RawCatalogApi[] };
  let apis = (body.apis ?? []).map(rawToCatalogApi);

  // Client-side priceLimit safety belt. The server respects
  // `price_max` natively now, but we apply a defensive filter so a
  // future server-side regression that ignores the param does not
  // silently leak over-budget listings to a price-sensitive caller.
  if (query?.priceLimitUsdc !== undefined) {
    apis = apis.filter((a) => a.priceUsdc <= query.priceLimitUsdc!);
  }

  // Client-side limit guarantee. Same logic: even if the server
  // ignores `per_page`, our caller asked for "at most N" — give them
  // at most N. Cheap to slice in memory.
  if (query?.limit !== undefined) {
    apis = apis.slice(0, Math.max(1, Math.min(50, query.limit)));
  }

  return apis;
}

/** Fetch one API by slug. Returns null on 404 (rather than throwing)
 *  so callers can branch on "does this listing exist" without try/catch. */
export async function getApi(
  ctx: CatalogContext,
  slug: string,
): Promise<CatalogApi | null> {
  const url = `${ctx.baseUrl}/api/catalog/${encodeURIComponent(slug)}`;
  const r = await ctx.fetch(url, {
    headers: authHeader(ctx.personalAccessToken),
    redirect: "follow",
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new GatefareApiError(r.status, null, `getApi failed: ${r.status} ${r.statusText}`, slug);
  }
  const raw = await r.json() as RawCatalogApi;
  return rawToCatalogApi(raw);
}
