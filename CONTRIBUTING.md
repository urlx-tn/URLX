# Contributing to URLX

Thanks for your interest in improving URLX. Contributions include bug reports,
fixes, documentation, and new tools.

## Requirements

- Node.js 24
- Bun 1.4.4 for Bun runtime development
- pnpm 10.22.0 (pinned in `packageManager`)
- Docker Compose and Linux nftables only when validating the full container
  network policy

```bash
corepack enable
pnpm install
```

## Project layout

```text
apps/
  web/                  Astro frontend and browser tools
  server/               Hono API and conversion services
  conversion-renderer/  isolated Playwright renderer
packages/
  api/                  oRPC routers and business logic
  db/                   Drizzle schema and migrations
  env/                  runtime validation
  config/               shared TypeScript configuration
  infra/                historical Cloudflare infrastructure reference
```

## Development

`pnpm dev` starts Astro for frontend-only work. `pnpm dev:api` and
`pnpm dev:conversion` start the Bun services individually. Server-backed
features need PostgreSQL and Valkey. Full conversion testing also needs the
isolated renderer and the verified host egress setup described in
[Docker Compose deployment](./docs/deployment/docker-compose.md).

## Quality gates

```bash
pnpm run check          # Biome lint and format checks
pnpm run check-types    # TypeScript and Astro checks
pnpm run test           # automated unit and integration tests
pnpm run build          # workspace build
```

When changing container files, validate Compose interpolation and build the
affected runtime image. Host firewall and egress behavior must be tested on the
Linux deployment test host; Docker image compilation alone does not prove the
network policy.

## Tests

- Add or update tests when behavior changes.
- Keep tests independent of deployed production resources.
- PostgreSQL integration tests must use explicit test-only URLs and isolated
  databases; do not point fixtures at a production or shared database.
- Conversion security changes need tests for redirect destinations, IP ranges,
  proxy bypass, and browser network isolation.

## Code style

Biome handles formatting and linting. Run `pnpm run check` before submitting.
Use `pnpm run check:write` for safe formatter fixes, and keep changes focused.

## Pull requests

1. Create a branch from the intended base.
2. Make a focused change and describe why it is needed.
3. Include the checks you ran and any environment limitation.
4. Link related issues and update relevant deployment documentation.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
