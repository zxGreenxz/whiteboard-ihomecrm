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
  # A busy emulator shows "isn't responding" prompts for its own launcher over the screenshots.
  adb shell settings put global hide_error_dialogs 1
  if (( api >= 31 )); then
    adb shell cmd location set-location-enabled true
  else
    adb shell settings put secure location_mode 3
  fi
  cp "$ANDROID_HOME/system-images/android-$api/google_apis/x86_64/source.properties" "$evidence/android-system-image.properties"
  adb shell getprop ro.build.fingerprint > "$evidence/android-fingerprint.txt"

  # The two probes need a fresh install and separate processes, so they run by themselves below.
  # The bank-message suite stays on the target release, the only one it has ever been verified on;
  # the check-in and Home suites run on every release listed above.
  local excluded='vn.ihome.diemdanh.CleanInstallProbe,vn.ihome.diemdanh.HomeCleanInstallProbe'
  local suites=(vn/ihome/diemdanh/DiemDanhDeviceTest vn/ihome/diemdanh/HomeDeviceTest)
  local shots=(diemdanh-setup diemdanh-status diemdanh-home diemdanh-steps diemdanh-home-clean)
  if (( api == 35 )); then
    suites+=(vn/ihome/smsgateway/GatewayDeviceTest)
    shots+=(gateway-setup gateway-status)
  else
    excluded+=',vn.ihome.smsgateway.GatewayDeviceTest'
  fi
  rm -rf app/build/outputs/androidTest-results/connected
  bash ./gradlew --no-daemon --console=plain -Pandroid.builder.sdkDownload=false \
    "-Pandroid.testInstrumentationRunnerArguments.notClass=$excluded" \
    :app:connectedDebugAndroidTest

  # Every declared test must have run; a skip is not a pass.
  local declared=0
  local suite
  for suite in "${suites[@]}"; do
    declared=$(( declared + $(grep -c '@Test' "app/src/androidTest/java/$suite.java") ))
  done
  local reports=(app/build/outputs/androidTest-results/connected/debug/TEST-*.xml)
  if [[ "${#reports[@]}" != 1 ]] \
      || ! grep -q "tests=\"$declared\" failures=\"0\" errors=\"0\" skipped=\"0\"" "${reports[0]}"; then
    printf 'Expected all %s device tests to pass with none skipped on Android %s.\n' "$declared" "$api" >&2
    exit 1
  fi
  for suite in "${suites[@]}"; do
    if ! grep -q "classname=\"${suite//\//.}\"" "${reports[0]}"; then
      printf 'Device suite %s did not run on Android %s.\n' "${suite##*/}" "$api" >&2
      exit 1
    fi
  done
  cp -r app/build/outputs/androidTest-results/connected "$evidence/androidTest-results"

  # The steps below are only meaningful on a fresh install with nothing granted. AGP removes the app
  # after its run; this fails loudly if that ever stops being true. The listing is read whole before
  # it is searched: a search that stops early inside a pipeline would turn a match into a failure.
  local installed
  installed="$(adb shell pm list packages | tr -d '\r')"
  if ! grep -Fxq 'package:android' <<< "$installed"; then
    printf 'Could not list the installed packages on Android %s.\n' "$api" >&2
    exit 1
  fi
  if grep -q '^package:vn\.ihome\.smsgateway' <<< "$installed"; then
    printf 'The app is still installed after the device tests on Android %s.\n' "$api" >&2
    exit 1
  fi
  adb install -r -t app/build/outputs/apk/debug/app-debug.apk
  adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
  # The debug build carries a suffix; both names come from the device instead of being repeated here.
  local listing
  listing="$(adb shell pm list instrumentation | tr -d '\r' | sed -n '/^instrumentation:vn\.ihome\.smsgateway/p')"
  if [[ "$(grep -c . <<< "$listing")" != 1 ]]; then
    printf 'Expected exactly one instrumentation of this app on Android %s.\n' "$api" >&2
    exit 1
  fi
  local runner
  runner="$(sed -n 's#^instrumentation:\([^ ]*\) .*#\1#p' <<< "$listing")"
  local package
  package="$(sed -n 's#.*(target=\([^)]*\)).*#\1#p' <<< "$listing")"
  test -n "$runner"
  test -n "$package"

  # First, what a new user gets: Home on a fresh install asks for nothing and arms nothing.
  # Then the encrypted queue across a real process restart: seed, force-stop, read back in a new
  # process; and last the check-in screen of a phone that has granted nothing.
  local step
  for step in HomeCleanInstallProbe#aFreshInstallOpensToHomeWithoutPromptsAlarmsOrWork \
              CleanInstallProbe#seed CleanInstallProbe#verify CleanInstallProbe#permissionSteps; do
    adb shell am force-stop "$package"
    adb shell am instrument -w -r -e class "vn.ihome.diemdanh.$step" "$runner" \
      | tee "$evidence/clean-install-${step#*#}.txt"
    if ! grep -q 'OK (1 test)' "$evidence/clean-install-${step#*#}.txt"; then
      printf 'Clean install step failed on Android %s: %s\n' "$api" "$step" >&2
      exit 1
    fi
  done

  # The tests leave these with the shell user because the app's own files go with the app.
  local shot
  for shot in "${shots[@]}"; do
    adb pull "/data/local/tmp/$shot.png" "$evidence/$shot.png"
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
