# URLX Backend API

URLX v1 exposes shortening and link resolution through oRPC. URL-to-Markdown
and URL-to-HTML are served by a separate conversion Worker. Short-link redirects
are served by the web app at `<<web-origin>>/u/:shortCode`.

## Local Configuration

The server Worker expects these bindings:

```text
DB
CORS_ORIGIN
SHORT_URL_BASE
```

The conversion Worker expects:

```text
BROWSER
CONVERSION_RATE_LIMIT
CORS_ORIGIN
```

`BROWSER` is the Cloudflare Browser Run binding provisioned by Alchemy; it does
not require a separate application API token. `CONVERSION_RATE_LIMIT` limits
each client IP to five total Markdown or HTML conversions per minute before
Browser Run is called.

Alchemy defaults `SHORT_URL_BASE` to:

```text
http://localhost:4321
```

Set `SHORT_URL_BASE` in production to the public web origin, for example:

```text
https://your-production-url.com
```

Do not include a trailing slash. Short links are built as `${SHORT_URL_BASE}/u/${shortCode}`.

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
POST <<conversion-worker-origin>>/markdown
```

Fetches a public webpage through Cloudflare Browser Run and returns its readable
content as Markdown.

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

The URL is validated before Browser Run is called. Localhost, private-network
addresses, unsupported schemes, and malformed public domains are rejected.
Images, media, fonts, and stylesheets are not loaded during conversion to reduce
page requests. Browser Run responses may be cached for five minutes. Generated
Markdown is not stored by URLX and responses larger than 1,000,000 characters
are rejected.

## HTML Conversion Endpoint

```text
POST <<conversion-worker-origin>>/html
```

Fetches a public webpage through Cloudflare Browser Run and returns the fully
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
media, and fonts are blocked to reduce page requests. Browser Run waits for
`networkidle2`, uses a 30-second navigation timeout, and may cache matching
requests for five minutes. URLX returns HTML only as data; the web interface
places it in a readonly textarea and never executes it. Results larger than
2,000,000 characters are rejected.

In local development, Alchemy supplies the remote development Worker URL to the
Astro app as `PUBLIC_CONVERSION_SERVER_URL`. Production deployments provision
and bind the corresponding deployed Worker URL automatically.

## Additional oRPC Procedures

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

Markdown and HTML conversion share a Cloudflare Rate Limiting binding at five
total conversion requests per minute per client IP. Broader rate limiting for
other `POST /rpc` operations can still be enforced with Cloudflare rules.
