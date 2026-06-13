# URLX Backend API

URLX v1 exposes shortening through oRPC and redirects through a normal Hono route.

## Local Configuration

The server Worker expects these bindings:

```text
DB
CORS_ORIGIN
SHORT_URL_BASE
```

Alchemy defaults `SHORT_URL_BASE` to:

```text
http://localhost:3000
```

Set `SHORT_URL_BASE` in production to the public short-link origin, for example:

```text
https://your-production-url.com
```

Do not include a trailing slash.

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
	"shortUrl": "http://localhost:3000/a8X2kPq"
}
```

In production, `shortUrl` uses the configured `SHORT_URL_BASE`.

## Redirect Endpoint

```text
GET /:shortCode
```

Behavior:

- Valid short codes redirect with `302 Found`.
- Unknown or malformed short codes return `404`.
- Disabled links return `410`.
- Redirect responses include `Cache-Control: no-store`.

Example:

```text
GET /a8X2kPq
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
- URLs longer than 2048 characters

The server does not fetch submitted URLs during shortening.

## Error Codes

Frontend-safe error codes:

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

Typical error payload data:

```json
{
	"code": "INVALID_URL",
	"message": "Please enter a valid http or https URL."
}
```

## Notes

Rate limiting is intended to be enforced with a Cloudflare rate limiting rule for `POST /rpc`, initially at 20 shorten requests per minute per IP. No application-level storage-backed limiter is provisioned in v1.
