/**
 * LangChain integration example — turn the Gatefare catalog into a
 * toolbelt that an agent can pick from at runtime.
 *
 * Run with:
 *   WALLET_PRIVATE_KEY=0x... npx tsx examples/langchain.ts
 *
 * Requires the consumer to install langchain and an LLM provider of
 * their choice. This example sketches the integration without
 * importing langchain so the SDK package itself stays small.
 */

import { Gatefare } from "../src/index.js";
import {
  gatefareLangChainTool,
  gatefareCatalogTools,
} from "../src/adapters/langchain.js";

async function main() {
  const gf = new Gatefare({
    wallet: { privateKey: process.env.WALLET_PRIVATE_KEY! },
    spendCaps: { perCallUsdc: 0.10, perDayUsdc: 1.00 },
  });

  // Variant A: one specific tool the agent must use.
  const single = await gatefareLangChainTool(gf, {
    slug: "weather-now",
    description: "Get the current weather. Input: JSON like {\"city\":\"Berlin\"}",
  });
  console.log(`[tool A] name=${single.name}`);
  // const tool = new DynamicTool(single);

  // Variant B: every cheap catalog API as a toolbelt — agent chooses.
  const toolbelt = await gatefareCatalogTools(gf, { priceLimitUsdc: 0.05, limit: 10 });
  console.log(`[tool B] ${toolbelt.length} tools available`);
  for (const t of toolbelt) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 80)}`);
  }

  // In real code:
  //
  //   import { DynamicTool } from "langchain/tools";
  //   import { initializeAgentExecutorWithOptions } from "langchain/agents";
  //   const tools = toolbelt.map((t) => new DynamicTool(t));
  //   const executor = await initializeAgentExecutorWithOptions(tools, llm, { ... });
  //   const result = await executor.invoke({ input: "What's the weather in Berlin?" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
