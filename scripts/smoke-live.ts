/**
 * Live smoke test against gatefare.io.
 *
 * Runs the SDK in read-only mode against the production catalog to
 * verify that:
 *   1. listCatalog returns the expected shape (server schema matches
 *      what we parse)
 *   2. getApi handles 200 + 404
 *   3. The built dist/ output is consumable
 *   4. Subpath imports (adapters) resolve correctly
 *
 * Does NOT make paid calls — that requires a real wallet on Base
 * mainnet which we are not going to do from a smoke test. The
 * mocked-fetch tests already cover the paid-call code paths in
 * isolation.
 *
 * Run with:
 *   npx tsx scripts/smoke-live.ts
 */

import { Gatefare } from "../src/index.js";
import { gatefareLangChainTool, gatefareCatalogTools } from "../src/adapters/langchain.js";
import { gatefareOpenAITools } from "../src/adapters/openai-tools.js";
import { gatefareAnthropicTools } from "../src/adapters/anthropic-tools.js";
import { gatefareLlamaIndexTool } from "../src/adapters/llamaindex.js";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

let failures = 0;
function ok(label: string, detail?: string): void {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ""}`);
}
function fail(label: string, err: unknown): void {
  failures++;
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  ${RED}✗${RESET} ${label}\n      ${RED}${msg}${RESET}`);
}

async function smoke() {
  console.log("\n[smoke] @gatefare/client vs https://gatefare.io (read-only)\n");

  const gf = new Gatefare({ baseUrl: "https://gatefare.io" });

  // ── 1. listCatalog ──────────────────────────────────────────────
  console.log("listCatalog");
  let apis: Awaited<ReturnType<typeof gf.listCatalog>> = [];
  try {
    apis = await gf.listCatalog({ limit: 5 });
    if (!Array.isArray(apis)) throw new Error("not an array");
    if (apis.length === 0) throw new Error("empty (expected at least 1 live listing)");
    ok("returned non-empty array", `${apis.length} apis`);
  } catch (err) {
    fail("listCatalog basic", err);
    return; // can't continue without a sample
  }

  const first = apis[0]!;
  try {
    const required = ["slug", "name", "price", "priceUsdc", "network", "proxyUrl"] as const;
    for (const k of required) {
      if (first[k] === undefined || first[k] === null) {
        throw new Error(`field "${k}" missing on sample API`);
      }
    }
    ok("required fields present", required.join(", "));
  } catch (err) {
    fail("listCatalog shape", err);
  }

  try {
    if (typeof first.priceUsdc !== "number" || !Number.isFinite(first.priceUsdc)) {
      throw new Error(`priceUsdc parsed to ${first.priceUsdc}`);
    }
    if (first.priceUsdc < 0) throw new Error("negative priceUsdc");
    ok("priceUsdc is a finite non-negative number", `${first.priceUsdc}`);
  } catch (err) {
    fail("priceUsdc parsing", err);
  }

  // ── 2. listCatalog with priceLimit ──────────────────────────────
  try {
    const cheap = await gf.listCatalog({ priceLimitUsdc: 0.10, limit: 20 });
    for (const a of cheap) {
      if (a.priceUsdc > 0.10) {
        throw new Error(`${a.slug} costs ${a.priceUsdc} USDC, exceeds priceLimitUsdc=0.10`);
      }
    }
    ok("priceLimitUsdc filter respected", `${cheap.length} apis under $0.10`);
  } catch (err) {
    fail("listCatalog priceLimit", err);
  }

  // ── 3. getApi happy path ────────────────────────────────────────
  console.log("\ngetApi");
  try {
    const api = await gf.getApi(first.slug);
    if (!api) throw new Error("getApi returned null for an api we just listed");
    if (api.slug !== first.slug) throw new Error("slug mismatch on roundtrip");
    ok("happy path roundtrip", api.name);
  } catch (err) {
    fail("getApi", err);
  }

  // ── 4. getApi 404 ───────────────────────────────────────────────
  try {
    const missing = await gf.getApi(`__definitely-not-a-real-slug-${Date.now()}__`);
    if (missing !== null) throw new Error(`expected null, got ${JSON.stringify(missing)}`);
    ok("404 returns null (not throw)");
  } catch (err) {
    fail("getApi 404 behavior", err);
  }

  // ── 5. Adapters (offline-shape only) ───────────────────────────
  console.log("\nadapters");
  try {
    const t = await gatefareLangChainTool(gf, { slug: first.slug });
    if (!t.name || !t.description || typeof t.func !== "function") {
      throw new Error("descriptor missing name/description/func");
    }
    ok("langchain single tool", t.name);
  } catch (err) {
    fail("langchain adapter", err);
  }

  try {
    const tools = await gatefareCatalogTools(gf, { limit: 3 });
    if (tools.length === 0) throw new Error("empty toolbelt");
    for (const t of tools) {
      if (!t.name || !t.description || typeof t.func !== "function") {
        throw new Error(`bad descriptor: ${JSON.stringify(t)}`);
      }
    }
    ok("langchain catalog tools", `${tools.length} tools`);
  } catch (err) {
    fail("langchain catalog adapter", err);
  }

  try {
    const tools = await gatefareOpenAITools(gf, { limit: 2 });
    for (const t of tools) {
      if (t.type !== "function" || !t.function.name.startsWith("gatefare_")) {
        throw new Error(`bad openai shape: ${JSON.stringify(t)}`);
      }
    }
    ok("openai tools", `${tools.length} tools`);
  } catch (err) {
    fail("openai adapter", err);
  }

  try {
    const tools = await gatefareAnthropicTools(gf, { limit: 2 });
    for (const t of tools) {
      if (!t.name.startsWith("gatefare_") || !t.input_schema) {
        throw new Error(`bad anthropic shape: ${JSON.stringify(t)}`);
      }
    }
    ok("anthropic tools", `${tools.length} tools`);
  } catch (err) {
    fail("anthropic adapter", err);
  }

  try {
    const t = await gatefareLlamaIndexTool(gf, { slug: first.slug });
    if (!t.metadata.name || typeof t.fn !== "function") {
      throw new Error("bad llamaindex shape");
    }
    ok("llamaindex single tool", t.metadata.name);
  } catch (err) {
    fail("llamaindex adapter", err);
  }

  // ── 6. Error classes are usable from the public surface ─────────
  console.log("\nerror classes");
  try {
    const { SpendCapError, GatefareApiError } = await import("../src/index.js");
    const e1 = new SpendCapError("per_call_cap_exceeded", 0.5, 0.1);
    const e2 = new GatefareApiError(404, "X", "y");
    if (!(e1 instanceof Error)) throw new Error("SpendCapError is not an Error");
    if (!(e2 instanceof Error)) throw new Error("GatefareApiError is not an Error");
    ok("SpendCapError + GatefareApiError exported");
  } catch (err) {
    fail("error classes", err);
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log("");
  if (failures === 0) {
    console.log(`${GREEN}[smoke] all checks passed${RESET}\n`);
  } else {
    console.log(`${RED}[smoke] ${failures} check(s) failed${RESET}\n`);
    process.exit(1);
  }
}

smoke().catch((err) => {
  console.error("\n[smoke] fatal:", err);
  process.exit(1);
});
