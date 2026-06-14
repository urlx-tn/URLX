# Contributing to URLX

Thanks for your interest in improving URLX - a fast, private URL shortener.
Contributions of all sizes are welcome: bug reports, fixes, docs, and features.

## Maintainers

- **Youssef Dhibi** - https://youssef.tn
- **Chames Eddine Dhibi** - https://v1.chames.dhibi.tn

## Prerequisites

- **Node.js** 20 or newer
- **pnpm** 10.22 or newer (this repo pins `pnpm@10.22.0` via `packageManager`)

```bash
corepack enable
pnpm install
```

## Project layout

This is a pnpm + Turborepo monorepo.

```text
apps/
  web/        Astro frontend (the shortener UI)
  server/     Hono/oRPC API worker
packages/
  api/        oRPC routers, link domain logic, schemas
  db/         Drizzle schema and migrations
  env/        Typed environment access
  config/     Shared TypeScript config
  infra/      Alchemy / Cloudflare deployment
```

## Development

Run the Cloudflare-compatible stack through Alchemy from the repo root:

```bash
pnpm run dev            # web, API, D1 binding, and local Workers runtime
pnpm run dev:web        # frontend only, without Alchemy-managed bindings
pnpm run dev:server     # API Worker only, through Alchemy
```

To work on just the frontend without the full pipeline:

```bash
pnpm --filter web dev:bare   # http://127.0.0.1:4321
```

## Quality gates

Please make sure these pass before opening a pull request:

```bash
pnpm run check          # Biome lint and format checks
pnpm run check-types    # configured TypeScript checks
pnpm run build          # build packages and apps
```

## Code style

- Formatting and linting are handled by **Biome** - run `pnpm run check`; do not
  hand-format against it.
- Use `pnpm run check:write` when you want Biome to apply safe fixes.
- Keep changes focused. Match the conventions of the surrounding code.
- Prefer small, self-explanatory code over inline comments.

## Pull requests

1. Fork the repository and create a branch from `main`
   (e.g. `fix/qr-export`, `feat/custom-alias`).
2. Make your change, with the quality gates passing.
3. Write a clear PR description: what changed, why, and how you verified it.
4. Link any related issue.

## Reporting issues

Open an issue with:

- What you expected to happen and what actually happened.
- Steps to reproduce (a URL or input that triggers it helps).
- Your browser/OS, and any console errors.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE) that covers this project.
