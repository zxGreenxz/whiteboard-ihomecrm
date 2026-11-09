#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
: "${ANDROID_HOME:?Use a runner with an existing Android SDK.}"
if [[ -n "${JAVA_HOME_17_X64:-}" ]]; then export JAVA_HOME="$JAVA_HOME_17_X64"; fi
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
mkdir -p build/ci-evidence

# The workflow may provision these components only under an already accepted SDK license.
# This script never accepts agreements or silently skips native verification.
image="$ANDROID_HOME/system-images/android-35/google_apis/x86_64"
if [[ ! -x "$ANDROID_HOME/emulator/emulator" || ! -f "$image/package.xml" ]]; then
  printf 'Native verification requires preinstalled emulator and android-35/google_apis/x86_64.\n' >&2
  exit 1
fi
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  printf 'Native verification requires accessible KVM on the disposable CI runner.\n' >&2
  exit 1
fi
avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
if [[ ! -x "$avdmanager" ]]; then
  printf 'Preinstalled avdmanager not found.\n' >&2
  exit 1
fi
# The Java AVD manager and native emulator must share one explicit user/AVD home.
# Runner defaults can otherwise create the .ini outside the emulator's search path.
export ANDROID_USER_HOME="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ihome-android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
mkdir -p "$ANDROID_AVD_HOME"
printf 'no\n' | "$avdmanager" create avd --force --name ihome-fixture \
  --package 'system-images;android-35;google_apis;x86_64' --device pixel_5 \
  --path "$ANDROID_AVD_HOME/ihome-fixture.avd"
test -s "$ANDROID_AVD_HOME/ihome-fixture.ini"
emulator -list-avds > build/ci-evidence/avd-list.txt
grep -Fxq 'ihome-fixture' build/ci-evidence/avd-list.txt
emulator -avd ihome-fixture -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -wipe-data > build/ci-evidence/emulator.log 2>&1 &
emulator_pid=$!
cleanup() {
  adb emu kill >/dev/null 2>&1 || true
  wait "$emulator_pid" 2>/dev/null || true
}
trap cleanup EXIT
booted=false
for attempt in $(seq 1 120); do
  if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == '1' ]]; then
    booted=true
    break
  fi
  if ! kill -0 "$emulator_pid" 2>/dev/null; then
    cat build/ci-evidence/emulator.log >&2
    exit 1
  fi
  sleep 2
done
if [[ "$booted" != true ]]; then printf 'Android emulator did not boot.\n' >&2; exit 1; fi
adb shell input keyevent 82
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell cmd location set-location-enabled true
cp "$image/source.properties" build/ci-evidence/android-system-image.properties
adb shell getprop ro.build.fingerprint > build/ci-evidence/android-fingerprint.txt

# QueueRestartProbe needs two processes, so it runs by itself below.
bash ./gradlew --no-daemon --console=plain -Pandroid.builder.sdkDownload=false \
  -Pandroid.testInstrumentationRunnerArguments.notClass=vn.ihome.diemdanh.QueueRestartProbe \
  :app:connectedDebugAndroidTest

# Every declared test must have run; a skip is not a pass.
declared="$(grep -c '@Test' app/src/androidTest/java/vn/ihome/diemdanh/DiemDanhDeviceTest.java)"
reports=(app/build/outputs/androidTest-results/connected/debug/TEST-*.xml)
if [[ "${#reports[@]}" != 1 ]] \
    || ! grep -q "tests=\"$declared\" failures=\"0\" errors=\"0\" skipped=\"0\"" "${reports[0]}"; then
  printf 'Expected all %s device tests to pass with none skipped.\n' "$declared" >&2
  exit 1
fi

# AGP uninstalls the app after the run, so the tests leave these with the shell user.
for shot in setup status; do
  adb pull "/data/local/tmp/diemdanh-$shot.png" "build/ci-evidence/$shot.png"
  if [[ "$(head -c 8 "build/ci-evidence/$shot.png" | od -An -tx1 | tr -d ' \n')" != '89504e470d0a1a0a' ]]; then
    printf 'Screenshot %s is not a PNG.\n' "$shot" >&2
    exit 1
  fi
done

# Encrypted queue across a real process restart: seed, force-stop, read back in a new process.
adb install -r -t app/build/outputs/apk/debug/app-debug.apk
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
runner="$(adb shell pm list instrumentation | tr -d '\r' | sed -n 's#^instrumentation:\(vn\.ihome\.diemdanh[^ ]*\) .*#\1#p' | head -n 1)"
test -n "$runner"
for step in seed verify; do
  adb shell am force-stop vn.ihome.diemdanh.thu
  adb shell am instrument -w -r -e class "vn.ihome.diemdanh.QueueRestartProbe#$step" "$runner" \
    | tee "build/ci-evidence/queue-restart-$step.txt"
  if ! grep -q 'OK (1 test)' "build/ci-evidence/queue-restart-$step.txt"; then
    printf 'Queue restart step failed: %s\n' "$step" >&2
    exit 1
  fi
done
adb logcat -d -v brief 'AndroidRuntime:E' '*:S' > build/ci-evidence/android-runtime-errors.txt
