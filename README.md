<p align="center">
  <img src="./apps/web/src/assets/logo.png" alt="URLX" width="220" />
</p>

<h1 align="center">URLX</h1>

<p align="center">
  A Cloudflare-first URL shortener with a polished Astro UI, QR code exports, and a Hono/oRPC API backed by Cloudflare D1.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178c6.svg" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10.22.0-f69220.svg" />
  <img alt="Turborepo" src="https://img.shields.io/badge/Turborepo-2.9-black.svg" />
  <img alt="Astro" src="https://img.shields.io/badge/Astro-6-ff5d01.svg" />
  <img alt="Hono" src="https://img.shields.io/badge/Hono-4.8-e36002.svg" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-f38020.svg" />
</p>

## Overview

URLX is a pnpm and Turborepo monorepo for shortening links on Cloudflare Workers. The frontend is an Astro server-rendered app, the backend is a Hono Worker exposing oRPC and redirect routes, and persistence uses Cloudflare D1 through Drizzle ORM.

Infrastructure is managed with [Alchemy](https://alchemy.run/). The stack in `packages/infra/alchemy.run.ts` provisions:

- an Astro Worker for the web app
- a Hono Worker for the API and redirect service
- a Cloudflare D1 database bound to the API Worker as `DB`
- environment bindings for `CORS_ORIGIN`, `SHORT_URL_BASE`, and `PUBLIC_SERVER_URL`

## Stack

- **Runtime:** Cloudflare Workers
- **Web:** Astro, Tailwind CSS, QR code generation
- **API:** Hono, oRPC, OpenAPI reference route
- **Database:** Cloudflare D1, Drizzle ORM, SQL migrations
- **Infrastructure:** Alchemy TypeScript IaC
- **Tooling:** pnpm, Turborepo, TypeScript, Biome

## Requirements

- Node.js 20 or newer
- pnpm 10.22.0 or newer
- A Cloudflare account for deployed environments
- Alchemy Cloudflare authentication for `deploy`, `deploy:dev`, `deploy:prod`, and `destroy`

Enable pnpm through Corepack:

```bash
corepack enable
```

## Getting Started

Install dependencies:

```bash
pnpm install
```

Create the local environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Start the full Cloudflare-compatible development stack:

```bash
pnpm run dev
```

Alchemy starts the local Workers stack and prints the web and server URLs. By default, the app uses:

- Web and short-link redirects: `http://localhost:4321`
- API: `http://localhost:3000`
- API reference: `http://localhost:3000/api-reference`

## Environment

The root `.env.example` contains the local values needed by the stack and local tooling:

| Variable | Required | Used by | Purpose |
| --- | --- | --- | --- |
| `CORS_ORIGIN` | Yes | Server Worker | Allowed browser origin for API requests. |
| `SHORT_URL_BASE` | No | Server Worker | Public origin used when returning shortened URLs. Defaults to `http://localhost:4321`. |
| `PUBLIC_SERVER_URL` | Yes | Web app | Public oRPC server URL used by the browser client. |
| `SKIP_ENV_VALIDATION` | No | Env helpers | Optional escape hatch for public env validation. |

Deployment scripts select an Alchemy stage and the infra stack loads the matching root environment file:

- `--stage dev` loads `.env.development`
- `--stage prod` loads `.env.production`

Keep `CORS_ORIGIN`, `SHORT_URL_BASE`, and `PUBLIC_SERVER_URL` aligned for each stage.

Environment files are root-only by design:

- `.env` for local development
- `.env.development` for the deployed `dev` stage
- `.env.production` for the deployed `prod` stage

Do not create app-level or package-level `.env` files for normal workflows. The web app and infra tooling are configured to read from the repo root so there is a single source of truth.

## Development

Run the full stack:

```bash
pnpm run dev
```

Run only the Astro frontend without Alchemy-managed Cloudflare bindings:

```bash
pnpm run dev:web
```

Run only the server app through Alchemy:

```bash
pnpm run dev:server
```

Use the full stack for testing URL shortening end to end, because the server depends on the Cloudflare D1 `DB` binding created by Alchemy.

## Database

D1 access is runtime-bound through `DB`; there is no application-level database URL for the Worker. Schema and migrations live in `packages/db`.

Generate Drizzle migrations after changing the schema:

```bash
pnpm run db:generate
```

Alchemy applies migrations from `packages/db/src/migrations` during local development and deployment.

## Testing and Quality

This repository does not currently include a dedicated unit test runner. Use these quality gates before opening a pull request or deploying:

```bash
pnpm run check
pnpm run check-types
pnpm run build
```

What each command covers:

- `pnpm run check` runs Biome formatting and lint checks.
- `pnpm run check-types` runs TypeScript checks for packages that define the task.
- `pnpm run build` builds the deployable Astro and Hono Worker outputs through Turborepo.

For an end-to-end smoke test, run `pnpm run dev`, open the web URL, shorten a public `https://` URL, copy the generated short URL, and confirm the redirect route returns the destination.

## Deployment

URLX deploys to Cloudflare through Alchemy, not a hand-written Wrangler config. The root scripts pass `--stage dev` or `--stage prod`; `packages/infra/alchemy.run.ts` maps those stages to `.env.development` and `.env.production`.

Authenticate Alchemy with Cloudflare once:

```bash
pnpm --filter @urlx/infra exec alchemy login cloudflare
```

You can also authenticate during the first Alchemy deployment prompt. Alchemy stores provider credentials in its local profile.

Deploy production:

```bash
pnpm run build
pnpm run deploy
```

Deploy the development stage:

```bash
pnpm run build
pnpm run deploy:dev
```

Destroy managed Cloudflare resources only when you intentionally want to remove a stage:

```bash
pnpm run destroy:dev
pnpm run destroy:prod
```

## Project Structure

```text
urlx/
|-- apps/
|   |-- web/              # Astro frontend and public assets
|   `-- server/           # Hono Worker entrypoint and redirect routes
|-- packages/
|   |-- api/              # oRPC routers, schemas, and link business logic
|   |-- config/           # Shared TypeScript configuration
|   |-- db/               # Drizzle schema and D1 migrations
|   |-- env/              # Typed runtime environment helpers
|   `-- infra/            # Alchemy Cloudflare infrastructure stack
|-- API.md                # Backend API behavior and error contracts
|-- CONTRIBUTING.md       # Contribution workflow
|-- turbo.json            # Turborepo task graph
`-- pnpm-workspace.yaml   # Workspace and dependency catalog
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm run dev` | Start the Alchemy local development stack. |
| `pnpm run dev:web` | Start the Astro frontend only. |
| `pnpm run dev:server` | Start the server Worker through Alchemy. |
| `pnpm run build` | Build workspace packages and apps. |
| `pnpm run check` | Run Biome checks. |
| `pnpm run check:write` | Run Biome and apply safe fixes. |
| `pnpm run check-types` | Run configured TypeScript checks. |
| `pnpm run db:generate` | Generate Drizzle migration files. |
| `pnpm run deploy:dev` | Deploy the Cloudflare development stage through Alchemy. |
| `pnpm run deploy` | Deploy the Cloudflare production stage through Alchemy. |
| `pnpm run deploy:prod` | Alias for production deployment. |
| `pnpm run destroy:dev` | Destroy the Alchemy-managed development stage. |
| `pnpm run destroy:prod` | Destroy the Alchemy-managed production stage. |

## API Reference

See [API.md](./API.md) for endpoint behavior, error codes, redirect semantics, and URL validation rules.

When the server is running, the generated OpenAPI reference is available at:

```text
http://localhost:3000/api-reference
```

## License

URLX is released under the [MIT License](./LICENSE).
