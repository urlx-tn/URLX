#!/bin/sh
set -eu

bun /app/check-egress-policy.ts
exec "$@"
