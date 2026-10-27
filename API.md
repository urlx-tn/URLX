# URLX Backend API

URLX v1 exposes shortening, link resolution, link-in-bio, and metadata
inspection through oRPC on the Hono API service. URL-to-Markdown and URL-to-HTML
are served by the separate conversion service. Short-link redirects are served by the web app at
`<<web-origin>>/u/:shortCode`.

## Local Configuration

The API service requires these runtime settings:

```text
DATABASE_URL
VALKEY_URL
CORS_ORIGIN
SHORT_URL_BASE
VISITOR_TOKEN_KEY_BASE64
EGRESS_PROXY_URL
```

The conversion service requires:

```text
VALKEY_URL
EGRESS_PROXY_URL
BROWSER_RENDERER_URL
CORS_ORIGIN
VISITOR_TOKEN_KEY_BASE64
```

`BROWSER_RENDERER_URL` points to the private conversion-renderer service. The
API and conversion services use Valkey for shared rate limits. The metadata and
renderer fetch paths require the configured egress proxy. Generate
`VISITOR_TOKEN_KEY_BASE64` as canonical base64 encoding of 32 random bytes, for
example with `openssl rand -base64 32`, and keep it in the ignored deployment
environment. Runtime startup fails if the key or proxy configuration is
invalid.

`SHORT_URL_BASE` should be the public web origin, for example:

```text
http://localhost:4321
```

Set `SHORT_URL_BASE` in production to the public web origin, for example:

```text
https://your-production-url.com
```

Do not include a trailing slash. Short links are built as `${SHORT_URL_BASE}/u/${shortCode}`.

## Anonymous Visitor Token

Browsers can obtain a pseudonymous token for fair rate limiting:

```http
GET /visitor-token
Origin: https://www.urlx.tn
```

The response is marked `Cache-Control: no-store`:

```json
{
	"token": "v1.<payload>.<signature>",
	"expiresAt": "2026-10-04T12:00:00.000Z"
}
```

The server issues a random visitor ID, signs it with HMAC-SHA-256, and expires
the token after 30 days. Browser clients store `{ token, expiresAt }` under
`urlx:visitor-token:v1` in local storage and send it only to conversion and
metadata operations:

```http
X-URLX-Visitor-Token: v1.<payload>.<signature>
```

The header is optional. Direct API clients can remain tokenless and use the
stricter per-IP fallback allowance. Missing or invalid tokens never cause an
authentication failure or server error. An invalid token is processed using
the fallback allowance and the response includes:

```http
X-URLX-Visitor-Token-Refresh: required
```

Browser clients clear that token so the next protected operation requests a
replacement. The exact-origin CORS policy permits the request header and
exposes the refresh header; wildcard origins are not allowed.

## Protected Tool Rate Limits

URL validation occurs before counters are consumed. For a valid request, URLX
first checks the operation's broader IP ceiling, then checks either the signed
visitor bucket or the stricter fallback-IP bucket:

| Operation | Visitor or fallback-IP allowance | IP ceiling | Window |
| --- | ---: | ---: | ---: |
| HTML and Markdown conversion (shared) | 15 | 60 | 60 seconds |
| Metadata inspection | 60 | 240 | 60 seconds |

Conversion and metadata use separate counters. A local limit failure retains
the `RATE_LIMITED` code and HTTP `429` status and includes `Retry-After: 60`.
Renderer or proxy failures are reported as `BROWSER_UNAVAILABLE` with HTTP
`503`, because service unavailability is not a URLX visitor-limit failure.

## oRPC Endpoint

```text
POST /rpc
```

The frontend should call:

```ts
orpc.links.shorten({ url })
```

### `links.shorten`

Creates a new short link or returns the existing short link for the same normalized URL.

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
	"shortUrl": "http://localhost:4321/u/a8X2kPq"
}
```

In production, `shortUrl` uses the configured `SHORT_URL_BASE`.

### `links.getByShortCode`

Resolves a short code to its original URL. Used by the web app to server-render the redirect at `/u/:shortCode`.

Request:

```json
{
	"shortCode": "a8X2kPq"
}
```

Success response:

```json
{
	"originalUrl": "https://example.com/page"
}
```

Unknown, malformed, or disabled short codes return a `SHORT_CODE_NOT_FOUND` error.

## Markdown Conversion Endpoint

```text
POST <<public-origin>>/convert/markdown
```

Fetches a public webpage through the isolated Playwright renderer and returns
its readable content as Markdown.

Request:

```json
{
	"url": "https://example.com/article"
}
```

Success response:

```json
{
	"sourceUrl": "https://example.com/article",
	"markdown": "# Article title\n\nArticle content."
}
```

The URL is validated before the renderer is called. Localhost, private-network
addresses, unsupported schemes, and malformed public domains are rejected.
Images, media, fonts, and stylesheets are not loaded during conversion to reduce
page requests. Generated
Markdown is not stored by URLX and responses larger than 1,000,000 characters
are rejected.

## HTML Conversion Endpoint

```text
POST <<public-origin>>/convert/html
```

Fetches a public webpage through the isolated Playwright renderer and returns the fully
rendered HTML, including the document head, after JavaScript execution.

Request:

```json
{
	"url": "https://example.com/"
}
```

Success response:

```json
{
	"sourceUrl": "https://example.com/",
	"html": "<!doctype html><html>...</html>"
}
```

HTML conversion retains scripts and stylesheets during rendering, while images,
media, and fonts are blocked to reduce page requests. The renderer waits for
`networkidle2` with a 30-second navigation timeout. URLX returns HTML only as data; the web interface
places it in a readonly textarea and never executes it. Results larger than
2,000,000 characters are rejected.

The public conversion URL is supplied to the web build as
`PUBLIC_CONVERSION_SERVER_URL`, normally the public origin with `/convert`
appended. The conversion service and renderer communicate on a private Compose
network; the browser renderer is not publicly exposed.

## Additional oRPC Procedures

### `metadata.inspect`

Fetches the initial server-rendered HTML for a public URL and returns link
preview metadata, diagnostics, and a computed preview object. It uses the main
API service and does not use the browser renderer.

Request:

```json
{
	"url": "https://example.com/article"
}
```

Success response includes:

```json
{
	"sourceUrl": "https://example.com/article",
	"finalUrl": "https://example.com/article",
	"status": 200,
	"ok": true,
	"contentType": "text/html; charset=utf-8",
	"checkedAt": "2026-06-22T12:00:00.000Z",
	"redirects": [],
	"title": "Article title",
	"description": "Article description",
	"canonicalUrl": "https://example.com/article",
	"openGraph": {
		"title": "Article title",
		"description": "Article description",
		"url": "https://example.com/article",
		"type": "article",
		"siteName": "Example",
		"locale": "en_US",
		"images": []
	},
	"twitter": {
		"card": "summary_large_image",
		"site": null,
		"creator": null,
		"title": null,
		"description": null,
		"image": null,
		"imageAlt": null
	},
	"preview": {
		"title": "Article title",
		"description": "Article description",
		"imageUrl": null,
		"imageAlt": null,
		"siteName": "Example",
		"url": "https://example.com/article",
		"faviconUrl": null
	},
	"rawTags": [],
	"warnings": []
}
```

The submitted URL and each redirect target are validated with the same public
URL rules as `links.shorten`. Redirects are followed manually up to five hops.
The inspector sends a simple GET request with no cookies or credentials, uses an
8-second timeout, reads at most the first 1 MiB of HTML, and stops after
`</head>` when possible. URLX does not store submitted URLs, fetched HTML,
extracted metadata, or generated JSON results.

### `bio.create`

Creates a "link in bio" page: one slug that renders a page listing several links.

Request:

```json
{
	"title": "Jane Doe",
	"description": "Designer & maker",
	"slug": "janedoe",
	"links": [
		{ "label": "Instagram", "url": "https://instagram.com/janedoe" },
		{ "label": "Portfolio", "url": "https://janedoe.example" }
	]
}
```

- `title` is required (1–80 characters).
- `description` is optional (≤300 characters).
- `slug` is optional. When provided it must be 3–30 characters of lowercase
  letters, digits, and single hyphens (not leading/trailing). When omitted, a
  random slug is generated.
- `links` must contain 1–25 entries. Each `label` is 1–60 characters and each
  `url` is validated with the same rules as `links.shorten` (see URL Rules).

Success response:

```json
{
	"slug": "janedoe"
}
```

The page is served by the web app at `<<web-origin>>/p/<slug>`.

### `bio.getBySlug`

Returns a bio page and its links, ordered as created. Used by the web app to
server-render `/p/:slug`.

Request:

```json
{
	"slug": "janedoe"
}
```

Success response:

```json
{
	"slug": "janedoe",
	"title": "Jane Doe",
	"description": "Designer & maker",
	"links": [
		{ "label": "Instagram", "url": "https://instagram.com/janedoe" }
	]
}
```

Unknown or disabled slugs return a `PAGE_NOT_FOUND` error.

## Redirect Endpoint

```text
GET <<web-origin>>/u/:shortCode
```

Served by the web app, which resolves the short code via `links.getByShortCode` and issues the redirect.

Behavior:

- Valid short codes redirect with `302 Found`.
- Unknown, malformed, or disabled short codes return `404`.
- Redirect responses include `Cache-Control: no-store`.

Example:

```text
GET /u/a8X2kPq
Location: https://example.com/page
```

## URL Rules

Accepted destination URLs:

- `http://...`
- `https://...`

Rejected destination URLs:

- Empty values
- Invalid URLs
- Unsupported schemes such as `javascript:`, `data:`, `file:`, `ftp:`, and `mailto:`
- `localhost` and `*.localhost`
- Private, loopback, and link-local IP addresses
- Named hosts without a valid public TLD (for example `https://ddd/`); public IP
  literals are still accepted
- URLs longer than 2048 characters

The server does not fetch submitted URLs during shortening.

## Error Codes

Frontend-safe error codes:

```text
EMPTY_URL
INVALID_URL
INVALID_DOMAIN
UNSUPPORTED_PROTOCOL
LOCAL_URL_NOT_ALLOWED
PRIVATE_IP_NOT_ALLOWED
URL_TOO_LONG
RATE_LIMITED
SHORT_CODE_NOT_FOUND
SERVER_ERROR
```

Metadata inspection may additionally return:

```text
TOO_MANY_REDIRECTS
FETCH_TIMEOUT
FETCH_FAILED
```

Markdown conversion may additionally return:

```text
PAGE_FETCH_FAILED
MARKDOWN_TOO_LARGE
BROWSER_UNAVAILABLE
```

HTML conversion may additionally return:

```text
HTML_TOO_LARGE
```

Bio-page error codes:

```text
EMPTY_TITLE
TITLE_TOO_LONG
DESCRIPTION_TOO_LONG
INVALID_SLUG
RESERVED_SLUG
SLUG_TAKEN
NO_LINKS
TOO_MANY_LINKS
INVALID_LINK_LABEL
PAGE_NOT_FOUND
```

`bio.create` may also return any URL Rules error code (for example `INVALID_URL`)
when a link's destination is rejected.

Typical error payload data:

```json
{
	"code": "INVALID_URL",
	"message": "Please enter a valid http or https URL."
}
```

## Notes

Markdown and HTML conversion continue to share one conversion allowance.
Shortener and Link-in-Bio procedures do not use anonymous visitor tokens and
their behavior is unchanged.
