# URLX V1 Web-Only Technical Plan

## Important Scope Correction

URLX v1 is a **web app only**.

The first version will not include:

- Expo
- React Native
- Native mobile app
- Browser extension
- WXT extension app
- Mobile-specific styling or native runtime code

If the project generator created Expo, native, or extension-related folders by accident, they should be removed or ignored before implementation starts.

The project should focus only on:

- Astro web frontend
- Hono backend
- Cloudflare Workers runtime
- oRPC API
- Drizzle ORM
- Cloudflare D1 SQLite database
- Cloudflare deployment through the existing Alchemy infrastructure package

## Corrected Product Goal

URLX v1 is a public web-based URL shortener.

The app should be fast, minimal, secure, and professional. It should be designed as a long-term foundation, not as a temporary demo.

The user should be able to shorten a URL, copy the generated short link, open the short link and get redirected, and generate a QR code for the short link from the same web page.

## Corrected MVP Scope

### Included in v1

The public web user can:

1. Paste a long URL.
2. Click `Shorten URL`.
3. Receive one generated short URL.
4. Copy the generated short URL.
5. Open the short URL and be redirected to the original URL.
6. Generate a QR code for the generated short URL on the same page.

### Not included in v1

- No login
- No accounts
- No dashboard
- No analytics
- No custom domains
- No custom aliases
- No payments
- No admin panel
- No mobile app
- No Expo app
- No browser extension
- No WXT extension
- No native styling system
- No unnecessary generated demo examples

## Corrected Stack

Recommended active stack for v1:

```text
Frontend: Astro
Backend: Hono
Runtime: Cloudflare Workers
API: oRPC
Database: Cloudflare D1
ORM: Drizzle
Package manager: pnpm
Monorepo: Turborepo
Linting/formatting: Biome
Deployment: Cloudflare
Infrastructure: Alchemy
```

Avoid building against:

```text
Expo
React Native
native-unistyles
WXT
mobile packages
extension packages
```

These can be reintroduced later only if the product roadmap truly needs them.

## Recommended Clean Project Direction

If the project has not started yet, the cleanest solution is to regenerate the project without the accidental mobile and extension options.

Use a web-only setup.

Example direction:

```bash
pnpm create better-t-stack@latest urlx \
  --frontend astro \
  --backend hono \
  --runtime workers \
  --api orpc \
  --auth none \
  --payments none \
  --database sqlite \
  --orm drizzle \
  --db-setup d1 \
  --package-manager pnpm \
  --git \
  --web-deploy cloudflare \
  --server-deploy cloudflare \
  --install \
  --addons biome skills turborepo \
  --examples none
```

If the generator requires a slightly different syntax, the principle stays the same:

```text
Keep Astro web.
Keep Hono server.
Remove Expo/native.
Remove WXT extension.
```

## If the Project Was Already Generated

This project has already been generated with the correct web-only Better-T-Stack options:

```text
Astro
Hono
Cloudflare Workers
oRPC
Drizzle
Cloudflare D1
Alchemy
Biome
Turborepo
```

Do not regenerate the project unless the generated structure becomes unrecoverable.

If the project already contains accidental mobile or extension folders, clean it before implementing the app.

Remove or ignore folders such as:

```text
apps/native/
apps/mobile/
apps/expo/
apps/extension/
apps/wxt/
```

Also remove related dependencies if they are not used:

```text
expo
react-native
native-unistyles
wxt
browser-extension-related packages
```

Then check:

```bash
pnpm install
pnpm check
pnpm check-types
pnpm build
```

The goal is to make sure the repository only contains code that belongs to the web app and server.

## Target Monorepo Structure

```text
apps/
  web/
    src/
      pages/
        index.astro
      components/
        url-shortener-form.astro
        result-panel.astro
        qr-code-panel.astro
      styles/
        tokens.css
        global.css
      lib/
        orpc.ts
        copy-to-clipboard.ts
        qr-code.ts

  server/
    src/
      index.ts

      routes/
        redirect.route.ts

      lib/
        security-headers.ts
        rate-limit.ts
        response.ts

packages/
  api/
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

  db/
    src/
      index.ts
      schema/
        index.ts
        migrations/

  env/
    src/
      server.ts
      web.ts
      cloudflare-local.ts

  config/

  infra/
    alchemy.run.ts
```

Keep the project focused. Do not keep extra apps just because they were generated.

Important package boundaries:

- `apps/web` owns the Astro UI and calls the oRPC client.
- `apps/server` owns the Hono Cloudflare Worker, middleware, oRPC mounting, OpenAPI reference mounting, and redirect route.
- `packages/api` owns the oRPC router, link service, validation, normalization, hashing, and error mapping.
- `packages/db` owns Drizzle schema, migrations, and database helpers.
- `packages/env` owns Cloudflare binding access and public web env validation.
- `packages/infra` owns Cloudflare resources through Alchemy.

## Architecture Principles

### 1. Thin routes

Hono routes in `apps/server` should only:

1. Receive the request.
2. Apply HTTP middleware.
3. Delegate to oRPC or the redirect service.
4. Return the response.

Routes should not contain database logic or business rules.

### 2. oRPC router for app API

The shorten action should be exposed as an oRPC procedure from `packages/api`.

The current web client already talks to:

```text
${PUBLIC_SERVER_URL}/rpc
```

Do not add a separate REST shorten endpoint unless there is a specific product reason.

### 3. Service layer for business logic

The link service should handle:

- URL validation
- URL normalization
- URL hashing
- Duplicate URL behavior
- Short code generation
- Collision retry
- Error mapping

### 4. Repository layer for database access

The repository should handle:

- Finding a link by URL hash
- Finding a link by short code
- Creating a new link
- Handling unique constraint conflicts

The repository can live in `packages/api/modules/links` if it is link-specific, but Drizzle schema and shared database creation should stay in `packages/db`.

### 5. Small files only

Avoid large files. Split by responsibility.

Good file examples:

```text
validate-url.ts
normalize-url.ts
generate-code.ts
link.service.ts
link.repository.ts
redirect.route.ts
```

Avoid:

```text
utils.ts with everything inside
index.ts with all routes and logic
one giant component for the full page
```

## Database Model

Table: `links`

```text
id
short_code
original_url
normalized_url
url_hash
created_at
updated_at
disabled_at
```

Required constraints and indexes:

```text
unique(short_code)
unique(url_hash)
index(created_at)
```

The most important one is:

```text
unique(url_hash)
```

This prevents duplicate rows for the same normalized URL, even if two users submit the same URL at the same time.

## Duplicate URL Rule

If the same normalized original URL already exists, return the existing short URL.

Flow:

```text
User submits URL
↓
Validate URL
↓
Normalize URL
↓
Hash normalized URL
↓
Search by url_hash
↓
If found: return existing short URL
↓
If not found: generate new short code and insert
```

The database unique constraint must be the final protection against duplicates.

Application logic alone is not enough.

## API Design

### Shorten procedure

```text
oRPC procedure: links.shorten
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

Error response:

```json
{
  "code": "INVALID_URL",
  "message": "Please enter a valid http or https URL."
}
```

### Redirect endpoint

```text
GET /:shortCode
```

The redirect endpoint should be a normal Hono route, not an oRPC procedure.

The redirect endpoint must run on the public short-link domain, not only on an internal API URL.

Recommended production domain layout:

```text
Web app:      https://urlx.com
Server API:   https://api.urlx.com/rpc
Short links:  https://x.urlx.com/:shortCode
```

Alternative production layout:

```text
Web app:      https://urlx.com
Server API:   https://urlx.com/rpc
Short links:  https://urlx.com/:shortCode
```

If using one apex domain for both web and server behavior, configure Cloudflare routes carefully so `/rpc`, `/api-reference`, and `/:shortCode` reach the Hono server while the rest of the site reaches the Astro web Worker. The plan must not assume that two separate Cloudflare Workers automatically share the same domain.

Recommended redirect type for v1:

```text
302 Found
```

Avoid `301 Permanent Redirect` for v1 because browsers can cache it aggressively.

## URL Validation Rules

Accept only:

```text
http://
https://
```

Reject:

```text
javascript:
data:
file:
ftp:
mailto:
localhost
private IP addresses
empty strings
invalid URLs
extremely long URLs
```

Recommended maximum length:

```text
2048 characters
```

Do not fetch the user-submitted destination URL server-side during shortening.

Reason:

Fetching user-submitted URLs can create SSRF risks. The app should parse and validate the URL, not visit it.

## URL Normalization Rules

Use safe normalization only.

Do:

- Trim spaces
- Lowercase protocol
- Lowercase hostname
- Remove default ports
- Preserve path
- Preserve query parameters
- Preserve hash if submitted

Do not:

- Remove query parameters
- Reorder query parameters
- Remove tracking parameters
- Assume `www.example.com` and `example.com` are the same
- Aggressively remove trailing path segments

Examples that can normalize to the same value:

```text
HTTPS://EXAMPLE.COM
https://example.com/
```

Examples that should remain different:

```text
https://example.com/product?id=1
https://example.com/product?id=2
```

## Short Code Generation

Use secure random short codes.

Recommended:

```text
Base62 alphabet
7 or 8 characters
Generated with Web Crypto
Unique database constraint on short_code
Retry only if a collision happens
```

Example:

```text
https://x.urlx.com/a8X2kPq
```

Avoid predictable short codes:

```text
https://x.urlx.com/1
https://x.urlx.com/2
https://x.urlx.com/3
```

Predictable codes are easier to enumerate and feel less professional.

## QR Code Generation

Generate the QR code in the web frontend after the short URL is returned.

The QR code should encode:

```text
https://x.urlx.com/a8X2kPq
```

Not the original URL.

Frontend behavior:

```text
Short URL is generated
↓
User clicks Generate QR Code
↓
QR code appears below the result
```

No QR database table is needed in v1.

No QR storage is needed in v1.

## Web UI Direction

The UI should feel clean, premium, and calm.

Think Apple-like:

- Minimal layout
- Large spacing
- Sharp typography
- Subtle borders
- No visual noise
- No glowing effects
- No heavy gradients
- No excessive cards
- No over-animation

### Page structure

```text
Header:
  URLX logo
  Small tagline

Main:
  Large title
  Short subtitle
  URL input
  Shorten button

Result state:
  Short URL
  Copy button
  Generate QR code button
  QR code area

Footer:
  Minimal trust text
```

### Suggested copy

Title:

```text
Shorten links. Share them beautifully.
```

Subtitle:

```text
Create clean, reliable short links in seconds.
```

Input placeholder:

```text
Paste your long URL
```

Main button:

```text
Shorten URL
```

Result label:

```text
Your short link
```

Copy states:

```text
Copy
Copied
```

QR button:

```text
Generate QR code
```

### Micro-interactions

Use subtle, performant interactions only:

- Button loading state
- Input focus state
- Copy button changes to `Copied`
- QR code fades in gently
- Error message appears smoothly
- Respect `prefers-reduced-motion`

Avoid animation libraries for v1. CSS transitions are enough.

## Security Plan

Minimum security requirements:

- Validate only `http` and `https` URLs.
- Reject localhost and private IP destinations.
- Limit URL length.
- Validate short code format before database access.
- Rate limit the oRPC `links.shorten` procedure at `/rpc`.
- Add security headers.
- Return production-safe error messages.
- Do not expose stack traces.
- Do not fetch submitted URLs server-side.
- Use database constraints for duplicate prevention and short code uniqueness.

Recommended security headers:

```text
Content-Security-Policy
Strict-Transport-Security
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

## Rate Limiting

Apply rate limiting to:

```text
oRPC links.shorten over POST /rpc
```

Suggested first threshold:

```text
20 requests per minute per IP
```

Do not over-limit redirects in v1, because legitimate short links may receive sudden traffic.

Cloudflare deployment note:

- Prefer a Cloudflare rate limiting rule in front of the server Worker for production.
- If application-level rate limiting is used instead, define the required Cloudflare binding or storage in `packages/infra/alchemy.run.ts` and type it through `packages/env`.
- Do not leave a `RATE_LIMIT` binding in the plan unless the infrastructure actually provisions it.

## Performance Plan

### Frontend

- Use Astro for a mostly static page.
- Ship minimal JavaScript.
- Do not add a client-side framework unless needed.
- Do not add a heavy UI library.
- Lazy-load QR code logic only when needed.
- Use CSS transitions only.
- Keep the page fast and lightweight.

### Backend

- Use indexed lookups.
- Avoid N plus one queries.
- Keep redirect path fast.
- Keep responses small.
- Validate before database work.
- Use database constraints for correctness.
- Keep cache optional, not required for correctness.

### Database

Required fast paths:

```text
url_hash → existing link
short_code → original URL
```

Indexes:

```text
unique(url_hash)
unique(short_code)
```

## Error States

The UI should handle:

- Empty input
- Invalid URL
- Unsupported protocol
- URL too long
- Rate limit exceeded
- Network error
- Unexpected server error

User-friendly messages:

```text
Please enter a URL.
Please enter a valid http or https URL.
This URL is too long.
Too many requests. Please try again shortly.
Something went wrong. Please try again.
```

Avoid showing internal technical errors in the UI.

## Testing Plan

### Unit tests

Test:

- URL validation
- URL normalization
- URL hashing
- Short code generation
- Short code format validation
- Error mapping

### Integration tests

Test:

- Shorten a valid URL
- Reject invalid URLs
- Return same short URL for duplicate URL
- Redirect a valid short code
- Return 404 for unknown short code
- Handle short code collision retry
- Handle duplicate insert race condition

### UI tests

Test:

- User submits URL
- Generated short link appears
- Copy button works
- QR code appears
- Invalid URL error appears
- Loading state works

## Deployment Plan

Deploy to Cloudflare with the existing Alchemy setup in:

```text
packages/infra/alchemy.run.ts
```

The current deployment shape should remain:

```text
Cloudflare D1 database
Cloudflare Worker for apps/server
Cloudflare Astro Worker for apps/web
```

Use environments:

```text
local
preview
production
```

Required environment variables and bindings:

```text
DB
CORS_ORIGIN
PUBLIC_SERVER_URL
SHORT_URL_BASE
```

Binding ownership:

- `DB` is bound to the server Worker and used by Drizzle D1.
- `CORS_ORIGIN` is bound to the server Worker and should match the public web origin.
- `PUBLIC_SERVER_URL` is bound to the web Worker and used by the browser oRPC client.
- `SHORT_URL_BASE` is bound to the server Worker and used when returning `shortUrl`.

Cloudflare routing requirements:

- The web app domain must route to the Astro Worker.
- The API route `/rpc` must route to the Hono server Worker.
- The redirect route `/:shortCode` must route to the Hono server Worker on the short-link domain.
- The OpenAPI reference route `/api-reference` may remain available in preview and can be disabled or restricted in production.
- D1 migrations must be generated from `packages/db` and applied through the Alchemy deployment flow.

Optional future variables:

```text
RATE_LIMIT
TURNSTILE_SECRET_KEY
ABUSE_CONTACT_EMAIL
```

## CI Quality Gates

Before deployment:

```bash
pnpm check
pnpm check-types
pnpm build
pnpm db:generate
```

Add `pnpm test` once tests exist. Also run the project-specific Drizzle migration validation command if one is added.

## Implementation Order

### Phase 1: Clean project setup

1. Confirm no accidental Expo/native app code exists.
2. Confirm no accidental WXT/browser extension code exists.
3. Remove unused dependencies only if they are actually present.
4. Confirm `apps/web`, `apps/server`, and the existing packages remain aligned with Better-T-Stack.
5. Run install, check, typecheck, and build.

### Phase 2: Database

1. Create `links` schema in `packages/db/src/schema`.
2. Add unique indexes for `url_hash` and `short_code`.
3. Generate migration.
4. Verify local D1 migration through the Alchemy dev flow.
5. Apply migration to preview and production through the Alchemy deploy flow.

### Phase 3: Backend

1. Implement URL validation.
2. Implement URL normalization.
3. Implement URL hashing.
4. Implement secure short code generation.
5. Implement repository.
6. Implement service.
7. Implement oRPC `links.shorten` procedure in `packages/api`.
8. Mount the updated router through the existing Hono oRPC handler.
9. Implement Hono redirect route in `apps/server`.
10. Add `SHORT_URL_BASE` support and Cloudflare binding types.

### Phase 4: Frontend

1. Build clean Astro page.
2. Add URL input form.
3. Add loading state.
4. Add result panel.
5. Add copy button behavior.
6. Add QR code generation.
7. Add error states.
8. Add reduced motion support.

### Phase 5: Hardening

1. Add rate limiting.
2. Add security headers.
3. Add production error handling.
4. Test invalid URLs.
5. Test duplicate behavior.
6. Test redirect behavior.
7. Confirm Cloudflare routes send `/rpc` and `/:shortCode` to the server Worker.

### Phase 6: Deployment

1. Run tests.
2. Run build.
3. Deploy preview with Alchemy.
4. Test preview manually, including shortening, copy, QR generation, and redirect.
5. Configure production Cloudflare routes/custom domains.
6. Deploy production with Alchemy.
7. Test the production short-link domain directly.

## Future-Ready, Without Overbuilding

This v1 should not include unused mobile or extension code.

However, the architecture should leave clean seams for future features:

- User accounts
- Analytics
- Dashboard
- Custom aliases
- Custom domains
- Admin panel
- Abuse reporting
- QR downloads
- Browser extension
- Mobile app

The key rule:

```text
Do not build future features now.
Build v1 cleanly so future features are easy to add later.
```

## Final Decision

URLX v1 is a focused web-only product.

Keep:

```text
Astro web
Hono server
Cloudflare Workers
oRPC
Drizzle
D1
Biome
Turborepo
```

Remove or ignore:

```text
Expo
React Native
native-unistyles
WXT
browser extension code
mobile-specific packages
```

The result should be a clean, fast, secure, professional URL shortener web app with no unnecessary generated complexity.
