#!/usr/bin/env bash
# Release APK (arm64) from a fresh JS bundle: tools/build-apk.sh <out.apk>
# The release build turns Health Connect on (Tester P1 B1); the app still never prompts by itself (only "Connect" asks).
# No AI key ever goes into the build. No backend URL either (mock/local mode) unless EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN=1
# (item 16): then EXPO_PUBLIC_API_URL (default https://stoke-api.onrender.com, app.config.ts) and the public Google client
# ids go in, and the check below makes sure they did. Expo Go / web runs leave the flags off.
set -euo pipefail
OUT=${1:?usage: tools/build-apk.sh <out.apk>}
cd "$(dirname "$0")/../android"
rm -f app/build/generated/assets/react/release/index.android.bundle
(
  source /workspace/calorie/run/android-env.sh
  unset GEMINI_API_KEY EXPO_TOKEN GITHUB_STOKE_TOKEN STOKE_DATABASE_URL
  [ "${EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN:-}" = 1 ] || unset EXPO_PUBLIC_API_URL
  export EXPO_NO_TELEMETRY=1 CI=1 EXPO_PUBLIC_FLAG_HEALTH_CONNECT=1
  NODE_ENV=production ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a -Porg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g" > log 2>&1
)
cp app/build/outputs/apk/release/app-release.apk "$OUT"
# checks: the flag is in the embedded config, the dev overlay permission is gone, and the APK asks for exactly the
# permissions on this allowlist (any new one fails the build until it is added here on purpose).
# POST_NOTIFICATIONS + RECEIVE_BOOT_COMPLETED: added on purpose for the rest-done local notification (Tester B1,
# expo-notifications; boot keeps a scheduled alert after a restart). No exact-alarm permission is requested.
ALLOWED='android.permission.INTERNET
android.permission.READ_EXTERNAL_STORAGE
android.permission.WRITE_EXTERNAL_STORAGE
android.permission.VIBRATE
android.permission.ACCESS_NETWORK_STATE
android.permission.health.READ_STEPS
android.permission.POST_NOTIFICATIONS
android.permission.RECEIVE_BOOT_COMPLETED
app.stokefit.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE'
CFG=$(unzip -p "$OUT" assets/app.config)
grep -q '"healthConnect":true' <<<"$CFG" || { echo "healthConnect flag missing" >&2; exit 1; }
if [ "${EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN:-}" = 1 ]; then
  grep -q '"googleSignIn":true' <<<"$CFG" || { echo "googleSignIn flag missing" >&2; exit 1; }
  grep -q '"apiUrl":"https://' <<<"$CFG" || { echo "sign-in build without an https API URL" >&2; exit 1; }
  grep -q '"googleWebClientId":"[0-9a-z-]*\.apps\.googleusercontent\.com"' <<<"$CFG" || { echo "web client id missing" >&2; exit 1; }
else
  grep -q '"apiUrl":""' <<<"$CFG" || { echo "a backend URL got into a local build" >&2; exit 1; }
fi
grep -qi 'GEMINI\|AIza' <<<"$CFG" && { echo "an AI key got into the build" >&2; exit 1; }
BT=$(ls -d ~/android-sdk/build-tools/* | tail -1)
if "$BT/aapt2" dump permissions "$OUT" | grep -q SYSTEM_ALERT_WINDOW; then echo "SYSTEM_ALERT_WINDOW still requested" >&2; exit 1; fi
EXTRA=$("$BT/aapt2" dump permissions "$OUT" | sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" | sort -u | grep -vxF "$ALLOWED" || true)
if [ -n "$EXTRA" ]; then echo "permissions not on the allowlist: $EXTRA" >&2; exit 1; fi
echo "built $OUT"
