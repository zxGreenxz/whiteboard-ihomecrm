#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
: "${ANDROID_HOME:?Use a runner with an existing Android SDK.}"
if [[ -n "${JAVA_HOME_17_X64:-}" ]]; then export JAVA_HOME="$JAVA_HOME_17_X64"; fi
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
mkdir -p build/ci-evidence

# Android 15 is the target; Android 10 is the oldest phone in use and takes the pre-Android-12 paths.
apis=(35 29)

# The workflow may provision these components only under an already accepted SDK license.
# This script never accepts agreements or silently skips native verification.
if [[ ! -x "$ANDROID_HOME/emulator/emulator" ]]; then
  printf 'Native verification requires the preinstalled emulator.\n' >&2
  exit 1
fi
for api in "${apis[@]}"; do
  if [[ ! -f "$ANDROID_HOME/system-images/android-$api/google_apis/x86_64/package.xml" ]]; then
    printf 'Native verification requires android-%s/google_apis/x86_64.\n' "$api" >&2
    exit 1
  fi
done
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

emulator_pid=''
stop_emulator() {
  adb emu kill >/dev/null 2>&1 || true
  if [[ -n "$emulator_pid" ]]; then wait "$emulator_pid" 2>/dev/null || true; fi
  emulator_pid=''
}
trap stop_emulator EXIT

run_on_api() {
  local api="$1"
  local evidence="build/ci-evidence/android-$api"
  local avd="ihome-fixture-$api"
  mkdir -p "$evidence"
  printf 'no\n' | "$avdmanager" create avd --force --name "$avd" \
    --package "system-images;android-$api;google_apis;x86_64" --device pixel_5 \
    --path "$ANDROID_AVD_HOME/$avd.avd"
  test -s "$ANDROID_AVD_HOME/$avd.ini"
  emulator -list-avds > "$evidence/avd-list.txt"
  grep -Fxq "$avd" "$evidence/avd-list.txt"
  emulator -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot \
    -gpu swiftshader_indirect -wipe-data > "$evidence/emulator.log" 2>&1 &
  emulator_pid=$!
  local booted=false
  for attempt in $(seq 1 120); do
    if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == '1' ]]; then
      booted=true
      break
    fi
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      cat "$evidence/emulator.log" >&2
      exit 1
    fi
    sleep 2
  done
  if [[ "$booted" != true ]]; then printf 'Android %s emulator did not boot.\n' "$api" >&2; exit 1; fi
  adb shell input keyevent 82
  adb shell settings put global window_animation_scale 0
  adb shell settings put global transition_animation_scale 0
  adb shell settings put global animator_duration_scale 0
  if (( api >= 31 )); then
    adb shell cmd location set-location-enabled true
  else
    adb shell settings put secure location_mode 3
  fi
  cp "$ANDROID_HOME/system-images/android-$api/google_apis/x86_64/source.properties" "$evidence/android-system-image.properties"
  adb shell getprop ro.build.fingerprint > "$evidence/android-fingerprint.txt"

  # CleanInstallProbe needs separate processes on a fresh install, so it runs by itself below.
  rm -rf app/build/outputs/androidTest-results/connected
  bash ./gradlew --no-daemon --console=plain -Pandroid.builder.sdkDownload=false \
    -Pandroid.testInstrumentationRunnerArguments.notClass=vn.ihome.diemdanh.CleanInstallProbe \
    :app:connectedDebugAndroidTest

  # Every declared test must have run; a skip is not a pass.
  local declared
  declared="$(grep -c '@Test' app/src/androidTest/java/vn/ihome/diemdanh/DiemDanhDeviceTest.java)"
  local reports=(app/build/outputs/androidTest-results/connected/debug/TEST-*.xml)
  if [[ "${#reports[@]}" != 1 ]] \
      || ! grep -q "tests=\"$declared\" failures=\"0\" errors=\"0\" skipped=\"0\"" "${reports[0]}"; then
    printf 'Expected all %s device tests to pass with none skipped on Android %s.\n' "$declared" "$api" >&2
    exit 1
  fi
  cp -r app/build/outputs/androidTest-results/connected "$evidence/androidTest-results"

  # AGP uninstalled the app, so these steps start from a clean install with nothing granted.
  # Encrypted queue across a real process restart: seed, force-stop, read back in a new process.
  adb install -r -t app/build/outputs/apk/debug/app-debug.apk
  adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
  local runner
  runner="$(adb shell pm list instrumentation | tr -d '\r' | sed -n 's#^instrumentation:\(vn\.ihome\.diemdanh[^ ]*\) .*#\1#p' | head -n 1)"
  test -n "$runner"
  local step
  for step in seed verify permissionSteps; do
    adb shell am force-stop vn.ihome.diemdanh.thu
    adb shell am instrument -w -r -e class "vn.ihome.diemdanh.CleanInstallProbe#$step" "$runner" \
      | tee "$evidence/clean-install-$step.txt"
    if ! grep -q 'OK (1 test)' "$evidence/clean-install-$step.txt"; then
      printf 'Clean install step failed on Android %s: %s\n' "$api" "$step" >&2
      exit 1
    fi
  done

  # The tests leave these with the shell user because the app's own files go with the app.
  local shot
  for shot in setup status steps; do
    adb pull "/data/local/tmp/diemdanh-$shot.png" "$evidence/$shot.png"
    if [[ "$(head -c 8 "$evidence/$shot.png" | od -An -tx1 | tr -d ' \n')" != '89504e470d0a1a0a' ]]; then
      printf 'Screenshot %s is not a PNG on Android %s.\n' "$shot" "$api" >&2
      exit 1
    fi
  done
  adb shell dumpsys alarm > "$evidence/alarm-dump.txt"
  adb logcat -d -v brief 'AndroidRuntime:E' '*:S' > "$evidence/android-runtime-errors.txt"
  stop_emulator
}

for api in "${apis[@]}"; do
  run_on_api "$api"
done
