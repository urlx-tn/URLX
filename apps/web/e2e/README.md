# URLX Forms browser check

The `playwright.config.mjs` entry below is the historical PR48/Cloudflare
Worker test: it provisions Miniflare D1 and does not test the Bun + PostgreSQL
Compose runtime. The Compose configuration runs the same UI assertions against
the active migration runtime using its PostgreSQL-backed fixture adapter.

## Bun + PostgreSQL browser verification

The migration branch reuses the same gallery, builder, pagination, versioning,
public response, CSV, keyboard, and responsive assertions against the running
Bun/Astro and PostgreSQL Compose stack. Run it only against a disposable test
project with Forms enabled and an isolated PostgreSQL volume. The Compose stack
publishes only web/API/conversion upstreams to the host's loopback interface;
it does not contain an ingress or TLS server. Use the final host's ingress for
remote browser tests, or a temporary local test gateway that routes to the
three loopback upstreams. For a remote VPS, keep SSH tunnels to the test host's
loopback ports private and let the local gateway listen only on client
loopback. The gateway contract is documented in
`docs/deployment/docker-compose.md`. The target is restricted to loopback or a
`.test` hostname. Build the test stack with matching public build/runtime
settings: `PUBLIC_ORIGIN` is the test frontend origin,
`PUBLIC_SERVER_URL` is the test API route origin, and
`PUBLIC_CONVERSION_SERVER_URL` is the public conversion URL ending in
`/convert`. Enable Forms. Use a disposable test Compose configuration; do not
edit production origins or reuse production images/configuration. The runner
checks the API CORS origin before opening the browser.

The test creates a unique synthetic account, captures its magic-link email inside
a one-off API-container auth instance, verifies the link through the real API,
and deletes that account and its forms when the run ends. Teardown sends a
transaction-scoped cleanup script to the already-running PostgreSQL container
over stdin, guarded to the synthetic E2E email pattern. It does not send email
or print credentials, links, or expanded Compose configuration.

With the repository dependencies and local Chromium installed, set the exact
test Compose project and base origin before running:

```bash
export URLX_COMPOSE_PROJECT=urlx-container-validation
export URLX_FORMS_E2E_BASE_URL=http://127.0.0.1:8080
pnpm exec playwright test --config apps/web/e2e/playwright.compose.config.mjs
```

Set `URLX_FORMS_E2E_BASE_URL` to the loopback origin exposed through the SSH
tunnel. The project must already be started with the matching
`URLX_COMPOSE_PROJECT` and egress policy. Compose must be using the Docker
context that owns that test project. Do not point this suite at production.

The browser runner can run on a separate machine from Docker. Start tunnels
from the runner to the test host's individual loopback upstreams, then start
the local test gateway that serves `127.0.0.1:8080` and applies the route
contract. Do not expose API/conversion upstreams on a public interface. Then set
`URLX_FORMS_E2E_SSH_TARGET` to an SSH alias or `user@host` and
`URLX_FORMS_E2E_REMOTE_REPO` to the absolute repository path on that host. The
helper sends only its one-off test source over SSH and runs it with
`docker compose exec` in the `api` container; it does not need Node, Bun, or
Playwright installed on the Docker host. Keep the repository path and Compose
project matched to the isolated test stack.

Example, in separate shells on the machine running Playwright:

```bash
ssh -N \
  -L 18080:127.0.0.1:8080 \
  -L 18787:127.0.0.1:8787 \
  -L 18788:127.0.0.1:8788 \
  "$URLX_FORMS_E2E_SSH_TARGET"
```

```bash
export URLX_COMPOSE_PROJECT=urlx-container-validation
export URLX_FORMS_E2E_BASE_URL=http://127.0.0.1:8080
export URLX_FORMS_E2E_SSH_TARGET=user@test-host
export URLX_FORMS_E2E_REMOTE_REPO=/srv/urlx/URLX-bun-container-deployment
pnpm exec playwright test --config apps/web/e2e/playwright.compose.config.mjs
```

If the SSH account has access to the repository but needs non-interactive sudo
for Docker, set `URLX_FORMS_E2E_SSH_SUDO=true` in the Playwright runner
environment. The helper then runs the complete remote command, including the
repository `cd`, through `sudo -n sh -c`; the default is `false`, and any value
other than exactly `true` or `false` is rejected. This requires existing
non-interactive sudo authorization on the test host. It does not change SSH
keys, group membership, or host permissions. The flag applies only to the SSH
path; local Docker execution is unchanged.

The Compose browser check exercises Astro against the running Bun web and API
services, with PostgreSQL and Valkey from the isolated Compose project. It
creates a fresh synthetic account through a captured magic link, edits and
publishes a form twice to check schema history, downloads QR assets, follows
the local short URL, submits the public form with JavaScript disabled, and
exports responses as CSV. It checks the template gallery, template detail,
builder, and respondent page at desktop and mobile widths. No real email is
sent.

The older Miniflare/D1 harness below is retained only for PR48/Cloudflare
reference. It is not the E2E path for the Bun + PostgreSQL deployment.

To run the historical Worker harness, install the repository's development
dependencies and Chromium, then run:

```powershell
pnpm exec playwright test --config apps/web/e2e/playwright.config.mjs
```

The test uses a unique run ID for the email, form title, slug, and fake credentials. It refuses to run if its discovered repository root does not end in `URLX`, rejects non-loopback API targets, and removes its temporary workspace and Miniflare database on completion. Screenshots are synthetic review artifacts; they contain no user data. Downloaded QR/CSV artifacts and transient Playwright results stay under the ignored `artifacts/` directory.
