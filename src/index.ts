/**
 * @gatefare/client — TypeScript client for the Gatefare x402 payment
 * marketplace.
 *
 * Three primitives you actually need:
 *
 *   const gf = new Gatefare({ wallet: { privateKey: process.env.KEY } });
 *   const apis = await gf.listCatalog({ query: "weather" });
 *   const r = await gf.callApi(apis[0].slug, { query: { city: "Berlin" } });
 *   const balance = await gf.checkBalance();
 *
 * Under the hood:
 *   - listCatalog hits /api/catalog with optional filters
 *   - callApi follows the x402 flow: GET → 402 → sign EIP-3009 → resend
 *   - retries failed claims (server returns 5xx after a successful
 *     settle) via /p/_claim/<id> up to DEFAULT_RETRY_BUDGET times
 *   - enforces SDK-local spend caps before signing any authorization
 *
 * Everything in this module is side-effect free until the caller
 * issues a method call.
 */

import {
  listCatalog as listCatalogImpl,
  getApi as getApiImpl,
} from "./catalog.js";
import {
  signEip3009Authorization,
  type PaymentRequirements,
} from "./payment.js";
import {
  createWalletState,
  readUsdcBalance,
  type WalletState,
} from "./wallet.js";
import {
  retryClaim,
  isRetryableStatus,
  DEFAULT_RETRY_BUDGET,
} from "./claim.js";
import { SpendCapManager } from "./spend-cap.js";
import {
  GatefareApiError,
  type CallApiOptions,
  type CallApiResult,
  type CatalogApi,
  type CatalogQuery,
  type GatefareNetwork,
  type GatefareOptions,
  type WalletBalance,
} from "./types.js";

const DEFAULT_BASE_URL = "https://gatefare.io";

/**
 * Quote returned by the resource server on a 402 response. The exact
 * shape is the x402 v2 contract; we only consume the fields we need.
 */
interface X402Quote {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: GatefareNetwork;
    payTo: `0x${string}`;
    /** USDC value in atomic micros, as a decimal string. */
    maxAmountRequired: string;
    /** Resource URL the payment is bound to. */
    resource: string;
  }>;
}

export class Gatefare {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly personalAccessToken: string | undefined;
  private readonly wallet?: WalletState;
  private readonly walletRawKey?: string;
  private readonly spend: SpendCapManager;

  constructor(opts: GatefareOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.personalAccessToken = opts.personalAccessToken;
    this.spend = new SpendCapManager({ caps: opts.spendCaps });

    if (opts.wallet?.privateKey) {
      // Default to Base mainnet. When a paid call lands on a Sepolia
      // listing the wallet is rebuilt against the right chain on the
      // fly inside callApi. We keep the raw key so we can re-derive
      // a wallet state on a different chain without asking the user
      // to pass it again.
      this.walletRawKey = String(opts.wallet.privateKey);
      this.wallet = createWalletState(this.walletRawKey, "eip155:8453");
    }
  }

  /** Public catalog search. Works without a wallet. */
  listCatalog(query?: CatalogQuery): Promise<CatalogApi[]> {
    return listCatalogImpl(this.context(), query);
  }

  /** Public catalog detail for one slug. Returns null on 404. */
  getApi(slug: string): Promise<CatalogApi | null> {
    return getApiImpl(this.context(), slug);
  }

  /** Make a paid call against a Gatefare-listed API. Handles x402
   *  challenge, EIP-3009 signing, settle, upstream proxy, and claim
   *  retries. Throws SpendCapError when the SDK-local guardrails
   *  refuse the call BEFORE any signature is produced. */
  async callApi(slug: string, opts: CallApiOptions = {}): Promise<CallApiResult> {
    if (!this.wallet) {
      throw new Error(
        "Gatefare.callApi requires a wallet — pass { wallet: { privateKey } } to the constructor.",
      );
    }

    // Resolve the listing so we know the price and the chain. We need
    // this for the SDK-local spend cap check BEFORE we issue the
    // initial unauthenticated request — the cap must guard us against
    // a malicious or buggy server quoting a wildly higher price.
    const api = await this.getApi(slug);
    if (!api) {
      throw new GatefareApiError(404, "API_NOT_FOUND", `Unknown slug ${slug}`, slug);
    }

    // SDK-local guardrail: refuse calls that would exceed the cap
    // BEFORE talking to the server. This is the only protection
    // against a compromised resource server quoting $1000 when the
    // listing says $0.01 — if the cap is $1.00, the SDK never signs.
    this.spend.authorize(api.priceUsdc, opts.perCallCapUsdc);

    // The wallet may need rebuilding if the listing lives on a
    // different chain than the one the constructor defaulted to.
    const wallet = api.network === this.wallet.network
      ? this.wallet
      : this.rebuildWalletForChain(api.network);

    const url = this.buildProxyUrl(api.proxyUrl, opts.query);

    // Step 1: unauthenticated request. Expect a 402 with the quote.
    const initial = await this.fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: this.serializeBody(opts.body),
    });

    if (initial.status !== 402) {
      // The publisher may have a public/free path that returns 200
      // directly — totally fine, surface as zero-cost result.
      return this.formatSuccess(initial, 0, null, null);
    }

    const quote = await initial.json().catch(() => null) as X402Quote | null;
    if (!quote || !Array.isArray(quote.accepts) || quote.accepts.length === 0) {
      throw new GatefareApiError(402, "MALFORMED_402", "Resource server returned 402 without a valid quote", slug);
    }
    const accept = quote.accepts[0]!;

    // Cross-check the server's quoted price against our local view.
    // If they diverge by more than 1% we refuse — covers price changes
    // mid-flight + malicious quote inflation.
    const quotedUsdc = Number(accept.maxAmountRequired) / 1_000_000;
    if (quotedUsdc > api.priceUsdc * 1.01) {
      throw new GatefareApiError(
        402,
        "PRICE_DIVERGENCE",
        `Server quoted ${quotedUsdc} USDC but catalog says ${api.priceUsdc} — refusing to sign.`,
        slug,
      );
    }
    // Re-authorize at the actually-quoted price (paranoia: never sign
    // for more than what the spend cap permits).
    this.spend.authorize(quotedUsdc, opts.perCallCapUsdc);

    // Step 2: sign EIP-3009 authorization.
    const requirements: PaymentRequirements = {
      value: accept.maxAmountRequired,
      payTo: accept.payTo,
      network: accept.network,
      resource: accept.resource,
    };
    const signed = await signEip3009Authorization(wallet, requirements);

    // Step 3: re-send the request with X-Payment.
    const paid = await this.fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.headers ?? {}),
        "X-Payment": signed.xPaymentHeader,
      },
      body: this.serializeBody(opts.body),
    });

    // Record spend ONLY when the settle actually happened (paid 2xx
    // means upstream proxied through — settle was a precondition).
    if (paid.ok) {
      this.spend.record(quotedUsdc);
    }

    const claimId = paid.headers.get("x-gatefare-claim-id");
    const settleTxHash = paid.headers.get("x-gatefare-settle-tx") || null;

    // 2xx → done.
    if (paid.ok) {
      return this.formatSuccess(paid, quotedUsdc, claimId, settleTxHash);
    }

    // Non-2xx after a successful settle is the claim-retry case.
    // We loop up to DEFAULT_RETRY_BUDGET via /p/_claim/<id>.
    if (claimId && isRetryableStatus(paid.status)) {
      let lastStatus = paid.status;
      let lastHeaders: Record<string, string> = {};
      paid.headers.forEach((v, k) => { lastHeaders[k.toLowerCase()] = v; });
      let lastBody: Uint8Array = new Uint8Array(await paid.arrayBuffer());

      for (let attempt = 1; attempt <= DEFAULT_RETRY_BUDGET; attempt++) {
        await sleep(backoff(attempt));
        try {
          const r = await retryClaim({ baseUrl: this.baseUrl, fetch: this.fetchImpl }, claimId);
          if (r.status >= 200 && r.status < 300) {
            return {
              status: r.status,
              headers: r.headers,
              data: this.decodeBody(r.body as Uint8Array, r.contentType),
              paidUsdc: quotedUsdc,
              claimId,
              settleTxHash,
            };
          }
          // Still failing — record state for the final throw if we
          // exhaust attempts.
          lastStatus = r.status;
          lastHeaders = r.headers;
          lastBody = r.body as Uint8Array;
          if (!isRetryableStatus(r.status)) break; // semantic failure, no point retrying
        } catch (err) {
          // A claim retry itself failed (network blip, server down).
          // Continue the loop unless the attempt budget is exhausted.
          if (attempt === DEFAULT_RETRY_BUDGET) throw err;
        }
      }

      // Out of retries — return the last result we got. Caller can
      // decide what to do with the failed body.
      return {
        status: lastStatus,
        headers: lastHeaders,
        data: this.decodeBody(lastBody, lastHeaders["content-type"] ?? "application/octet-stream"),
        paidUsdc: quotedUsdc,
        claimId,
        settleTxHash,
      };
    }

    // Non-retryable failure with no claim id (shouldn't normally
    // happen but defensively surface it).
    return this.formatFailure(paid, quotedUsdc, claimId, settleTxHash);
  }

  /** Current USDC balance for the configured wallet. Requires a wallet. */
  async checkBalance(network?: GatefareNetwork): Promise<WalletBalance> {
    if (!this.wallet) {
      throw new Error("Gatefare.checkBalance requires a wallet.");
    }
    const target = network && network !== this.wallet.network
      ? this.rebuildWalletForChain(network)
      : this.wallet;
    const { micros, usdc } = await readUsdcBalance(target);
    return {
      usdc,
      usdcMicros: micros,
      address: target.account.address,
      network: target.network,
    };
  }

  /** Reveal the manager so adapters can read spent-today / remaining. */
  get spendManager(): SpendCapManager { return this.spend; }

  // ── internals ─────────────────────────────────────────────────

  private context() {
    return {
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      personalAccessToken: this.personalAccessToken,
    };
  }

  private buildProxyUrl(proxyPath: string, query?: Record<string, string | number | boolean>): string {
    const base = proxyPath.startsWith("http") ? proxyPath : `${this.baseUrl}${proxyPath}`;
    if (!query || Object.keys(query).length === 0) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) params.set(k, String(v));
    return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
  }

  private serializeBody(body: unknown): BodyInit | undefined {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return body;
    // viem and Node both ship Uint8Array as a BodyInit-compatible
    // value at runtime, but TypeScript's lib.dom typing widened in
    // 5.6 to require ArrayBuffer-backed buffers. Cast through unknown
    // — the underlying fetch implementation handles both.
    if (body instanceof Uint8Array) return body as unknown as BodyInit;
    if (body instanceof ArrayBuffer) return new Uint8Array(body) as unknown as BodyInit;
    return JSON.stringify(body);
  }

  private async formatSuccess(
    res: Response,
    paidUsdc: number,
    claimId: string | null,
    settleTxHash: string | null,
  ): Promise<CallApiResult> {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const contentType = headers["content-type"] ?? "";
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      headers,
      data: this.decodeBody(buf, contentType),
      paidUsdc,
      claimId,
      settleTxHash,
    };
  }

  private async formatFailure(
    res: Response,
    paidUsdc: number,
    claimId: string | null,
    settleTxHash: string | null,
  ): Promise<CallApiResult> {
    // Same shape as success — we surface non-2xx without throwing so
    // callers can branch on status without try/catch. Errors thrown
    // by callApi are reserved for SDK-local refusals + outright
    // network failures.
    return this.formatSuccess(res, paidUsdc, claimId, settleTxHash);
  }

  private decodeBody(buf: Uint8Array, contentType: string): unknown {
    const ct = contentType.toLowerCase();
    if (ct.includes("application/json") || ct.includes("+json")) {
      const text = new TextDecoder().decode(buf);
      try { return JSON.parse(text); } catch { return text; }
    }
    if (ct.startsWith("text/")) return new TextDecoder().decode(buf);
    return buf;
  }

  private rebuildWalletForChain(network: GatefareNetwork): WalletState {
    // Reuse the same private key, just bind it to the right chain.
    if (!this.walletRawKey) throw new Error("rebuildWalletForChain called without an initial wallet");
    return createWalletState(this.walletRawKey, network);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number): number {
  return Math.min(4_000, 1_000 * 2 ** (attempt - 1));
}

// Re-export public types so consumers can `import type { ... } from "@gatefare/client"`.
export type {
  AccountReputation,
  CallApiOptions,
  CallApiResult,
  CatalogApi,
  CatalogQuery,
  GatefareNetwork,
  GatefareOptions,
  PublisherInfo,
  SpendCaps,
  WalletBalance,
  WalletOptions,
} from "./types.js";

export { GatefareApiError, SpendCapError } from "./types.js";
export { DEFAULT_SPEND_CAPS } from "./spend-cap.js";
