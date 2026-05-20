import { describe, it, expect } from "vitest";
import { retryClaim, isRetryableStatus } from "../src/claim.js";
import { GatefareApiError } from "../src/types.js";

const BASE = "https://example-gatefare";

function mockFetch(map: Record<string, () => Response>): typeof fetch {
  return async (input: any) => {
    const url = String(input);
    const f = map[url];
    if (!f) throw new Error(`Unmocked URL: ${url}`);
    return f();
  };
}

describe("retryClaim", () => {
  it("returns the buffered body on a successful retry", async () => {
    const fetchImpl = mockFetch({
      [`${BASE}/p/_claim/c1`]: () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const r = await retryClaim({ baseUrl: BASE, fetch: fetchImpl }, "c1");
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/json");
    expect(new TextDecoder().decode(r.body)).toBe('{"ok":true}');
  });

  it("throws CLAIM_EXHAUSTED on 410", async () => {
    const fetchImpl = mockFetch({
      [`${BASE}/p/_claim/exhausted`]: () => new Response("", { status: 410 }),
    });
    await expect(
      retryClaim({ baseUrl: BASE, fetch: fetchImpl }, "exhausted"),
    ).rejects.toMatchObject({ status: 410, code: "CLAIM_EXHAUSTED" });
  });

  it("throws CLAIM_NOT_FOUND on 404", async () => {
    const fetchImpl = mockFetch({
      [`${BASE}/p/_claim/missing`]: () => new Response("", { status: 404 }),
    });
    await expect(
      retryClaim({ baseUrl: BASE, fetch: fetchImpl }, "missing"),
    ).rejects.toMatchObject({ status: 404, code: "CLAIM_NOT_FOUND" });
  });

  it("throws CLAIM_BAD_FORMAT on 400", async () => {
    const fetchImpl = mockFetch({
      [`${BASE}/p/_claim/bad`]: () =>
        new Response("malformed", { status: 400 }),
    });
    await expect(
      retryClaim({ baseUrl: BASE, fetch: fetchImpl }, "bad"),
    ).rejects.toMatchObject({ status: 400, code: "CLAIM_BAD_FORMAT" });
  });
});

describe("isRetryableStatus", () => {
  it("treats 5xx as retryable", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it("treats 408 and 429 as retryable", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("does NOT retry 200, 4xx semantic errors, redirects", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(301)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

it("GatefareApiError carries status + code + message", () => {
  const e = new GatefareApiError(402, "FOO_BAR", "wat", "slug-1");
  expect(e.status).toBe(402);
  expect(e.code).toBe("FOO_BAR");
  expect(e.message).toBe("wat");
  expect(e.slug).toBe("slug-1");
});
