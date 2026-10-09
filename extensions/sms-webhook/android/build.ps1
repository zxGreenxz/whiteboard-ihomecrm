param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $env:ANDROID_HOME
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($AndroidSdk)) {
    $AndroidSdk = $env:ANDROID_SDK_ROOT
}
if ([string]::IsNullOrWhiteSpace($JavaHome) -or
    -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/java.exe'))) {
    throw 'Set JAVA_HOME or pass -JavaHome with a JDK 17 installation.'
}
if ([string]::IsNullOrWhiteSpace($AndroidSdk) -or
    -not (Test-Path -LiteralPath (Join-Path $AndroidSdk 'platforms/android-35/android.jar')) -or
    -not (Test-Path -LiteralPath (Join-Path $AndroidSdk 'build-tools/35.0.0/aapt2.exe'))) {
    throw 'Install Android SDK Platform 35 and Build Tools 35.0.0, accept the SDK license yourself, then set ANDROID_HOME or pass -AndroidSdk.'
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdk
Push-Location $PSScriptRoot
try {
    & .\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug --console=plain
    if ($LASTEXITCODE -ne 0) {
        throw "Android build or checks failed with exit code $LASTEXITCODE."
    }
    Write-Output (Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk')
} finally {
    Pop-Location
}
