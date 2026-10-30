#!/bin/sh
set -eu

denylist=/run/urlx-egress/host-denylist.txt
manifest=/run/urlx-egress/ready.json
if [ ! -s "$denylist" ] || grep -Eqv '^[0-9A-Fa-f:.]+$' "$denylist"; then
	echo "Refusing to start: host IP denylist is missing or malformed" >&2
	exit 78
fi

hostname="$(cat /etc/hostname)"
netns="$(readlink /proc/self/ns/net)"
deadline=$(( $(date +%s) + 300 ))
while :; do
	if [ -s "$manifest" ] \
		&& grep -Eq '"policyVersion"[[:space:]]*:[[:space:]]*1' "$manifest" \
		&& grep -Eq '"ruleSetHash"[[:space:]]*:[[:space:]]*"[a-fA-F0-9]{64}"' "$manifest" \
		&& grep -Eq "\"containerId\"[[:space:]]*:[[:space:]]*\"${hostname}[a-fA-F0-9]{52}\"" "$manifest" \
		&& grep -Fq "\"netns\": \"${netns}\"" "$manifest"; then
		verified_at="$(sed -n 's/.*"verifiedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
		verified_epoch="$(date -u -d "$verified_at" +%s 2>/dev/null || true)"
		now="$(date -u +%s)"
		if [ -n "$verified_epoch" ] && [ "$verified_epoch" -le "$now" ] && [ $((now - verified_epoch)) -le 2592000 ]; then
			missing_address=0
			while IFS= read -r address; do
				if ! grep -Fq "\"${address}\"" "$manifest"; then
					missing_address=1
					break
				fi
			done < "$denylist"
			if [ "$missing_address" -eq 0 ]; then
				break
			fi
		fi
	fi
	if [ "$(date +%s)" -ge "$deadline" ]; then
		echo "Refusing to start: verified host egress policy manifest is missing, stale, or mismatched" >&2
		exit 78
	fi
	sleep 1
done

exec squid -N -f /etc/squid/squid.conf
