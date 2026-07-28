#Requires -Version 7.3

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ReviewedTree,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$MReviewedTree,

  [Parameter(Mandatory = $true)]
  [string]$MReviewReportPath,

  [Parameter(Mandatory = $true)]
  [string]$RReviewReportPath,

  [Parameter(Mandatory = $true)]
  [string]$BuildxPath,

  [Parameter(Mandatory = $true)]
  [string]$DockerPath,

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
  [string]$ReleaseArtifactPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Native command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return @($output)
}

$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
Invoke-NativeChecked -FilePath $nodePath -Arguments @(
  '-e',
  'const m=/^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.version);if(!m||Number(m[1])<15){console.error("Official stable Node >=24.15.0 <25 is required");process.exit(1)}'
) | Out-Null

$cellRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if (-not [IO.Path]::IsPathFullyQualified($BuildxPath)) {
  throw 'BuildxPath must be absolute; PATH lookup is forbidden'
}
if (-not [IO.Path]::IsPathFullyQualified($DockerPath)) {
  throw 'DockerPath must be absolute; PATH lookup is forbidden'
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
if ($MReviewedTree -eq $ReviewedTree) {
  throw 'MReviewedTree and ReviewedTree must be distinct'
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
if ($resolvedMReviewReport -eq $resolvedRReviewReport) {
  throw 'M and R review reports must be distinct files'
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
$buildxVersion = Invoke-NativeChecked -FilePath $resolvedBuildx -Arguments @('version')
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
$dockerVersion = Invoke-NativeChecked -FilePath $resolvedDocker -Arguments @(
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
Invoke-NativeChecked -FilePath $nodePath -Arguments @(
  $reviewedExporter,
  'verify', '--reviewed-tree', $ReviewedTree,
  '--output-root', $resolvedReviewedSourceRoot,
  '--manifest', $resolvedReviewedExportManifest
) | Out-Null

$lockPath = Join-Path $cellRoot 'image-lock.json'
$verifierPath = Join-Path $cellRoot 'scripts/verify-image-lock.mjs'
$schemaPath = Join-Path $cellRoot 'build-evidence.schema.v1.json'
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
$ownershipMarker = Join-Path $workRoot '.ihome-openclaw-image-owner'
$ociA = Join-Path $workRoot 'gate-a.oci.tar'
$ociB = Join-Path $workRoot 'gate-b.oci.tar'
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
    $sourceItem = Get-Item -LiteralPath $source -Force -ErrorAction Stop
    if ($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Locked context input must be a regular non-reparse file: $relativePath"
    }
    $destination = Join-Path $contextRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
  }

  Invoke-NativeChecked -FilePath $nodePath -Arguments @(
    $verifierPath,
    '--root', $contextRoot,
    '--lock', (Join-Path $contextRoot 'image-lock.json'),
    '--m-reviewed-tree', $MReviewedTree,
    '--reviewed-tree', $ReviewedTree,
    '--m-review-report', $resolvedMReviewReport,
    '--r-review-report', $resolvedRReviewReport,
    '--reviewed-source-root', $resolvedReviewedSourceRoot,
    '--reviewed-export-manifest', $resolvedReviewedExportManifest,
    '--reviewed-export-manifest-sha256', $actualReviewedExportManifestSha256
  ) | Out-Null

  $builderACreated = $true
  Invoke-NativeChecked -FilePath $resolvedBuildx -Arguments @(
    'create', '--name', $builderA, '--driver', 'docker-container',
    '--driver-opt', "image=$buildkitImage"
  ) | Out-Null
  $builderBCreated = $true
  Invoke-NativeChecked -FilePath $resolvedBuildx -Arguments @(
    'create', '--name', $builderB, '--driver', 'docker-container',
    '--driver-opt', "image=$buildkitImage"
  ) | Out-Null

  foreach ($builder in @($builderA, $builderB)) {
    $inspection = Invoke-NativeChecked -FilePath $resolvedBuildx -Arguments @(
      'inspect', '--bootstrap', $builder
    )
    if (($inspection -join "`n") -notmatch '(?m)\bv0\.13\.2\b') {
      throw "Builder $builder did not report BuildKit v0.13.2"
    }
  }

  $commonBuildArguments = @(
    'build',
    '--platform', $Platform,
    '--no-cache',
    '--pull',
    '--build-arg', "SOURCE_DATE_EPOCH=$SourceDateEpoch",
    '--provenance=false',
    '--sbom=false'
  )
  Invoke-NativeChecked -FilePath $resolvedBuildx -Arguments @(
    $commonBuildArguments + @(
      '--builder', $builderA,
      '--output', "type=oci,dest=$ociA,rewrite-timestamp=true",
      $contextRoot
    )
  ) | Out-Null
  Invoke-NativeChecked -FilePath $resolvedBuildx -Arguments @(
    $commonBuildArguments + @(
      '--builder', $builderB,
      '--output', "type=oci,dest=$ociB,rewrite-timestamp=true",
      $contextRoot
    )
  ) | Out-Null

  Invoke-NativeChecked -FilePath $nodePath -Arguments @(
    $verifierPath,
    '--root', $contextRoot,
    '--lock', (Join-Path $contextRoot 'image-lock.json'),
    '--oci-a', $ociA,
    '--oci-b', $ociB,
    '--m-reviewed-tree', $MReviewedTree,
    '--reviewed-tree', $ReviewedTree,
    '--m-review-report', $resolvedMReviewReport,
    '--r-review-report', $resolvedRReviewReport,
    '--schema', $schemaPath,
    '--evidence', $EvidencePath,
    '--release-artifact', $ReleaseArtifactPath,
    '--buildx-path', $resolvedBuildx,
    '--buildx-sha256', $actualBuildxSha256,
    '--docker-path', $resolvedDocker,
    '--docker-sha256', $actualDockerSha256,
    '--reviewed-source-root', $resolvedReviewedSourceRoot,
    '--reviewed-export-manifest', $resolvedReviewedExportManifest,
    '--reviewed-export-manifest-sha256', $actualReviewedExportManifestSha256
  ) | Out-Null
} catch {
  $primaryError = $_
} finally {
  foreach ($builderState in @(
    @{ Name = $builderA; Created = $builderACreated },
    @{ Name = $builderB; Created = $builderBCreated }
  )) {
    if ($builderState.Created) {
      try {
        Invoke-NativeChecked -FilePath $resolvedBuildx -Arguments @(
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
