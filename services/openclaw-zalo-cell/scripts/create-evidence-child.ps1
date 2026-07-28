#Requires -Version 7.3

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ReviewedTree,

  [Parameter(Mandatory = $true)]
  [string]$CandidateEvidencePath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateArchivePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
& $nodePath -e 'const m=/^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.version);if(!m||Number(m[1])<15){console.error("Official stable Node >=24.15.0 <25 is required");process.exit(1)}'
if ($LASTEXITCODE -ne 0) {
  throw 'Official stable Node >=24.15.0 <25 is required'
}

$sourceRoot = [IO.Path]::GetFullPath((Get-Location).Path)
$servicesRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'services'))
$cellRoot = [IO.Path]::GetFullPath((Join-Path $servicesRoot 'openclaw-zalo-cell'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $cellRoot '.release'))

if (-not [IO.Path]::IsPathFullyQualified($CandidateEvidencePath)) {
  throw 'CandidateEvidencePath must be absolute'
}
if (-not [IO.Path]::IsPathFullyQualified($CandidateArchivePath)) {
  throw 'CandidateArchivePath must be absolute'
}

$candidateEvidence = [IO.Path]::GetFullPath($CandidateEvidencePath)
$candidateArchive = [IO.Path]::GetFullPath($CandidateArchivePath)
$evidenceRelative = [IO.Path]::GetRelativePath($releaseRoot, $candidateEvidence)
$archiveRelative = [IO.Path]::GetRelativePath($releaseRoot, $candidateArchive)
foreach ($candidateRelative in @($evidenceRelative, $archiveRelative)) {
  if ([IO.Path]::IsPathRooted($candidateRelative) -or
      $candidateRelative -eq '.' -or
      $candidateRelative -eq '..' -or
      $candidateRelative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
    throw 'Task 2 candidate escaped the canonical release root'
  }
}
if ($candidateEvidence -eq $candidateArchive) {
  throw 'Evidence and archive candidates must be distinct'
}

$sourceItem = Get-Item -LiteralPath $sourceRoot -Force -ErrorAction Stop
$servicesItem = Get-Item -LiteralPath $servicesRoot -Force -ErrorAction Stop
$cellItem = Get-Item -LiteralPath $cellRoot -Force -ErrorAction Stop
$releaseItem = Get-Item -LiteralPath $releaseRoot -Force -ErrorAction Stop
$candidateEvidenceItem = Get-Item -LiteralPath $candidateEvidence -Force -ErrorAction Stop
$candidateArchiveItem = Get-Item -LiteralPath $candidateArchive -Force -ErrorAction Stop
if (-not $sourceItem.PSIsContainer -or
    -not $servicesItem.PSIsContainer -or
    -not $cellItem.PSIsContainer -or
    -not $releaseItem.PSIsContainer) {
  throw 'Source and release ancestors must be directories'
}
if ($candidateEvidenceItem.PSIsContainer -or $candidateArchiveItem.PSIsContainer) {
  throw 'Evidence and archive candidates must be regular files'
}
foreach ($checkedItem in @(
    $sourceItem, $servicesItem, $cellItem, $releaseItem,
    $candidateEvidenceItem, $candidateArchiveItem
  )) {
  if ($checkedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Source, release, and candidate paths must not traverse a reparse point'
  }
}

$candidateEvidenceSha256 = (Get-FileHash -LiteralPath $candidateEvidence -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateArchiveSha256 = (Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant()

if ((git rev-parse HEAD).Trim() -ne $ReviewedTree) {
  throw 'Current HEAD is not the reviewed tree'
}
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) {
  throw 'Reviewed source worktree is not completely clean'
}
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  throw 'Reviewed source index is not empty'
}
$gitStatePaths = @(
  (git rev-parse --git-path MERGE_HEAD),
  (git rev-parse --git-path rebase-merge),
  (git rev-parse --git-path rebase-apply)
)
if (@($gitStatePaths | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) {
  throw 'Merge or rebase is in progress'
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRootItem = Get-Item -LiteralPath $tempRoot -Force -ErrorAction Stop
if (-not $tempRootItem.PSIsContainer -or
    ($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Temp root must be a regular non-reparse directory'
}
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
  git worktree add --detach $eWorktree $ReviewedTree
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create detached E worktree' }

  $eDestination = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell/build-evidence.json'))
  $eSchema = [IO.Path]::GetFullPath((Join-Path $eWorktree 'services/openclaw-zalo-cell/build-evidence.schema.v1.json'))
  if (-not [IO.Path]::IsPathFullyQualified($eDestination) -or
      -not [IO.Path]::IsPathFullyQualified($eSchema)) {
    throw 'Evidence and schema operands must be absolute'
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $eDestination) -Force -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $candidateEvidence -Destination $eDestination -Force -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $eDestination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateEvidenceSha256) {
    throw 'Copied evidence hash mismatch'
  }
  if ((Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateArchiveSha256) {
    throw 'Candidate archive changed before E verification'
  }

  Push-Location $eWorktree
  try {
    $verifyArgs = @(
      'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs',
      '--evidence', $eDestination,
      '--schema', $eSchema,
      '--reviewed-tree', $ReviewedTree,
      '--release-artifact', $candidateArchive
    )
    & $nodePath @verifyArgs
    if ($LASTEXITCODE -ne 0) { throw 'Evidence verifier rejected candidate E' }

    git add -- 'services/openclaw-zalo-cell/build-evidence.json'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stage evidence-only child' }
    $ePaths = @(git diff --cached --name-only)
    if (($ePaths.Count -ne 1) -or ($ePaths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) {
      throw 'E staged diff is not evidence-only'
    }
    git commit -m 'chore(openclaw-zalo): record verified evidence E' -m 'Co-Authored-By: Codex <noreply@openai.com>'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to commit evidence-only child E' }
    $E = (git rev-parse HEAD).Trim()
    if ((git rev-parse "$E^").Trim() -ne $ReviewedTree) {
      throw 'E is not a direct child of the reviewed tree'
    }
    $committedPaths = @(git diff-tree --no-commit-id --name-only -r $E)
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
    $registeredPaths = @(git worktree list --porcelain |
      Where-Object { $_ -like 'worktree *' } |
      ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if (($registeredPaths -contains $eWorktree) -or (Test-Path -LiteralPath $eWorktree)) {
      git worktree remove --force $eWorktree
      if ($LASTEXITCODE -ne 0) { throw 'Forced detached E worktree removal failed' }
    }
    if (Test-Path -LiteralPath $eWorktree) {
      throw 'Detached E path remains after forced removal'
    }
    $remainingPaths = @(git worktree list --porcelain |
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

if ($null -eq $E -or (git rev-parse HEAD).Trim() -ne $ReviewedTree) {
  throw 'Source branch changed before E fast-forward'
}
git merge --ff-only $E
if ($LASTEXITCODE -ne 0 -or (git rev-parse HEAD).Trim() -ne $E) {
  throw 'Source branch did not fast-forward to E'
}
