# Native local application preview

On Windows, `pnpm dev:local` starts the Astro web app and the native Bun API
against a private PostgreSQL cluster. It needs the repository's Node, pnpm, and
Bun dependencies plus PostgreSQL 18 server binaries. The default binary path is
`C:\Program Files\PostgreSQL\18\bin`; set `URLX_PG_BIN` to another installed
PostgreSQL 18 `bin` directory when needed.

The command creates or reuses only
`%LOCALAPPDATA%\URLX-local-preview\postgresql-utf8`, initializes it as UTF-8,
binds it to `127.0.0.1:5433`, and applies the normal restricted migration and
application roles. It does not connect to or modify a PostgreSQL service on
another port.
The database persists between runs. The API and web server bind only to
`127.0.0.1:8787` and `127.0.0.1:4321`; occupied ports make startup stop without
terminating the existing process. Press Ctrl+C to stop the two child servers
and the preview-owned PostgreSQL cluster.

Forms authentication uses the actual Better Auth and PostgreSQL code. Use the
synthetic address `local-preview@example.invalid`; the native preview captures
the one-time link under a fresh owner-only directory in
`%LOCALAPPDATA%\URLX-local-preview\runs` instead of sending email. Do not use a
real email address in this preview.

The native preview uses a process-local TTL store and single-process rate
limiters only for this explicit development mode. Production API startup still
requires Valkey and the host egress-policy readiness manifest. Metadata fetching
and conversion are unavailable in native preview; this path does not qualify
the production container, proxy, or nftables deployment.
