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
# Fetching the checksum-pinned distribution is safe to repeat; a build failure is never retried here.
for attempt in 1 2 3; do
  if bash ./gradlew --no-daemon --version > /dev/null; then break; fi
  if (( attempt == 3 )); then printf 'Gradle distribution could not be downloaded.\n' >&2; exit 1; fi
  sleep 20
done
bash ./gradlew --no-daemon --console=plain -Pandroid.builder.sdkDownload=false \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest

# One app, two features, each with its own JVM suite. Every declared test of both must have run.
for suite in vn/ihome/smsgateway/GatewayPolicyTest vn/ihome/diemdanh/CheckinPolicyTest; do
  declared="$(grep -c '@Test' "app/src/test/java/$suite.java")"
  report="app/build/test-results/testDebugUnitTest/TEST-${suite//\//.}.xml"
  summary=''
  if [[ -f "$report" ]]; then summary="$(grep -m 1 -o '<testsuite [^>]*>' "$report" || true)"; fi
  for expected in "tests=\"$declared\"" 'skipped="0"' 'failures="0"' 'errors="0"'; do
    if [[ "$summary" != *" $expected"* ]]; then
      printf 'Expected all %s JVM tests of %s to pass with none skipped.\n' "$declared" "${suite##*/}" >&2
      exit 1
    fi
  done
  printf '%s\n' "$summary" >> build/ci-evidence/jvm-suites.txt
done

apk='app/build/outputs/apk/debug/app-debug.apk'
sha256sum "$apk" > build/ci-evidence/apk-sha256.txt
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose "$apk" > build/ci-evidence/apk-signature.txt
# Package, version, label, launcher and permissions of the APK that the device step installs. The
# checks and the approved permission list live in ci-verify-apk.sh; ci-release.sh runs the same file
# on the signed release APK.
bash ./ci-verify-apk.sh "$apk" 'vn.ihome.smsgateway.thu' 'iHome Gateway (thử)' build/ci-evidence

# ci-release.sh runs on main only. A pull request therefore proves here that the verifier holds its
# arguments to the APK: this debug APK must be refused as the release package and under the release label.
mkdir -p build/ci-verify-refused
must_refuse() {
  local status=0
  bash ./ci-verify-apk.sh "$apk" "$2" "$3" build/ci-verify-refused \
    > /dev/null 2> build/ci-verify-refused/stderr.txt || status=$?
  if [[ "$status" != '1' ]] || ! grep -q "^$1" build/ci-verify-refused/stderr.txt; then
    printf 'ci-verify-apk.sh must refuse the debug APK as package %s with label %s.\n' "$2" "$3" >&2
    exit 1
  fi
  cat build/ci-verify-refused/stderr.txt >> build/ci-evidence/apk-verify-refusals.txt
}
must_refuse 'APK identity differs' 'vn.ihome.smsgateway' 'iHome Gateway (thử)'
must_refuse 'APK label differs' 'vn.ihome.smsgateway.thu' 'iHome Gateway'
printf 'ci-verify-apk.sh refused the debug APK as the release package and under the release label.\n'
