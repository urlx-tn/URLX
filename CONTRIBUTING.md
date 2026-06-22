# Contributing to URLX

Thanks for your interest in improving URLX, a free and open-source collection
of URL tools. Contributions of all sizes are welcome: bug reports, fixes,
documentation, and new tools.

## Maintainers

- **Youssef Dhibi** - https://youssef.tn
- **Chames Eddine Dhibi** - https://v1.chames.dhibi.tn

## Prerequisites

- **Node.js** 22 or newer
- **pnpm** 10.22 or newer (this repo pins `pnpm@10.22.0` via `packageManager`)

```bash
corepack enable
pnpm install
```

## Project layout

This is a pnpm + Turborepo monorepo.

```text
apps/
  web/        Astro frontend and browser-based URL tools
  server/     Hono/oRPC API worker
packages/
  api/        oRPC routers, URL/link-page/metadata/conversion domain logic, schemas
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

URL-to-Markdown and URL-to-HTML use Cloudflare Browser Run Quick Actions. The
binding is remote and cannot be fully exercised by deterministic unit tests;
verify real conversion flows against a Cloudflare development deployment.

To work on just the frontend without the full pipeline:

```bash
pnpm --filter web dev:bare   # http://127.0.0.1:4321
```

## Quality gates

Please make sure these pass before opening a pull request:

```bash
pnpm run check          # Biome lint and format checks
pnpm run check-types    # TypeScript and Astro checks
pnpm run test           # automated unit tests
pnpm run build          # build packages and apps
```

GitHub Actions runs these gates on pull requests targeting `main` and pushes to
`main`. The pull request cannot be considered ready while the `Quality` check is
failing.

## Tests

- Add or update unit tests when behavior changes.
- Keep tests deterministic and independent of deployed Cloudflare resources.
- Verify D1-backed and Worker-specific behavior against `pnpm run dev` when it
  cannot be covered by a unit test.

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

GitHub automatically fills new pull requests with the repository template.
Complete the applicable verification and checklist items; remove sections that
do not apply.

## Reporting issues

Open an issue with:

- What you expected to happen and what actually happened.
- Steps to reproduce (a URL or input that triggers it helps).
- Your browser/OS, and any console errors.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE) that covers this project.
