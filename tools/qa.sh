#!/usr/bin/env bash
# QA screenshots from the real web export of HEAD: refuses a dirty tree, exports fresh into /tmp/kc-web-<sha>,
# serves that exact folder on :5055 (any older server is stopped), then runs tools/qa-screens.mjs (stamps <sha>).
set -euo pipefail
cd "$(dirname "$0")/.."
git diff --quiet HEAD || { echo "commit first: screenshots must match a commit" >&2; exit 1; }
SHA=$(git rev-parse --short HEAD); DIR=/tmp/kc-web-$SHA
rm -rf "$DIR"
EXPO_PUBLIC_MOCK_AI=1 EXPO_PUBLIC_MOCK_AI_DELAY=4000 npx expo export --platform web --output-dir "$DIR" >/tmp/qa-export.log 2>&1
pkill -f "serve -s /tmp/kc-web" || true
(npx serve -s "$DIR" -l 5055 >/tmp/serve.log 2>&1 &)
for _ in $(seq 30); do curl -s -o /dev/null localhost:5055 && break; sleep 1; done
QA_SHA=$SHA node tools/qa-screens.mjs
echo "screenshots for $SHA in ${OUT:-/workspace/calorie/design/qa}"
