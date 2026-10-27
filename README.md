<p align="center">
  <a href="https://www.urlx.tn">
    <img src="./apps/web/src/assets/logo.png" alt="URLX" width="220" />
  </a>
</p>

<h1 align="center">URLX</h1>

<p align="center">
  Free and open-source tools for shortening, cleaning, inspecting, converting, and sharing URLs.
</p>

<p align="center">
  <a href="https://www.urlx.tn"><strong>Open URLX</strong></a>
  · <a href="./API.md">API reference</a>
  · <a href="./CONTRIBUTING.md">Contributing</a>
</p>

## What is URLX?

URLX is a no-account URL toolkit built for the web. This branch packages the
Astro frontend, Hono API, conversion service, and isolated Playwright renderer
for Bun containers backed by PostgreSQL and Valkey. It combines focused
browser-based utilities with server-backed short links, link-in-bio pages,
metadata inspection, and webpage conversion.

| Tool | What it does | Processing |
| --- | --- | --- |
| [URL Shortener](https://www.urlx.tn/tools/url-shortener) | Creates compact redirect links and optional QR codes. | Hono API + PostgreSQL |
| [URL Cleaner](https://www.urlx.tn/tools/url-cleaner) | Removes common tracking parameters from a URL. | In the browser |
| [QR Code Generator](https://www.urlx.tn/tools/qr-code-generator) | Exports a URL as SVG or PNG. | In the browser |
| [URL Metadata Inspector](https://www.urlx.tn/tools/url-metadata) | Reads link-preview metadata from a public URL. | Hono API + controlled egress proxy |
| [URL to Markdown](https://www.urlx.tn/tools/url-to-markdown) | Converts a public webpage into Markdown. | Conversion service + isolated Playwright renderer |
| [URL to HTML](https://www.urlx.tn/tools/url-to-html) | Captures fully rendered HTML from a public webpage. | Conversion service + isolated Playwright renderer |
| [Link in Bio](https://www.urlx.tn/tools/link-in-bio) | Publishes one shareable page containing multiple links. | Hono API + PostgreSQL |

No user account is required. Optional recent-URL history is stored locally in
the browser only when the user enables it.

## Architecture

```text
Browser
  |
  +-- Astro on Bun ---------------------- browser UI, SSR, public routes
  |         +-- private API connection -- Hono API on Bun
  |         +-- /convert route ---------- Hono conversion service
  |
  +-- Hono API -------------------------- PostgreSQL + Valkey
  |
  +-- conversion service --------------- isolated Playwright renderer
              +-- controlled HTTP proxy - public page fetches
```

- **Web:** Astro standalone output served by Bun
- **API and conversion:** Hono services on Bun
- **Database:** PostgreSQL with Drizzle migrations
- **Shared limits:** Valkey
- **Conversion:** separate Playwright renderer; browser traffic can use only the Squid proxy
- **Ingress:** existing host ingress or the optional loopback-only Caddy profile
- **Tooling:** pnpm, Turborepo, TypeScript, Biome, Docker Compose

Cloudflare and D1 files remain as historical reference on this migration branch.
The Compose stack does not update or remove the existing Cloudflare deployment,
and it does not automatically copy production D1 data to PostgreSQL.

## Requirements

- Node.js 24 for dependency installation and builds
- Bun 1.4.4 for runtime containers
- pnpm 10.22.0
- Docker Engine and Docker Compose on a Linux deployment host

Enable pnpm through Corepack:

```bash
corepack enable
pnpm install
```

## Development

Copy the environment template and fill in the values needed for your setup:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

`pnpm dev` starts Astro for frontend-only work. `pnpm dev:api` and
`pnpm dev:conversion` start the Bun services individually. Server-backed tools
require PostgreSQL, Valkey, the renderer, and a verified egress policy. Follow
the [Docker Compose deployment guide](./docs/deployment/docker-compose.md) for
the complete stack and host setup.

Public Astro URLs are embedded in the browser bundle at build time. Rebuild the
web image after changing `PUBLIC_SERVER_URL` or
`PUBLIC_CONVERSION_SERVER_URL`.

## Database

The active database is PostgreSQL. Compose creates `urlx_app` for restricted
runtime DML and `urlx_migrator` for schema migrations. The API receives only the
app role URL; the one-shot migration service receives only the migrator URL.
PostgreSQL remains on a private Compose network with a persistent named volume.

Generate migrations after schema changes and run them with the migration URL:

```bash
pnpm db:generate
pnpm db:migrate
```

Historical D1 migrations are retained for reference and export. Importing data
from an existing deployment is a separate cutover task.

## Quality checks

```bash
pnpm run check
pnpm run check-types
pnpm run test
pnpm run build
```

GitHub Actions runs the repository checks for pull requests targeting `main`
and pushes to `main`.

## Deployment

Read [Docker Compose deployment](./docs/deployment/docker-compose.md) for image
builds, the fail-closed host egress gate, ingress requirements, PostgreSQL
backup/restore, and deployment limits. The base Compose file publishes no
ports. Existing production is unchanged until an operator performs and verifies
a separate migration and cutover.

## Project structure

```text
apps/
  web/                  Astro frontend
  server/               Hono API and conversion services
  conversion-renderer/  Isolated Playwright runtime
packages/
  api/                  oRPC routers and domain logic
  db/                   Drizzle schema and PostgreSQL migrations
  env/                  Runtime validation and environment helpers
  config/               Shared TypeScript configuration
  infra/                Historical Cloudflare infrastructure reference
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start Astro for frontend-only work. |
| `pnpm dev:api` | Start the Bun API service. |
| `pnpm dev:conversion` | Start the Bun conversion service. |
| `pnpm build` | Build workspace packages and apps. |
| `pnpm check` | Run Biome formatting and lint checks. |
| `pnpm check-types` | Run TypeScript and Astro checks. |
| `pnpm test` | Run the automated suite. |
| `pnpm db:generate` | Generate PostgreSQL migrations. |
| `pnpm db:migrate` | Apply PostgreSQL migrations using `MIGRATOR_DATABASE_URL`. |
| `pnpm containers:build` | Build runtime, migration, renderer, and egress images. |
| `pnpm egress:prepare` | Start the gated stack and install URLX-scoped host policy on Linux. |
| `pnpm containers:up` | Start the Compose stack. |
| `pnpm containers:down` | Stop the stack without removing named data volumes. |

## API

See [API.md](./API.md) for endpoint behavior, error contracts, redirect
semantics, and validation rules. The generated OpenAPI reference is available
under `/api-reference` when the API is running.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
for setup and quality gates.

## License

URLX is available under the [MIT License](./LICENSE).
