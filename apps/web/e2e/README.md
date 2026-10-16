# URLX Forms browser check

This browser check exercises the Astro pages against the real server Forms Hono app and oRPC router, loaded through the same Vite TypeScript transform used by the server test setup, with a disposable Miniflare D1 database. The browser creates a fresh synthetic account through a captured local magic link, edits and publishes a form twice to check schema history, downloads the generated QR assets, follows the local short URL, and submits the public form with JavaScript disabled. It saves desktop editor, mobile editor, response, and public response screenshots under `apps/web/e2e/artifacts/`.

The harness copies the source into a temporary workspace with `.env*`, `.git`, `.alchemy`, `.wrangler`, build output, and installed modules excluded. It links only the already-installed local dependency directories. Both HTTP servers bind to `127.0.0.1`; the API blocks all non-loopback fetches except a captured fake Resend request. D1 is created in-process, receives only the repository migrations, and is disposed after the run. No real email is sent.

Run after installing the repository's development dependencies and Chromium:

```powershell
pnpm exec playwright test --config apps/web/e2e/playwright.config.mjs
```

The test uses a unique run ID for the email, form title, slug, and fake credentials. It refuses to run if its discovered repository root does not end in `URLX`, rejects non-loopback API targets, and removes its temporary workspace and Miniflare database on completion. The checked-in screenshot and QR files are synthetic review artifacts; they contain no user data.
