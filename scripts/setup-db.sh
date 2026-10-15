#!/usr/bin/env bash
# Recreate the local Postgres setup. Safe to rerun.
#  - installs/starts Postgres if missing
#  - role calorie (password calorie) with CREATEDB
#  - databases calorie and calorie_test, owned by calorie
#  - runs the migrations on both (the API migrates on start)
set -euo pipefail
cd "$(dirname "$0")/.."
PGROLE=${PGROLE:-calorie}; PGPASS=${PGPASS:-calorie}
if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null
fi
if ! pg_isready -q -h localhost; then
  sudo service postgresql start >/dev/null 2>&1 || sudo pg_ctlcluster "$(ls /etc/postgresql | sort -V | tail -1)" main start
  for _ in $(seq 30); do pg_isready -q -h localhost && break; sleep 1; done
fi
psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtAc "$1"; }
if [ -z "$(psql_su "SELECT 1 FROM pg_roles WHERE rolname='$PGROLE'")" ]; then
  psql_su "CREATE ROLE $PGROLE LOGIN CREATEDB PASSWORD '$PGPASS'"
else
  psql_su "ALTER ROLE $PGROLE LOGIN CREATEDB PASSWORD '$PGPASS'"
fi
for db in calorie calorie_test; do
  [ -n "$(psql_su "SELECT 1 FROM pg_database WHERE datname='$db'")" ] || psql_su "CREATE DATABASE $db OWNER $PGROLE"
done
go build -o /tmp/ct-setup-api ./cmd/api
for db in calorie calorie_test; do
  log=$(mktemp)
  DATABASE_URL="postgres://$PGROLE:$PGPASS@localhost:5432/$db" APP_ENV=dev AUTH_MODE=dev AI_MODE=stub PORT=${MIGRATE_PORT:-18099} \
    /tmp/ct-setup-api >"$log" 2>&1 & pid=$!
  ok=
  for _ in $(seq 60); do grep -q "listening" "$log" && ok=1 && break; kill -0 $pid 2>/dev/null || break; sleep 0.5; done
  kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
  [ -n "$ok" ] || { echo "migrations failed on $db:"; cat "$log"; exit 1; }
  echo "migrated $db"
done
echo "ok: role $PGROLE (CREATEDB), databases calorie + calorie_test"
