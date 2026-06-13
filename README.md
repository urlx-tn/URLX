# urlx

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines Astro, Hono, oRPC, and more.

urlx is a Cloudflare-first URL shortener with a web UI, QR code generation, and a Hono/oRPC API backed by Cloudflare D1.

## Features

- **TypeScript** - For type safety and improved developer experience
- **Astro** - The web framework for content-driven websites
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Hono** - Lightweight, performant server framework
- **oRPC** - End-to-end type-safe APIs with OpenAPI integration
- **Cloudflare Workers** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **Cloudflare D1** - Database engine
- **Biome** - Linting and formatting
- **Turborepo** - Optimized monorepo build system

## Getting Started

Install dependencies:

```bash
pnpm install
```

## Database Setup

This project uses Cloudflare D1 (SQLite) with Drizzle ORM.

Runtime database access uses the Cloudflare `DB` binding from `packages/infra/alchemy.run.ts`. If a local `DATABASE_URL` is present, it is only for database tooling.

Alchemy provisions the D1 database and applies migrations during `dev` and `deploy`.

Generate migration files:

```bash
pnpm run db:generate
```

## Environment

Create a local `.env` file before running the full stack:

```bash
CORS_ORIGIN=http://localhost:4321
SHORT_URL_BASE=http://localhost:3000
```

- `CORS_ORIGIN` is required by the server Worker.
- `SHORT_URL_BASE` is optional and defaults to `http://localhost:3000`.

## Development

Run the development server:

```bash
pnpm run dev
```

Open [http://localhost:4321](http://localhost:4321) in your browser to see the web application.
The API is running at [http://localhost:3000](http://localhost:3000).

## Deployment

### Cloudflare via Alchemy

This project deploys the Astro web app, Hono server Worker, and D1 database through Alchemy.

Log in to Cloudflare:

```bash
pnpm dlx wrangler login
```

Set production environment values:

```bash
CORS_ORIGIN=https://your-web-domain.com
SHORT_URL_BASE=https://your-short-domain.com
```

Deploy:

```bash
pnpm run build
pnpm run deploy
```

Destroy the Cloudflare resources:

```bash
pnpm run destroy
```

For more details, see the guide on [Deploying to Cloudflare with Alchemy](https://www.better-t-stack.dev/docs/guides/cloudflare-alchemy).

## Git Hooks and Formatting

- Run checks: `pnpm run check`
- Format and apply safe fixes: `pnpm run check:write`

## Project Structure

```text
urlx/
|-- apps/
|   |-- web/       # Frontend application (Astro)
|   `-- server/    # Backend API (Hono, oRPC)
`-- packages/
    |-- api/       # API layer and business logic
    |-- db/        # Database schema and queries
    |-- env/       # Runtime environment helpers
    `-- infra/     # Cloudflare/Alchemy infrastructure
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run dev:server`: Start only the server
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm run db:generate`: Generate Drizzle migration files
- `pnpm run deploy`: Deploy to Cloudflare through Alchemy
- `pnpm run destroy`: Destroy Cloudflare resources managed by Alchemy
- `pnpm run check`: Run Biome checks
- `pnpm run check:write`: Run Biome checks and apply safe fixes
