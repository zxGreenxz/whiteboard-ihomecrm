#!/usr/bin/env bash
set +x
set -euo pipefail

cd "$(dirname "$0")"
: "${IHOME_BANK_ANDROID_KEYSTORE_B64:?Release signing keystore secret is required.}"
: "${IHOME_BANK_ANDROID_PASSWORD:?Release signing password secret is required.}"
: "${ANDROID_HOME:?Use a runner with an existing Android SDK.}"
if [[ -n "${JAVA_HOME_17_X64:-}" ]]; then export JAVA_HOME="$JAVA_HOME_17_X64"; fi
: "${JAVA_HOME:?JDK 17 is required.}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export LC_ALL=C

# Release signing uses only existing SDK components and never accepts licenses.
for required in "$ANDROID_HOME/platforms/android-35/android.jar" \
                "$ANDROID_HOME/build-tools/35.0.0/aapt2" \
                "$ANDROID_HOME/build-tools/35.0.0/apksigner"; do
  if [[ ! -f "$required" ]]; then
    printf 'Required preinstalled Android component missing: %s\n' "$required" >&2
    exit 1
  fi
done

umask 077
signing_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ihome-signing.XXXXXX")"
signing_store="$signing_dir/release.keystore"
cleanup() {
  rm -f -- "$signing_store" "$signing_dir/signing-cert.der"
  rmdir -- "$signing_dir"
  unset IHOME_SIGNING_STORE IHOME_SIGNING_PASSWORD IHOME_BANK_ANDROID_KEYSTORE_B64 IHOME_BANK_ANDROID_PASSWORD
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s' "$IHOME_BANK_ANDROID_KEYSTORE_B64" | base64 --decode > "$signing_store"
chmod 600 "$signing_store"
test -s "$signing_store"
export IHOME_SIGNING_STORE="$signing_store"
export IHOME_SIGNING_PASSWORD="$IHOME_BANK_ANDROID_PASSWORD"
unset IHOME_BANK_ANDROID_KEYSTORE_B64 IHOME_BANK_ANDROID_PASSWORD

evidence='build/release-evidence'
mkdir -p "$evidence"
java -version > "$evidence/java-version.txt" 2>&1
if ! grep -Eq '(openjdk|java) version "17([.]|")' "$evidence/java-version.txt"; then
  printf 'Release signing requires JDK 17.\n' >&2
  exit 1
fi
git rev-parse HEAD > "$evidence/commit.txt"
cp "$ANDROID_HOME/platforms/android-35/source.properties" "$evidence/android-platform.properties"
cp "$ANDROID_HOME/build-tools/35.0.0/source.properties" "$evidence/android-build-tools.properties"

# Export only the public certificate; the password never appears in argv or logs.
keytool -exportcert -keystore "$IHOME_SIGNING_STORE" -storepass:env IHOME_SIGNING_PASSWORD \
  -alias ihome-gateway -file "$signing_dir/signing-cert.der" >/dev/null
expected_certificate="$(sha256sum "$signing_dir/signing-cert.der" | cut -d ' ' -f 1)"
bash ./gradlew --no-daemon --no-configuration-cache --console=plain -Pandroid.builder.sdkDownload=false \
  :app:assembleRelease

apk='app/build/outputs/apk/release/app-release.apk'
test -s "$apk"
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose --print-certs "$apk" \
  > "$evidence/apk-signature.txt"
actual_certificate="$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' "$evidence/apk-signature.txt" | tr 'A-F' 'a-f')"
if [[ "$(grep -Ec '^Signer #[0-9]+ certificate SHA-256 digest: ' "$evidence/apk-signature.txt")" != '1' \
      || "$actual_certificate" != "$expected_certificate" ]]; then
  printf 'APK signing certificate does not match the configured release key.\n' >&2
  exit 1
fi
sha256sum "$apk" > "$evidence/apk-sha256.txt"
printf '%s\n' "$expected_certificate" > "$evidence/signing-certificate-sha256.txt"
cp "$signing_dir/signing-cert.der" "$evidence/signing-certificate.der"
printf 'Signed release APK and public verification evidence are ready.\n'
