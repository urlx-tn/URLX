# SQLite snapshot import to PostgreSQL

The importer copies a current URLX SQLite/D1 database snapshot into a fresh,
migrated PostgreSQL database. It preserves primary IDs, auth sessions and
tokens, aliases and tombstones, millisecond timestamps, retained responses,
monthly accepted-response counters (including deleted responses), and
`form_limits`. The PostgreSQL target must use UTF8 server encoding so imported
Unicode text can be represented exactly. The importer checks this before its
dry-run or apply target checks. It does not access the Cloudflare account,
export D1, or copy data over a network.

The input must be a SQLite database file using the repository's current
historical SQLite migration schema. Keep the snapshot outside the checkout and
make it read-only after export. A raw SQL export is not accepted directly; first
restore it into a local SQLite file using a separately reviewed procedure.

## Dry run

Set `MIGRATOR_DATABASE_URL` in the local environment to a dedicated, migrated,
empty PostgreSQL target using the restricted `urlx_migrator` role. Do not put
the URL on the command line. The importer does not print connection details or
row contents.

Run a source-only check first:

```sh
pnpm --filter @urlx/db test:import-sqlite
pnpm --filter @urlx/db exec bun ./scripts/import-sqlite-to-postgres.ts --source-only --source /absolute/path/outside/checkout/urlx.sqlite
```

Then run the default target dry run:

```sh
pnpm --filter @urlx/db db:import-sqlite -- --source /absolute/path/outside/checkout/urlx.sqlite
```

Dry run validates SQLite integrity, foreign keys, schema columns, target role,
UTF8 server encoding, and that the PostgreSQL application tables are empty. It
reports row counts and SHA-256 checksums of primary keys only. The fresh
migration's default `form_limits` row is permitted; changed limit values or any
other target data cause refusal.

## Apply

Review the dry-run report and confirm that the target database is dedicated to
this import. Apply requires both `--apply` and the exact database name returned
by the dry run:

```sh
pnpm --filter @urlx/db db:import-sqlite -- --source /absolute/path/outside/checkout/urlx.sqlite --apply --confirm-empty-target urlx
```

The importer rechecks emptiness while holding locks, copies rows in bounded
100-row source pages and parameter-bounded PostgreSQL batches, and performs all
writes in one transaction. It pins one SQLite read transaction from source
preflight through final reconciliation; still use a frozen, read-only snapshot
so another process cannot replace or mutate the source file during an import.
It disables only user triggers on
`form_responses` during import so historical rows do not re-run monthly quota
or retention logic; PostgreSQL foreign-key triggers remain enabled. It restores
the user triggers before commit. Any insert, validation, or reconciliation
error rolls the entire transaction back.

Before commit, it compares per-table row counts and keyed content MACs in
memory, checks that PostgreSQL foreign keys are validated, and reports
primary-key checksums without exposing row values, email addresses, session
tokens, or credentials. The keyed content MAC is ephemeral and is not printed
or stored.

The importer does not merge into a live database, delete existing records,
recompute monthly usage from retained responses, or establish a production
cutover. Run it only against a newly migrated, dedicated empty target. Keep the
original D1 database and snapshot unchanged until a separately reviewed
migration and rollback plan is approved.
