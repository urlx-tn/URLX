# URLX V1 Backend Cloudflare Technical Plan

## Purpose

This plan covers only the backend work for URLX v1.

The backend is responsible for:

- Accepting shorten requests from the Astro web app.
- Validating and normalizing destination URLs.
- Creating or reusing short links.
- Redirecting short codes to destination URLs.
- Persisting link data in Cloudflare D1 through Drizzle.
- Running on Cloudflare Workers.
- Being deployed through the existing Alchemy infrastructure package.

This plan does not cover frontend layout, visual design, QR rendering UI, or copy polish except where the backend response contract affects the UI.

## Active Stack

```text
Runtime: Cloudflare Workers
HTTP framework: Hono
API transport: oRPC over /rpc
Database: Cloudflare D1 SQLite
ORM: Drizzle
Infrastructure: Alchemy
Package manager: pnpm
Monorepo: Turborepo
Validation: Zod
Linting/formatting: Biome
```

Do not add:

```text
Express
Next.js API routes
Node-only server assumptions
REST shorten endpoint unless intentionally replacing oRPC
Separate database client outside Drizzle/D1
Authentication
Analytics
Admin APIs
Custom aliases
Custom domains
Payments
```

## Existing Repo Ownership

Keep the generated Better-T-Stack package boundaries.

```text
apps/server
  Owns the Hono Cloudflare Worker.
  Mounts oRPC at /rpc.
  Mounts OpenAPI reference at /api-reference.
  Owns redirect HTTP route for /:shortCode.
  Owns server middleware such as CORS, security headers, error handling, and request logging.

packages/api
  Owns the oRPC router.
  Owns link business logic.
  Owns request/response schemas.
  Owns URL validation, normalization, hashing, short-code generation, and link errors.

packages/db
  Owns Drizzle schema.
  Owns migrations.
  Owns createDb() and shared database exports.

packages/env
  Owns Cloudflare binding access and env typing.

packages/infra
  Owns Cloudflare resources through Alchemy.
```

Do not move Drizzle schema or migrations into `apps/server`.

Do not create a separate `packages/contracts` package for v1. The oRPC router types in `packages/api` are the contract.

## Target Backend Files

Recommended final structure:

```text
apps/server/
  src/
    index.ts
    routes/
      redirect.route.ts
    lib/
      security-headers.ts
      request-ip.ts
      rate-limit.ts
      response.ts

packages/api/
  src/
    index.ts
    context.ts
    routers/
      index.ts
      links.router.ts
    modules/
      links/
        link.service.ts
        link.repository.ts
        link.schema.ts
        link.types.ts
        link.errors.ts
    lib/
      validate-url.ts
      normalize-url.ts
      hash-url.ts
      generate-code.ts
      validate-short-code.ts

packages/db/
  src/
    index.ts
    schema/
      index.ts
    migrations/
```

The exact file count can be smaller if the implementation remains readable, but avoid a large `utils.ts` or a large `apps/server/src/index.ts`.

## Cloudflare Deployment Shape

Use the existing Alchemy file:

```text
packages/infra/alchemy.run.ts
```

Required Cloudflare resources:

```text
Cloudflare D1 database
Cloudflare Worker for apps/server
Cloudflare Astro Worker for apps/web
```

Required server Worker bindings:

```text
DB
CORS_ORIGIN
SHORT_URL_BASE
```

Required web Worker binding:

```text
PUBLIC_SERVER_URL
```

Recommended production domain layout:

```text
Web app:     https://urlx.com
API server:  https://api.urlx.com/rpc
Short links: https://x.urlx.com/:shortCode
```

Alternative production domain layout:

```text
Web app:     https://urlx.com
API server:  https://urlx.com/rpc
Short links: https://urlx.com/:shortCode
```

If the API and web app share one apex domain, Cloudflare routes must explicitly send `/rpc`, `/api-reference`, and `/:shortCode` to the server Worker while the rest of the web app routes to the Astro Worker. Do not assume two Workers automatically share routing.

## Database Model

Table: `links`

Recommended fields:

```text
id              text primary key
short_code      text not null
original_url    text not null
normalized_url  text not null
url_hash        text not null
created_at      integer not null
updated_at      integer not null
disabled_at     integer nullable
```

Required constraints:

```text
unique(short_code)
unique(url_hash)
```

Required indexes:

```text
index(created_at)
```

The two hot lookup paths must be indexed:

```text
url_hash -> existing link
short_code -> original URL
```

`unique(url_hash)` is required for race-condition safety. The service should check first, but the database constraint is the final source of truth.

## Link Creation Behavior

Duplicate URL rule:

If two requests normalize to the same URL, return the existing short link.

Flow:

```text
Receive URL
Validate request schema
Validate URL string
Normalize URL
Hash normalized URL
Look up url_hash
If found, return existing short code
If not found, generate short code
Insert link
If short_code collision, retry with a new code
If url_hash conflict, read existing row and return it
Return shortCode and shortUrl
```

This flow prevents duplicate rows for the same normalized destination and handles concurrent requests.

## oRPC API Contract

Expose the shorten operation as an oRPC procedure:

```text
links.shorten
Transport: POST ${PUBLIC_SERVER_URL}/rpc
```

Request:

```json
{
  "url": "https://example.com/page"
}
```

Success response:

```json
{
  "shortCode": "a8X2kPq",
  "shortUrl": "https://x.urlx.com/a8X2kPq"
}
```

Expected frontend call:

```text
orpc.links.shorten({ url })
```

Do not add:

```text
POST /api/links/shorten
```

unless the project intentionally switches away from the current oRPC client.

## Redirect Route

Expose redirect through Hono:

```text
GET /:shortCode
```

Behavior:

```text
Validate shortCode format
Look up link by short_code
If not found, return 404
If disabled_at is set, return 404 or 410
Redirect to original_url or normalized_url
```

Recommended redirect status:

```text
302 Found
```

Avoid `301 Permanent Redirect` for v1 because browsers and intermediaries can cache it aggressively.

Recommended response headers for redirects:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer-when-downgrade
X-Content-Type-Options: nosniff
```

Do not add analytics, click tracking, or logging tables in v1.

## URL Validation Rules

Accept only:

```text
http://
https://
```

Reject:

```text
empty strings
invalid URLs
javascript:
data:
file:
ftp:
mailto:
localhost
loopback hostnames
private IP addresses
link-local IP addresses
extremely long URLs
```

Recommended maximum length:

```text
2048 characters
```

Do not fetch the submitted URL during shortening. Server-side fetching creates SSRF risk and is not needed for v1.

Private address rejection should cover:

```text
127.0.0.0/8
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
::1
fc00::/7
fe80::/10
```

If IPv6 validation is too much for the first pass, explicitly document the gap and block obvious IPv6 localhost/private forms before production.

## URL Normalization Rules

Use safe normalization only.

Do:

- Trim leading and trailing spaces.
- Lowercase protocol.
- Lowercase hostname.
- Remove default ports.
- Preserve path.
- Preserve query string.
- Preserve hash if submitted.
- Let the platform URL parser normalize obvious URL syntax.

Do not:

- Remove query parameters.
- Reorder query parameters.
- Remove tracking parameters.
- Treat `www.example.com` and `example.com` as the same.
- Remove arbitrary trailing path segments.
- Decode and re-encode in a way that changes meaning.

Examples that can normalize together:

```text
HTTPS://EXAMPLE.COM
https://example.com/
```

Examples that must remain different:

```text
https://example.com/product?id=1
https://example.com/product?id=2
```

## Hashing

Hash the normalized URL, not the raw submitted URL.

Recommended:

```text
SHA-256
Hex or base64url encoded string
Generated with Web Crypto
Stored in url_hash
```

The hash is for duplicate detection, not security secrecy.

## Short Code Generation

Recommended:

```text
Alphabet: Base62
Length: 7 or 8 characters
Randomness: Web Crypto
Constraint: unique(short_code)
Retry: only on collision
```

Avoid sequential codes:

```text
1
2
3
```

Collision handling:

```text
Try insert with generated short_code
If short_code unique conflict, generate another code
Retry a small bounded number of times
If retries fail, return a production-safe server error
```

## Error Model

Use stable error codes that the frontend can map to friendly UI copy.

Recommended codes:

```text
EMPTY_URL
INVALID_URL
UNSUPPORTED_PROTOCOL
LOCAL_URL_NOT_ALLOWED
PRIVATE_IP_NOT_ALLOWED
URL_TOO_LONG
RATE_LIMITED
SHORT_CODE_NOT_FOUND
SERVER_ERROR
```

Frontend-safe error shape:

```json
{
  "code": "INVALID_URL",
  "message": "Please enter a valid http or https URL."
}
```

Never expose:

```text
stack traces
database errors
Cloudflare binding details
SQL text
internal package paths
```

## Security Headers

Add security headers in Hono middleware for server responses.

Recommended baseline:

```text
Content-Security-Policy
Strict-Transport-Security
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

CORS:

- Allow only the configured `CORS_ORIGIN`.
- Allow `GET`, `POST`, and `OPTIONS`.
- Do not use wildcard origins in production.

## Rate Limiting

Rate limit the shorten operation:

```text
links.shorten over POST /rpc
```

Initial threshold:

```text
20 requests per minute per IP
```

Do not aggressively rate limit redirects in v1.

Preferred production approach:

```text
Cloudflare rate limiting rule in front of the server Worker
```

If application-level rate limiting is required:

- Add the required Cloudflare storage or binding in `packages/infra/alchemy.run.ts`.
- Type the binding through `packages/env`.
- Keep the limiter small and isolated in `apps/server/src/lib/rate-limit.ts`.
- Do not pretend a `RATE_LIMIT` binding exists before it is provisioned.

## Cloudflare Environment Work

Update `packages/infra/alchemy.run.ts` so the server Worker has:

```text
DB
CORS_ORIGIN
SHORT_URL_BASE
```

Update env typing so application code can safely read:

```text
env.DB
env.CORS_ORIGIN
env.SHORT_URL_BASE
```

The web Worker should continue receiving:

```text
PUBLIC_SERVER_URL
```

`SHORT_URL_BASE` must be the origin used in copied links and QR codes:

```text
https://x.urlx.com
```

No trailing slash is preferred.

## Testing Plan

Unit tests:

- URL validation accepts http and https.
- URL validation rejects unsupported schemes.
- URL validation rejects localhost.
- URL validation rejects private IPv4.
- URL validation handles obvious private IPv6 forms.
- URL validation rejects URLs over 2048 characters.
- URL normalization lowercases protocol and hostname.
- URL normalization removes default ports.
- URL normalization preserves path, query, and hash.
- URL hashing is stable.
- Short code generation returns valid Base62 codes.
- Short code validation rejects malformed codes.
- Error mapping returns frontend-safe codes.

Integration tests:

- Shorten a valid URL.
- Return the same short URL for duplicate normalized URL.
- Handle duplicate insert race by returning the existing row.
- Retry short_code collision.
- Redirect a known short code with 302.
- Return 404 for an unknown short code.
- Return 404 or 410 for disabled links.
- Reject invalid shorten requests before database work.
- Apply CORS only for allowed origins.

Cloudflare-local tests:

- Confirm D1 binding works in local Alchemy dev.
- Confirm `/rpc` is reachable from web origin.
- Confirm short-link domain route reaches the server Worker.

Testing tools:

- Use normal unit/integration test tooling once added.
- Use Hono `app.request()` for tests that do not require Cloudflare bindings.
- Use a Workers-aware fetch tool or Alchemy dev flow for D1-bound integration tests.

## Backend Implementation Order

1. Confirm current repo structure and scripts.
2. Add Drizzle `links` schema in `packages/db/src/schema`.
3. Generate migration with `pnpm db:generate`.
4. Add link schemas and types in `packages/api/src/modules/links`.
5. Implement `validate-url.ts`.
6. Implement `normalize-url.ts`.
7. Implement `hash-url.ts`.
8. Implement `generate-code.ts`.
9. Implement `validate-short-code.ts`.
10. Implement `link.repository.ts`.
11. Implement `link.service.ts`.
12. Implement `links.router.ts` with `links.shorten`.
13. Register `links` in `packages/api/src/routers/index.ts`.
14. Add `SHORT_URL_BASE` binding support.
15. Add Hono redirect route in `apps/server/src/routes/redirect.route.ts`.
16. Mount redirect route in `apps/server/src/index.ts` after oRPC handling.
17. Add production-safe error handling.
18. Add security headers.
19. Add rate limiting or document Cloudflare rule setup.
20. Run quality gates.

## Backend Quality Gates

Before considering backend complete:

```bash
pnpm check
pnpm check-types
pnpm build
pnpm db:generate
```

Add and run backend tests once the test runner is configured:

```bash
pnpm test
```

Manual verification:

- Shorten `https://example.com`.
- Shorten the same URL again and confirm the same short code.
- Open the short URL and confirm 302 redirect.
- Submit invalid schemes and confirm safe errors.
- Confirm production-like `SHORT_URL_BASE` appears in responses.
- Confirm Cloudflare preview routes send `/rpc` and `/:shortCode` to the server Worker.

## Backend Non-Goals

Do not build these in v1:

- Accounts
- Sessions
- Dashboards
- Analytics tables
- Click tracking
- Custom aliases
- Custom domains
- Admin moderation
- Abuse report workflow
- QR storage
- URL preview fetching
- Destination health checks
- Browser extension endpoints
- Mobile-specific APIs

The backend should be small, correct, boring in the best way, and ready to extend later.
