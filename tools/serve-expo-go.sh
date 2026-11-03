#!/usr/bin/env bash
# Expo Go link on :8082 (exp://oxtgtfa-juarsh-8082.exp.direct), SDK 58. Run from the expo worktree:
#   cd /workspace/workouts-app-expo && bash tools/serve-expo-go.sh
# - Node 22 (SDK 58's CLI needs >= 22.13; the box's system node is 20).
# - --tunnel ngrok keeps the exp.direct link (SDK 58's default tunnel would hand out a new *.on.expo.app one).
# - EXPO_PACKAGER_PROXY_URL makes the manifest point the phone at the bundle over https. Over plain http the 11.7 MB
#   streamed bundle failed on the iPhone ("Could not connect to development server", an NSURLError mid-download).
# - Never Reload from the red screen on iOS Expo Go 58.0.5: that in-place reload comes up with no Expo modules
#   ("Cannot find native module 'ExpoAsset'", expo/expo#52146, fixed in Expo Go 58.0.7). Reopen the link instead.
set -euo pipefail
export PATH=/opt/node22/bin:$PATH
HOST=oxtgtfa-juarsh-8082.exp.direct
pkill -f "expo start --port 8082" || true
sleep 2
env -u GEMINI_API_KEY CI=1 EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_API_URL=https://stoke-api.onrender.com EXPO_PUBLIC_FLAG_HEALTH_CONNECT=0 \
  EAS_PROJECT_ID=be75333e-46d4-4d8b-a4be-ea39bcd21402 EXPO_PACKAGER_PROXY_URL=https://$HOST \
  nohup npx expo start --port 8082 --tunnel ngrok --clear > /workspace/calorie/run/expo-8082-stable.log 2>&1 &
echo "started; log /workspace/calorie/run/expo-8082-stable.log"
