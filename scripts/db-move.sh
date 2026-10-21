#!/usr/bin/env bash
# Whole-database move with plain Postgres tools (schema + data), e.g. local -> Neon, or Neon -> another host:
#   FROM_URL=postgres://... TO_URL=postgres://... scripts/db-move.sh
# The target should be an empty database. No host-specific features are used (no extensions, no roles).
set -euo pipefail
: "${FROM_URL:?set FROM_URL}" "${TO_URL:?set TO_URL}"
dump="$(mktemp -t stoke-XXXX.dump)"
trap 'rm -f "$dump"' EXIT
pg_dump --format=custom --no-owner --no-privileges --dbname="$FROM_URL" --file="$dump"
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$TO_URL" "$dump"
echo "moved $(pg_restore --list "$dump" | grep -c 'TABLE DATA') tables"
