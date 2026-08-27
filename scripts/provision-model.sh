#!/usr/bin/env bash
#
# Push the two on-device models onto the watch, into the app's external files dir:
#   - the LLM (GGUF)          -> files/model.gguf
#   - the Vosk STT model (zip) -> files/vosk-model.zip   (the app unzips it on first run)
#
# Models are NOT bundled in the APK (they're big). Provision them once with this script;
# they persist across reboots and app updates (a full uninstall / "clear data" wipes them).
#
# Usage:  ./scripts/provision-model.sh [device-serial]
#   LLM_GGUF and VOSK_ZIP env vars override the file paths.
set -euo pipefail

SERIAL="${1:-}"
ADB=(adb); [ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")
FILES=/sdcard/Android/data/com.wearllmapp/files

LLM_GGUF="${LLM_GGUF:-SmolLM2-360M-Instruct-Q4_K_M.gguf}"
VOSK_ZIP="${VOSK_ZIP:-vosk-small-en.zip}"

"${ADB[@]}" shell "mkdir -p $FILES"

# --- LLM ---
if [ -f "$LLM_GGUF" ]; then
  echo ">> Pushing LLM $LLM_GGUF -> $FILES/model.gguf"
  "${ADB[@]}" push "$LLM_GGUF" "$FILES/model.gguf"
else
  echo "!! LLM model '$LLM_GGUF' not found. Download it with:"
  echo '   curl -L -o SmolLM2-360M-Instruct-Q4_K_M.gguf \'
  echo '     "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf?download=true"'
fi

# --- Vosk STT (single-file zip; the app unzips it into internal storage on first run) ---
if [ -f "$VOSK_ZIP" ]; then
  echo ">> Pushing Vosk STT $VOSK_ZIP -> $FILES/vosk-model.zip"
  "${ADB[@]}" push "$VOSK_ZIP" "$FILES/vosk-model.zip"
else
  echo "!! Vosk model zip '$VOSK_ZIP' not found. Download it with:"
  echo '   curl -L -o vosk-small-en.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip'
  echo '   (the small model is real-time on this watch; the larger lgraph model is too slow here)'
fi

echo ">> Done. Relaunch the app; it loads the LLM and unpacks the STT model on first run."
