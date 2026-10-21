#!/usr/bin/env bash
# Release APK (arm64) from a fresh JS bundle: tools/build-apk.sh <out.apk>
# The release build turns Health Connect on (Tester P1 B1); the app still never prompts by itself (only "Connect" asks).
# No backend URL and no AI key go into the build (mock/local mode). Expo Go / web runs leave the flag off.
set -euo pipefail
OUT=${1:?usage: tools/build-apk.sh <out.apk>}
cd "$(dirname "$0")/../android"
rm -f app/build/generated/assets/react/release/index.android.bundle
(
  source /workspace/calorie/run/android-env.sh
  unset GEMINI_API_KEY EXPO_PUBLIC_API_URL
  export EXPO_NO_TELEMETRY=1 CI=1 EXPO_PUBLIC_FLAG_HEALTH_CONNECT=1
  NODE_ENV=production ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a -Porg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g" > log 2>&1
)
cp app/build/outputs/apk/release/app-release.apk "$OUT"
# checks: the flag is in the embedded config, and the dev overlay permission is gone
unzip -p "$OUT" assets/app.config | grep -q '"healthConnect":true' || { echo "healthConnect flag missing" >&2; exit 1; }
BT=$(ls -d ~/android-sdk/build-tools/* | tail -1)
if "$BT/aapt2" dump permissions "$OUT" | grep -q SYSTEM_ALERT_WINDOW; then echo "SYSTEM_ALERT_WINDOW still requested" >&2; exit 1; fi
echo "built $OUT"
