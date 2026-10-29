# Native local application preview

On Windows, `pnpm dev:local` starts the Astro web app, native Bun APIs, a local
public-only proxy, and the Playwright renderer against a private PostgreSQL
cluster. It needs the repository's Node, pnpm, and Bun dependencies,
Playwright's Chromium browser, and PostgreSQL 18 server binaries. The default
binary path is `C:\Program Files\PostgreSQL\18\bin`; set `URLX_PG_BIN` to
another installed PostgreSQL 18 `bin` directory when needed.

The command creates or reuses only
`%LOCALAPPDATA%\URLX-local-preview\postgresql-utf8`, initializes it as UTF-8,
binds it to `127.0.0.1:5433`, and applies the normal restricted migration and
application roles. It does not connect to or modify a PostgreSQL service on
another port.
The database persists between runs. The API, conversion API, proxy, renderer,
and web server bind only to `127.0.0.1` on ports 8787, 8788, 8789, 8790, and
4321 respectively. Occupied ports make startup stop without terminating the
existing process. Press Ctrl+C to stop the preview's child processes and its
PostgreSQL cluster.

Forms authentication uses the actual Better Auth and PostgreSQL code. Use the
synthetic address `local-preview@example.invalid`; the native preview captures
the one-time link under a fresh owner-only directory in
`%LOCALAPPDATA%\URLX-local-preview\runs` instead of sending email. Do not use a
real email address in this preview.

Metadata, Markdown, and HTML tools are available in the native preview. Their
outbound requests go through an authenticated proxy bound to loopback. It
allows public HTTP on port 80 and HTTPS on port 443, rejects non-public or
host-owned DNS answers, and pins connections to a checked IPv4 address. It
does not provide arbitrary outbound access. The renderer uses the installed
Playwright Chromium browser through the same proxy.

The native preview uses a process-local TTL store and single-process rate
limiters only in this explicit development mode. Production API startup still
requires Valkey and the host egress-policy readiness manifest. This local path
does not validate production containers, Squid, or nftables deployment.
