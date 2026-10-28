#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" || "$(id -u)" != "0" ]]; then
	echo "Run as root on the Linux Docker host to remove URLX's nftables table." >&2
	exit 77
fi

for command_name in docker nft python3 flock; do
	command -v "$command_name" >/dev/null || {
		echo "Required host command is missing: $command_name" >&2
		exit 69
	}
done

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
install -d -m 0755 /run/lock
exec 9>/run/lock/urlx-egress-gate.lock
flock -n 9 || {
	echo "Another URLX host egress operation is in progress; refusing to continue." >&2
	exit 75
}
export URLX_EGRESS_LOCK_FD=9
compose_project="${URLX_COMPOSE_PROJECT:-urlx}"
if [[ ! "$compose_project" =~ ^urlx(-[a-z0-9][a-z0-9_-]{0,42})?$ ]]; then
	echo "URLX_COMPOSE_PROJECT must be urlx or start with urlx- and use lowercase Compose-safe characters." >&2
	exit 64
fi
policy_dir="$repo_root/deploy/egress/policy"
python3 scripts/prepare-egress-gate.py --project "$compose_project" --check-active-only
python3 scripts/prepare-egress-gate.py --project "$compose_project" --policy-dir "$policy_dir" --check-owner-only

# Stop every URLX workload before removing the host rule set or readiness data.
# Compose validates every `${VAR:?}` expression even for `down`. Supply inert
# values only to this teardown command so recovery still works if `.env` is
# missing or incomplete. `down` never starts a service or persists these values.
PUBLIC_ORIGIN=http://127.0.0.1 \
	PUBLIC_SERVER_URL=http://127.0.0.1 \
	PUBLIC_CONVERSION_SERVER_URL=http://127.0.0.1/convert \
URLX_HOST_MEMORY_BUDGET_BYTES=1000000000000 \
URLX_HOST_CPU_BUDGET=1000 \
WEB_MEMORY_LIMIT=1 \
WEB_CPU_LIMIT=0.01 \
API_MEMORY_LIMIT=1 \
API_CPU_LIMIT=0.01 \
CONVERSION_MEMORY_LIMIT=1 \
CONVERSION_CPU_LIMIT=0.01 \
CONVERSION_RENDERER_MEMORY_LIMIT=1 \
CONVERSION_RENDERER_CPU_LIMIT=0.01 \
POSTGRES_MEMORY_LIMIT=1 \
POSTGRES_CPU_LIMIT=0.01 \
MIGRATOR_MEMORY_LIMIT=1 \
MIGRATOR_CPU_LIMIT=0.01 \
EGRESS_PROXY_MEMORY_LIMIT=1 \
EGRESS_PROXY_CPU_LIMIT=0.01 \
	DATABASE_URL=postgresql://urlx_app:teardown@postgres:5432/urlx \
	MIGRATOR_DATABASE_URL=postgresql://urlx_migrator:teardown@postgres:5432/urlx \
	POSTGRES_BOOTSTRAP_PASSWORD=teardown \
	URLX_APP_PASSWORD=teardown \
	URLX_MIGRATOR_PASSWORD=teardown \
	PG_POOL_MAX=1 \
VALKEY_MAXMEMORY=1 \
	VALKEY_MEMORY_LIMIT=64m \
	VALKEY_CPU_LIMIT=0.5 \
	VISITOR_TOKEN_KEY_BASE64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
RENDERER_CONCURRENCY=1 \
RENDERER_MAX_QUEUE=0 \
	docker compose --project-name "$compose_project" down
python3 scripts/prepare-egress-gate.py --project "$compose_project" --check-active-only
python3 scripts/prepare-egress-gate.py --project "$compose_project" --policy-dir "$policy_dir" --check-owner-only
remaining_project="$(docker ps --quiet --filter "label=com.docker.compose.project=$compose_project")"
if [[ -n "$remaining_project" ]]; then
	echo "Containers for $compose_project are still running; retaining the egress gate." >&2
	exit 70
fi
if nft list table bridge urlx_egress >/dev/null 2>&1; then
	nft delete table bridge urlx_egress
fi
rm -f "$policy_dir/ready.json" "$policy_dir/ready.json.tmp"
rm -f "$policy_dir/host-denylist.txt"

echo "URLX containers are stopped; PostgreSQL volume is retained."
