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
unzip -p "$OUT" assets/app.config | grep -q '"healthConnect":true' || { echo "healthConnect flag missing" >&2; exit 1; }
BT=$(ls -d ~/android-sdk/build-tools/* | tail -1)
if "$BT/aapt2" dump permissions "$OUT" | grep -q SYSTEM_ALERT_WINDOW; then echo "SYSTEM_ALERT_WINDOW still requested" >&2; exit 1; fi
EXTRA=$("$BT/aapt2" dump permissions "$OUT" | sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" | sort -u | grep -vxF "$ALLOWED" || true)
if [ -n "$EXTRA" ]; then echo "permissions not on the allowlist: $EXTRA" >&2; exit 1; fi
echo "built $OUT"
