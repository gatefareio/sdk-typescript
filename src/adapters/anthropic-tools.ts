/**
 * Anthropic tool-use adapter — mirrors the openai-tools module but
 * for the Anthropic Messages API tool-use schema.
 *
 *   const tools = await gatefareAnthropicTools(gf, { priceLimitUsdc: 0.10 });
 *   const message = await anthropic.messages.create({
 *     model: "claude-3-5-sonnet-latest",
 *     messages,
 *     tools,
 *   });
 *
 * When the model emits a `tool_use` block, the consumer hands it to
 * `gatefareAnthropicDispatch` and feeds the result back as a
 * `tool_result` block.
 */

import type { Gatefare } from "../index.js";
import type { CatalogQuery } from "../types.js";

/** Anthropic tool descriptor shape. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: {
      query: {
        type: "object";
        description: string;
        additionalProperties: { type: "string" };
      };
    };
    required: [];
  };
}

function toolName(slug: string): string {
  // Anthropic tool names match `^[a-zA-Z0-9_-]{1,64}$`.
  return `gatefare_${slug.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50)}`;
}

export async function gatefareAnthropicTools(
  gf: Gatefare,
  query?: CatalogQuery,
): Promise<AnthropicTool[]> {
  const apis = await gf.listCatalog(query);
  return apis.map((api) => ({
    name: toolName(api.slug),
    description: `${api.name}: ${api.description} (price: ${api.price}, network: ${api.networkName})`,
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "object" as const,
          description: "Query parameters to pass to the upstream API as ?key=value pairs.",
          additionalProperties: { type: "string" as const },
        },
      },
      required: [] as [],
    },
  }));
}

/** Dispatch an Anthropic tool_use block back to the Gatefare client. */
export async function gatefareAnthropicDispatch(
  gf: Gatefare,
  block: { name: string; input: unknown },
): Promise<string> {
  if (!block.name.startsWith("gatefare_")) {
    return `Tool ${block.name} is not a Gatefare tool.`;
  }
  const candidate = block.name.slice("gatefare_".length).replace(/_/g, "-");
  const api = await gf.getApi(candidate);
  if (!api) return `No Gatefare listing for ${candidate}`;

  const input = (block.input ?? {}) as { query?: Record<string, string> };
  const result = await gf.callApi(api.slug, { query: input.query });
  if (result.status >= 200 && result.status < 300) {
    return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  }
  return `Upstream returned HTTP ${result.status}: ${JSON.stringify(result.data).slice(0, 500)}`;
}
