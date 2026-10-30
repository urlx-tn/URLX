#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--apply" ]]; then
	cat >&2 <<'EOF'
This command starts URLX's idle-gated containers and changes only the
URLX-specific nftables table on this Linux host. Review deploy/egress.md first.
Run it only on the target Linux Docker host after the host policy is approved:

  pnpm egress:prepare
EOF
	exit 64
fi

if [[ "$(uname -s)" != "Linux" || "$(id -u)" != "0" ]]; then
	echo "Run as root on the Linux Docker host so nftables policy can be verified." >&2
	exit 77
fi

for command_name in docker ip jq nft python3 flock; do
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
python3 scripts/prepare-egress-gate.py --project "$compose_project" --policy-dir "$policy_dir" --preflight-only
bash scripts/check-compose-config.sh
umask 022

# Stop egress clients and the proxy before changing the host policy. Their
# entrypoints will remain behind the manifest barrier when they restart.
egress_clients_output="$(python3 scripts/prepare-egress-gate.py --project "$compose_project" --list-egress-clients)"
egress_clients=()
mkdir -p "$policy_dir"
chmod 0755 "$policy_dir"
if [[ -n "$egress_clients_output" ]]; then
	mapfile -t egress_clients <<< "$egress_clients_output"
	docker compose --project-name "$compose_project" stop "${egress_clients[@]}" >/dev/null
	running_clients="$(docker compose --project-name "$compose_project" ps --status running -q "${egress_clients[@]}")"
	if [[ -n "$running_clients" ]]; then
		echo "URLX egress clients are still running; refusing to change the host policy." >&2
		exit 70
	fi
fi
python3 scripts/prepare-egress-gate.py --project "$compose_project" --check-active-only
python3 scripts/prepare-egress-gate.py --project "$compose_project" --policy-dir "$policy_dir" --check-owner-only
python3 scripts/prepare-egress-gate.py --project "$compose_project" --policy-dir "$policy_dir" --invalidate-runtime-only

ip -j address show | jq -r '.[].addr_info[]?.local' | sort -u > "$policy_dir/host-denylist.txt"
if [[ ! -s "$policy_dir/host-denylist.txt" ]]; then
	echo "No host interface addresses were discovered; refusing to start URLX." >&2
	exit 78
fi
chmod 0644 "$policy_dir/host-denylist.txt"

# PostgreSQL, Valkey, and the one-shot migrator start on internal networks.
# Egress clients stay behind their policy barriers until fresh rules and the
# owner-bound readiness manifest are written below.
docker compose --project-name "$compose_project" up --detach --no-build

python3 scripts/prepare-egress-gate.py --project "$compose_project" --policy-dir "$policy_dir"

echo "URLX host egress gate is installed and the verified manifest was written."
echo "Check readiness with: docker compose ps"
