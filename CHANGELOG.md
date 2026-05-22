# Changelog

All notable changes to `@gatefare/client` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-21

### Fixed

- `getApi()` now surfaces `publisher.reputation` and `sampleResponse`
  from `/catalog/:slug` detail responses. v0.1.0 declared `CatalogApi`
  with only the catalog-list field subset, so the two detail-only
  fields were silently dropped. Consumers calling `gf.getApi(slug)`
  could not read a publisher's trust badges or the publisher-provided
  sample response without bypassing the SDK. Both are now exposed.

### Added

- `AccountReputation` interface — positive-only publisher trust
  badges (`established`, `topContributor`, `highlyRated`) plus the
  raw counters behind them.
- `publisher.reputation` and `sampleResponse` on the `CatalogApi`
  type. Both optional: populated by `getApi()` detail responses,
  absent on `listCatalog()` list responses.

### Compatibility

Additive only. No breaking change from 0.1.0. Code written against
0.1.0 keeps working; the new fields are extra.

## [0.1.0] - 2026-05-21

### Added

- Initial public release.
- `Gatefare` client class with three primitives: `listCatalog`,
  `callApi`, `checkBalance` (plus `getApi`).
- Full x402 v2 flow: 402 challenge handling, EIP-3009 USDC signing,
  `X-Payment` header, response decoding.
- SDK-local spend caps (per-call + per-day) enforced before any
  signature is produced. `SpendCapError` thrown on refusal.
- Quote-price cross-check against the catalog listing; refuses to
  sign if the server quote diverges more than 1%.
- Automatic claim retry via `/p/_claim/<id>` with exponential
  backoff for upstream failures after a successful settle.
- Framework adapters as subpath imports (no runtime dependency on
  the host framework): `@gatefare/client/langchain`,
  `/llamaindex`, `/openai-tools`, `/anthropic-tools`.
- 30 vitest unit tests; live + dist-consumer smoke scripts.
- `viem` as the only runtime dependency.
