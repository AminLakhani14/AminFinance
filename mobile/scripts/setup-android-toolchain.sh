#!/usr/bin/env bash
# Installs a JDK 17 and the Android SDK command-line tools into the user's home
# folder (no admin rights), then the SDK packages an Expo/React Native release
# build needs. Safe to re-run: finished steps are skipped.
#
# Windows, from Git Bash. Versions match what React Native 0.86 (Expo SDK 57)
# builds against: compileSdk 36, build-tools 36.0.0, NDK 27.1, CMake 3.22.1.
# scripts/build-apk.mjs finds these locations without any further setup.
set -euo pipefail
ROOT="$HOME/AndroidBuild"
mkdir -p "$ROOT"
JDK_DIR="$ROOT/jdk-17"
SDK="$LOCALAPPDATA/Android/Sdk"
cd "$ROOT"

if [ ! -x "$JDK_DIR/bin/java.exe" ]; then
  echo "[jdk] downloading Temurin 17"
  curl -sSL -o jdk.zip "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse"
  rm -rf jdk-extract && mkdir jdk-extract && unzip -q jdk.zip -d jdk-extract
  rm -rf "$JDK_DIR" && mv jdk-extract/* "$JDK_DIR" && rm -rf jdk-extract jdk.zip
fi
"$JDK_DIR/bin/java.exe" -version 2>&1 | head -1

if [ ! -f "$SDK/cmdline-tools/latest/bin/sdkmanager.bat" ]; then
  echo "[sdk] downloading command-line tools"
  mkdir -p "$SDK/cmdline-tools"
  curl -sSL -o cmdtools.zip "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip"
  rm -rf "$SDK/cmdline-tools/latest" "$SDK/cmdline-tools/cmdline-tools"
  unzip -q cmdtools.zip -d "$SDK/cmdline-tools" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest" && rm cmdtools.zip
fi

export JAVA_HOME="$(cygpath -w "$JDK_DIR")"
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager.bat"
echo "[sdk] accepting licences"
yes | "$SDKM" --sdk_root="$(cygpath -w "$SDK")" --licenses > /dev/null 2>&1 || true
echo "[sdk] installing platform-tools, platform 36, build-tools 36, NDK 27.1, CMake 3.22.1"
"$SDKM" --sdk_root="$(cygpath -w "$SDK")" "platform-tools" "platforms;android-36" "build-tools;36.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1" 2>&1 | grep -v "^\[=*" | tail -3
echo "[done] JDK at $JDK_DIR, SDK at $SDK"
ls "$SDK"
