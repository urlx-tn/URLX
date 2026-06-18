<p align="center">
  <a href="https://www.urlx.tn">
    <img src="./apps/web/src/assets/logo.png" alt="URLX" width="220" />
  </a>
</p>

<h1 align="center">URLX</h1>

<p align="center">
  Free and open-source tools for shortening, cleaning, and sharing URLs.
</p>

<p align="center">
  <a href="https://www.urlx.tn"><strong>Open URLX</strong></a>
  ·
  <a href="./API.md">API reference</a>
  ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6.svg?logo=typescript&logoColor=white" />
  <img alt="Astro" src="https://img.shields.io/badge/Astro-ff5d01.svg?logo=astro&logoColor=white" />
  <img alt="Hono" src="https://img.shields.io/badge/Hono-e36002.svg?logo=hono&logoColor=white" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare_Workers-f38020.svg?logo=cloudflare&logoColor=white" />
</p>

## What is URLX?

URLX is a no-account URL toolkit built for the web and deployed on Cloudflare.
It combines focused browser-based utilities with server-backed short links and
link-in-bio pages.

The project is MIT licensed and designed to be easy to use, self-host, extend,
and contribute to.

## Tools

| Tool | What it does | Processing |
| --- | --- | --- |
| [URL Shortener](https://www.urlx.tn/tools/url-shortener) | Creates compact redirect links and optional QR codes. | Cloudflare Worker + D1 |
| [URL Cleaner](https://www.urlx.tn/tools/url-cleaner) | Removes common tracking parameters from a URL. | In the browser |
| [QR Code Generator](https://www.urlx.tn/tools/qr-code-generator) | Exports a URL as SVG or PNG. | In the browser |
| [Link in Bio](https://www.urlx.tn/tools/link-in-bio) | Publishes one shareable page containing multiple links. | Cloudflare Worker + D1 |

No user account is required. Optional recent-URL history is stored locally in
the browser only when the user enables it.

## Architecture

URLX is a pnpm and Turborepo monorepo:

```text
Browser
  |
  +-- Astro web Worker ---------------- Browser-only URL tools
  |          |
  |          +-------------------------- oRPC client
  |
  +-- Hono API Worker ----------------- Validation and business logic
             |
             +-------------------------- Cloudflare D1
```

- **Web:** Astro, Tailwind CSS, browser-side QR generation
- **API:** Hono, oRPC, OpenAPI reference
- **Database:** Cloudflare D1 and Drizzle ORM
- **Infrastructure:** Alchemy TypeScript IaC
- **Tooling:** pnpm, Turborepo, TypeScript, Biome

Alchemy provisions the Astro Worker, API Worker, D1 database, runtime bindings,
and database migrations from `packages/infra/alchemy.run.ts`.

## Requirements

- Node.js 20 or newer
- pnpm 10.22.0 or newer
- A Cloudflare account for deployed environments

Enable pnpm through Corepack:

```bash
corepack enable
```

## Local development

Install dependencies and create the local environment file:

```bash
pnpm install
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Start the full Cloudflare-compatible stack:

```bash
pnpm run dev
```

Default local URLs:

- Web app and short links: `http://localhost:4321`
- API: `http://localhost:3000`
- OpenAPI reference: `http://localhost:3000/api-reference`

The full stack is required to test URL shortening and link-in-bio persistence
because those features use the D1 binding created by Alchemy.

### Run individual apps

```bash
pnpm run dev:web
pnpm run dev:server
```

`dev:web` starts Astro without Alchemy-managed Cloudflare bindings. Browser-only
tools work in this mode, but server-backed features require the full stack.

## Environment variables

The repository uses root environment files because Alchemy loads and distributes
the stage configuration for both Workers.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CORS_ORIGIN` | Yes | Browser origin accepted by the API Worker. |
| `SHORT_URL_BASE` | No | Public origin used to construct short URLs. |
| `PUBLIC_SERVER_URL` | Yes | Public oRPC API URL used by the Astro app. |
| `SKIP_ENV_VALIDATION` | No | Optional escape hatch for public environment validation. |

Stage mapping:

- `.env` — local development
- `.env.development` — deployed `dev` stage
- `.env.production` — deployed `prod` stage

Keep `CORS_ORIGIN`, `SHORT_URL_BASE`, and `PUBLIC_SERVER_URL` aligned for each
stage. Never commit secrets or populated environment files.

## Database

The API Worker accesses D1 through its `DB` runtime binding. Schema definitions
and SQL migrations live in `packages/db`.

Generate a migration after changing the schema:

```bash
pnpm run db:generate
```

Alchemy applies migrations during local development and deployment.

## Quality checks

Run all checks before opening a pull request:

```bash
pnpm run check
pnpm run check-types
pnpm run build
```

The repository does not currently have a dedicated automated test suite.
Changes to server-backed features should also be verified against the full
local stack.

## Deployment

Authenticate Alchemy with Cloudflare:

```bash
pnpm --filter @urlx/infra exec alchemy login cloudflare
```

Deploy a stage:

```bash
pnpm run deploy:dev
pnpm run deploy
```

`pnpm run deploy` targets the production stage. Destruction commands remove
Alchemy-managed resources and should only be used intentionally:

```bash
pnpm run destroy:dev
pnpm run destroy:prod
```

## Project structure

```text
urlx/
|-- apps/
|   |-- web/              # Astro frontend, URL tools, redirects, and public assets
|   `-- server/           # Hono Worker and API transport
|-- packages/
|   |-- api/              # oRPC routers and domain logic
|   |-- config/           # Shared TypeScript configuration
|   |-- db/               # Drizzle schema and D1 migrations
|   |-- env/              # Typed runtime environment helpers
|   `-- infra/            # Alchemy Cloudflare infrastructure
|-- API.md                # API behavior and error contracts
|-- CONTRIBUTING.md       # Contribution workflow
|-- turbo.json            # Turborepo task graph
`-- pnpm-workspace.yaml   # Workspace and dependency catalog
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm run dev` | Start the full local Workers stack. |
| `pnpm run dev:web` | Start only the Astro app. |
| `pnpm run dev:server` | Start only the API Worker through Alchemy. |
| `pnpm run build` | Build workspace apps and packages. |
| `pnpm run check` | Run Biome formatting and lint checks. |
| `pnpm run check:write` | Apply safe Biome fixes. |
| `pnpm run check-types` | Run configured TypeScript checks. |
| `pnpm run db:generate` | Generate Drizzle migrations. |
| `pnpm run deploy:dev` | Deploy the development stage. |
| `pnpm run deploy` | Deploy the production stage. |

## API

See [API.md](./API.md) for endpoint behavior, error contracts, redirect
semantics, and validation rules.

When the server is running, its generated OpenAPI reference is available at
`http://localhost:3000/api-reference`.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
for setup, quality gates, and the expected contribution workflow.

Useful contribution areas include:

- new focused URL utilities;
- accessibility and browser compatibility;
- automated tests and CI coverage;
- abuse prevention and moderation tooling;
- documentation and translations.

## License

URLX is available under the [MIT License](./LICENSE).
