// Claim retry helper. When a paid call returns 2xx the claim is
// fulfilled and the SDK is done. When it returns 5xx/timeout AFTER a
// successful settle (Gatefare's claim-and-retry guarantee — see
// BACKLOG #57 in the main repo), the buyer gets a 24h, 10-attempt
// retry budget. We expose that to the SDK consumer transparently:
// `callApi` retries internally up to N times before surfacing the
// final result.

import { GatefareApiError } from "./types.js";

export interface ClaimContext {
  baseUrl: string;
  fetch: typeof fetch;
}

export interface ClaimRetryResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  contentType: string;
}

/** Number of retries we'll attempt on a single failed paid call before
 *  giving up. Each retry uses the existing claim — no second on-chain
 *  settle. We cap below Gatefare's 10 server-side cap so we never hit
 *  the 410 GONE state mid-retry. */
export const DEFAULT_RETRY_BUDGET = 3;

/** Backoff between retries. Conservative: an upstream that's been
 *  failing typically needs a beat to recover. */
function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, capped — we won't go past attempt 4 in practice.
  return Math.min(4_000, 1_000 * 2 ** (attempt - 1));
}

/** Retry a fulfilled-but-failed claim. The claimId comes from the
 *  X-Gatefare-Claim-Id header on the original paid response. */
export async function retryClaim(
  ctx: ClaimContext,
  claimId: string,
): Promise<ClaimRetryResult> {
  const url = `${ctx.baseUrl}/p/_claim/${encodeURIComponent(claimId)}`;
  const r = await ctx.fetch(url);

  if (r.status === 410) {
    throw new GatefareApiError(
      410,
      "CLAIM_EXHAUSTED",
      "Claim retry budget exhausted (10 attempts used or 24h elapsed). " +
      "Contact the publisher with the claim id for an off-chain refund.",
    );
  }
  if (r.status === 404) {
    throw new GatefareApiError(404, "CLAIM_NOT_FOUND", `No claim ${claimId}`);
  }
  if (r.status === 400) {
    const text = await r.text().catch(() => "");
    throw new GatefareApiError(400, "CLAIM_BAD_FORMAT", text || "Malformed claim id");
  }

  const buf = new Uint8Array(await r.arrayBuffer());
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  return {
    status: r.status,
    headers,
    body: buf,
    contentType: headers["content-type"] || "application/octet-stream",
  };
}

/** Should we retry on this status code? */
export function isRetryableStatus(status: number): boolean {
  // 5xx upstream failures + 408 timeout + 429 too-many-requests are
  // the canonical "wait and retry" set. Anything else (4xx semantic
  // errors, 3xx redirects we already followed) is not the SDK's
  // problem.
  if (status >= 500 && status < 600) return true;
  if (status === 408 || status === 429) return true;
  return false;
}
