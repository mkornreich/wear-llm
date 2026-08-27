#!/usr/bin/env bash
#
# Cross-compile the llama.cpp HTTP server as a 32-bit ARM (armeabi-v7a) Android
# binary for the Pixel Watch 3 (and other 32-bit Wear OS watches), then drop it
# into the app as jniLibs/armeabi-v7a/libllamaserver.so.
#
# The Pixel Watch 3 runs a fully 32-bit userspace (zygote32, armeabi-v7a only),
# so every mainstream on-device LLM lib (llama.rn, ExecuTorch, MLC, MediaPipe) —
# all arm64-only — refuses to build. llama.cpp itself DOES build for armeabi-v7a
# once you disable the one optional kernel that uses ARMv8-only FP16 NEON
# intrinsics: -DGGML_LLAMAFILE=OFF. Everything else compiles cleanly.
#
# Requirements: Android NDK (r27+), CMake + Ninja (the ones bundled with the
# Android SDK work fine). Adjust the paths below for your machine.
set -euo pipefail

NDK="${ANDROID_NDK:-$HOME/Android/Sdk/ndk/27.1.12297006}"
CMAKE_BIN_DIR="${CMAKE_BIN_DIR:-$HOME/Android/Sdk/cmake/3.22.1/bin}"   # provides cmake + ninja
LLAMA_SRC="${LLAMA_SRC:-$PWD/llama.cpp}"                               # a llama.cpp checkout
APP_JNILIBS="$(cd "$(dirname "$0")/.." && pwd)/android/app/src/main/jniLibs/armeabi-v7a"

export PATH="$CMAKE_BIN_DIR:$PATH"

if [ ! -d "$LLAMA_SRC" ]; then
  echo ">> Cloning llama.cpp into $LLAMA_SRC"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_SRC"
fi

BUILD="$LLAMA_SRC/build-v7a-static"
echo ">> Configuring (armeabi-v7a, static libc++, llamafile OFF)"
cmake -S "$LLAMA_SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=armeabi-v7a \
  -DANDROID_PLATFORM=android-24 \
  -DANDROID_STL=c++_static \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_LLAMAFILE=OFF \
  -DLLAMA_CURL=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_TOOLS=ON \
  -DLLAMA_BUILD_SERVER=ON

echo ">> Building llama-server"
cmake --build "$BUILD" --target llama-server -j"$(nproc)"

echo ">> Stripping + installing into the app as libllamaserver.so"
"$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" --strip-all "$BUILD/bin/llama-server"
mkdir -p "$APP_JNILIBS"
cp "$BUILD/bin/llama-server" "$APP_JNILIBS/libllamaserver.so"

echo ">> Done. $(ls -lh "$APP_JNILIBS/libllamaserver.so" | awk '{print $5}')  ->  $APP_JNILIBS/libllamaserver.so"
echo ">> It only needs system libs (libc/libm/libdl):"
"$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" -d "$APP_JNILIBS/libllamaserver.so" | grep NEEDED || true
