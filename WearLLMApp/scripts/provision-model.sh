#!/usr/bin/env bash
#
# Push the GGUF model onto the watch, into the app's external files dir where the
# on-device server reads it: /sdcard/Android/data/com.wearllmapp/files/model.gguf
#
# The model is NOT bundled in the APK (it is ~260 MB). Provision it once with this
# script; it persists across reboots and app updates (but a full uninstall or
# "clear data" wipes it — just re-run this).
#
# Usage:  ./scripts/provision-model.sh [path-to.gguf] [device-serial]
set -euo pipefail

MODEL="${1:-SmolLM2-360M-Instruct-Q4_K_M.gguf}"
SERIAL="${2:-}"
ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

if [ ! -f "$MODEL" ]; then
  echo "Model file '$MODEL' not found."
  echo "Download the default (SmolLM2-360M-Instruct Q4_K_M, ~260 MB):"
  echo '  curl -L -o SmolLM2-360M-Instruct-Q4_K_M.gguf \'
  echo '    "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf?download=true"'
  exit 1
fi

DIR=/sdcard/Android/data/com.wearllmapp/files
echo ">> Ensuring $DIR exists on the watch"
"${ADB[@]}" shell "mkdir -p $DIR"
echo ">> Pushing $MODEL -> $DIR/model.gguf"
"${ADB[@]}" push "$MODEL" "$DIR/model.gguf"
"${ADB[@]}" shell "ls -l $DIR/model.gguf"
echo ">> Done. Relaunch the app; it will load this model on the watch."
