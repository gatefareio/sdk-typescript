# @gatefare/client

[![npm version](https://img.shields.io/npm/v/@gatefare/client.svg)](https://www.npmjs.com/package/@gatefare/client)
[![CI](https://github.com/gatefareio/sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/gatefareio/sdk-typescript/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

TypeScript client for the [Gatefare](https://gatefare.io) x402 payment
marketplace. Pay any Gatefare-listed API in USDC on Base with three
function calls. Non-custodial. No platform account required for paying;
your wallet signs every authorization.

## Install

```bash
npm install @gatefare/client
```

Requires Node 20+ (uses Web Crypto + native `fetch`).

## Quick start

```ts
import { Gatefare } from "@gatefare/client";

const gf = new Gatefare({
  wallet: { privateKey: process.env.WALLET_PRIVATE_KEY! },
  spendCaps: {
    perCallUsdc: 0.50,    // refuse any single call above $0.50
    perDayUsdc: 5.00,     // refuse anything past $5/day total
  },
});

// Search the catalog
const apis = await gf.listCatalog({ priceLimitUsdc: 0.10, limit: 5 });

// Pay and call
const r = await gf.callApi(apis[0].slug, { query: { city: "Berlin" } });
console.log(r.status, r.data);   // 200 { ... }

// Check balance
const balance = await gf.checkBalance();
console.log(balance.usdc);       // 12.345
```

## What the SDK does for you

- Speaks the x402 v2 protocol: handles the initial 402 response,
  signs an EIP-3009 USDC `transferWithAuthorization` with your wallet,
  resubmits with the `X-Payment` header, parses the response.
- Enforces SDK-local spend caps **before** signing any authorization,
  so a buggy or malicious upstream cannot drain the wallet beyond what
  you configured.
- Cross-checks the server's quoted price against the catalog listing
  and refuses to sign if they diverge by more than 1%.
- Retries failed claims automatically (Gatefare's 24h, 10-attempt
  budget) via the `/p/_claim/<id>` endpoint, with exponential backoff.
- Decodes JSON / text responses without you needing to handle the
  raw stream.

## What the SDK does NOT do

- Custody your funds. The private key never leaves your process; we
  do not have a hosted wallet. Pass `privateKey` from an env var, KMS,
  or hardware signer (return its `0x...` hex).
- Pay for failed settles. If the on-chain settle reverts, no spend
  is recorded.
- Connect to the chain for catalog reads. Catalog endpoints are pure
  HTTP and work without a wallet — useful for read-only discovery.

## Spend caps

Two layers of guardrail. Both are enforced by the SDK locally, before
any wire activity that costs money:

```ts
new Gatefare({
  wallet: { privateKey: ... },
  spendCaps: {
    perCallUsdc: 1.00,    // default 1.00
    perDayUsdc: 10.00,    // default 10.00
  },
});
```

The per-call cap can be overridden per `callApi`:

```ts
await gf.callApi("expensive-listing", { perCallCapUsdc: 5.00 });
```

The per-day cap is reset at midnight UTC and held in-process. Provide
your own `SpendStorage` to make it crash-safe across process restarts.

## Framework adapters

All optional. Subpath imports — only what you use is bundled.

### LangChain (`@gatefare/client/langchain`)

```ts
import { DynamicTool } from "langchain/tools";
import { gatefareLangChainTool, gatefareCatalogTools } from "@gatefare/client/langchain";

// One specific Gatefare API as a tool
const tool = new DynamicTool(await gatefareLangChainTool(gf, {
  slug: "weather-now",
}));

// Or expose the whole filtered catalog as a toolbelt
const toolbelt = (await gatefareCatalogTools(gf, { priceLimitUsdc: 0.10 }))
  .map((d) => new DynamicTool(d));
```

### LlamaIndex (`@gatefare/client/llamaindex`)

```ts
import { FunctionTool } from "llamaindex";
import { gatefareLlamaIndexTool } from "@gatefare/client/llamaindex";

const tool = FunctionTool.from(await gatefareLlamaIndexTool(gf, {
  slug: "weather-now",
}));
```

### OpenAI function-calling (`@gatefare/client/openai-tools`)

```ts
import OpenAI from "openai";
import { gatefareOpenAITools, gatefareOpenAIDispatch } from "@gatefare/client/openai-tools";

const openai = new OpenAI();
const tools = await gatefareOpenAITools(gf, { priceLimitUsdc: 0.05 });

const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What's the weather in Berlin?" }],
  tools,
});

const toolCall = completion.choices[0].message.tool_calls?.[0];
if (toolCall) {
  const result = await gatefareOpenAIDispatch(gf, toolCall);
  // Feed `result` back as a `tool` role message and re-call the model.
}
```

### Anthropic tool-use (`@gatefare/client/anthropic-tools`)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { gatefareAnthropicTools, gatefareAnthropicDispatch } from "@gatefare/client/anthropic-tools";

const anthropic = new Anthropic();
const tools = await gatefareAnthropicTools(gf, { priceLimitUsdc: 0.05 });

const message = await anthropic.messages.create({
  model: "claude-3-5-sonnet-latest",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What's the weather in Berlin?" }],
  tools,
});

for (const block of message.content) {
  if (block.type === "tool_use") {
    const result = await gatefareAnthropicDispatch(gf, block);
    // Continue the conversation with `result` as a tool_result block.
  }
}
```

## Errors

The SDK throws two named error types:

- `SpendCapError` — your call was refused locally because it would
  exceed a configured spend cap. The wallet never produced a signature.
- `GatefareApiError` — Gatefare returned a non-2xx response we cannot
  recover from (unknown slug, exhausted claim, malformed quote).

Non-2xx responses from the upstream API (404 from a paid endpoint,
500 after a successful settle that exhausted retries) are surfaced as
the `status` field on `CallApiResult` rather than thrown.

## Configuration reference

```ts
new Gatefare({
  baseUrl: "https://gatefare.io",       // override for staging
  wallet: { privateKey: "0x..." },      // omit for catalog-only usage
  spendCaps: { perCallUsdc: 1.0, perDayUsdc: 10.0 },
  personalAccessToken: "gfpat_...",     // optional, raises rate limits
  fetch: customFetch,                   // optional, for tests
});
```

## Related packages

Gatefare ships three first-party packages. They share the same x402
protocol and the same backend, so a project can mix them as needed:

| Package | Where | When to use |
|---|---|---|
| [`@gatefare/client`](https://www.npmjs.com/package/@gatefare/client) (this one) | npm | TypeScript / JavaScript agents that pay APIs in code |
| [`gatefare`](https://pypi.org/project/gatefare/) | PyPI | Python agents (LangChain, LlamaIndex, etc.) |
| [`@gatefare/mcp`](https://www.npmjs.com/package/@gatefare/mcp) | npm | Drop into Claude Desktop / Cursor / any MCP host to give the agent tools for catalog discovery + paid calls |

## License

MIT. See [LICENSE](./LICENSE).

## Links

- Gatefare website: https://gatefare.io
- Catalog: https://gatefare.io/catalog
- Issues: https://github.com/gatefareio/sdk-typescript/issues
- Source: https://github.com/gatefareio/sdk-typescript
