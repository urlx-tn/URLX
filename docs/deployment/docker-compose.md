# Docker Compose deployment

This guide describes the Bun + PostgreSQL runtime on a Linux Docker host. It
does not deploy or modify the existing Cloudflare production resources. The
Compose database starts empty; copying records from D1 is a separate migration
and cutover task.

## Services and exposure

| Service | Runtime | Network access |
| --- | --- | --- |
| `web` | Astro standalone on Bun | Loopback-published host upstream; private API, configured egress proxy |
| `api` | Hono on Bun | Loopback-published host upstream; PostgreSQL, Valkey, egress proxy |
| `conversion` | Hono on Bun | Loopback-published host upstream; Valkey, renderer, egress proxy |
| `conversion-renderer` | Playwright 1.64.1 on Bun | Conversion control service and egress proxy only |
| `postgres` | PostgreSQL | Private data network; named persistent volume |
| `valkey` | Valkey | Private rate-limit network; UID/GID 999:1000; no persistence |
| `migrate` | Bun + Drizzle ORM | One-shot schema migration using `urlx_migrator` |
| `egress-proxy` | Squid | Only service with an external Docker network |

Compose publishes only the web, API, and conversion upstreams on host loopback:
`127.0.0.1:8080` to web `:8080`, `127.0.0.1:8787` to API `:8787`, and
`127.0.0.1:8788` to conversion `:8788`. Host port numbers can be changed with
`WEB_HOST_PORT`, `API_HOST_PORT`, and `CONVERSION_HOST_PORT`; Compose keeps the
bind address fixed at `127.0.0.1`. Preflight rejects non-loopback bindings,
incorrect targets, or extra published ports. Database, Valkey, renderer, and
proxy ports remain unpublished.

The independently managed host ingress owns routing and public TLS. Configure
it with this route contract:

| Public path | Upstream | Path rewrite |
| --- | --- | --- |
| `/rpc*`, `/visitor-token`, `/api-reference*`, `/api/forms`, `/api/forms/*`, `/api/auth/*` | `127.0.0.1:${API_HOST_PORT:-8787}` | Preserve path |
| `/convert/*` | `127.0.0.1:${CONVERSION_HOST_PORT:-8788}` | Strip `/convert` (`/convert/markdown` becomes `/markdown`) |
| All other paths | `127.0.0.1:${WEB_HOST_PORT:-8080}` | Preserve path |

The ingress must overwrite `X-Urlx-Client-IP` with the actual socket peer
address for every upstream request. Do not trust a client-supplied value or
append to an existing value: the API uses this header for rate limits and
form-auth client IPs. Preserve the request `Host` and original HTTPS scheme in
forwarded headers. Set `PUBLIC_ORIGIN` to the canonical HTTPS frontend origin,
`PUBLIC_SERVER_URL` to the public API route origin, and
`PUBLIC_CONVERSION_SERVER_URL` to the public conversion URL ending in `/convert`;
keep them consistent with ingress routes, CORS, and Better Auth settings. The
ingress terminates public TLS; Compose upstreams use HTTP on loopback. Never
publish these service ports on a public interface. Direct API and conversion
access would bypass the trusted ingress boundary.

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

### Proxy base-image advisory disposition (R9 scan)

This Candidate R9 review is tied to proxy image digest
`sha256:6883a44bca237ec3bdfa4b1386a41523bd4c887f792ec90f836573377ab65996`
and its local, report-only scan snapshot (not shipped with this repository).
The companion `proxy-advisory-review.md` is also report-only and untracked.
The scan completed at
`2026-10-28T10:13:10Z`; its receipt records 136 OS packages and 37
vulnerability rows (0 critical, 0 high, 27 medium, 10 low) that deduplicate to
27 CVEs. The report SHA-256 is
`aef5edf920602c49ab96a442a31f85d38aa5975ec152d2793916f1ec90b7ca8b`. The
proxy scan's Ubuntu package versions are not interchangeable with the Debian
13 package versions in the core-image HIGH findings. The following
dispositions use Canonical and upstream records; they do not suppress scanner
output or declare the image vulnerability-free. For every release, rebuild,
record and scan the resulting image digest, then review the package inventory
and current vendor advisory status again; do not carry these Candidate R9
results forward to a different digest.

| CVE | Proxy package version | Vendor/upstream disposition | Proxy runtime relevance |
| --- | --- | --- | --- |
| [CVE-2025-69720](https://ubuntu.com/security/CVE-2025-69720) | `ncurses-bin` / `libtinfo6` `6.4+20240113-1ubuntu2.2` | Ubuntu Noble is fixed from `6.4+20240113-1ubuntu2.1`. The defect is in the `infocmp` command parser. | `infocmp` is installed, but this image has Ubuntu's fixed package revision. The Debian 13 scan's affected version does not describe this Ubuntu package. |
| [CVE-2026-16742](https://ubuntu.com/security/CVE-2026-16742) | `systemd` / libraries `255.4-1ubuntu8.18` | Ubuntu Noble is fixed from `255.4-1ubuntu8.17`. The flaw is in `systemd-homed`. | No `systemd-homed` package/service is in the proxy inventory. The entrypoint runs Squid directly as UID 13; it does not start systemd as PID 1. |
| [CVE-2026-54369](https://ubuntu.com/security/CVE-2026-54369) | `libacl1` `2.3.2-1build1.1` | **Unresolved.** Canonical marks Noble `Ignored — backport too intrusive`; upstream's fix adds pathname-relative `acl_*_at()` APIs. This is not a fixed or not-affected determination. | `libacl.so` is installed. The described escalation requires a local attacker-controlled pathname component processed by a privileged caller. UID 13, read-only rootfs, dropped capabilities, and `no-new-privileges` reduce impact, but do not patch the library or prove all callers unreachable. |
| [CVE-2026-76642](https://ubuntu.com/security/CVE-2026-76642) | `util-linux`, `mount`, `libmount1` `2.39.3-9ubuntu6.6` | **Unresolved upstream/vendor assessment.** [Upstream](https://github.com/util-linux/util-linux/security/advisories/GHSA-m25x-3hj9-m26f) lists versions through `2.42.2` as affected and fixes at `2.41.6` / `2.42.3`; Canonical Noble is `Needs evaluation`. | Requires a privileged mount helper plus configured `X-mount.idmap` or `X-mount.owner` post-hook. The proxy runs as UID 13, does not call `mount`, has no writable rootfs/fstab, drops all capabilities, and Compose enables `no-new-privileges`, which blocks SUID privilege gain. This is a strong runtime constraint, not a package fix. |
| [CVE-2026-78408](https://ubuntu.com/security/CVE-2026-78408) | `util-linux` `2.39.3-9ubuntu6.6` | Canonical Noble is `Needs evaluation`; [upstream](https://github.com/util-linux/util-linux/security/advisories/GHSA-55fx-f4gg-cfhj) lists affected versions `>=2.40`. Installed `2.39.3` is below that upstream minimum. Keep Canonical's status unresolved; the upstream range alone does not establish Ubuntu's package status. | Requires a privileged operator to invoke `nsenter --join-cgroup` against an attacker-controlled target. The proxy lifecycle does not invoke `nsenter`. |
| [CVE-2026-78409](https://ubuntu.com/security/CVE-2026-78409) | `util-linux` `2.39.3-9ubuntu6.6` | Canonical Noble is `Needs evaluation`; [upstream](https://github.com/util-linux/util-linux/security/advisories/GHSA-8f2p-47x3-43mv) lists affected versions `>=2.42`. Installed `2.39.3` is below that upstream minimum. Keep Canonical's status unresolved; the upstream range alone does not establish Ubuntu's package status. | Also requires Linux 6.15 or later and an fstab-authorized `X-mount.subdir` entry. URLX does not configure such an entry in the image or Compose. Host-kernel applicability is not inferred from the image scan. |
| [CVE-2026-78410](https://ubuntu.com/security/CVE-2026-78410) | `util-linux`, `mount`, `libmount1` `2.39.3-9ubuntu6.6` | **Unresolved upstream/vendor assessment.** [Upstream](https://github.com/util-linux/util-linux/security/advisories/GHSA-rh77-686x-2f2m) lists versions through `2.42.2` as affected and fixes at `2.41.6` / `2.42.3`; Canonical Noble is `Needs evaluation`. | Requires restricted SUID `mount(8)`, an fstab-authorized bind entry, an attacker-replaceable source path, and an `X-mount.owner/group/mode` hook. URLX does not configure such an entry; read-only rootfs and `no-new-privileges` constrain this path, but do not update util-linux. |
| [CVE-2026-9538](https://ubuntu.com/security/CVE-2026-9538) | `perl`, `perl-base`, `perl-modules-5.38` `5.38.2-3.2ubuntu0.6` | Ubuntu Noble is fixed from `5.38.2-3.2ubuntu0.4`. The issue is memory exhaustion in `Archive::Tar` on an attacker-controlled tar header. | Perl is installed, but the proxy image has the vendor-fixed revision. The Debian 13 finding is not the Ubuntu package status. |

The live Compose proxy service is configured as `proxy:proxy` (UID/GID 13),
with a read-only root filesystem, bounded writable tmpfs mounts, all Linux
capabilities dropped, and `no-new-privileges`; its entrypoint executes
`squid -N`. These controls reduce the practical reachability of local privilege
escalation paths; they do not change package advisory status, protect a
different runtime configuration, or establish that every library call is
unreachable. In particular, keep ACL and the util-linux advisories above
unresolved until Canonical publishes an affected/fixed assessment or the image
is changed through a separately reviewed package-minimization/rebase. Do not
describe a zero-HIGH Trivy result as a clean or cleared image.

Chromium runs as the image's non-root `pwuser` with its sandbox enabled. The
renderer uses the [Playwright v1.64.1 seccomp profile](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json),
which retains the default-deny syscall policy and adds the user-namespace
syscalls required by Playwright's documented sandbox setup. Keep this profile
in sync with the pinned Playwright image and verify sandboxed rendering only
in the local browser-enabled test environment; the VPS application test overlay
does not run Chromium. Do not switch the browser to `--no-sandbox`.

The host setup helper derives the live container IDs, network IDs, IP/MAC
addresses, and network namespace identities. It reads each namespace through
the host's `/proc/<Docker State.Pid>/ns/net` and rechecks the container ID,
running state, PID, and start time, so runtime images need no inspection
utilities. It adds rules in the dedicated
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

The PostgreSQL image is derived from the official `postgres:18.6-alpine3.24`
manifest pinned by digest in its Dockerfile. It upgrades only `brotli-libs` and
`libcurl` from Alpine v3.24 and checks their fixed-version floors; PostgreSQL
remains 18.6 and keeps the official entrypoint and `/var/lib/postgresql` volume
layout. Build the application and infrastructure images before preparing the
host gate, which starts services with `--no-build`. The final host provides its
own ingress and TLS termination:

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
known running egress clients after the same ownership checks. Before Compose
starts, it atomically removes the readiness manifest and deletes only the
owner-verified URLX table, preventing stale container IP/MAC rules from
blocking PostgreSQL initialization after a network recreation. PostgreSQL,
Valkey, and the migrator use internal networks; app and proxy entrypoints stay
gated until the helper installs fresh rules and a fresh manifest. If table
deletion fails, Compose does not start and the non-readiness owner sidecar is
retained for a safe retry. If a foreign project is active or the nftables table
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
test-only Compose overlay; it leaves the loopback conversion upstream published but
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
docker compose build web api conversion migrate egress-proxy postgres
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
