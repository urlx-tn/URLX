# Contributing to URLX

Thanks for your interest in improving URLX — a fast, private URL shortener.
Contributions of all sizes are welcome: bug reports, fixes, docs, and features.

## Maintainers

- **Youssef Dhibi** — https://youssef.tn
- **Chames Eddine Dhibi** — https://v1.chames.dhibi.tn

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
  web/        Astro 5 frontend (the shortener UI)
  server/     oRPC API worker
packages/
  api/        oRPC routers, link domain logic, schemas
  db/         Drizzle schema and migrations
  env/        Typed environment access
  config/     Shared TypeScript config
  infra/      Alchemy / Cloudflare deployment
```

## Development

Run everything through Turborepo from the repo root:

```bash
pnpm dev            # run all apps in dev
pnpm dev:web        # frontend only
pnpm dev:server     # API only
```

To work on just the frontend without the full pipeline:

```bash
pnpm -F web dev:bare   # http://127.0.0.1:4321
```

## Quality gates

Please make sure these pass before opening a pull request:

```bash
pnpm check          # Biome lint + format (auto-fixes)
pnpm check-types    # TypeScript across the workspace
pnpm build          # build all packages and apps
```

## Code style

- Formatting and linting are handled by **Biome** — run `pnpm check`; do not
  hand-format against it.
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
