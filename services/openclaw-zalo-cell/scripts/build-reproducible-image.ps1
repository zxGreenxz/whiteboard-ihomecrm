#Requires -Version 7.3

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ReviewedTree,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedM,

  [Parameter(Mandatory = $true)]
  [string]$MReviewReportPath,

  [Parameter(Mandatory = $true)]
  [string]$RReviewReportPath,

  [Parameter(Mandatory = $true)]
  [string]$BuildxPath,

  [Parameter(Mandatory = $true)]
  [string]$DockerPath,

  [Parameter(Mandatory = $true)]
  [string]$DockerHost,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$GitPath,

  [Parameter(Mandatory = $true)]
  [string]$GitRepositoryRoot,

  [Parameter(Mandatory = $true)]
  [string]$ReviewedSourceRoot,

  [Parameter(Mandatory = $true)]
  [string]$ReviewedExportManifestPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{64}$')]
  [string]$ReviewedExportManifestSha256,

  [Parameter(Mandatory = $true)]
  [ValidateSet('linux/amd64')]
  [string]$Platform,

  [Parameter(Mandatory = $true)]
  [ValidateSet('1785062400')]
  [string]$SourceDateEpoch,

  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,

  [Parameter(Mandatory = $true)]
  [string]$ReleaseArtifactPath,

  [Parameter(Mandatory = $true)]
  [string]$ReproductionArtifactPath,

  [Parameter(Mandatory = $true)]
  [string]$StockOciPath,

  [Parameter(Mandatory = $true)]
  [string]$RetainedUpstreamTarballPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$script:BaseNativeEnvironment = [ordered]@{
  HOME = '/nonexistent'
  LANG = 'C'
  LC_ALL = 'C'
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Collections.IDictionary]$Environment = $script:BaseNativeEnvironment
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Environment.Clear()
  foreach ($binding in $Environment.GetEnumerator()) {
    $startInfo.Environment[[string]$binding.Key] = [string]$binding.Value
  }
  foreach ($argument in $Arguments) {
    $startInfo.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "Unable to start native command: $FilePath"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $script:LASTEXITCODE = $process.ExitCode
    $output = [Collections.Generic.List[string]]::new()
    foreach ($stream in @($stdout, $stderr)) {
      if (-not [string]::IsNullOrEmpty($stream)) {
        foreach ($line in @($stream.TrimEnd("`r", "`n") -split "`r?`n")) {
          $output.Add($line)
        }
      }
    }
    if ($process.ExitCode -ne 0) {
      throw "Native command failed ($($process.ExitCode)): $FilePath $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return @($output)
  } finally {
    $process.Dispose()
  }
}

function Assert-NoReparseChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $cursor = [IO.Path]::GetFullPath($Path)
  while (-not (Test-Path -LiteralPath $cursor)) {
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) {
      throw "$Label has no existing filesystem ancestor"
    }
    $cursor = $parent
  }
  while ($true) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Label must not traverse a reparse ancestor: $cursor"
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Assert-RegularArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-NoReparseChain -Path $Path -Label $Label
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must be a regular non-reparse file"
  }
}

function Publish-RetainedArchive {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-RegularArchive -Path $SourcePath -Label "$Label source"
  $sourceHash = Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256
  $destinationParent = Split-Path -Parent $DestinationPath
  New-Item -ItemType Directory -Path $destinationParent -Force -ErrorAction Stop | Out-Null
  Assert-NoReparseChain -Path $DestinationPath -Label "$Label destination"
  if (Test-Path -LiteralPath $DestinationPath) {
    Assert-RegularArchive -Path $DestinationPath -Label "$Label existing destination"
  }
  $temporary = "$DestinationPath.tmp-$([guid]::NewGuid().ToString('N'))"
  try {
    Copy-Item -LiteralPath $SourcePath -Destination $temporary -Force -ErrorAction Stop
    Assert-RegularArchive -Path $temporary -Label "$Label temporary copy"
    [IO.File]::Move($temporary, $DestinationPath, $true)
    Assert-RegularArchive -Path $DestinationPath -Label "$Label retained destination"
    $destinationHash = Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256
    if ($sourceHash.Hash -ne $destinationHash.Hash) {
      throw "$Label retained copy SHA-256 mismatch"
    }
    return $destinationHash
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Assert-DistinctArchives {
  param(
    [Parameter(Mandatory = $true)][string[]]$Paths,
    [Parameter(Mandatory = $true)][string]$Label
  )

  for ($left = 0; $left -lt $Paths.Count; $left++) {
    Assert-RegularArchive -Path $Paths[$left] -Label "$Label[$left]"
    for ($right = $left + 1; $right -lt $Paths.Count; $right++) {
      if ([StringComparer]::Ordinal.Equals($Paths[$left], $Paths[$right])) {
        throw "$Label paths must be distinct"
      }
      $leftInfo = Get-Item -LiteralPath $Paths[$left] -Force -ErrorAction Stop
      $rightInfo = Get-Item -LiteralPath $Paths[$right] -Force -ErrorAction Stop
      if ($leftInfo.FullName -eq $rightInfo.FullName) {
        throw "$Label paths resolve to the same file"
      }
    }
  }
}

function Assert-HashUnchanged {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Bindings,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  foreach ($binding in $Bindings.GetEnumerator()) {
    $actual = (Get-FileHash -LiteralPath $binding.Value.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $binding.Value.Sha256) {
      throw "$($binding.Key) changed during $Phase"
    }
  }
}

if (-not [IO.Path]::IsPathFullyQualified($NodePath)) {
  throw 'NodePath must be absolute; PATH lookup is forbidden'
}
Assert-NoReparseChain -Path $NodePath -Label 'Node executable'
$nodeItem = Get-Item -LiteralPath $NodePath -Force -ErrorAction Stop
if ($nodeItem.PSIsContainer -or ($nodeItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'NodePath must be a regular non-reparse file'
}
$nodePath = [IO.Path]::GetFullPath($NodePath)
$expectedNodeSize = 122889056
$expectedNodeSha256 = 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c'
$actualNodeSha256 = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeItem.Length -ne $expectedNodeSize -or $actualNodeSha256 -ne $expectedNodeSha256) {
  throw 'NodePath bytes do not match the pinned Node 24.15.0 linux/amd64 authority'
}
function Invoke-NodeChecked {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $beforeItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
  $beforeSha256 = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($beforeItem.Length -ne $expectedNodeSize -or $beforeSha256 -ne $expectedNodeSha256) {
    throw 'Node authority changed before execution'
  }
  $output = Invoke-NativeChecked -FilePath $nodePath -Arguments $Arguments
  $afterItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
  $afterSha256 = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($afterItem.Length -ne $beforeItem.Length -or $afterSha256 -ne $beforeSha256) {
    throw 'Node authority changed during execution'
  }
  return @($output)
}
$nodeVersion = Invoke-NodeChecked -Arguments @('--version')
if (($nodeVersion -join "`n").Trim() -ne 'v24.15.0') {
  throw 'Official stable Node >=24.15.0 <25 is required; the pinned authority is exactly v24.15.0'
}

$cellRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if (-not [IO.Path]::IsPathFullyQualified($GitPath)) {
  throw 'GitPath must be absolute; PATH lookup is forbidden'
}
Assert-NoReparseChain -Path $GitPath -Label 'Git executable'
$gitItem = Get-Item -LiteralPath $GitPath -Force -ErrorAction Stop
if ($gitItem.PSIsContainer -or ($gitItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'GitPath must be a regular non-reparse file'
}
$expectedGitVersion = '2.53.0'
$expectedGitSha256 = '5516c9f362c29376ab9a499a33082f9f611941d8c75930c880e30ad109e39c9a'
$actualGitSha256 = (Get-FileHash -LiteralPath $GitPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualGitSha256 -ne $expectedGitSha256) {
  throw 'GitPath SHA-256 does not match the pinned Git authority'
}
$gitEnvironment = [ordered]@{}
foreach ($binding in $script:BaseNativeEnvironment.GetEnumerator()) {
  $gitEnvironment[[string]$binding.Key] = [string]$binding.Value
}
$gitEnvironmentBindings = [ordered]@{
  GIT_ATTR_NOSYSTEM = '1'
  GIT_CONFIG_GLOBAL = '/dev/null'
  GIT_CONFIG_NOSYSTEM = '1'
  GIT_NO_LAZY_FETCH = '1'
  GIT_NO_REPLACE_OBJECTS = '1'
  GIT_OPTIONAL_LOCKS = '0'
  GIT_TERMINAL_PROMPT = '0'
}
foreach ($binding in $gitEnvironmentBindings.GetEnumerator()) {
  $gitEnvironment[[string]$binding.Key] = [string]$binding.Value
}
function Invoke-GitChecked {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $trustedArguments = @(
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false',
    '-c', 'core.attributesFile=/dev/null'
  ) + $Arguments
  return @(Invoke-NativeChecked -FilePath $GitPath -Environment $gitEnvironment -Arguments $trustedArguments)
}
$gitVersionOutput = Invoke-GitChecked -Arguments @('--version')
if (($gitVersionOutput -join "`n").Trim() -ne "git version $expectedGitVersion") {
  throw 'GitPath version does not match the pinned Git authority'
}

if (-not [IO.Path]::IsPathFullyQualified($BuildxPath)) {
  throw 'BuildxPath must be absolute; PATH lookup is forbidden'
}
if (-not [IO.Path]::IsPathFullyQualified($DockerPath)) {
  throw 'DockerPath must be absolute; PATH lookup is forbidden'
}
if ($DockerHost -notmatch '^unix:///.+$') {
  throw 'DockerHost must be an explicit absolute unix socket URI'
}
$dockerSocketPath = $DockerHost.Substring('unix://'.Length)
if (-not [IO.Path]::IsPathFullyQualified($dockerSocketPath)) {
  throw 'DockerHost socket path must be absolute'
}
Assert-NoReparseChain -Path $dockerSocketPath -Label 'Docker socket authority'
Invoke-NodeChecked -Arguments @(
  '-e',
  'const f=require("node:fs");const p=process.argv[1];const s=f.lstatSync(p,{bigint:true});if(!s.isSocket()||s.isSymbolicLink())throw new Error("DockerHost is not a real Unix socket");if(typeof process.getuid==="function"&&s.uid!==BigInt(process.getuid()))throw new Error("DockerHost owner mismatch");if((s.mode&2n)!==0n)throw new Error("DockerHost is world-writable")',
  $dockerSocketPath
) | Out-Null
$dockerEnvironment = [ordered]@{}
foreach ($binding in $script:BaseNativeEnvironment.GetEnumerator()) {
  $dockerEnvironment[[string]$binding.Key] = [string]$binding.Value
}
$dockerEnvironment.DOCKER_HOST = $DockerHost
if (-not [IO.Path]::IsPathFullyQualified($GitRepositoryRoot)) {
  throw 'GitRepositoryRoot must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($ReviewedSourceRoot)) {
  throw 'ReviewedSourceRoot must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($ReviewedExportManifestPath)) {
  throw 'ReviewedExportManifestPath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($EvidencePath)) {
  throw 'EvidencePath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($ReleaseArtifactPath)) {
  throw 'ReleaseArtifactPath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($ReproductionArtifactPath)) {
  throw 'ReproductionArtifactPath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($StockOciPath)) {
  throw 'StockOciPath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($RetainedUpstreamTarballPath)) {
  throw 'RetainedUpstreamTarballPath must be absolute'
}
$resolvedReleaseArtifact = [IO.Path]::GetFullPath($ReleaseArtifactPath)
$resolvedReproductionArtifact = [IO.Path]::GetFullPath($ReproductionArtifactPath)
$resolvedStockOci = [IO.Path]::GetFullPath($StockOciPath)
$resolvedRetainedUpstreamTarball = [IO.Path]::GetFullPath($RetainedUpstreamTarballPath)
$resolvedEvidencePath = [IO.Path]::GetFullPath($EvidencePath)
$retainedArchivePaths = @(
  $resolvedReleaseArtifact,
  $resolvedReproductionArtifact,
  $resolvedStockOci
)
$retainedOutputPaths = @($retainedArchivePaths) + @($resolvedRetainedUpstreamTarball)
for ($left = 0; $left -lt $retainedOutputPaths.Count; $left++) {
  if ([StringComparer]::Ordinal.Equals($retainedOutputPaths[$left], $resolvedEvidencePath)) {
    throw 'EvidencePath must be distinct from every retained qualification output path'
  }
  for ($right = $left + 1; $right -lt $retainedOutputPaths.Count; $right++) {
    if ([StringComparer]::Ordinal.Equals($retainedOutputPaths[$left], $retainedOutputPaths[$right])) {
      throw 'Every retained OCI and upstream tarball output path must be distinct'
    }
  }
}
if ($ExpectedM -eq $ReviewedTree) {
  throw 'ExpectedM and ReviewedTree must be distinct'
}
$resolvedGitRepositoryRoot = (Resolve-Path -LiteralPath $GitRepositoryRoot -ErrorAction Stop).Path
$gitRepositoryItem = Get-Item -LiteralPath $resolvedGitRepositoryRoot -Force -ErrorAction Stop
if (-not $gitRepositoryItem.PSIsContainer) {
  throw 'GitRepositoryRoot must be a directory'
}
foreach ($reviewReportPath in @($MReviewReportPath, $RReviewReportPath)) {
  if (-not [IO.Path]::IsPathFullyQualified($reviewReportPath)) {
    throw 'Review report paths must be absolute'
  }
  $reviewReportItem = Get-Item -LiteralPath $reviewReportPath -Force -ErrorAction Stop
  if ($reviewReportItem.PSIsContainer -or ($reviewReportItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Review reports must be regular non-reparse files'
  }
}
$resolvedMReviewReport = (Resolve-Path -LiteralPath $MReviewReportPath -ErrorAction Stop).Path
$resolvedRReviewReport = (Resolve-Path -LiteralPath $RReviewReportPath -ErrorAction Stop).Path
$expectedMReviewReport = [IO.Path]::GetFullPath((Join-Path $resolvedGitRepositoryRoot "services/openclaw-zalo-cell/.release/reviews/m-review-report-v1-$ExpectedM.json"))
$expectedRReviewReport = [IO.Path]::GetFullPath((Join-Path $resolvedGitRepositoryRoot "services/openclaw-zalo-cell/.release/reviews/r-review-report-v1-$ReviewedTree.json"))
if ($resolvedMReviewReport -ne $expectedMReviewReport -or $resolvedRReviewReport -ne $expectedRReviewReport) {
  throw 'Review reports must use the canonical SHA-bound .release/reviews paths'
}
if ($resolvedMReviewReport -eq $resolvedRReviewReport) {
  throw 'M and R review reports must be distinct files'
}
$retainedMReviewSha256 = (Get-FileHash -LiteralPath $resolvedMReviewReport -Algorithm SHA256).Hash.ToLowerInvariant()
$retainedRReviewSha256 = (Get-FileHash -LiteralPath $resolvedRReviewReport -Algorithm SHA256).Hash.ToLowerInvariant()

foreach ($commitBinding in @(
    [pscustomobject]@{ Sha = $ExpectedM; Label = 'ExpectedM' },
    [pscustomobject]@{ Sha = $ReviewedTree; Label = 'ReviewedTree' }
  )) {
  $objectType = Invoke-GitChecked -Arguments @(
    '-C', $resolvedGitRepositoryRoot, 'cat-file', '-t', "$($commitBinding.Sha)^{commit}"
  )
  if (($objectType -join "`n").Trim() -ne 'commit') {
    throw "$($commitBinding.Label) is not an exact Git commit object"
  }
  $resolvedCommit = Invoke-GitChecked -Arguments @(
    '-C', $resolvedGitRepositoryRoot, 'rev-parse', '--verify', "$($commitBinding.Sha)^{commit}"
  )
  if (($resolvedCommit -join "`n").Trim() -ne $commitBinding.Sha) {
    throw "$($commitBinding.Label) does not resolve exactly"
  }
}
Invoke-GitChecked -Arguments @(
  '-C', $resolvedGitRepositoryRoot, 'merge-base', '--is-ancestor', $ExpectedM, $ReviewedTree
) | Out-Null

foreach ($pathBinding in @(
  [pscustomobject]@{ Path = $resolvedGitRepositoryRoot; Label = 'Git repository root' },
    [pscustomobject]@{ Path = $GitPath; Label = 'Git executable' },
    [pscustomobject]@{ Path = $resolvedMReviewReport; Label = 'M review report' },
    [pscustomobject]@{ Path = $resolvedRReviewReport; Label = 'R review report' },
    [pscustomobject]@{ Path = $BuildxPath; Label = 'Buildx binary' },
    [pscustomobject]@{ Path = $DockerPath; Label = 'Docker binary' },
    [pscustomobject]@{ Path = $nodePath; Label = 'Node executable' },
    [pscustomobject]@{ Path = $ReviewedSourceRoot; Label = 'Reviewed source root' },
    [pscustomobject]@{ Path = $ReviewedExportManifestPath; Label = 'Reviewed export manifest' },
    [pscustomobject]@{ Path = $resolvedEvidencePath; Label = 'Evidence output' },
    [pscustomobject]@{ Path = $resolvedReleaseArtifact; Label = 'Release artifact output' },
    [pscustomobject]@{ Path = $resolvedReproductionArtifact; Label = 'Reproduction artifact output' },
    [pscustomobject]@{ Path = $resolvedStockOci; Label = 'Stock OCI output' },
  [pscustomobject]@{ Path = $resolvedRetainedUpstreamTarball; Label = 'Retained upstream tarball output' }
  )) {
  Assert-NoReparseChain -Path $pathBinding.Path -Label $pathBinding.Label
}

$resolvedBuildx = (Resolve-Path -LiteralPath $BuildxPath -ErrorAction Stop).Path
$buildxItem = Get-Item -LiteralPath $resolvedBuildx -Force
if ($buildxItem.PSIsContainer -or ($buildxItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'BuildxPath must be a regular non-reparse file'
}
$expectedBuildxSha256 = if ($IsWindows) {
  '6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75'
} elseif ($IsLinux) {
  '3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c'
} else {
  throw 'Only Windows amd64 and Linux amd64 buildx binaries are locked'
}
$actualBuildxSha256 = (Get-FileHash -LiteralPath $resolvedBuildx -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualBuildxSha256 -ne $expectedBuildxSha256) {
  throw 'Buildx binary SHA-256 does not match image-lock.json'
}
$buildxVersion = Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @('version')
if (($buildxVersion -join "`n") -notmatch '(?m)\bv?0\.13\.1\b') {
  throw 'Buildx semantic version must be exactly 0.13.1'
}

if (-not $IsLinux) {
  throw 'The qualifying Docker runtime probe must run on the reviewed Linux amd64 host'
}
$resolvedDocker = (Resolve-Path -LiteralPath $DockerPath -ErrorAction Stop).Path
$dockerItem = Get-Item -LiteralPath $resolvedDocker -Force
if ($dockerItem.PSIsContainer -or ($dockerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'DockerPath must be a regular non-reparse file'
}
$expectedDockerSha256 = '40cdaf7fd0f21089dd9e15b0c3a7dd7f2399027f010e366dac6304ae0615954a'
$actualDockerSha256 = (Get-FileHash -LiteralPath $resolvedDocker -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualDockerSha256 -ne $expectedDockerSha256) {
  throw 'Docker binary SHA-256 does not match image-lock.json'
}
$dockerVersion = Invoke-NativeChecked -FilePath $resolvedDocker -Environment $dockerEnvironment -Arguments @(
  'version', '--format', '{{.Client.Version}}|{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}'
)
if (($dockerVersion -join "`n").Trim() -ne '29.1.3|29.1.3|linux|amd64') {
  throw 'Docker client/server version and platform must be exactly 29.1.3 linux/amd64'
}

$resolvedReviewedSourceRoot = (Resolve-Path -LiteralPath $ReviewedSourceRoot -ErrorAction Stop).Path
$reviewedSourceItem = Get-Item -LiteralPath $resolvedReviewedSourceRoot -Force
if (-not $reviewedSourceItem.PSIsContainer -or ($reviewedSourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'ReviewedSourceRoot must be a real non-reparse directory'
}
$expectedReviewedSourceRoot = [IO.Path]::GetFullPath((Join-Path $cellRoot '..\..'))
if ($resolvedReviewedSourceRoot -ne $expectedReviewedSourceRoot) {
  throw 'ReviewedSourceRoot does not contain this reviewed cell helper'
}
$resolvedReviewedExportManifest = (Resolve-Path -LiteralPath $ReviewedExportManifestPath -ErrorAction Stop).Path
$reviewedManifestItem = Get-Item -LiteralPath $resolvedReviewedExportManifest -Force
if ($reviewedManifestItem.PSIsContainer -or ($reviewedManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Reviewed export manifest must be a regular non-reparse file'
}
$actualReviewedExportManifestSha256 = (Get-FileHash -LiteralPath $resolvedReviewedExportManifest -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualReviewedExportManifestSha256 -ne $ReviewedExportManifestSha256) {
  throw 'Reviewed export manifest SHA-256 mismatch'
}
$reviewedExporter = Join-Path $resolvedReviewedSourceRoot 'services/openclaw-zalo-cell/scripts/export-reviewed-tree.mjs'
Invoke-NodeChecked -Arguments @(
  $reviewedExporter,
  'verify', '--reviewed-tree', $ReviewedTree,
  '--git-path', $GitPath, '--repository-root', $resolvedGitRepositoryRoot,
  '--output-root', $resolvedReviewedSourceRoot,
  '--manifest', $resolvedReviewedExportManifest
) | Out-Null

$reviewedUpstreamVerifier = [IO.Path]::GetFullPath((Join-Path $cellRoot 'vendor/zalouser-bridge/scripts/verify-upstream.mjs'))
Assert-RegularArchive -Path $reviewedUpstreamVerifier -Label 'Reviewed upstream verifier'
$upstreamTarballDestination = [IO.Path]::GetFullPath((Join-Path $cellRoot 'vendor/zalouser-bridge/.work/verified-upstream.tgz'))
Assert-NoReparseChain -Path $upstreamTarballDestination -Label 'Online upstream acquisition destination'
Invoke-NodeChecked -Arguments @(
    $reviewedUpstreamVerifier,
    '--online',
    '--reviewed-export-manifest', $resolvedReviewedExportManifest,
    '--reviewed-export-manifest-sha256', $actualReviewedExportManifestSha256,
    '--reviewed-tree', $ReviewedTree
  ) | Out-Null

$behaviorRunnerPath = (Resolve-Path -LiteralPath (Join-Path $cellRoot 'scripts/behavior-probe-runner.mjs') -ErrorAction Stop).Path
$upstreamTarballPath = (Resolve-Path -LiteralPath $upstreamTarballDestination -ErrorAction Stop).Path
$upstreamTarballSha256 = (Get-FileHash -LiteralPath $upstreamTarballPath -Algorithm SHA256).Hash.ToLowerInvariant()
$stockDockerfilePath = (Resolve-Path -LiteralPath (Join-Path $cellRoot 'Dockerfile.stock-probe') -ErrorAction Stop).Path
$stockInstallerPath = (Resolve-Path -LiteralPath (Join-Path $cellRoot 'scripts/install-stock-zalouser-probe.sh') -ErrorAction Stop).Path
$stockDockerfileText = Get-Content -LiteralPath $stockDockerfilePath -Raw
$stockNormalizerName = 'normalize-openclaw-install.mjs'
if (-not $stockDockerfileText.Contains($stockNormalizerName)) {
  throw 'Dockerfile.stock-probe must bind the reviewed normalize-openclaw-install.mjs'
}
$stockNormalizerPath = (Resolve-Path -LiteralPath (Join-Path $cellRoot "scripts/$stockNormalizerName") -ErrorAction Stop).Path

foreach ($stockInput in @(
    [pscustomobject]@{ Path = $behaviorRunnerPath; Label = 'Behavior runner' },
    [pscustomobject]@{ Path = $upstreamTarballPath; Label = 'Verified upstream tarball' },
    [pscustomobject]@{ Path = $stockDockerfilePath; Label = 'Stock Dockerfile' },
    [pscustomobject]@{ Path = $stockInstallerPath; Label = 'Stock installer' },
    [pscustomobject]@{ Path = $stockNormalizerPath; Label = 'Stock normalizer' }
  )) {
  Assert-RegularArchive -Path $stockInput.Path -Label $stockInput.Label
}

$lockedQualificationOperands = [ordered]@{
  'Behavior runner' = @{ Path = $behaviorRunnerPath; Sha256 = (Get-FileHash -LiteralPath $behaviorRunnerPath -Algorithm SHA256).Hash.ToLowerInvariant() }
  'Verified upstream tarball' = @{ Path = $upstreamTarballPath; Sha256 = $upstreamTarballSha256 }
  'M review report' = @{ Path = $resolvedMReviewReport; Sha256 = $retainedMReviewSha256 }
  'R review report' = @{ Path = $resolvedRReviewReport; Sha256 = $retainedRReviewSha256 }
  'Buildx binary' = @{ Path = $resolvedBuildx; Sha256 = $actualBuildxSha256 }
  'Docker binary' = @{ Path = $resolvedDocker; Sha256 = $actualDockerSha256 }
  'Node executable' = @{ Path = $nodePath; Sha256 = $actualNodeSha256 }
  'Git executable' = @{ Path = $GitPath; Sha256 = $actualGitSha256 }
  'Stock Dockerfile' = @{ Path = $stockDockerfilePath; Sha256 = (Get-FileHash -LiteralPath $stockDockerfilePath -Algorithm SHA256).Hash.ToLowerInvariant() }
  'Stock installer' = @{ Path = $stockInstallerPath; Sha256 = (Get-FileHash -LiteralPath $stockInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant() }
  'Stock normalizer' = @{ Path = $stockNormalizerPath; Sha256 = (Get-FileHash -LiteralPath $stockNormalizerPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}

$lockPath = Join-Path $cellRoot 'image-lock.json'
$verifierPath = Join-Path $cellRoot 'scripts/verify-image-lock.mjs'
$schemaPath = Join-Path $cellRoot 'build-evidence.schema.v1.json'
$protectedQualificationInputs = @(
  $resolvedBuildx,
  $resolvedDocker,
  $nodePath,
  $GitPath,
  $resolvedMReviewReport,
  $resolvedRReviewReport,
  $resolvedReviewedExportManifest,
  $behaviorRunnerPath,
  $upstreamTarballPath,
  $stockDockerfilePath,
  $stockInstallerPath,
  $stockNormalizerPath,
  $reviewedExporter,
  $lockPath,
  $verifierPath,
  $schemaPath
)
foreach ($outputPath in @($resolvedEvidencePath) + $retainedOutputPaths) {
  foreach ($protectedPath in $protectedQualificationInputs) {
    if ([StringComparer]::Ordinal.Equals($outputPath, [IO.Path]::GetFullPath($protectedPath))) {
      throw 'Qualification outputs must be distinct from every retained input and authority path'
    }
  }
}
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json -Depth 16
if (
  [string]$lock.docker.version -ne '29.1.3' -or
  [string]$lock.docker.linux_amd64_sha256 -ne $expectedDockerSha256
) {
  throw 'image-lock.json Docker pin does not match the checked native binary'
}
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$workRoot = Join-Path $tempBase ('ihome-openclaw-image-' + [guid]::NewGuid().ToString('N'))
$contextRoot = Join-Path $workRoot 'context'
$stockContextRoot = Join-Path $workRoot 'stock-context'
$nativeHome = Join-Path $workRoot 'native-home'
$nativeConfigRoot = Join-Path $nativeHome '.config'
$nativeCacheRoot = Join-Path $nativeHome '.cache'
$dockerConfigRoot = Join-Path $nativeHome '.docker'
$ownershipMarker = Join-Path $workRoot '.ihome-openclaw-image-owner'
$ociA = Join-Path $workRoot 'gate-a.oci.tar'
$ociB = Join-Path $workRoot 'gate-b.oci.tar'
$stockOci = Join-Path $workRoot 'stock.oci.tar'
$builderA = 'ihome-openclaw-gate-a-' + [guid]::NewGuid().ToString('N')
$builderB = 'ihome-openclaw-gate-b-' + [guid]::NewGuid().ToString('N')
$buildkitImage = 'moby/buildkit:v0.13.2@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6'
$builderACreated = $false
$builderBCreated = $false
$primaryError = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()

try {
  New-Item -ItemType Directory -Path $contextRoot -ErrorAction Stop | Out-Null
  [IO.File]::WriteAllText($ownershipMarker, $ReviewedTree, [Text.UTF8Encoding]::new($false))
  foreach ($nativeDirectory in @($nativeHome, $nativeConfigRoot, $nativeCacheRoot, $dockerConfigRoot)) {
    New-Item -ItemType Directory -Path $nativeDirectory -Force -ErrorAction Stop | Out-Null
    Assert-NoReparseChain -Path $nativeDirectory -Label 'controlled native process directory'
  }
  $dockerEnvironment.HOME = $nativeHome
  $dockerEnvironment.DOCKER_CONFIG = $dockerConfigRoot
  $dockerEnvironment.XDG_CONFIG_HOME = $nativeConfigRoot
  $dockerEnvironment.XDG_CACHE_HOME = $nativeCacheRoot
  Copy-Item -LiteralPath $lockPath -Destination (Join-Path $contextRoot 'image-lock.json') -ErrorAction Stop
  foreach ($input in $lock.inputs) {
    $relativePath = [string]$input.path
    if ($relativePath.Contains('\') -or $relativePath.StartsWith('/') -or $relativePath.Split('/') -contains '..') {
      throw "Unsafe locked context path: $relativePath"
    }
    $source = [IO.Path]::GetFullPath((Join-Path $cellRoot $relativePath))
    $sourceRelative = [IO.Path]::GetRelativePath($cellRoot, $source)
    if ([IO.Path]::IsPathRooted($sourceRelative) -or $sourceRelative -eq '..' -or $sourceRelative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
      throw "Locked context path escaped cell root: $relativePath"
    }
    Assert-NoReparseChain -Path $source -Label "Locked context input $relativePath"
    $sourceItem = Get-Item -LiteralPath $source -Force -ErrorAction Stop
    if ($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Locked context input must be a regular non-reparse file: $relativePath"
    }
    $destination = Join-Path $contextRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
  }

  Invoke-NodeChecked -Arguments @(
    $verifierPath,
    '--mode', 'lock',
    '--root', $contextRoot,
    '--lock', (Join-Path $contextRoot 'image-lock.json'),
    '--expected-m', $ExpectedM,
    '--reviewed-tree', $ReviewedTree,
    '--m-review-report', $resolvedMReviewReport,
    '--r-review-report', $resolvedRReviewReport,
    '--git-path', $GitPath,
    '--git-repository-root', $resolvedGitRepositoryRoot,
    '--reviewed-source-root', $resolvedReviewedSourceRoot,
    '--reviewed-export-manifest', $resolvedReviewedExportManifest,
    '--reviewed-export-manifest-sha256', $actualReviewedExportManifestSha256
  ) | Out-Null

  $builderACreated = $true
  Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @(
    'create', '--name', $builderA, '--driver', 'docker-container',
    '--driver-opt', "image=$buildkitImage"
  ) | Out-Null
  $builderBCreated = $true
  Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @(
    'create', '--name', $builderB, '--driver', 'docker-container',
    '--driver-opt', "image=$buildkitImage"
  ) | Out-Null

  foreach ($builder in @($builderA, $builderB)) {
    $inspection = Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @(
      'inspect', '--bootstrap', $builder
    )
    if (($inspection -join "`n") -notmatch '(?m)\bv0\.13\.2\b') {
      throw "Builder $builder did not report BuildKit v0.13.2"
    }
  }

  $forkBuildArguments = @(
    'build',
    '--platform', $Platform,
    '--no-cache',
    '--pull',
    '--build-arg', "SOURCE_DATE_EPOCH=$SourceDateEpoch",
    '--provenance=false',
    '--sbom=false'
  )
  Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @(
    $forkBuildArguments + @(
      '--builder', $builderA,
      '--output', "type=oci,dest=$ociA,rewrite-timestamp=true",
      $contextRoot
    )
  ) | Out-Null

  New-Item -ItemType Directory -Path $stockContextRoot -ErrorAction Stop | Out-Null
  foreach ($stockContextInput in @(
      [pscustomobject]@{ Source = $stockDockerfilePath; Destination = 'Dockerfile.stock-probe' },
      [pscustomobject]@{ Source = $stockInstallerPath; Destination = 'install-stock-zalouser-probe.sh' },
      [pscustomobject]@{ Source = $stockNormalizerPath; Destination = $stockNormalizerName },
      [pscustomobject]@{ Source = $upstreamTarballPath; Destination = 'verified-upstream.tgz' }
    )) {
    $stockDestination = Join-Path $stockContextRoot $stockContextInput.Destination
    Copy-Item -LiteralPath $stockContextInput.Source -Destination $stockDestination -ErrorAction Stop
    $sourceSha256 = (Get-FileHash -LiteralPath $stockContextInput.Source -Algorithm SHA256).Hash.ToLowerInvariant()
    $destinationSha256 = (Get-FileHash -LiteralPath $stockDestination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceSha256 -ne $destinationSha256) {
      throw "Stock context copy mismatch: $($stockContextInput.Destination)"
    }
  }

  $stockBuildArguments = @(
    'build',
    '--platform', $Platform,
    '--no-cache',
    '--network', 'none',
    '--build-arg', "SOURCE_DATE_EPOCH=$SourceDateEpoch",
    '--provenance=false',
    '--sbom=false'
  )
  Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @(
    $stockBuildArguments + @(
      '--builder', $builderA,
      '--file', (Join-Path $stockContextRoot 'Dockerfile.stock-probe'),
      '--output', "type=oci,dest=$stockOci,rewrite-timestamp=true",
      $stockContextRoot
    )
  ) | Out-Null

  Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @(
    $forkBuildArguments + @(
      '--builder', $builderB,
      '--output', "type=oci,dest=$ociB,rewrite-timestamp=true",
      $contextRoot
    )
  ) | Out-Null

  Assert-DistinctArchives -Paths @($ociA, $ociB, $stockOci) -Label 'Temporary qualifying OCI archives'
  $retainedAHash = Publish-RetainedArchive -SourcePath $ociA -DestinationPath $resolvedReleaseArtifact -Label 'Fork OCI A'
  $retainedBHash = Publish-RetainedArchive -SourcePath $ociB -DestinationPath $resolvedReproductionArtifact -Label 'Fork OCI B'
  $retainedStockHash = Publish-RetainedArchive -SourcePath $stockOci -DestinationPath $resolvedStockOci -Label 'Stock OCI'
  $retainedUpstreamHash = Publish-RetainedArchive -SourcePath $upstreamTarballPath -DestinationPath $resolvedRetainedUpstreamTarball -Label 'Verified upstream tarball'
  Assert-DistinctArchives -Paths $retainedArchivePaths -Label 'Retained qualifying OCI archives'
  if ($retainedAHash.Hash.ToLowerInvariant() -ne $retainedBHash.Hash.ToLowerInvariant()) {
    throw 'Retained fork OCI archives are not byte-identical'
  }
  Assert-HashUnchanged -Bindings $lockedQualificationOperands -Phase 'image builds'

  Invoke-NodeChecked -Arguments @(
    $verifierPath,
    '--mode', 'qualify',
    '--root', $contextRoot,
    '--lock', (Join-Path $contextRoot 'image-lock.json'),
    '--oci-a', $resolvedReleaseArtifact,
    '--oci-b', $resolvedReproductionArtifact,
    '--stock-oci', $resolvedStockOci,
    '--upstream-tgz', $resolvedRetainedUpstreamTarball,
    '--behavior-runner', $behaviorRunnerPath,
    '--expected-m', $ExpectedM,
    '--reviewed-tree', $ReviewedTree,
    '--m-review-report', $resolvedMReviewReport,
    '--r-review-report', $resolvedRReviewReport,
    '--git-path', $GitPath,
    '--git-repository-root', $resolvedGitRepositoryRoot,
    '--schema', $schemaPath,
    '--evidence', $EvidencePath,
    '--release-artifact', $ReleaseArtifactPath,
    '--buildx-path', $resolvedBuildx,
    '--buildx-sha256', $actualBuildxSha256,
    '--docker-path', $resolvedDocker,
    '--docker-host', $DockerHost,
    '--docker-sha256', $actualDockerSha256,
    '--reviewed-source-root', $resolvedReviewedSourceRoot,
    '--reviewed-export-manifest', $resolvedReviewedExportManifest,
    '--reviewed-export-manifest-sha256', $actualReviewedExportManifestSha256
  ) | Out-Null

  Assert-HashUnchanged -Bindings $lockedQualificationOperands -Phase 'qualification verification'
  foreach ($retainedBinding in @(
      [pscustomobject]@{ Path = $resolvedReleaseArtifact; Sha256 = $retainedAHash.Hash.ToLowerInvariant(); Label = 'Fork OCI A' },
      [pscustomobject]@{ Path = $resolvedReproductionArtifact; Sha256 = $retainedBHash.Hash.ToLowerInvariant(); Label = 'Fork OCI B' },
      [pscustomobject]@{ Path = $resolvedStockOci; Sha256 = $retainedStockHash.Hash.ToLowerInvariant(); Label = 'Stock OCI' },
      [pscustomobject]@{ Path = $resolvedRetainedUpstreamTarball; Sha256 = $retainedUpstreamHash.Hash.ToLowerInvariant(); Label = 'Verified upstream tarball' }
    )) {
    $actualRetainedSha256 = (Get-FileHash -LiteralPath $retainedBinding.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualRetainedSha256 -ne $retainedBinding.Sha256) {
      throw "$($retainedBinding.Label) changed during qualification verification"
    }
  }
} catch {
  $primaryError = $_
} finally {
  foreach ($builderState in @(
    @{ Name = $builderA; Created = $builderACreated },
    @{ Name = $builderB; Created = $builderBCreated }
  )) {
    if ($builderState.Created) {
      try {
        Invoke-NativeChecked -FilePath $resolvedBuildx -Environment $dockerEnvironment -Arguments @(
          'rm', '--force', [string]$builderState.Name
        ) | Out-Null
      } catch {
        $cleanupErrors.Add($_.Exception.Message)
      }
    }
  }

  if (Test-Path -LiteralPath $workRoot) {
    try {
      $canonicalWorkRoot = [IO.Path]::GetFullPath($workRoot)
      $relativeToTemp = [IO.Path]::GetRelativePath($tempBase, $canonicalWorkRoot)
      if ([IO.Path]::IsPathRooted($relativeToTemp) -or $relativeToTemp -eq '..' -or $relativeToTemp.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
        throw 'Refusing to clean a path outside the canonical temp root'
      }
      $workItem = Get-Item -LiteralPath $canonicalWorkRoot -Force
      if (($workItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Test-Path -LiteralPath $ownershipMarker -PathType Leaf)) {
        throw 'Refusing to clean an unowned or reparse work root'
      }
      Remove-Item -LiteralPath $canonicalWorkRoot -Recurse -Force -ErrorAction Stop
    } catch {
      $cleanupErrors.Add($_.Exception.Message)
    }
  }
}

if ($null -ne $primaryError) {
  if ($cleanupErrors.Count -gt 0) {
    Write-Error ("Cleanup failures after primary error:`n" + ($cleanupErrors -join "`n")) -ErrorAction Continue
  }
  throw $primaryError
}
if ($cleanupErrors.Count -gt 0) {
  throw ("Image build cleanup failed:`n" + ($cleanupErrors -join "`n"))
}
