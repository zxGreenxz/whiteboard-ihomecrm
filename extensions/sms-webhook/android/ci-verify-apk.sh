#!/usr/bin/env bash
# The one place that checks what an APK declares about itself. ci-build.sh runs it on the debug APK
# of every pull request; ci-release.sh runs it on the signed release APK, which is built on main only.
# Paths are relative to this directory.
set +x
set -euo pipefail

if (( $# != 4 )); then
  printf 'Usage: ci-verify-apk.sh <apk> <expected-package> <expected-label> <evidence-dir>\n' >&2
  exit 2
fi
apk="$1"
expected_package="$2"
expected_label="$3"
evidence="$4"

cd "$(dirname "$0")"
: "${ANDROID_HOME:?Use a runner with an existing Android SDK.}"
export LC_ALL=C
aapt2="$ANDROID_HOME/build-tools/35.0.0/aapt2"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ -f "$aapt2" ]] || fail "Required preinstalled Android component missing: $aapt2"
[[ -s "$apk" ]] || fail "APK missing or empty: $apk"
[[ -n "$expected_package" && -n "$expected_label" ]] || fail 'Expected package and label must not be empty.'
mkdir -p "$evidence"

# Both build types take their version from defaultConfig, so the expectation is read there, once.
expected_code="$(sed -n "s/^[[:space:]]*versionCode[[:space:]][[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p" app/build.gradle)"
expected_name="$(sed -n "s/^[[:space:]]*versionName[[:space:]][[:space:]]*'\([^']*\)'[[:space:]]*$/\1/p" app/build.gradle)"
[[ "$expected_code" =~ ^[0-9]+$ && "$expected_name" =~ ^[0-9A-Za-z._-]+$ ]] \
  || fail 'app/build.gradle must declare exactly one versionCode and one versionName.'

"$aapt2" dump badging "$apk" > "$evidence/apk-badging.txt"

identity="$(sed -n "s/^package: name='\([^']*\)' versionCode='\([^']*\)' versionName='\([^']*\)'.*/\1 \2 \3/p" "$evidence/apk-badging.txt")"
[[ "$identity" == "$expected_package $expected_code $expected_name" ]] \
  || fail "APK identity differs: expected '$expected_package $expected_code $expected_name', found '$identity'."

launcher_count="$(grep -c '^launchable-activity:' "$evidence/apk-badging.txt" || true)"
launcher="$(sed -n "s/^launchable-activity: name='\([^']*\)'.*/\1/p" "$evidence/apk-badging.txt")"
[[ "$launcher_count" == '1' && "$launcher" == 'vn.ihome.smsgateway.HomeActivity' ]] \
  || fail "APK launcher differs: expected only vn.ihome.smsgateway.HomeActivity, found $launcher_count: '$launcher'."

# The default label and every per-locale label must be the same single name.
labels="$(sed -n "s/^application-label[^:]*:'\(.*\)'$/\1/p" "$evidence/apk-badging.txt" | sort -u)"
application_label="$(sed -n "s/^application: label='\([^']*\)'.*/\1/p" "$evidence/apk-badging.txt")"
[[ "$labels" == "$expected_label" && "$application_label" == "$expected_label" ]] \
  || fail "APK label differs: expected '$expected_label', found '$labels' and '$application_label'."

# The merged manifest may only hold the approved list (RECEIVE_SMS for bank messages, plan 4.6 for
# check-in) plus what androidx.work and androidx.core add. The list lives here and nowhere else.
"$aapt2" dump permissions "$apk" > "$evidence/apk-permissions.txt"
sed -n "s/^uses-permission[^:]*: name='\([^']*\)'.*/\1/p" "$evidence/apk-permissions.txt" \
  | { grep -Fxv "$expected_package.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" || true; } \
  | sort -u > "$evidence/apk-permissions-actual.txt"
sort -u > "$evidence/apk-permissions-expected.txt" <<'EOF'
android.permission.ACCESS_BACKGROUND_LOCATION
android.permission.ACCESS_COARSE_LOCATION
android.permission.ACCESS_FINE_LOCATION
android.permission.ACCESS_NETWORK_STATE
android.permission.FOREGROUND_SERVICE
android.permission.FOREGROUND_SERVICE_LOCATION
android.permission.INTERNET
android.permission.POST_NOTIFICATIONS
android.permission.RECEIVE_BOOT_COMPLETED
android.permission.RECEIVE_SMS
android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
android.permission.SCHEDULE_EXACT_ALARM
android.permission.USE_EXACT_ALARM
android.permission.WAKE_LOCK
EOF
if ! diff "$evidence/apk-permissions-expected.txt" "$evidence/apk-permissions-actual.txt"; then
  fail 'APK permissions differ from the approved list.'
fi
alarm="$(grep "^uses-permission[^:]*: name='android.permission.SCHEDULE_EXACT_ALARM'" "$evidence/apk-permissions.txt" || true)"
[[ "$alarm" == "uses-permission: name='android.permission.SCHEDULE_EXACT_ALARM' maxSdkVersion='32'" ]] \
  || fail 'SCHEDULE_EXACT_ALARM must stop at Android 12L.'

printf 'APK verified: %s package=%s versionCode=%s versionName=%s label=%s launcher=%s permissions=%s (approved list) SCHEDULE_EXACT_ALARM maxSdkVersion=32\n' \
  "$apk" "$expected_package" "$expected_code" "$expected_name" "$expected_label" "$launcher" \
  "$(grep -c '' "$evidence/apk-permissions-actual.txt")" | tee "$evidence/apk-verified.txt"
