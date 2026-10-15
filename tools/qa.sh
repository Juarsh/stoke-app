#!/usr/bin/env bash
# QA screenshots from the real web export of HEAD: refuses any uncommitted or untracked change, exports fresh into
# /tmp/kc-web-<sha>, serves that folder on $QA_PORT with a server it starts itself (own process group, PID saved),
# runs tools/qa-screens.mjs (stamps <sha> in file names + corner label), then stops only that server.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "commit first (incl. untracked files): screenshots must match a commit" >&2; git status --porcelain >&2; exit 1; }
SHA=$(git rev-parse --short HEAD); DIR=/tmp/kc-web-$SHA; PORT=${QA_PORT:-5055}
if curl -s -o /dev/null "localhost:$PORT"; then echo "port $PORT is busy (not ours); set QA_PORT" >&2; exit 1; fi
rm -rf "$DIR"
EXPO_PUBLIC_MOCK_AI=1 EXPO_PUBLIC_MOCK_AI_DELAY=4000 npx expo export --platform web --output-dir "$DIR" >/tmp/qa-export.log 2>&1
setsid npx serve -s "$DIR" -l "$PORT" >/tmp/qa-serve.log 2>&1 &
PID=$!
stop() { kill -- "-$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true; }
trap stop EXIT
for _ in $(seq 30); do curl -s -o /dev/null "localhost:$PORT" && break; sleep 1; done
BASE="http://localhost:$PORT" QA_SHA=$SHA node tools/qa-screens.mjs
echo "screenshots for $SHA in ${OUT:-/workspace/calorie/design/qa}"
