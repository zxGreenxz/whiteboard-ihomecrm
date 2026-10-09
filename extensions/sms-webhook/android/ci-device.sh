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
printf 'no\n' | "$avdmanager" create avd --force --name ihome-fixture \
  --package 'system-images;android-35;google_apis;x86_64' --device pixel_5
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
cp "$image/source.properties" build/ci-evidence/android-system-image.properties
adb shell getprop ro.build.fingerprint > build/ci-evidence/android-fingerprint.txt
bash ./gradlew --no-daemon --console=plain -Pandroid.builder.sdkDownload=false :app:connectedDebugAndroidTest
adb exec-out run-as vn.ihome.smsgateway cat files/evidence/setup.png > build/ci-evidence/setup.png
adb exec-out run-as vn.ihome.smsgateway cat files/evidence/status.png > build/ci-evidence/status.png
test -s build/ci-evidence/setup.png
test -s build/ci-evidence/status.png
adb logcat -d -v brief 'AndroidRuntime:E' '*:S' > build/ci-evidence/android-runtime-errors.txt
