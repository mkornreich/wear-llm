#!/usr/bin/env bash
#
# Build the standalone release APK, install it on the watch, provision the model
# if needed, and launch. This is the "just run it on the watch" path — no Metro,
# no laptop dependency once installed.
#
# Usage:  ./scripts/build-and-run.sh [device-serial]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# --- Toolchain: JDK 21 (Android Studio's JBR) + the local SDK ---
export JAVA_HOME="${JAVA_HOME:-/home/mk/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-/home/mk/Android/Sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

SERIAL="${1:-}"
ADB=(adb); [ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

echo ">> Java: $(java -version 2>&1 | head -1)"
echo ">> Building release APK (bundled JS + on-device llama-server)…"
( cd android && ./gradlew :app:assembleRelease --console=plain )

APK="android/app/build/outputs/apk/release/app-release.apk"
echo ">> Installing $APK"
"${ADB[@]}" install -r "$APK"

# Provision the model if it isn't already on the device.
DIR=/sdcard/Android/data/com.wearllmapp/files
if ! "${ADB[@]}" shell "test -s $DIR/model.gguf" 2>/dev/null; then
  echo ">> Model not found on device — provisioning…"
  MODEL="${MODEL:-SmolLM2-360M-Instruct-Q4_K_M.gguf}"
  "$HERE/scripts/provision-model.sh" "$MODEL" "$SERIAL"
fi

echo ">> Launching app"
"${ADB[@]}" shell monkey -p com.wearllmapp -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo ">> Done. The watch loads the model (~10-20s first time), then you can tap Speak."
echo ">> To watch the on-device server: adb logcat -s LlamaServerProc:I"
