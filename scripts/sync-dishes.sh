#!/usr/bin/env bash
# Copies the shared dish table + parser rules + dev samples from the Go backend,
# then regenerates Go-parser golden outputs used by the jest parity tests.
set -euo pipefail
BACKEND="${BACKEND:-/workspace/calorie-tracker}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
cp "$BACKEND/internal/dishes/dishes.json" "$APP/src/data/dishes.json"
cp "$BACKEND/internal/parser/rules.json" "$APP/src/data/rules.json"
cp "$BACKEND/internal/parser/testdata/dev-meals.json" "$APP/src/data/dev-meals.json"
( cd "$BACKEND" && git rev-parse --short HEAD 2>/dev/null || echo unknown ) > "$APP/src/data/SOURCE_COMMIT"
if command -v go >/dev/null; then
  T="$(mktemp -d)"; mkdir -p "$T/parser" "$T/dishes"
  cp "$BACKEND/internal/parser/parser.go" "$BACKEND/internal/parser/rules.json" "$T/parser/"
  cp "$BACKEND/internal/dishes/dishes.go" "$BACKEND/internal/dishes/dishes.json" "$T/dishes/"
  sed -i 's#github.com/akarsh/calorie-tracker/internal/dishes#golden/dishes#' "$T/parser/parser.go"
  cp "$APP/scripts/golden/main.go" "$T/main.go"
  printf 'module golden\n\ngo 1.22\n' > "$T/go.mod"
  ( cd "$T" && go run . "$APP/src/data/dev-meals.json" "$APP/scripts/golden/extra-inputs.json" ) > "$APP/src/data/golden.json"
  rm -rf "$T"
  echo "golden.json regenerated from the Go parser"
fi
echo "synced $(node -e "console.log(require('$APP/src/data/dishes.json').length)") dishes"
