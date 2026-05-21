/**
 * Public types for @gatefare/client.
 *
 * Keep this surface NARROW. Anything that leaks Gatefare's internal
 * column names (snake_case, internal user_ids, audit fields) should
 * stay in `internal-types.ts`, not here. Consumers should be able to
 * import * from this module and never see anything not meant for them.
 */

/** Supported networks for x402 settlement.
 *
 *  These mirror the canonical x402 / CAIP-2 chain identifiers that
 *  Gatefare lists in /api/networks. As of v0.1.0 the marketplace
 *  serves Base mainnet + Base Sepolia only; the union widens as
 *  Gatefare onboards more chains. */
export type GatefareNetwork = "eip155:8453" | "eip155:84532";

/** Wallet options. Currently only an in-process EOA from a private
 *  key is supported. CDP-managed wallets and browser injected wallets
 *  are planned for v0.2. */
export interface WalletOptions {
  /** 0x-prefixed 32-byte hex private key. Required for paid calls.
   *  Read-only catalog calls work without it. */
  privateKey?: `0x${string}` | string;
}

/** Spend caps applied across every paid call this SDK instance makes.
 *  Defaults: $1.00 per call, $10.00 per UTC day. These guardrails are
 *  the difference between "agent helps a user shop" and "agent burns
 *  your wallet to zero overnight" — set them deliberately. */
export interface SpendCaps {
  /** USDC ceiling per single call. Default: 1.00. */
  perCallUsdc?: number;
  /** USDC ceiling per UTC day across all calls. Default: 10.00. */
  perDayUsdc?: number;
}

/** Constructor input. */
export interface GatefareOptions {
  /** Gatefare base URL. Defaults to https://gatefare.io. Override for
   *  staging or self-hosted environments. */
  baseUrl?: string;
  /** Wallet credentials. Required for paid calls; optional for
   *  catalog-only usage. */
  wallet?: WalletOptions;
  /** Spend caps. Defaults to 1.00 / 10.00 USDC. */
  spendCaps?: SpendCaps;
  /** Optional PAT for higher-rate catalog reads + write:catalog
   *  operations (registering APIs from an agent). Prefix is
   *  `gfpat_`. Generated from the Gatefare dashboard Settings → PATs. */
  personalAccessToken?: string;
  /** Provide a custom fetch implementation for testing. Default is
   *  globalThis.fetch. */
  fetch?: typeof fetch;
}

/** Positive-only publisher trust signals. Returned on getApi()
 *  detail responses (catalog list endpoints omit them for payload
 *  size). New accounts have all booleans false — agents should
 *  treat absence of badges as "no signal yet", NOT as a warning.
 *  Thresholds are env-tunable server-side; the booleans here are
 *  the authoritative answer. */
export interface AccountReputation {
  tenureMonths: number;
  established: boolean;
  lifetimeSuccessCalls: number;
  topContributor: boolean;
  averageRating: number | null;
  reviewCount: number;
  highlyRated: boolean;
  activeApis: number;
  computedAt: number;
}

/** Publisher information attached to a catalog detail response. */
export interface PublisherInfo {
  handle: string | null;
  displayName: string | null;
  /** Optional admin-issued tier (bronze/silver/gold). null when none. */
  verificationTier: string | null;
  /** Account-level trust signals. Present on getApi() detail
   *  responses; absent on lightweight list-endpoint payloads. */
  reputation?: AccountReputation;
}

/** Public API record returned by listCatalog / getApi.
 *
 *  The fields up to `tags` are present on both endpoints. The fields
 *  below (publisher, sampleResponse) are populated by getApi() only —
 *  the list endpoint omits them to keep response sizes small. Both
 *  are typed as optional so type-checked code doesn't need to
 *  conditional-narrow when reading from a list. */
export interface CatalogApi {
  /** Globally-unique identifier. Use for proxy URLs. */
  slug: string;
  /** Per-publisher URL segment (canonical). */
  urlName: string | null;
  /** Publisher handle. */
  handle: string | null;
  name: string;
  description: string;
  /** Display price like "$0.01". */
  price: string;
  /** Numeric price as USDC (parsed for convenience). */
  priceUsdc: number;
  network: GatefareNetwork;
  networkName: string;
  testnet: boolean;
  /** Canonical proxy URL — `/p/<handle>/<urlName>` when both set,
   *  else legacy `/p/<slug>`. */
  proxyUrl: string;
  categories: string[];
  tags: string[];
  /** Full publisher record with reputation badges. Populated by
   *  getApi() only — undefined on listCatalog() responses. Use this
   *  to make trust decisions BEFORE issuing a paid call:
   *
   *      const api = await gf.getApi(slug);
   *      if (!api.publisher?.reputation?.established) {
   *        // brand-new account — extra caution OR proceed if
   *        // small-dollar exploratory call
   *      }
   */
  publisher?: PublisherInfo;
  /** Publisher-pasted sample response (max 4 KiB UTF-8) shown on
   *  the catalog detail page. Populated by getApi() only. Lets the
   *  agent eyeball the expected output shape BEFORE paying:
   *
   *      const api = await gf.getApi(slug);
   *      console.log("Publisher claims this comes back:", api.sampleResponse);
   *
   *  null when the publisher has not provided one (legacy listings
   *  pre-dating BACKLOG #47). undefined on list-endpoint payloads. */
  sampleResponse?: string | null;
}

/** Filters for listCatalog. */
export interface CatalogQuery {
  /** Full-text query against name + description. */
  query?: string;
  /** Filter by category slug (e.g. "weather"). */
  category?: string;
  /** Filter by tag (without leading #). */
  tag?: string;
  /** Maximum price in USDC. Listings above this are excluded. */
  priceLimitUsdc?: number;
  /** Include testnet listings. Default false. */
  includeTestnet?: boolean;
  /** Result count cap. Default 20, max 100. */
  limit?: number;
}

/** Options for callApi. */
export interface CallApiOptions {
  /** HTTP method. Default GET. */
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Query string parameters. Appended to the proxy URL. */
  query?: Record<string, string | number | boolean>;
  /** Request headers forwarded to the upstream API. */
  headers?: Record<string, string>;
  /** Request body. If object, serialized as JSON with
   *  `Content-Type: application/json`. If string/Buffer, sent verbatim. */
  body?: unknown;
  /** Maximum total time we'll wait for a paid response including
   *  on-chain settle + upstream + retry. Default 60 seconds. */
  timeoutMs?: number;
  /** Override the spend cap for THIS call. Useful when the publisher
   *  price is known to exceed the default cap. */
  perCallCapUsdc?: number;
}

/** Result of callApi. */
export interface CallApiResult {
  /** HTTP status from upstream API. */
  status: number;
  /** Response headers. */
  headers: Record<string, string>;
  /** Body parsed as JSON if `Content-Type` is JSON; otherwise raw text. */
  data: unknown;
  /** USDC paid for this call (after settlement). */
  paidUsdc: number;
  /** Gatefare claim ID. Used internally for retries; surfaced here for
   *  the consumer's own audit trail. */
  claimId: string | null;
  /** On-chain transaction hash of the settle, when surfaced by the
   *  facilitator. Null on free-retry (no new settle). */
  settleTxHash: string | null;
}

/** Wallet balance. */
export interface WalletBalance {
  /** USDC balance as a decimal number (e.g. 12.345 means 12.345 USDC). */
  usdc: number;
  /** USDC balance in atomic units (6-decimal micros). */
  usdcMicros: bigint;
  /** EVM address the balance is for. */
  address: `0x${string}`;
  /** Network the balance was read on. */
  network: GatefareNetwork;
}

/** Reason a call was refused before any payment attempt. */
export type SpendCapDenialReason =
  | "per_call_cap_exceeded"
  | "per_day_cap_exceeded";

/** Thrown by callApi when the SDK blocks the call locally — without
 *  ever signing a payment authorization. */
export class SpendCapError extends Error {
  override readonly name = "SpendCapError";
  constructor(
    public readonly reason: SpendCapDenialReason,
    public readonly attemptedUsdc: number,
    public readonly capUsdc: number,
  ) {
    super(
      `SDK-local spend cap (${capUsdc.toFixed(2)} USDC) would be exceeded ` +
      `by a call requesting ${attemptedUsdc.toFixed(2)} USDC (${reason}). ` +
      `Raise the cap explicitly in the call or adjust the constructor settings.`,
    );
  }
}

/** Thrown when the Gatefare server returns a non-2xx response that
 *  cannot be handled by the SDK (preflight failed, unknown slug, etc). */
export class GatefareApiError extends Error {
  override readonly name = "GatefareApiError";
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
    public readonly slug?: string,
  ) {
    super(message);
  }
}
