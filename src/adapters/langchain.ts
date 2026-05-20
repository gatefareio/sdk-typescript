/**
 * LangChain adapter — wraps a Gatefare client into a LangChain
 * `DynamicTool`-compatible shape WITHOUT importing langchain.
 *
 * Why no direct import: every framework version moves quickly, and
 * pinning a langchain version in our peerDependencies would either
 * force users to a specific version (annoying) or be silently wrong
 * after a breaking release. Instead we return the exact object shape
 * `langchain/tools` consumes, which has been stable since langchain
 * 0.1 — name, description, func. The caller does:
 *
 *   import { DynamicTool } from "langchain/tools";
 *   import { gatefareLangChainTool } from "@gatefare/client/langchain";
 *
 *   const tool = new DynamicTool(gatefareLangChainTool(gf, {
 *     slug: "weather-now",
 *     description: "Get the weather for a city",
 *   }));
 *
 * Or with the catalog discovery variant:
 *
 *   const tools = await gatefareCatalogTools(gf, { priceLimitUsdc: 0.10 });
 *
 * which returns one DynamicTool-shaped descriptor per catalog API
 * matching the filter. The agent can then pick which one to call.
 */

import type { Gatefare } from "../index.js";
import type { CatalogQuery } from "../types.js";

/** LangChain DynamicTool-compatible descriptor. */
export interface LangChainToolDescriptor {
  name: string;
  description: string;
  func: (input: string) => Promise<string>;
}

export interface LangChainToolOptions {
  /** Catalog slug to bind this tool to. */
  slug: string;
  /** Override description shown to the agent. Defaults to the
   *  publisher's listing description. */
  description?: string;
  /** Override tool name (LangChain expects [a-zA-Z0-9_-]). Defaults
   *  to the slug, sanitized. */
  name?: string;
}

function sanitizeToolName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** Build a LangChain DynamicTool descriptor that calls one specific
 *  Gatefare-listed API. The agent passes a JSON string of query
 *  parameters; the tool calls and returns the response text. */
export async function gatefareLangChainTool(
  gf: Gatefare,
  opts: LangChainToolOptions,
): Promise<LangChainToolDescriptor> {
  const api = await gf.getApi(opts.slug);
  if (!api) throw new Error(`Gatefare: unknown slug "${opts.slug}"`);

  return {
    name: opts.name ?? sanitizeToolName(api.slug),
    description: opts.description ?? `${api.name}. ${api.description} (price: ${api.price})`,
    func: async (input: string) => {
      // The agent may pass a plain query string, a JSON object, or
      // nothing. We try JSON first and fall back to passing input as
      // a single `q` query param.
      let query: Record<string, string | number | boolean> | undefined;
      const trimmed = input.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          query = JSON.parse(trimmed);
        } catch {
          query = { q: input };
        }
      } else if (trimmed.length > 0) {
        query = { q: trimmed };
      }

      const result = await gf.callApi(opts.slug, { query });
      if (result.status >= 200 && result.status < 300) {
        return typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data);
      }
      return `Gatefare call returned HTTP ${result.status}: ${JSON.stringify(result.data).slice(0, 500)}`;
    },
  };
}

/** Convenience: discover catalog APIs matching a filter and produce
 *  one tool per matching listing. Useful when you want the agent to
 *  see "everything cheaper than $0.10" as its available toolbelt. */
export async function gatefareCatalogTools(
  gf: Gatefare,
  query?: CatalogQuery,
): Promise<LangChainToolDescriptor[]> {
  const apis = await gf.listCatalog(query);
  return Promise.all(apis.map((a) => gatefareLangChainTool(gf, { slug: a.slug })));
}
