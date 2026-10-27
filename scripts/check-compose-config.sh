#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
compose_project="${URLX_COMPOSE_PROJECT:-urlx}"
if [[ ! "$compose_project" =~ ^urlx(-[a-z0-9][a-z0-9_-]{0,42})?$ ]]; then
	echo "URLX_COMPOSE_PROJECT must be urlx or start with urlx- and use lowercase Compose-safe characters." >&2
	exit 64
fi

# Compose resolves the active profiles from the shell and dotenv sources. Pass
# only the profile list to the validator; other environment values stay in pipes.
active_profiles="$(docker compose --project-name "$compose_project" config --environment | python3 scripts/compose-active-profiles.py)"
COMPOSE_PROFILES="$active_profiles" docker compose --project-name "$compose_project" config --format json | python3 scripts/check-deployment-config.py
