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
apk='app/build/outputs/apk/debug/app-debug.apk'
sha256sum "$apk" > build/ci-evidence/apk-sha256.txt
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose "$apk" > build/ci-evidence/apk-signature.txt

# The merged manifest may only hold plan 4.6 plus what androidx.work and androidx.core add.
"$ANDROID_HOME/build-tools/35.0.0/aapt2" dump permissions "$apk" > build/ci-evidence/apk-permissions.txt
sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" build/ci-evidence/apk-permissions.txt \
  | grep -v '\.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION$' | LC_ALL=C sort -u > build/ci-evidence/apk-permissions-actual.txt
LC_ALL=C sort -u > build/ci-evidence/apk-permissions-expected.txt <<'EOF'
android.permission.ACCESS_BACKGROUND_LOCATION
android.permission.ACCESS_COARSE_LOCATION
android.permission.ACCESS_FINE_LOCATION
android.permission.ACCESS_NETWORK_STATE
android.permission.FOREGROUND_SERVICE
android.permission.FOREGROUND_SERVICE_LOCATION
android.permission.INTERNET
android.permission.POST_NOTIFICATIONS
android.permission.RECEIVE_BOOT_COMPLETED
android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
android.permission.SCHEDULE_EXACT_ALARM
android.permission.USE_EXACT_ALARM
android.permission.WAKE_LOCK
EOF
if ! diff build/ci-evidence/apk-permissions-expected.txt build/ci-evidence/apk-permissions-actual.txt; then
  printf 'APK permissions differ from the approved list.\n' >&2
  exit 1
fi
if ! grep -q "SCHEDULE_EXACT_ALARM' maxSdkVersion='32'" build/ci-evidence/apk-permissions.txt; then
  printf 'SCHEDULE_EXACT_ALARM must stop at Android 12L.\n' >&2
  exit 1
fi
