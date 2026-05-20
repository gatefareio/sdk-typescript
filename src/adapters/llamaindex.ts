/**
 * LlamaIndex.ts adapter — wraps Gatefare APIs as LlamaIndex
 * `FunctionTool`-compatible descriptors, again without taking a
 * runtime dependency on llamaindex.
 *
 *   import { FunctionTool } from "llamaindex";
 *   import { gatefareLlamaIndexTool } from "@gatefare/client/llamaindex";
 *
 *   const tool = FunctionTool.from(
 *     await gatefareLlamaIndexTool(gf, { slug: "weather-now" }),
 *   );
 */

import type { Gatefare } from "../index.js";
import type { CatalogQuery } from "../types.js";

export interface LlamaIndexToolMetadata {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LlamaIndexToolDescriptor {
  metadata: LlamaIndexToolMetadata;
  fn: (input: { query?: Record<string, string> }) => Promise<string>;
}

function toolName(slug: string): string {
  return `gatefare_${slug.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50)}`;
}

export async function gatefareLlamaIndexTool(
  gf: Gatefare,
  opts: { slug: string; name?: string; description?: string },
): Promise<LlamaIndexToolDescriptor> {
  const api = await gf.getApi(opts.slug);
  if (!api) throw new Error(`Gatefare: unknown slug "${opts.slug}"`);

  return {
    metadata: {
      name: opts.name ?? toolName(api.slug),
      description: opts.description ?? `${api.name}: ${api.description} (${api.price})`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "object",
            description: "Query parameters for the upstream API.",
            additionalProperties: { type: "string" },
          },
        },
        required: [],
      },
    },
    fn: async (input) => {
      const result = await gf.callApi(opts.slug, { query: input.query });
      if (result.status >= 200 && result.status < 300) {
        return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      }
      return `Upstream returned HTTP ${result.status}: ${JSON.stringify(result.data).slice(0, 500)}`;
    },
  };
}

export async function gatefareLlamaIndexCatalogTools(
  gf: Gatefare,
  query?: CatalogQuery,
): Promise<LlamaIndexToolDescriptor[]> {
  const apis = await gf.listCatalog(query);
  return Promise.all(apis.map((a) => gatefareLlamaIndexTool(gf, { slug: a.slug })));
}
