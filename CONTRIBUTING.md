# Contributing to @gatefare/client

Thanks for considering a contribution. This is a small, focused SDK;
the bar is "does it make the package more correct, safer, or easier to
use" rather than "does it add features".

## Setup

```bash
git clone https://github.com/gatefareio/sdk-typescript
cd sdk-typescript
npm install
```

Requires Node 20+.

## Workflow

```bash
npm run typecheck      # tsc --noEmit, must be clean
npm test               # vitest, all green
npm run build          # emits dist/, must succeed
npx tsx scripts/smoke-live.ts   # 12-point live check vs gatefare.io
```

Open a PR against `main`. CI runs typecheck + vitest + build + an
`npm pack` dry-run. Keep PRs single-purpose.

## Ground rules

- **No new runtime dependency** without a strong reason. The package
  ships with `viem` as its only runtime dep and we want to keep the
  install slim. Dev dependencies are fine.
- **Spend-cap and price-divergence logic is load-bearing.** Any change
  near `src/spend-cap.ts` or the cap checks in `callApi` needs a test
  that proves the wallet cannot sign past the cap. These are the lines
  that stand between a user and a drained wallet.
- **Adapters import nothing.** The framework adapters under
  `src/adapters/` deliberately do NOT import langchain / llamaindex /
  openai / anthropic. They return descriptors the host framework
  consumes. Keep it that way so the package stays dependency-light.
- **Tests use mocked `fetch`.** Unit tests must not hit the network.
  The one exception is `scripts/smoke-live.ts`, which is a manual /
  scheduled check, not part of `npm test`.

## Style

- TypeScript strict mode, `noUncheckedIndexedAccess` on.
- Comments explain *why*, not *what*. The existing source is the
  reference for tone and density.
- No emoji in source or commit messages.

## Releasing (maintainers)

1. Bump `version` in `package.json`.
2. Update the README if the public surface changed.
3. Commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `publish.yml` workflow runs typecheck + tests + build and
   publishes to npm automatically.

## Security

Found a vulnerability? Do not open a public issue. See
[SECURITY.md](./SECURITY.md).
