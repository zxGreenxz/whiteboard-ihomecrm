param([string]$JavaHome = $env:JAVA_HOME)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($JavaHome) -or
    -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/javac.exe'))) {
    throw 'Set JAVA_HOME or pass -JavaHome with a JDK 17 installation.'
}

# These policy tests run without an Android SDK. Dependencies are pinned and verified.
$taskCache = Join-Path $PSScriptRoot '.gradle/policy-tests'
$taskClasses = Join-Path $taskCache 'classes'
New-Item -ItemType Directory -Path $taskClasses -Force | Out-Null
$taskDependencies = @(
    @{
        Name = 'junit-4.13.2.jar'
        Url = 'https://repo.maven.apache.org/maven2/junit/junit/4.13.2/junit-4.13.2.jar'
        Sha256 = '8e495b634469d64fb8acfa3495a065cbacc8a0fff55ce1e31007be4c16dc57d3'
    },
    @{
        Name = 'hamcrest-core-1.3.jar'
        Url = 'https://repo.maven.apache.org/maven2/org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar'
        Sha256 = '66fdef91e9739348df7a096aa384a5685f4e875584cce89386a7a47251c4d8e9'
    }
)
foreach ($taskDependency in $taskDependencies) {
    $taskJar = Join-Path $taskCache $taskDependency.Name
    if (-not (Test-Path -LiteralPath $taskJar)) {
        Invoke-WebRequest -Uri $taskDependency.Url -OutFile $taskJar -TimeoutSec 60
    }
    $taskActualHash = (Get-FileHash -LiteralPath $taskJar -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($taskActualHash -ne $taskDependency.Sha256) {
        throw "Checksum mismatch for $($taskDependency.Name). Remove the cached file and retry."
    }
}

$taskClasspath = ($taskDependencies | ForEach-Object { Join-Path $taskCache $_.Name }) -join ';'
$taskSource = Join-Path $PSScriptRoot 'app/src/main/java/vn/ihome/smsgateway/GatewayPolicy.java'
$taskTest = Join-Path $PSScriptRoot 'app/src/test/java/vn/ihome/smsgateway/GatewayPolicyTest.java'
& (Join-Path $JavaHome 'bin/javac.exe') -encoding UTF-8 --release 17 -cp $taskClasspath -d $taskClasses $taskSource $taskTest
if ($LASTEXITCODE -ne 0) {
    throw "Policy compilation failed with exit code $LASTEXITCODE."
}
& (Join-Path $JavaHome 'bin/java.exe') -cp "$taskClasses;$taskClasspath" org.junit.runner.JUnitCore vn.ihome.smsgateway.GatewayPolicyTest
if ($LASTEXITCODE -ne 0) {
    throw "Policy tests failed with exit code $LASTEXITCODE."
}
