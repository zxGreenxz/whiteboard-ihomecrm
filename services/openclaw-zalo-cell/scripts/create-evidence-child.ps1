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
  [string]$CandidateEvidencePath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateArchivePath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateArchiveBPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateStockOciPath,

  [Parameter(Mandatory = $true)]
  [string]$UpstreamTarballPath,

  [Parameter(Mandatory = $true)]
  [string]$DockerPath,

  [Parameter(Mandatory = $true)]
  [string]$DockerHost,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$GitPath
)

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
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { throw "$Label has no existing ancestor" }
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

function Assert-EvidenceOnlyWorktreeStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Worktree,
    [Parameter(Mandatory = $true)][string]$ExpectedPrefix
  )
  $status = @(Invoke-Git @('-C', $Worktree, 'status', '--porcelain=v1', '--untracked-files=all'))
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect detached E worktree status' }
  $expected = "$ExpectedPrefix services/openclaw-zalo-cell/build-evidence.json"
  if ($status.Count -ne 1 -or $status[0] -ne $expected) {
    throw "Detached E worktree status is not evidence-only: $($status -join ', ')"
  }
}

function Assert-ReviewedBlob {
  param(
    [Parameter(Mandatory = $true)][string]$WorktreePath,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $expectedOid = @(Invoke-Git @('-C', $sourceRoot, 'rev-parse', "$ReviewedTree`:$RelativePath"))
  if ($LASTEXITCODE -ne 0 -or $expectedOid.Count -ne 1) { throw "Unable to resolve reviewed $Label Git blob" }
  $actualOid = @(Invoke-Git @('-C', $WorktreePath, 'hash-object', '--', $RelativePath))
  if ($LASTEXITCODE -ne 0 -or $actualOid.Count -ne 1 -or $actualOid[0].Trim() -ne $expectedOid[0].Trim()) {
    throw "$Label bytes do not match the exact ReviewedTree Git blob"
  }
}

function Get-GitBlobSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$ObjectId,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $GitPath
  $startInfo.ArgumentList.Add('--no-replace-objects')
  $startInfo.ArgumentList.Add('-c')
  $startInfo.ArgumentList.Add('core.fsmonitor=false')
  $startInfo.ArgumentList.Add('-c')
  $startInfo.ArgumentList.Add('core.hooksPath=/dev/null')
  $startInfo.ArgumentList.Add('-c')
  $startInfo.ArgumentList.Add('commit.gpgSign=false')
  $startInfo.ArgumentList.Add('-c')
  $startInfo.ArgumentList.Add('core.attributesFile=/dev/null')
  $startInfo.ArgumentList.Add('-C')
  $startInfo.ArgumentList.Add($sourceRoot)
  $startInfo.ArgumentList.Add('cat-file')
  $startInfo.ArgumentList.Add('blob')
  $startInfo.ArgumentList.Add($ObjectId)
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Environment.Clear()
  foreach ($binding in $gitEnvironment.GetEnumerator()) {
    $startInfo.Environment[[string]$binding.Key] = [string]$binding.Value
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Unable to start raw Git blob read for $Label" }
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash($process.StandardOutput.BaseStream)
  } finally {
    $sha256.Dispose()
  }
  $process.WaitForExit()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
  $script:LASTEXITCODE = $exitCode
  $process.Dispose()
  if ($exitCode -ne 0) { throw "Unable to read raw Git blob for $Label`: $stderr" }
  return [Convert]::ToHexString($hashBytes).ToLowerInvariant()
}

function Assert-SourceWorktreeState {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedHead,
    [Parameter(Mandatory = $true)][string]$Context
  )
  $branchRef = @(Invoke-Git @('-C', $sourceRoot, 'symbolic-ref', '--quiet', 'HEAD'))
  if ($LASTEXITCODE -ne 0 -or $branchRef.Count -ne 1 -or $branchRef[0].Trim() -ne $sourceBranchRef) {
    throw "Source branch ref changed or became detached $Context"
  }
  $head = @(Invoke-Git @('-C', $sourceRoot, 'rev-parse', 'HEAD'))
  if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0].Trim() -ne $ExpectedHead) {
    throw "Source branch HEAD changed $Context"
  }
  $status = @(Invoke-Git @('-C', $sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'))
  if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
    throw "Source worktree is not completely clean $Context`: $($status -join ', ')"
  }
  Invoke-Git @('-C', $sourceRoot, 'diff', '--cached', '--quiet') | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Source index is not empty $Context"
  }
  $gitStatePaths = @(
    (Invoke-Git @('-C', $sourceRoot, 'rev-parse', '--git-path', 'MERGE_HEAD')),
    (Invoke-Git @('-C', $sourceRoot, 'rev-parse', '--git-path', 'rebase-merge')),
    (Invoke-Git @('-C', $sourceRoot, 'rev-parse', '--git-path', 'rebase-apply'))
  )
  if ($LASTEXITCODE -ne 0 -or @($gitStatePaths | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) {
    throw "Merge or rebase is in progress $Context"
  }
}

function Assert-RetainedAuthorityBindings {
  param([Parameter(Mandatory = $true)][string]$Context)
  $bindings = @(
    [pscustomobject]@{ Path = $candidateEvidence; Label = 'candidate evidence'; Expected = $candidateEvidenceSha256 },
    [pscustomobject]@{ Path = $candidateArchive; Label = 'candidate archive A'; Expected = $candidateArchiveSha256 },
    [pscustomobject]@{ Path = $candidateArchiveB; Label = 'candidate archive B'; Expected = $candidateArchiveBSha256 },
    [pscustomobject]@{ Path = $candidateStockOci; Label = 'candidate stock OCI'; Expected = $candidateStockOciSha256 },
    [pscustomobject]@{ Path = $upstreamTarball; Label = 'retained upstream tgz'; Expected = $upstreamTarballSha256 },
    [pscustomobject]@{ Path = $dockerPath; Label = 'Docker CLI'; Expected = $dockerSha256 },
    [pscustomobject]@{ Path = $nodePath; Label = 'Node executable'; Expected = $actualNodeSha256 },
    [pscustomobject]@{ Path = $GitPath; Label = 'Git executable'; Expected = $actualGitSha256 },
    [pscustomobject]@{ Path = $mReviewReport; Label = 'M review report'; Expected = $retainedMReviewSha256 },
    [pscustomobject]@{ Path = $rReviewReport; Label = 'R review report'; Expected = $retainedRReviewSha256 }
  )
  foreach ($binding in $bindings) {
    Assert-NoReparseChain -Path $binding.Path -Label "$($binding.Label) $Context"
    $item = Get-Item -LiteralPath $binding.Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "$($binding.Label) must remain a regular non-reparse file $Context"
    }
    $actual = (Get-FileHash -LiteralPath $binding.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $binding.Expected) {
      throw "$($binding.Label) bytes changed $Context"
    }
  }
}

if (-not [IO.Path]::IsPathFullyQualified($NodePath)) {
  throw 'NodePath must be absolute; PATH lookup is forbidden'
}
Assert-NoReparseChain -Path $NodePath -Label 'Node executable'
$nodePath = [IO.Path]::GetFullPath($NodePath)
$nodeItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
$expectedNodeSize = 122889056
$expectedNodeSha256 = 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c'
$actualNodeSha256 = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeItem.PSIsContainer -or ($nodeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    $nodeItem.Length -ne $expectedNodeSize -or $actualNodeSha256 -ne $expectedNodeSha256) {
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

$sourceRoot = [IO.Path]::GetFullPath((Get-Location).Path)
$servicesRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'services'))
$cellRoot = [IO.Path]::GetFullPath((Join-Path $servicesRoot 'openclaw-zalo-cell'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $cellRoot '.release'))

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
  GIT_AUTHOR_EMAIL = 'noreply@openai.com'
  GIT_AUTHOR_NAME = 'Codex'
  GIT_COMMITTER_EMAIL = 'noreply@openai.com'
  GIT_COMMITTER_NAME = 'Codex'
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

function Invoke-Git {
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

$gitVersionOutput = Invoke-Git -Arguments @('--version')
if ($LASTEXITCODE -ne 0 -or ($gitVersionOutput -join "`n").Trim() -ne "git version $expectedGitVersion") {
  throw 'GitPath version does not match the pinned Git authority'
}

if (-not [IO.Path]::IsPathFullyQualified($CandidateEvidencePath)) {
  throw 'CandidateEvidencePath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($CandidateArchivePath)) {
  throw 'CandidateArchivePath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($CandidateArchiveBPath)) {
  throw 'CandidateArchiveBPath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($CandidateStockOciPath)) {
  throw 'CandidateStockOciPath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($UpstreamTarballPath)) {
  throw 'UpstreamTarballPath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($DockerPath)) {
  throw 'DockerPath must be absolute'
}
if ($DockerHost -notmatch '^unix:///.+$') {
  throw 'DockerHost must be an explicit absolute unix socket URI'
}
if (-not [IO.Path]::IsPathFullyQualified($MReviewReportPath) -or
    -not [IO.Path]::IsPathFullyQualified($RReviewReportPath)) {
  throw 'Retained review report paths must be absolute'
}
if ($ExpectedM -eq $ReviewedTree) { throw 'ExpectedM and ReviewedTree must be distinct' }

$candidateEvidence = [IO.Path]::GetFullPath($CandidateEvidencePath)
$candidateArchive = [IO.Path]::GetFullPath($CandidateArchivePath)
$candidateArchiveB = [IO.Path]::GetFullPath($CandidateArchiveBPath)
$candidateStockOci = [IO.Path]::GetFullPath($CandidateStockOciPath)
$upstreamTarball = [IO.Path]::GetFullPath($UpstreamTarballPath)
$dockerPath = [IO.Path]::GetFullPath($DockerPath)
$mReviewReport = [IO.Path]::GetFullPath($MReviewReportPath)
$rReviewReport = [IO.Path]::GetFullPath($RReviewReportPath)
$expectedMReviewReport = [IO.Path]::GetFullPath((Join-Path $sourceRoot "services/openclaw-zalo-cell/.release/reviews/m-review-report-v1-$ExpectedM.json"))
$expectedRReviewReport = [IO.Path]::GetFullPath((Join-Path $sourceRoot "services/openclaw-zalo-cell/.release/reviews/r-review-report-v1-$ReviewedTree.json"))
if ($mReviewReport -ne $expectedMReviewReport -or $rReviewReport -ne $expectedRReviewReport) {
  throw 'Review reports must use the canonical SHA-bound .release/reviews paths'
}
$evidenceRelative = [IO.Path]::GetRelativePath($releaseRoot, $candidateEvidence)
$archiveRelative = [IO.Path]::GetRelativePath($releaseRoot, $candidateArchive)
$archiveBRelative = [IO.Path]::GetRelativePath($releaseRoot, $candidateArchiveB)
$stockRelative = [IO.Path]::GetRelativePath($releaseRoot, $candidateStockOci)
$upstreamRelative = [IO.Path]::GetRelativePath($releaseRoot, $upstreamTarball)
foreach ($candidateRelative in @($evidenceRelative, $archiveRelative, $archiveBRelative, $stockRelative, $upstreamRelative)) {
  if ([IO.Path]::IsPathRooted($candidateRelative) -or
      $candidateRelative -eq '.' -or
      $candidateRelative -eq '..' -or
      $candidateRelative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
    throw 'Task 2 candidate escaped the canonical release root'
  }
}
if (@($candidateEvidence, $candidateArchive, $candidateArchiveB, $candidateStockOci, $upstreamTarball) |
    Group-Object | Where-Object Count -gt 1) {
  throw 'Evidence and retained artifact candidates must be pairwise distinct'
}

$sourceItem = Get-Item -LiteralPath $sourceRoot -Force -ErrorAction Stop
$servicesItem = Get-Item -LiteralPath $servicesRoot -Force -ErrorAction Stop
$cellItem = Get-Item -LiteralPath $cellRoot -Force -ErrorAction Stop
$releaseItem = Get-Item -LiteralPath $releaseRoot -Force -ErrorAction Stop
$candidateEvidenceItem = Get-Item -LiteralPath $candidateEvidence -Force -ErrorAction Stop
$candidateArchiveItem = Get-Item -LiteralPath $candidateArchive -Force -ErrorAction Stop
$candidateArchiveBItem = Get-Item -LiteralPath $candidateArchiveB -Force -ErrorAction Stop
$candidateStockOciItem = Get-Item -LiteralPath $candidateStockOci -Force -ErrorAction Stop
$upstreamTarballItem = Get-Item -LiteralPath $upstreamTarball -Force -ErrorAction Stop
$dockerItem = Get-Item -LiteralPath $dockerPath -Force -ErrorAction Stop
if (-not $sourceItem.PSIsContainer -or
    -not $servicesItem.PSIsContainer -or
    -not $cellItem.PSIsContainer -or
    -not $releaseItem.PSIsContainer) {
  throw 'Source and release ancestors must be directories'
}
if (@($candidateEvidenceItem, $candidateArchiveItem, $candidateArchiveBItem, $candidateStockOciItem, $upstreamTarballItem, $dockerItem) |
    Where-Object { $_.PSIsContainer }) {
  throw 'Evidence, retained artifacts, and Docker must be regular files'
}
foreach ($checkedItem in @(
    $sourceItem, $servicesItem, $cellItem, $releaseItem,
    $candidateEvidenceItem, $candidateArchiveItem, $candidateArchiveBItem,
    $candidateStockOciItem, $upstreamTarballItem, $dockerItem, $nodeItem
  )) {
  if ($checkedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Source, release, and candidate paths must not traverse a reparse point'
  }
}
foreach ($pathBinding in @(
    [pscustomobject]@{ Path = $sourceRoot; Label = 'source root' },
    [pscustomobject]@{ Path = $servicesRoot; Label = 'services root' },
    [pscustomobject]@{ Path = $cellRoot; Label = 'cell root' },
    [pscustomobject]@{ Path = $releaseRoot; Label = 'release root' },
    [pscustomobject]@{ Path = $candidateEvidence; Label = 'candidate evidence' },
    [pscustomobject]@{ Path = $candidateArchive; Label = 'candidate archive A' },
    [pscustomobject]@{ Path = $candidateArchiveB; Label = 'candidate archive B' },
    [pscustomobject]@{ Path = $candidateStockOci; Label = 'candidate stock OCI' },
    [pscustomobject]@{ Path = $upstreamTarball; Label = 'retained upstream tgz' },
    [pscustomobject]@{ Path = $dockerPath; Label = 'Docker CLI' },
    [pscustomobject]@{ Path = $nodePath; Label = 'Node executable' },
    [pscustomobject]@{ Path = $GitPath; Label = 'Git executable' },
    [pscustomobject]@{ Path = $mReviewReport; Label = 'M review report' },
    [pscustomobject]@{ Path = $rReviewReport; Label = 'R review report' }
  )) {
  Assert-NoReparseChain -Path $pathBinding.Path -Label $pathBinding.Label
}

$mType = Invoke-Git @('-C', $sourceRoot, 'cat-file', '-t', "$ExpectedM`^{commit}")
if ($LASTEXITCODE -ne 0 -or ($mType -join "`n").Trim() -ne 'commit') { throw 'ExpectedM is not an exact Git commit object' }
$resolvedM = Invoke-Git @('-C', $sourceRoot, 'rev-parse', '--verify', "$ExpectedM`^{commit}")
if ($LASTEXITCODE -ne 0 -or ($resolvedM -join "`n").Trim() -ne $ExpectedM) { throw 'ExpectedM does not resolve exactly' }
$rType = Invoke-Git @('-C', $sourceRoot, 'cat-file', '-t', "$ReviewedTree`^{commit}")
if ($LASTEXITCODE -ne 0 -or ($rType -join "`n").Trim() -ne 'commit') { throw 'ReviewedTree is not an exact Git commit object' }
$resolvedR = Invoke-Git @('-C', $sourceRoot, 'rev-parse', '--verify', "$ReviewedTree`^{commit}")
if ($LASTEXITCODE -ne 0 -or ($resolvedR -join "`n").Trim() -ne $ReviewedTree) { throw 'ReviewedTree does not resolve exactly' }
Invoke-Git @('-C', $sourceRoot, 'merge-base', '--is-ancestor', $ExpectedM, $ReviewedTree) | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ExpectedM is not an ancestor of ReviewedTree' }
$sourceBranchRefResult = @(Invoke-Git @('-C', $sourceRoot, 'symbolic-ref', '--quiet', 'HEAD'))
if ($LASTEXITCODE -ne 0 -or $sourceBranchRefResult.Count -ne 1) {
  throw 'Source worktree must be attached to exactly one branch ref'
}
$sourceBranchRef = $sourceBranchRefResult[0].Trim()
if ($sourceBranchRef -notmatch '^refs/heads/[A-Za-z0-9._/-]+$' -or $sourceBranchRef.Contains('..')) {
  throw 'Source branch ref is not a canonical local branch'
}
$sourceBranchOid = @(Invoke-Git @('-C', $sourceRoot, 'show-ref', '--verify', '--hash', $sourceBranchRef))
if ($LASTEXITCODE -ne 0 -or $sourceBranchOid.Count -ne 1 -or $sourceBranchOid[0].Trim() -ne $ReviewedTree) {
  throw 'Source branch ref is not bound to exact ReviewedTree'
}
$retainedMReviewSha256 = (Get-FileHash -LiteralPath $mReviewReport -Algorithm SHA256).Hash.ToLowerInvariant()
$retainedRReviewSha256 = (Get-FileHash -LiteralPath $rReviewReport -Algorithm SHA256).Hash.ToLowerInvariant()

$candidateEvidenceSha256 = (Get-FileHash -LiteralPath $candidateEvidence -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateArchiveSha256 = (Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateArchiveBSha256 = (Get-FileHash -LiteralPath $candidateArchiveB -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateStockOciSha256 = (Get-FileHash -LiteralPath $candidateStockOci -Algorithm SHA256).Hash.ToLowerInvariant()
$upstreamTarballSha256 = (Get-FileHash -LiteralPath $upstreamTarball -Algorithm SHA256).Hash.ToLowerInvariant()
$dockerSha256 = (Get-FileHash -LiteralPath $dockerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($candidateArchiveSha256 -ne $candidateArchiveBSha256) {
  throw 'Candidate fork OCI A/B archives must be byte-identical'
}
if ($candidateArchiveSha256 -eq $candidateStockOciSha256) {
  throw 'Candidate stock OCI must be byte-distinct from fork OCI A/B'
}

Assert-SourceWorktreeState -ExpectedHead $ReviewedTree -Context 'before detached E creation'
Assert-RetainedAuthorityBindings -Context 'before detached E creation'

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRootItem = Get-Item -LiteralPath $tempRoot -Force -ErrorAction Stop
if (-not $tempRootItem.PSIsContainer -or
    ($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Temp root must be a regular non-reparse directory'
}
Assert-NoReparseChain -Path $tempRoot -Label 'temp root'
$eWorktree = [IO.Path]::GetFullPath((Join-Path $tempRoot ('ihome-openclaw-e-' + [guid]::NewGuid().ToString('N'))))
$eRelative = [IO.Path]::GetRelativePath($tempRoot, $eWorktree)
if ([IO.Path]::IsPathRooted($eRelative) -or
    $eRelative -eq '..' -or
    $eRelative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
  throw 'Detached E path escaped canonical temp root'
}
if (Test-Path -LiteralPath $eWorktree) {
  throw 'Detached E worktree path already exists'
}

$E = $null
$primaryError = $null
$cleanupError = $null
try {
  Invoke-Git @('worktree', 'add', '--detach', $eWorktree, $ReviewedTree) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create detached E worktree' }
  Assert-NoReparseChain -Path $eWorktree -Label 'detached E worktree'
  if (((Invoke-Git @('-C', $eWorktree, 'rev-parse', 'HEAD')) -join "`n").Trim() -ne $ReviewedTree) {
    throw 'Detached E worktree is not exact ReviewedTree'
  }

  $eDestination = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell/build-evidence.json'))
  $eCellRoot = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell'))
  $eSchema = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell/build-evidence.schema.v1.json'))
  $eLock = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell/image-lock.json'))
  $eVerifier = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs'))
  $eBehaviorRunner = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs'))
  if (-not [IO.Path]::IsPathFullyQualified($eDestination) -or
      -not [IO.Path]::IsPathFullyQualified($eSchema) -or
      -not [IO.Path]::IsPathFullyQualified($eVerifier) -or
      -not [IO.Path]::IsPathFullyQualified($eLock) -or
      -not [IO.Path]::IsPathFullyQualified($eBehaviorRunner)) {
    throw 'Evidence, schema, lock, runner, and verifier operands must be absolute'
  }
  if (Test-Path -LiteralPath $eDestination) {
    throw 'ReviewedTree already contains tracked or untracked build evidence'
  }
  Assert-NoReparseChain -Path $eDestination -Label 'detached E evidence destination'
  Assert-NoReparseChain -Path $eSchema -Label 'detached E schema'
  Assert-NoReparseChain -Path $eLock -Label 'detached E image lock'
  Assert-NoReparseChain -Path $eVerifier -Label 'detached E verifier'
  Assert-NoReparseChain -Path $eBehaviorRunner -Label 'detached E behavior runner'
  Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs' -Label 'Verifier'
  Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/build-evidence.schema.v1.json' -Label 'Evidence schema'
  Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/image-lock.json' -Label 'Image lock'
  Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs' -Label 'Behavior runner'
  New-Item -ItemType Directory -Path (Split-Path -Parent $eDestination) -Force -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $candidateEvidence -Destination $eDestination -Force -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $eDestination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateEvidenceSha256) {
    throw 'Copied evidence hash mismatch'
  }
  if ((Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateArchiveSha256) {
    throw 'Candidate archive changed before E verification'
  }
  Assert-EvidenceOnlyWorktreeStatus -Worktree $eWorktree -ExpectedPrefix '??'

  Push-Location $eWorktree
  try {
    $verifyArgs = @(
      $eVerifier,
      '--mode', 'evidence-replay-v1',
      '--root', $eCellRoot,
      '--lock', $eLock,
      '--evidence', $eDestination,
      '--schema', $eSchema,
      '--reviewed-tree', $ReviewedTree,
      '--expected-m', $ExpectedM,
      '--oci-a', $candidateArchive,
      '--oci-b', $candidateArchiveB,
      '--stock-oci', $candidateStockOci,
      '--upstream-tgz', $upstreamTarball,
      '--behavior-runner', $eBehaviorRunner,
      '--docker-path', $dockerPath,
      '--docker-host', $DockerHost,
      '--docker-sha256', $dockerSha256,
      '--git-path', $GitPath,
      '--git-repository-root', $sourceRoot,
      '--m-review-report', $mReviewReport,
      '--r-review-report', $rReviewReport
    )
    Invoke-NodeChecked -Arguments $verifyArgs | Out-Null
    $verifierExitCode = 0
    Assert-NoReparseChain -Path $eVerifier -Label 'detached E verifier after execution'
    Assert-NoReparseChain -Path $eSchema -Label 'detached E schema after execution'
    Assert-NoReparseChain -Path $eLock -Label 'detached E image lock after execution'
    Assert-NoReparseChain -Path $eBehaviorRunner -Label 'detached E behavior runner after execution'
    Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs' -Label 'Verifier'
    Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/build-evidence.schema.v1.json' -Label 'Evidence schema'
    Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/image-lock.json' -Label 'Image lock'
    Assert-ReviewedBlob -WorktreePath $eWorktree -RelativePath 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs' -Label 'Behavior runner'
    if ((Get-FileHash -LiteralPath $mReviewReport -Algorithm SHA256).Hash.ToLowerInvariant() -ne $retainedMReviewSha256 -or
        (Get-FileHash -LiteralPath $rReviewReport -Algorithm SHA256).Hash.ToLowerInvariant() -ne $retainedRReviewSha256) {
      throw 'Retained canonical review report bytes changed during detached E reauthentication'
    }
    if ((Get-FileHash -LiteralPath $eDestination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateEvidenceSha256) {
      throw 'Detached E evidence bytes changed during verification'
    }
    Assert-RetainedAuthorityBindings -Context 'after detached E verification'
    Assert-EvidenceOnlyWorktreeStatus -Worktree $eWorktree -ExpectedPrefix '??'
    if ($verifierExitCode -ne 0) { throw 'Evidence verifier rejected candidate E' }

    Invoke-Git @('add', '--', 'services/openclaw-zalo-cell/build-evidence.json') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stage evidence-only child' }
    Assert-EvidenceOnlyWorktreeStatus -Worktree $eWorktree -ExpectedPrefix 'A '
    $ePaths = @(Invoke-Git @('diff', '--cached', '--name-only'))
    if (($ePaths.Count -ne 1) -or ($ePaths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) {
      throw 'E staged diff is not evidence-only'
    }
    Invoke-Git @('commit', '-m', 'chore(openclaw-zalo): record verified evidence E', '-m', 'Co-Authored-By: Codex <noreply@openai.com>') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to commit evidence-only child E' }
    $E = (Invoke-Git @('rev-parse', 'HEAD') -join "`n").Trim()
    $committedEvidenceSpec = "$E`:services/openclaw-zalo-cell/build-evidence.json"
  $committedEvidenceOid = @(Invoke-Git @('-C', $sourceRoot, 'rev-parse', $committedEvidenceSpec))
    if ($LASTEXITCODE -ne 0 -or $committedEvidenceOid.Count -ne 1 -or
        $committedEvidenceOid[0].Trim() -notmatch '^[0-9a-f]{40}$') {
      throw 'Unable to resolve the committed evidence Git blob'
    }
    $committedEvidenceOid = $committedEvidenceOid[0].Trim()
  $committedEvidenceType = @(Invoke-Git @('-C', $sourceRoot, 'cat-file', '-t', $committedEvidenceOid))
    if ($LASTEXITCODE -ne 0 -or ($committedEvidenceType -join "`n").Trim() -ne 'blob') {
      throw 'Committed evidence object is not a Git blob'
    }
  $committedEvidenceSize = [int64]((Invoke-Git @('-C', $sourceRoot, 'cat-file', '-s', $committedEvidenceOid)) -join "`n").Trim()
    if ($LASTEXITCODE -ne 0 -or $committedEvidenceSize -ne (Get-Item -LiteralPath $candidateEvidence).Length) {
      throw 'Committed evidence Git blob size differs from the verified candidate'
    }
    $committedEvidenceSha256 = Get-GitBlobSha256 -ObjectId $committedEvidenceOid -Label 'committed evidence'
    if ($committedEvidenceSha256 -ne $candidateEvidenceSha256) {
      throw 'Committed evidence Git blob bytes differ from the verified candidate'
    }
    $parentLine = @(Invoke-Git @('rev-list', '--parents', '-n', '1', $E))
    if ($LASTEXITCODE -ne 0 -or $parentLine.Count -ne 1) {
      throw 'Unable to read the exact E parent list'
    }
    $parentFields = @($parentLine[0] -split '\s+')
    if ($parentFields.Count -ne 2 -or $parentFields[1] -ne $ReviewedTree) {
      throw 'E must have exactly one parent and it must be ReviewedTree'
    }
    if (((Invoke-Git @('rev-parse', "$E^") -join "`n").Trim()) -ne $ReviewedTree) {
      throw 'E is not a direct child of the reviewed tree'
    }
    $committedPaths = @(Invoke-Git @('diff-tree', '--no-commit-id', '--name-only', '-r', $E))
    if (($committedPaths.Count -ne 1) -or ($committedPaths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) {
      throw 'E committed diff is not evidence-only'
    }
  } finally {
    Pop-Location
  }
} catch {
  $primaryError = $_
} finally {
  try {
  $registeredPaths = @(Invoke-Git @('worktree', 'list', '--porcelain') |
      Where-Object { $_ -like 'worktree *' } |
      ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if (($registeredPaths -contains $eWorktree) -or (Test-Path -LiteralPath $eWorktree)) {
  Invoke-Git @('worktree', 'remove', '--force', $eWorktree) | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Forced detached E worktree removal failed' }
    }
    if (Test-Path -LiteralPath $eWorktree) {
      throw 'Detached E path remains after forced removal'
    }
  $remainingPaths = @(Invoke-Git @('worktree', 'list', '--porcelain') |
      Where-Object { $_ -like 'worktree *' } |
      ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if ($remainingPaths -contains $eWorktree) {
      throw 'Detached E registration remains after forced removal'
    }
  } catch {
    $cleanupError = $_
  }
  if ($null -ne $primaryError) {
    if ($null -ne $cleanupError) {
      [Console]::Error.WriteLine('Detached E cleanup also failed: ' + $cleanupError.Exception.Message)
    }
    throw $primaryError
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}

if ($null -eq $E) { throw 'Evidence-only child E was not created' }
Assert-SourceWorktreeState -ExpectedHead $ReviewedTree -Context 'before E fast-forward'
Assert-RetainedAuthorityBindings -Context 'before E fast-forward'
$branchAdvanced = $false
try {
  Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', $sourceBranchRef, $E, $ReviewedTree) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Source branch compare-and-swap to E failed' }
  $branchAdvanced = $true
  $currentBranchRef = @((Invoke-Git @('-C', $sourceRoot, 'symbolic-ref', '--quiet', 'HEAD')))
  if ($LASTEXITCODE -ne 0 -or $currentBranchRef.Count -ne 1 -or $currentBranchRef[0].Trim() -ne $sourceBranchRef) {
    throw 'Source branch ref changed during E compare-and-swap'
  }
  Invoke-Git @('-C', $sourceRoot, 'read-tree', '--reset', '-u', $E) | Out-Null
  if ($LASTEXITCODE -ne 0 -or ((Invoke-Git @('-C', $sourceRoot, 'rev-parse', 'HEAD') -join "`n").Trim()) -ne $E) {
    throw 'Source worktree did not materialize evidence-only E'
  }
} catch {
  $fastForwardError = $_
  if ($branchAdvanced) {
    Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', $sourceBranchRef, $ReviewedTree, $E) | Out-Null
    Invoke-Git @('-C', $sourceRoot, 'read-tree', '--reset', '-u', $ReviewedTree) | Out-Null
  }
  throw $fastForwardError
}
Assert-SourceWorktreeState -ExpectedHead $E -Context 'after E fast-forward'
Assert-RetainedAuthorityBindings -Context 'after E fast-forward'
$fastForwardedEvidence = Join-Path $sourceRoot 'services/openclaw-zalo-cell/build-evidence.json'
Assert-NoReparseChain -Path $fastForwardedEvidence -Label 'fast-forwarded evidence'
if ((Get-FileHash -LiteralPath $fastForwardedEvidence -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateEvidenceSha256 -or
    ((Invoke-Git @('hash-object', '--', $fastForwardedEvidence) -join "`n").Trim()) -ne $committedEvidenceOid) {
  throw 'Fast-forwarded evidence bytes differ from the authenticated E Git blob'
}
