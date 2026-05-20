/**
 * OpenAI function-calling adapter.
 *
 * Returns one entry per Gatefare catalog API in the exact shape the
 * OpenAI Chat Completions API expects for the `tools` parameter:
 *
 *   const tools = await gatefareOpenAITools(gf, { priceLimitUsdc: 0.10 });
 *   const completion = await openai.chat.completions.create({
 *     model: "gpt-4o",
 *     messages,
 *     tools,
 *   });
 *
 * When the model emits a tool_call with one of our function names,
 * the consumer calls `gatefareOpenAIDispatch(gf, toolCall)` and feeds
 * the result back to the model.
 */

import type { Gatefare } from "../index.js";
import type { CatalogQuery } from "../types.js";

/** Shape of one tool descriptor passed to OpenAI's Chat Completions
 *  `tools` parameter (`type: "function"`). */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
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
  };
}

/** Sanitize a slug to a function-name-safe identifier. */
function fnName(slug: string): string {
  return `gatefare_${slug.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50)}`;
}

/** Build OpenAI tool descriptors for every catalog API matching the
 *  query. */
export async function gatefareOpenAITools(
  gf: Gatefare,
  query?: CatalogQuery,
): Promise<OpenAITool[]> {
  const apis = await gf.listCatalog(query);
  return apis.map((api) => ({
    type: "function" as const,
    function: {
      name: fnName(api.slug),
      description: `${api.name}: ${api.description} (price: ${api.price}, network: ${api.networkName})`,
      parameters: {
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
    },
  }));
}

/** Dispatch a tool_call from an OpenAI completion back to the
 *  Gatefare client. Returns the stringified response body suitable
 *  for sending back as a `tool` role message in the conversation. */
export async function gatefareOpenAIDispatch(
  gf: Gatefare,
  toolCall: { function: { name: string; arguments: string } },
): Promise<string> {
  const name = toolCall.function.name;
  if (!name.startsWith("gatefare_")) {
    return `Tool ${name} is not a Gatefare tool.`;
  }
  // Recover the slug. We can't perfectly invert the sanitizer if the
  // original slug had non-[a-zA-Z0-9_] characters, but Gatefare slugs
  // are lowercased-hyphenated by convention so the underscore-only
  // sanitizer is a no-op in practice. Fall through to a catalog
  // lookup for safety.
  const candidate = name.slice("gatefare_".length).replace(/_/g, "-");
  const api = await gf.getApi(candidate);
  if (!api) return `No Gatefare listing for ${candidate}`;

  let args: { query?: Record<string, string> };
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    args = {};
  }

  const result = await gf.callApi(api.slug, { query: args.query });
  if (result.status >= 200 && result.status < 300) {
    return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  }
  return `Upstream returned HTTP ${result.status}: ${JSON.stringify(result.data).slice(0, 500)}`;
}
