#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
: "${ANDROID_HOME:?Use a runner with an existing Android SDK.}"
if [[ -n "${JAVA_HOME_17_X64:-}" ]]; then export JAVA_HOME="$JAVA_HOME_17_X64"; fi
: "${JAVA_HOME:?JDK 17 is required.}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

# No sdkmanager license acceptance and no automatic SDK install. Missing pinned tools fail clearly.
for required in "$ANDROID_HOME/platforms/android-35/android.jar" \
                "$ANDROID_HOME/build-tools/35.0.0/aapt2"; do
  if [[ ! -f "$required" ]]; then
    printf 'Required preinstalled Android component missing: %s\n' "$required" >&2
    exit 1
  fi
done

mkdir -p build/ci-evidence
java -version 2> build/ci-evidence/java-version.txt
git rev-parse HEAD > build/ci-evidence/commit.txt
cp "$ANDROID_HOME/platforms/android-35/source.properties" build/ci-evidence/android-platform.properties
cp "$ANDROID_HOME/build-tools/35.0.0/source.properties" build/ci-evidence/android-build-tools.properties
bash ./gradlew --no-daemon --console=plain -Pandroid.builder.sdkDownload=false \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest
sha256sum app/build/outputs/apk/debug/app-debug.apk > build/ci-evidence/apk-sha256.txt
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose \
  app/build/outputs/apk/debug/app-debug.apk > build/ci-evidence/apk-signature.txt
