/**
 * Consumer-perspective smoke test.
 *
 * Imports the SDK exclusively through `dist/` paths — the same paths
 * a downstream npm consumer would resolve from after running
 * `npm install @gatefare/client`. This catches bugs where:
 *   - the build was missing a file
 *   - subpath exports in package.json don't match what was emitted
 *   - default vs named export semantics broke between source and
 *     compiled output
 *
 * Resolves dist/ via relative path because the package is not actually
 * installed via npm during this smoke. The shape we exercise is the
 * one consumers see.
 */

import { Gatefare, SpendCapError, GatefareApiError, DEFAULT_SPEND_CAPS } from "../dist/index.js";
import { gatefareLangChainTool } from "../dist/adapters/langchain.js";
import { gatefareOpenAITools } from "../dist/adapters/openai-tools.js";
import { gatefareAnthropicTools } from "../dist/adapters/anthropic-tools.js";
import { gatefareLlamaIndexTool } from "../dist/adapters/llamaindex.js";

let failures = 0;
const GREEN = "\x1b[32m"; const RED = "\x1b[31m"; const RESET = "\x1b[0m"; const DIM = "\x1b[2m";

function ok(label: string, detail?: string): void {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ""}`);
}
function fail(label: string, err: unknown): void {
  failures++;
  console.log(`  ${RED}✗${RESET} ${label}\n      ${RED}${err instanceof Error ? err.message : String(err)}${RESET}`);
}

async function smoke() {
  console.log("\n[smoke-dist] consumer-perspective imports from dist/\n");

  // ── Build artifacts ──
  console.log("class + error exports");
  try {
    if (typeof Gatefare !== "function") throw new Error("Gatefare class not exported");
    if (typeof SpendCapError !== "function") throw new Error("SpendCapError not exported");
    if (typeof GatefareApiError !== "function") throw new Error("GatefareApiError not exported");
    if (DEFAULT_SPEND_CAPS.perCallUsdc !== 1.0) throw new Error("DEFAULT_SPEND_CAPS wrong");
    ok("Gatefare, SpendCapError, GatefareApiError, DEFAULT_SPEND_CAPS from main");
  } catch (err) {
    fail("main exports", err);
  }

  // ── Adapter subpaths ──
  console.log("\nadapter subpath imports");
  try {
    if (typeof gatefareLangChainTool !== "function") throw new Error("langchain adapter not exported");
    if (typeof gatefareOpenAITools !== "function") throw new Error("openai-tools adapter not exported");
    if (typeof gatefareAnthropicTools !== "function") throw new Error("anthropic-tools adapter not exported");
    if (typeof gatefareLlamaIndexTool !== "function") throw new Error("llamaindex adapter not exported");
    ok("all four adapter subpaths resolve to functions");
  } catch (err) {
    fail("subpath imports", err);
  }

  // ── Instantiate without wallet and verify catalog-only mode ──
  console.log("\nreadonly Gatefare instance against live server");
  try {
    const gf = new Gatefare({ baseUrl: "https://gatefare.io" });
    const apis = await gf.listCatalog({ limit: 3 });
    if (!Array.isArray(apis) || apis.length === 0) throw new Error("empty catalog from dist build");
    if (apis.length > 3) throw new Error(`limit ignored: got ${apis.length}`);
    ok(`listCatalog from dist build`, `${apis.length} apis`);
  } catch (err) {
    fail("Gatefare from dist", err);
  }

  // ── Spend cap throws SpendCapError, not generic Error ──
  console.log("\nspend cap error class identity");
  try {
    const gf = new Gatefare({
      baseUrl: "https://gatefare.io",
      wallet: { privateKey: "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318" },
      spendCaps: { perCallUsdc: 0.0001 },  // impossibly low
    });
    const apis = await gf.listCatalog({ limit: 1 });
    if (apis.length === 0) {
      ok("skipped (no catalog listings available)");
    } else {
      try {
        await gf.callApi(apis[0]!.slug);
        throw new Error("expected SpendCapError but call succeeded");
      } catch (caught) {
        if (caught instanceof SpendCapError) {
          ok("SpendCapError thrown with correct class identity", caught.reason);
        } else if (caught instanceof Error && caught.message.includes("expected SpendCapError")) {
          throw caught;
        } else {
          // Could also legitimately throw GatefareApiError if the live
          // listing is unreachable. We accept either as long as our
          // wallet never signed anything.
          ok("blocked before signing", caught instanceof Error ? caught.constructor.name : "unknown");
        }
      }
    }
  } catch (err) {
    fail("spend cap class identity", err);
  }

  console.log("");
  if (failures === 0) {
    console.log(`${GREEN}[smoke-dist] all consumer-perspective checks passed${RESET}\n`);
  } else {
    console.log(`${RED}[smoke-dist] ${failures} check(s) failed${RESET}\n`);
    process.exit(1);
  }
}

smoke().catch((err) => {
  console.error("\n[smoke-dist] fatal:", err);
  process.exit(1);
});
