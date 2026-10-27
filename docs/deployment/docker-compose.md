# Docker Compose deployment

This guide describes the Bun + PostgreSQL runtime on a Linux Docker host. It
does not deploy or modify the existing Cloudflare production resources. The
Compose database starts empty; copying records from D1 is a separate migration
and cutover task.

## Services and exposure

| Service | Runtime | Network access |
| --- | --- | --- |
| `web` | Astro standalone on Bun | Private API, configured egress proxy |
| `api` | Hono on Bun | PostgreSQL, Valkey, egress proxy |
| `conversion` | Hono on Bun | Valkey, renderer, egress proxy |
| `conversion-renderer` | Playwright 1.64.1 on Bun | Conversion control service and egress proxy only |
| `postgres` | PostgreSQL | Private data network; named persistent volume |
| `valkey` | Valkey | Private rate-limit network; no persistence |
| `migrate` | Bun + Drizzle ORM | One-shot schema migration using `urlx_migrator` |
| `egress-proxy` | Squid | Only service with an external Docker network |

The base Compose file publishes no ports. Use the host's existing ingress and
keep API, conversion, database, Valkey, renderer, and proxy ports private. The
ingress must overwrite `X-Urlx-Client-IP` from its actual socket peer. The API
trusts that header only from the private ingress path; do not expose API or
conversion ports directly to the Internet.

The optional `ingress` profile provides loopback-only HTTP on port 8080 for
local testing or a host-level ingress. It does not provision TLS. It must not be
used to claim a public HTTPS deployment.

## Required configuration

1. Copy `.env.example` to `.env` and set all values. Keep `.env` out of source
   control and do not pass private values as build arguments.
2. Generate independent passwords for `POSTGRES_BOOTSTRAP_PASSWORD`,
   `URLX_APP_PASSWORD`, and `URLX_MIGRATOR_PASSWORD`. The example connection
   URLs must use the matching role and password. URL-encode passwords if they
   contain characters reserved in URLs.
3. Set `VISITOR_TOKEN_KEY_BASE64` to canonical base64 encoding of 32 random
   bytes. Generate `BETTER_AUTH_SECRET` with a CSPRNG (for example,
   `openssl rand -base64 32`) instead of choosing a memorable string. Enable
   forms only after configuring the Better Auth and email values.
4. Set `PG_POOL_MAX`, `RENDERER_CONCURRENCY`, and the per-service memory/CPU
   caps for the measured host capacity. The Compose preflight requires caps for
   web, API, conversion, PostgreSQL, Valkey, migration, proxy, and each active
   profile service, sums them, and rejects totals above the host budget you
   enter. Keep
   extra host memory/CPU for the OS, Docker, and ingress. These are operator
   limits, not measured production sizing recommendations. Renderer limits
   must allow at least 512 MiB and 0.5 CPU per configured browser context; the
   renderer also has a bounded restart count after failure. Its request
   controls cap tracked requests at 128, each response at 4 MiB, total
   transferred response data at 16 MiB, and each render at 30 seconds. These
   request caps complement the renderer cgroup limits and do not replace host
   egress filtering.
   Set `VALKEY_MAXMEMORY` and `VALKEY_MEMORY_LIMIT` as byte counts, with
   maxmemory no greater than 80% of the container limit. The deployment
   preflight validates the limit and headroom before stopping or starting
   services. Valkey's key storage and process overhead stay inside an explicit
   container memory bound. The `noeviction` policy makes rate/auth writes fail
   instead of silently evicting active limits when configured memory is full.
5. `PUBLIC_SERVER_URL` and `PUBLIC_CONVERSION_SERVER_URL` are public build-time
   values. Rebuild the web image after changing either value.

The Compose file maps environment variables explicitly per service. Only
PostgreSQL receives the bootstrap and role-creation passwords. Only the
migration service receives `MIGRATOR_DATABASE_URL`; API and conversion receive
the restricted runtime role URL where needed. The browser renderer has no
database, auth, visitor-token, email, or Valkey credentials.

## Build and egress startup gate

The egress policy is part of the runtime boundary. Internal Compose networks
keep app containers from having a direct default route. The renderer shares
only its control network and a private proxy network; Squid denies non-global
and reserved destinations, host interface addresses, and ports outside HTTP
and HTTPS. A host nftables table further restricts container-to-container
connections, blocks URLX container traffic to the host, and limits proxy
egress.

The egress image refreshes the Ubuntu Noble Squid package at build time and
fails the build below version `6.14-0ubuntu0.24.04.5`, Canonical's fixed
security floor for the proxy. Run the image package audit after building it.

Chromium runs as the image's non-root `pwuser` with its sandbox enabled. The
renderer uses the [Playwright v1.64.1 seccomp profile](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json),
which retains the default-deny syscall policy and adds the user-namespace
syscalls required by Playwright's documented sandbox setup. Keep this profile
in sync with the pinned Playwright image and verify sandboxed rendering only
in the local browser-enabled test environment; the VPS application test overlay
does not run Chromium. Do not switch the browser to `--no-sandbox`.

The host setup helper derives the live container IDs, network IDs, IP/MAC
addresses, and network namespace identities. It adds rules in the dedicated
`bridge urlx_egress` nftables table and writes a readiness manifest atomically.
It does not edit the host's unrelated firewall tables or sysctls. The API,
conversion, web, renderer, and proxy processes wait without opening listeners
or fetching URLs until their manifest identity matches. Missing or stale
policy leaves the services unready.

Before running the helper, review the generated host policy with the operator
responsible for the VPS. The host needs Docker Compose, `ip`, `jq`, `nft`,
Python 3, and a Linux kernel with nftables bridge conntrack support. Do not
start this stack on a public host until the host rules, Squid ACLs, and renderer
network isolation have been verified from the test environment.

Build images, then prepare the host gate:

```bash
pnpm containers:build
sudo pnpm egress:prepare
```

The helper first takes the host lock and checks for a foreign active URLX
project and a matching nftables/manifest owner. On a cold start with no running
containers, it accepts the empty inventory and starts the configured services
behind their entrypoint barriers. API, web, conversion, and renderer stay
without listeners until the egress policy and matching readiness manifest are
installed. The helper does not wait for those gated healthchecks before
installing the policy; PostgreSQL, Valkey, and the one-shot migration can still
satisfy their startup dependencies. On an existing stack it stops only the
known running egress clients after the same ownership checks, then recreates
the policy and manifest. If a foreign project is active or the nftables table
has no matching owner manifest, it stops before stopping containers or changing
the firewall. A fresh checkout does not need a pre-created egress policy
directory: the helper checks firewall/manifest ownership first, then creates
the directory after that check and before starting services. Check health before
routing test traffic:

```bash
docker compose ps
docker compose logs --tail=100 egress-proxy api conversion conversion-renderer web
```

### Browserless VPS application tests

Run browser rendering checks locally. For VPS application checks, use the
test-only Compose overlay; it leaves the public conversion endpoint mounted but
returns the stable `503` / `BROWSER_UNAVAILABLE` response. The overlay disables
the renderer dependency and places `conversion-renderer` behind the `browser`
profile, so Compose does not build, pull, or start the Playwright/Chromium image.
The default `compose.yaml` has no such profile and retains full conversion for
normal deployments.

Keep the test overlay selected for every Compose lifecycle command by setting
`COMPOSE_FILE` (colon-separated on the Linux host):

```bash
export COMPOSE_FILE=compose.yaml:compose.vps-test.yaml
pnpm containers:preflight
docker compose build web api conversion migrate egress-proxy
sudo env URLX_COMPOSE_PROJECT=urlx-container-validation COMPOSE_FILE="$COMPOSE_FILE" pnpm egress:prepare
docker compose ps --services
docker compose logs --tail=100 egress-proxy api conversion web
```

The `.env` file still needs renderer interpolation values because the base
Compose file defines that service. Give its unused caps valid values such as
`CONVERSION_RENDERER_MEMORY_LIMIT=536870912`,
`CONVERSION_RENDERER_CPU_LIMIT=0.5`, and `RENDERER_CONCURRENCY=1`. They are
parsed but excluded from the active-service budget; the explicit build service
list omits the renderer, so no Chromium image is built, pulled, or started. The
test override uses Compose's
`!override` tag and requires Docker Compose 2.24.4 or newer. Do not add `browser` to
`COMPOSE_PROFILES` while browser conversion is disabled; preflight rejects that
contradictory configuration. To tear down the same project while retaining the
database volume, keep `COMPOSE_FILE` selected:

```bash
sudo env URLX_COMPOSE_PROJECT=urlx-container-validation COMPOSE_FILE="$COMPOSE_FILE" pnpm containers:down
```

The egress gate discovers running Compose services, verifies their URLX and
project labels, and records only active egress services in its readiness
manifest. It requires the renderer in normal conversion mode and permits its
absence only when the conversion service has the explicit disabled setting.

For an isolated test instance, choose a Compose project name with the
`urlx-` prefix (for example `urlx-container-validation`) and use the same value
for both setup and teardown via `URLX_COMPOSE_PROJECT`. The helper rejects
other project names and uses the Compose file set selected by `COMPOSE_FILE`.

```bash
sudo env URLX_COMPOSE_PROJECT=urlx-container-validation pnpm egress:prepare
sudo env URLX_COMPOSE_PROJECT=urlx-container-validation pnpm containers:down
```

When the Docker host restarts or service containers are recreated, rerun the
gate helper before routing traffic. Container IDs and network namespace
identities are intentionally checked so an old manifest cannot authorize a new
container. Only one URLX Compose project may be active on a host at a time
because the firewall uses one URLX-owned nftables table and one readiness
manifest. Setup and teardown take a host-wide lock, detect URLX containers even
when a test project uses a custom Compose name, and verify the manifest owner
before changing or removing the table. If another URLX project is active or
ownership cannot be proven, they stop and leave the gate in place. Use these
helpers instead of starting or stopping URLX containers directly. The teardown
helper removes only the verified URLX-owned table and generated policy files
after stopping URLX's egress clients.

The one-shot `migrate` service runs against PostgreSQL on the internal data
network and completes before the gate discovers the long-running services. Its
fixed migration code is not a user-facing URL fetcher and is intentionally not
included in the runtime container address allowlist.

## PostgreSQL roles, persistence, and backup

The named volume `urlx-postgres-data` stores the PostgreSQL data directory. The
PostgreSQL initialization script runs only when that volume is empty. It creates
`urlx_app` with no superuser, database-creation, role-creation, replication, or
RLS-bypass privileges, and creates `urlx_migrator` as the schema owner. The
migrator receives `CREATE` on the configured database to maintain Drizzle's
migration journal, but no `CREATEDB`, `CREATEROLE`, or superuser privilege. The
API role has no database or schema `CREATE` privilege. The script uses psql's
environment reader and SQL literal quoting; passwords are not
interpolated into SQL text or shell command arguments.

Changing values in `.env` does not rotate passwords in an existing volume.
Use a reviewed `ALTER ROLE` procedure and update URLs together. Do not remove
the named database volume as a troubleshooting step.

Create a custom-format logical dump with the migration role:

```bash
mkdir -p backups
backup="backups/urlx-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$URLX_MIGRATOR_PASSWORD" pg_dump -h 127.0.0.1 -U urlx_migrator -Fc --no-owner "$POSTGRES_DB"' \
  > "$backup"
docker compose exec -T postgres pg_restore --list < "$backup" > /dev/null
sha256sum "$backup"
```

Store encrypted copies off-host, restrict access, and retain checksums. Form
responses and auth/session records may contain personal information. Regularly
restore a dump into an isolated test database and verify that migrations and
application reads work before relying on the backup. Keep enough free disk for
the database, a temporary dump, image builds, and container logs.

This single-host volume is not high availability and does not provide point-in-
time recovery. Automated off-host backups and a rehearsed recovery procedure
are operational prerequisites before production use. The test-host setup is
not a validated production sizing or recovery target.

To test a restore, use a disposable PostgreSQL instance with the same schema
version and restore the dump there. `pg_restore --clean --if-exists` drops and
recreates objects; never point it at a live database unless a separately
reviewed destructive recovery is intended.

## Data migration and cutover

The Compose migration service applies schema migrations only; it does not
export from D1 or copy production records. Before a real cutover, separately
measure source table sizes and retention, map IDs/timestamps/foreign keys,
export and validate the D1 data, test import and auth/session behavior, verify
redirect and form behavior, and rehearse rollback. Keep the current Cloudflare
deployment and its data intact until the new runtime has passed acceptance and
the operator explicitly schedules a cutover.

## Verification matrix

Before considering a test deployment ready, verify all of the following:

- `docker compose config` resolves with the private test environment and no
  secrets are present in build arguments or image layers.
- PostgreSQL initializes roles, runs migrations once, survives container
  replacement, and accepts API connections only as `urlx_app`.
- Missing, stale, malformed, or identity-mismatched egress manifest prevents
  proxy/API/web/conversion/renderer readiness.
- In the local browser-enabled test environment, the renderer can reach a
  public test page through Squid but cannot reach private IPs, host addresses,
  PostgreSQL, Valkey, or any non-proxy egress path. The browserless VPS overlay
  instead returns `503` / `BROWSER_UNAVAILABLE` from conversion endpoints.
- Squid denies private, loopback, link-local, reserved, host, metadata, and
  non-HTTP(S) destinations, including redirected requests.
- Ingress overwrites `X-Urlx-Client-IP`; direct access to private service ports
  is unavailable from outside the host.
- Auth, email verification/reset, form response submission, CSV export, short
  redirects, metadata, and HTML/Markdown conversion work in the container
  deployment.
- Container stop/restart, host restart, backup, and isolated restore are
  rehearsed before any production migration.

Docker is not available in every developer workspace, so a source build alone
does not verify the host firewall or container network rules. Keep host-side
verification results attached to the deployment change.
