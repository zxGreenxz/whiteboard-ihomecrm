#Requires -Version 7.3

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Qualification', 'Evidence')]
  [string]$Phase
)

if ($PSVersionTable.PSVersion -ne [version]'7.6.2') {
  throw "PowerShell 7.6.2 is required; current runtime is $($PSVersionTable.PSVersion)"
}

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$script:PinnedPwshPath = '/opt/openclaw-tools/powershell-7.6.2/pwsh'
$script:ExpectedPwshSha256 = 'cd7ac031490349b4ffd203cadf8922af85113b84ab9bfc28a50d03730d9309bc'
$script:ExpectedNodeSha256 = 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c'
$script:ExpectedGitSha256 = '5516c9f362c29376ab9a499a33082f9f611941d8c75930c880e30ad109e39c9a'
$script:BaseEnvironment = [ordered]@{ HOME = '/nonexistent'; LANG = 'C'; LC_ALL = 'C' }
$script:PowerShellStdinBootstrap = @'
$ErrorActionPreference = 'Stop'
$approvedRootText = $env:OPENCLAW_PWSH_APPROVED_ROOT
$logicalPathText = $env:OPENCLAW_PWSH_LOGICAL_PATH
if ([string]::IsNullOrWhiteSpace($approvedRootText) -or [string]::IsNullOrWhiteSpace($logicalPathText)) { throw 'reviewed PowerShell logical path metadata is missing' }
if (-not [IO.Path]::IsPathFullyQualified($approvedRootText) -or -not [IO.Path]::IsPathFullyQualified($logicalPathText)) { throw 'reviewed PowerShell logical paths must be absolute' }
$approvedRoot = [IO.Path]::GetFullPath($approvedRootText)
$logicalPath = [IO.Path]::GetFullPath($logicalPathText)
if ($approvedRoot -cne $approvedRootText -or $logicalPath -cne $logicalPathText) { throw 'reviewed PowerShell logical paths must be canonical' }
$relativePath = [IO.Path]::GetRelativePath($approvedRoot, $logicalPath)
if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath -in @('.', '..') -or $relativePath.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) { throw 'reviewed PowerShell logical path escaped its approved root' }
[long]$expectedSize = 0
if (-not [long]::TryParse($env:OPENCLAW_PWSH_BLOB_SIZE, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$expectedSize) -or $expectedSize -lt 1) { throw 'reviewed PowerShell byte length is invalid' }
$expectedSha256 = $env:OPENCLAW_PWSH_BLOB_SHA256
if ($expectedSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'reviewed PowerShell SHA-256 is invalid' }
$memory = [IO.MemoryStream]::new()
try { [Console]::OpenStandardInput().CopyTo($memory); [byte[]]$scriptBytes = $memory.ToArray() } finally { $memory.Dispose() }
if ($scriptBytes.LongLength -ne $expectedSize) { throw 'reviewed PowerShell byte length mismatch' }
$actualSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($scriptBytes)).ToLowerInvariant()
if ($actualSha256 -cne $expectedSha256) { throw 'reviewed PowerShell SHA-256 mismatch' }
$scriptText = [Text.UTF8Encoding]::new($false, $true).GetString($scriptBytes)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($scriptText, $logicalPath, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -ne 0) { throw 'reviewed PowerShell source contains a parse error' }
$argumentsJson = $env:OPENCLAW_PWSH_ARGUMENTS_JSON
if ([string]::IsNullOrWhiteSpace($argumentsJson)) { throw 'reviewed PowerShell arguments are missing' }
[string[]]$argumentList = [Text.Json.JsonSerializer]::Deserialize[string[]]($argumentsJson)
if ($null -eq $argumentList -or $argumentList.Count -eq 0 -or ($argumentList.Count % 2) -ne 0) { throw 'reviewed PowerShell arguments must be nonempty option/value pairs' }
$namedArguments = [ordered]@{}
for ($index = 0; $index -lt $argumentList.Count; $index += 2) {
  $option = $argumentList[$index]
  if ($option -cnotmatch '^-[A-Za-z][A-Za-z0-9-]*$') { throw 'reviewed PowerShell option name is invalid' }
  $parameterName = $option.Substring(1)
  if ($namedArguments.Contains($parameterName)) { throw 'reviewed PowerShell option is duplicated' }
  $namedArguments[$parameterName] = $argumentList[$index + 1]
}
$scriptBlock = $ast.GetScriptBlock()
& $scriptBlock @namedArguments
'@

function Assert-RegularAbsoluteFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw "$Label path must be absolute" }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must be a regular non-reparse file"
  }
}

function Assert-NoReparseChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($true) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Label must not traverse a reparse point: $cursor"
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-GitObjectId {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('blob', 'tree', 'commit')][string]$Type,
    [Parameter(Mandatory = $true)][byte[]]$Bytes
  )
  $header = [Text.Encoding]::ASCII.GetBytes("$Type $($Bytes.Length)`0")
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try {
    $sha1.TransformBlock($header, 0, $header.Length, $null, 0) | Out-Null
    $sha1.TransformFinalBlock($Bytes, 0, $Bytes.Length) | Out-Null
    return [Convert]::ToHexString($sha1.Hash).ToLowerInvariant()
  } finally {
    $sha1.Dispose()
  }
}

function Invoke-LauncherNativeBytes {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Collections.IDictionary]$Environment = $script:BaseEnvironment,
    [byte[]]$InputBytes,
    [string]$WorkingDirectory
  )
  Assert-RegularAbsoluteFile -Path $FilePath -Label 'native authority'
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $null -ne $InputBytes
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Environment.Clear()
  foreach ($binding in $Environment.GetEnumerator()) {
    $startInfo.Environment[[string]$binding.Key] = [string]$binding.Value
  }
  foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
  if (-not [string]::IsNullOrEmpty($WorkingDirectory)) {
    if (-not [IO.Path]::IsPathFullyQualified($WorkingDirectory)) {
      throw 'Native working directory must be absolute'
    }
    $startInfo.WorkingDirectory = $WorkingDirectory
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $stdout = [IO.MemoryStream]::new()
  try {
    if (-not $process.Start()) { throw "Unable to start native authority: $FilePath" }
    $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if ($null -ne $InputBytes) {
      $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
      $process.StandardInput.BaseStream.Close()
    }
    $process.WaitForExit()
    $null = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    if ($exitCode -ne 0) {
      throw "Native authority failed ($exitCode): $FilePath $($Arguments -join ' ')`n$stderr"
    }
    if (-not [string]::IsNullOrEmpty($stderr)) {
      throw "Native authority wrote unexpected stderr: $FilePath`n$stderr"
    }
    return ,$stdout.ToArray()
  } finally {
    $stdout.Dispose()
    $process.Dispose()
  }
}

function Invoke-LauncherNativeText {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Collections.IDictionary]$Environment = $script:BaseEnvironment,
    [byte[]]$InputBytes,
    [string]$WorkingDirectory
  )
  $bytes = Invoke-LauncherNativeBytes -FilePath $FilePath -Arguments $Arguments `
    -Environment $Environment -InputBytes $InputBytes -WorkingDirectory $WorkingDirectory
  return [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
}

$sourceRoot = [IO.Path]::GetFullPath((Get-Location).Path)
$ReviewedTree = $env:OPENCLAW_REVIEWED_R_SHA
$ExpectedM = $env:OPENCLAW_REVIEWED_M_SHA
if ($ReviewedTree -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_R_SHA must be exact R' }
if ($ExpectedM -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_M_SHA must be exact M' }
$approvalManifestText = $env:OPENCLAW_TASK2_APPROVAL_MANIFEST
if ([string]::IsNullOrWhiteSpace($approvalManifestText) -or
    -not [IO.Path]::IsPathFullyQualified($approvalManifestText)) {
  throw 'OPENCLAW_TASK2_APPROVAL_MANIFEST must be an absolute path'
}
$approvalManifest = [IO.Path]::GetFullPath($approvalManifestText)
$expectedApprovalManifest = [IO.Path]::GetFullPath("/opt/openclaw-tools/reviewed-task2/$ReviewedTree/approval-manifest-v1.json")
if ($approvalManifestText -cne $approvalManifest -or $approvalManifest -cne $expectedApprovalManifest) {
  throw 'OPENCLAW_TASK2_APPROVAL_MANIFEST must be the exact canonical R-bound approval manifest path'
}
Assert-NoReparseChain -Path $approvalManifest -Label 'Task 2 approval manifest'
Assert-RegularAbsoluteFile -Path $approvalManifest -Label 'Task 2 approval manifest'
$nodePath = [IO.Path]::GetFullPath($env:OPENCLAW_NODE_PATH)
$gitPath = [IO.Path]::GetFullPath($env:OPENCLAW_GIT_PATH)
Assert-RegularAbsoluteFile -Path $nodePath -Label 'Node authority'
Assert-RegularAbsoluteFile -Path $gitPath -Label 'Git authority'
Assert-RegularAbsoluteFile -Path $script:PinnedPwshPath -Label 'PowerShell authority'
if ((Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $script:ExpectedNodeSha256) {
  throw 'Pinned Node SHA-256 mismatch'
}
if ((Get-FileHash -LiteralPath $gitPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $script:ExpectedGitSha256) {
  throw 'Pinned Git SHA-256 mismatch'
}
if ((Get-FileHash -LiteralPath $script:PinnedPwshPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $script:ExpectedPwshSha256) {
  throw 'Pinned PowerShell SHA-256 mismatch'
}

$script:GitEnvironment = [ordered]@{
  HOME = '/nonexistent'; LANG = 'C'; LC_ALL = 'C'; GIT_ATTR_NOSYSTEM = '1'
  GIT_CONFIG_GLOBAL = '/dev/null'; GIT_CONFIG_NOSYSTEM = '1'; GIT_NO_LAZY_FETCH = '1'
  GIT_NO_REPLACE_OBJECTS = '1'; GIT_OPTIONAL_LOCKS = '0'; GIT_TERMINAL_PROMPT = '0'
}
$script:GitPrefix = @(
  '--no-replace-objects', '-c', 'core.commitGraph=false', '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null',
  '-c', 'diff.external=', '-c', 'credential.helper='
)

function Invoke-LauncherGitBytes {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  return ,(Invoke-LauncherNativeBytes -FilePath $gitPath -Arguments ($script:GitPrefix + $Arguments) `
    -Environment $script:GitEnvironment)
}

function Invoke-LauncherGitText {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  return (Invoke-LauncherNativeText -FilePath $gitPath -Arguments ($script:GitPrefix + $Arguments) `
    -Environment $script:GitEnvironment)
}

function Get-AuthenticatedGitObject {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ObjectId,
    [Parameter(Mandatory = $true)][ValidateSet('blob', 'tree', 'commit')][string]$Type,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ((Invoke-LauncherGitText @('-C', $sourceRoot, 'cat-file', '-t', $ObjectId)).Trim() -ne $Type) {
    throw "$Label Git object type mismatch"
  }
  $size = 0L
  if (-not [int64]::TryParse(
      (Invoke-LauncherGitText @('-C', $sourceRoot, 'cat-file', '-s', $ObjectId)).Trim(),
      [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture,
      [ref]$size) -or $size -lt 0) {
    throw "$Label Git object size is invalid"
  }
  $bytes = Invoke-LauncherGitBytes @('-C', $sourceRoot, 'cat-file', $Type, $ObjectId)
  if ($bytes.LongLength -ne $size -or (Get-GitObjectId -Type $Type -Bytes $bytes) -ne $ObjectId) {
    throw "$Label raw Git object authentication failed"
  }
  return [pscustomobject]@{ ObjectId = $ObjectId; Type = $Type; Size = $size; Bytes = $bytes; Sha256 = Get-Sha256 $bytes }
}

function Get-CommitTreeId {
  param([Parameter(Mandatory = $true)][pscustomobject]$Commit)
  $text = [Text.UTF8Encoding]::new($false, $true).GetString([byte[]]$Commit.Bytes)
  $headers = @($text.Substring(0, $text.IndexOf("`n`n", [StringComparison]::Ordinal)) -split "`n")
  $trees = @($headers | Where-Object { $_ -match '^tree [0-9a-f]{40}$' })
  if ($trees.Count -ne 1) { throw 'Reviewed commit must contain exactly one tree' }
  return $trees[0].Substring(5)
}

function Find-TreeEntry {
  param(
    [Parameter(Mandatory = $true)][pscustomobject]$Tree,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $bytes = [byte[]]$Tree.Bytes
  $position = 0
  $match = $null
  while ($position -lt $bytes.Length) {
    $nul = [Array]::IndexOf($bytes, [byte]0, $position)
    if ($nul -le $position -or $nul + 20 -ge $bytes.Length) { throw "$Label tree is malformed" }
    $header = [Text.UTF8Encoding]::new($false, $true).GetString([byte[]]$bytes[$position..($nul - 1)])
    $separator = $header.IndexOf(' ', [StringComparison]::Ordinal)
    if ($separator -le 0) { throw "$Label tree header is malformed" }
    $entryName = $header.Substring($separator + 1)
    $oid = [Convert]::ToHexString([byte[]]$bytes[($nul + 1)..($nul + 20)]).ToLowerInvariant()
    if ($entryName -eq $Name) {
      if ($null -ne $match) { throw "$Label tree contains duplicate segment" }
      $match = [pscustomobject]@{ Mode = $header.Substring(0, $separator); ObjectId = $oid }
    }
    $position = $nul + 21
  }
  if ($null -eq $match) { throw "$Label path segment is absent: $Name" }
  return $match
}

function Get-AuthenticatedReviewedBlob {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($RelativePath.Contains('\') -or $RelativePath.StartsWith('/') -or
      @($RelativePath.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0) {
    throw "$Label reviewed path is not portable"
  }
  $commit = Get-AuthenticatedGitObject -ObjectId $ReviewedTree -Type commit -Label 'reviewed R commit'
  $tree = Get-AuthenticatedGitObject -ObjectId (Get-CommitTreeId $commit) -Type tree -Label 'reviewed R tree'
  $segments = @($RelativePath.Split('/'))
  for ($index = 0; $index -lt $segments.Count; $index += 1) {
    $entry = Find-TreeEntry -Tree $tree -Name $segments[$index] -Label $Label
    if ($index -lt $segments.Count - 1) {
      if ($entry.Mode -ne '40000') { throw "$Label parent is not a tree" }
      $tree = Get-AuthenticatedGitObject -ObjectId $entry.ObjectId -Type tree -Label "$Label parent tree"
    } else {
      if ($entry.Mode -notin @('100644', '100755')) { throw "$Label is not a regular reviewed blob" }
      return Get-AuthenticatedGitObject -ObjectId $entry.ObjectId -Type blob -Label $Label
    }
  }
  throw "Unable to resolve reviewed blob: $Label"
}

function Get-PortableRepositoryPath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $relative = [IO.Path]::GetRelativePath($sourceRoot, [IO.Path]::GetFullPath($Path))
  if ([IO.Path]::IsPathRooted($relative) -or $relative -in @('.', '..') -or
      $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw "$Label escaped source root" }
  $portable = $relative.Replace([IO.Path]::DirectorySeparatorChar, '/')
  if ($portable.Contains('\')) { throw "$Label is not portable" }
  return $portable
}

function Invoke-ReviewedSourceGate {
  param(
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string[]]$AllowedPaths
  )
  $blob = Get-AuthenticatedReviewedBlob `
    -RelativePath 'services/openclaw-zalo-cell/scripts/verify-reviewed-source-gate.mjs' `
    -Label 'reviewed source gate'
  $arguments = @(
    '--input-type=module', '-', '--git-path', $gitPath, '--repository-root', $sourceRoot,
    '--reviewed-tree', $Commit, '--git-sha256', $script:ExpectedGitSha256
  )
  foreach ($allowedPath in $AllowedPaths) { $arguments += @('--allow-untracked', $allowedPath) }
  $record = (Invoke-LauncherNativeText -FilePath $nodePath -Arguments $arguments `
    -Environment $script:BaseEnvironment -InputBytes $blob.Bytes).Trim() | ConvertFrom-Json -Depth 8
  $reported = @($record.allowed_untracked_paths | ForEach-Object { [string]$_ })
  if ([string]$record.reviewed_tree -ne $Commit -or $reported.Count -ne $AllowedPaths.Count -or
      @($AllowedPaths | Where-Object { $reported -cnotcontains $_ }).Count -ne 0) {
    throw 'Reviewed source gate did not preserve exact commit and allowlist'
  }
}

function Invoke-ReviewedPowerShellBlob {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$ApprovedRoot,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $blob = Get-AuthenticatedReviewedBlob -RelativePath $RelativePath -Label 'reviewed PowerShell helper'
  $resolvedApprovedRoot = [IO.Path]::GetFullPath($ApprovedRoot)
  if ($resolvedApprovedRoot -cne $ApprovedRoot) { throw 'Reviewed PowerShell approved root must be canonical' }
  $logicalPath = [IO.Path]::GetFullPath((Join-Path $resolvedApprovedRoot $RelativePath))
  $relativeLogicalPath = [IO.Path]::GetRelativePath($resolvedApprovedRoot, $logicalPath)
  if ([IO.Path]::IsPathRooted($relativeLogicalPath) -or $relativeLogicalPath -in @('.', '..') -or
      $relativeLogicalPath.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) {
    throw 'Reviewed PowerShell logical path escaped its approved root'
  }
  $helperEnvironment = [ordered]@{}
  foreach ($binding in $script:BaseEnvironment.GetEnumerator()) {
    $helperEnvironment[[string]$binding.Key] = [string]$binding.Value
  }
  $helperEnvironment.OPENCLAW_PWSH_APPROVED_ROOT = $resolvedApprovedRoot
  $helperEnvironment.OPENCLAW_PWSH_LOGICAL_PATH = $logicalPath
  $helperEnvironment.OPENCLAW_PWSH_BLOB_SIZE = $blob.Size.ToString([Globalization.CultureInfo]::InvariantCulture)
  $helperEnvironment.OPENCLAW_PWSH_BLOB_SHA256 = $blob.Sha256
  $helperEnvironment.OPENCLAW_PWSH_ARGUMENTS_JSON = [Text.Json.JsonSerializer]::Serialize([string[]]$Arguments)
  $before = (Get-FileHash -LiteralPath $script:PinnedPwshPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($before -ne $script:ExpectedPwshSha256) { throw 'PowerShell changed before reviewed helper dispatch' }
  Invoke-LauncherNativeBytes -FilePath $script:PinnedPwshPath `
    -Arguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', $script:PowerShellStdinBootstrap) `
    -Environment $helperEnvironment -InputBytes $blob.Bytes -WorkingDirectory $sourceRoot | Out-Null
  $after = (Get-FileHash -LiteralPath $script:PinnedPwshPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($after -ne $before) { throw 'PowerShell changed during reviewed helper dispatch' }
}

$releaseRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'))
$mReviewReport = [IO.Path]::GetFullPath($env:OPENCLAW_M_REVIEW_REPORT)
$rReviewReport = [IO.Path]::GetFullPath($env:OPENCLAW_R_REVIEW_REPORT)
$expectedMReport = [IO.Path]::GetFullPath((Join-Path $releaseRoot "reviews/m-review-report-v1-$ExpectedM.json"))
$expectedRReport = [IO.Path]::GetFullPath((Join-Path $releaseRoot "reviews/r-review-report-v1-$ReviewedTree.json"))
if ($mReviewReport -cne $expectedMReport -or $rReviewReport -cne $expectedRReport) {
  throw 'Canonical SHA-bound M/R review report paths are required'
}
Assert-RegularAbsoluteFile -Path $mReviewReport -Label 'M review report'
Assert-RegularAbsoluteFile -Path $rReviewReport -Label 'R review report'
$reportAllowlist = @(
  Get-PortableRepositoryPath -Path $mReviewReport -Label 'M review report'
  Get-PortableRepositoryPath -Path $rReviewReport -Label 'R review report'
)
$candidateAllowlist = @(
  'services/openclaw-zalo-cell/.release/task2-build-evidence.json'
  'services/openclaw-zalo-cell/.release/openclaw-zalo-cell-fork-a-linux-amd64.oci.tar'
  'services/openclaw-zalo-cell/.release/openclaw-zalo-cell-fork-b-linux-amd64.oci.tar'
  'services/openclaw-zalo-cell/.release/openclaw-zalo-cell-stock-linux-amd64.oci.tar'
  'services/openclaw-zalo-cell/.release/zalouser-2026.7.1-verified.tgz'
)
$initialAllowlist = if ($Phase -eq 'Evidence') { @($reportAllowlist + $candidateAllowlist) } else { @($reportAllowlist) }
Invoke-ReviewedSourceGate -Commit $ReviewedTree -AllowedPaths $initialAllowlist

if ($Phase -eq 'Qualification') {
  if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
  $ErrorActionPreference = 'Stop'
  $PSNativeCommandUseErrorActionPreference = $true
  $nodePath = (Resolve-Path -LiteralPath $env:OPENCLAW_NODE_PATH -ErrorAction Stop).Path
  $gitPath = (Resolve-Path -LiteralPath $env:OPENCLAW_GIT_PATH -ErrorAction Stop).Path
  $npmRoot = (Resolve-Path -LiteralPath $env:OPENCLAW_NPM_ROOT -ErrorAction Stop).Path
  $dockerHost = $env:OPENCLAW_DOCKER_HOST
  if (-not [IO.Path]::IsPathFullyQualified($nodePath) -or -not [IO.Path]::IsPathFullyQualified($gitPath) -or -not [IO.Path]::IsPathFullyQualified($npmRoot)) { throw 'Pinned Node/Git/npm paths must be absolute' }
  function Invoke-QualificationNative {
    param(
      [Parameter(Mandatory = $true)][string]$FilePath,
      [Parameter(Mandatory = $true)][string[]]$Arguments,
      [Collections.IDictionary]$Environment = @{},
      [string]$WorkingDirectory
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment.Clear()
    foreach ($name in $Environment.Keys) { $startInfo.Environment[$name] = [string]$Environment[$name] }
    if (-not [string]::IsNullOrEmpty($WorkingDirectory)) {
      if (-not [IO.Path]::IsPathFullyQualified($WorkingDirectory)) { throw 'Native working directory must be absolute' }
      $startInfo.WorkingDirectory = $WorkingDirectory
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Unable to start pinned native authority: $FilePath" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    $process.Dispose()
    if ($exitCode -ne 0) { throw "Pinned native authority failed ($exitCode): $FilePath`n$stderr" }
    return $stdout
  }
  $expectedNodeSha256 = 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c'
  $expectedGitSha256 = '5516c9f362c29376ab9a499a33082f9f611941d8c75930c880e30ad109e39c9a'
  $expectedNpmRootSha256 = 'aebb5b5b1892a7dd23c04af9b5afa24747f752beff2e4f2e781d9eb3830f93d9'
  $expectedNpmCliSha256 = '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7'
  if ((Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedNodeSha256) { throw 'Pinned Node SHA-256 mismatch' }
  if ((Get-FileHash -LiteralPath $gitPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedGitSha256) { throw 'Pinned Git SHA-256 mismatch' }
  $nodeCheck = 'const m=/^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.version);if(!m||Number(m[1])<15){process.exit(1)}process.stdout.write(process.version)'
  $nodeVersion = (Invoke-QualificationNative -FilePath $nodePath -Arguments @('-e', $nodeCheck)).Trim()
  if ($nodeVersion -ne 'v24.15.0') { throw 'Pinned Node must be exact official stable v24.15.0' }
  $gitSafePrefix = @(
    '--no-replace-objects',
    '-c', 'core.commitGraph=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false',
    '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.excludesFile=/dev/null',
    '-c', 'diff.external=',
    '-c', 'credential.helper='
  )
  $gitEnvironment = [ordered]@{
    HOME = '/nonexistent'
    LANG = 'C'
    LC_ALL = 'C'
    GIT_ATTR_NOSYSTEM = '1'
    GIT_CONFIG_GLOBAL = '/dev/null'
    GIT_CONFIG_NOSYSTEM = '1'
    GIT_NO_LAZY_FETCH = '1'
    GIT_NO_REPLACE_OBJECTS = '1'
    GIT_OPTIONAL_LOCKS = '0'
    GIT_TERMINAL_PROMPT = '0'
  }
  function Invoke-QualificationGit {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    return Invoke-QualificationNative -FilePath $gitPath -Arguments ($gitSafePrefix + $Arguments) -Environment $gitEnvironment
  }
  if ((Invoke-QualificationGit -Arguments @('--version')).Trim() -ne 'git version 2.53.0') { throw 'Pinned Git semantic version mismatch' }
  $R = $env:OPENCLAW_REVIEWED_R_SHA
  if ($R -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_R_SHA must be the exact reviewed R SHA' }
  $M = $env:OPENCLAW_REVIEWED_M_SHA
  if ($M -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_M_SHA must be the exact reviewed M SHA' }
  $mReviewReport = (Resolve-Path -LiteralPath $env:OPENCLAW_M_REVIEW_REPORT -ErrorAction Stop).Path
  $rReviewReport = (Resolve-Path -LiteralPath $env:OPENCLAW_R_REVIEW_REPORT -ErrorAction Stop).Path
  $buildxPath = (Resolve-Path -LiteralPath $env:OPENCLAW_BUILDX_PATH -ErrorAction Stop).Path
  if (-not [IO.Path]::IsPathFullyQualified($buildxPath)) { throw 'OPENCLAW_BUILDX_PATH must resolve to an absolute path' }
  $dockerPath = (Resolve-Path -LiteralPath $env:OPENCLAW_DOCKER_PATH -ErrorAction Stop).Path
  if (-not [IO.Path]::IsPathFullyQualified($dockerPath)) { throw 'OPENCLAW_DOCKER_PATH must resolve to an absolute path' }
  $sourceRoot = (Get-Location).Path
  if ((Invoke-QualificationGit -Arguments @('-C', $sourceRoot, 'rev-parse', 'HEAD')).Trim() -ne $R) { throw 'HEAD is not exact reviewed R' }
  Invoke-QualificationGit -Arguments @('-C', $sourceRoot, 'merge-base', '--is-ancestor', $M, $R) | Out-Null
  $reviewedBootstrapPaths = [ordered]@{
    exporter = 'services/openclaw-zalo-cell/scripts/export-reviewed-tree.mjs'
    sourceGate = 'services/openclaw-zalo-cell/scripts/verify-reviewed-source-gate.mjs'
    npmAuthority = 'services/openclaw-zalo-cell/scripts/verify-package-manager-authority.mjs'
  }
  $reviewedBootstrap = [ordered]@{}
  foreach ($name in $reviewedBootstrapPaths.Keys) {
    $repositoryPath = [string]$reviewedBootstrapPaths[$name]
    $reviewedBootstrap[$name] = Get-AuthenticatedReviewedBlob -RelativePath $repositoryPath -Label "reviewed $name bootstrap"
  }
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $bootstrapRoot = Join-Path $tempRoot ('ihome-openclaw-bootstrap-' + [guid]::NewGuid().ToString('N'))
  $verificationExportRoot = Join-Path $tempRoot ('ihome-openclaw-r-verify-' + [guid]::NewGuid().ToString('N'))
  $qualificationExportRoot = Join-Path $tempRoot ('ihome-openclaw-r-qualify-' + [guid]::NewGuid().ToString('N'))
  $releaseRoot = Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'
  New-Item -ItemType Directory -Path $bootstrapRoot -ErrorAction Stop | Out-Null
  try {
    function Invoke-QualificationNodeBlob {
      param(
        [Parameter(Mandatory = $true)][pscustomobject]$Binding,
        [Parameter(Mandatory = $true)][string[]]$Arguments
      )
      return Invoke-LauncherNativeText -FilePath $nodePath `
        -Arguments (@('--input-type=module', '-') + $Arguments) `
        -Environment $nodeEnvironment -InputBytes $Binding.Bytes
    }

    $nodeEnvironment = [ordered]@{ HOME = '/nonexistent'; LANG = 'C'; LC_ALL = 'C' }
    function Assert-QualificationCoreAuthorities {
      if ((Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedNodeSha256) { throw 'Pinned Node changed during qualification' }
      if ((Get-FileHash -LiteralPath $gitPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedGitSha256) { throw 'Pinned Git changed during qualification' }
      if ((Invoke-QualificationNative -FilePath $nodePath -Arguments @('-e', $nodeCheck) -Environment $nodeEnvironment).Trim() -ne 'v24.15.0') { throw 'Pinned Node version changed during qualification' }
      if ((Invoke-QualificationGit -Arguments @('--version')).Trim() -ne 'git version 2.53.0') { throw 'Pinned Git version changed during qualification' }
      foreach ($name in $reviewedBootstrap.Keys) {
        $before = $reviewedBootstrap[$name]
        $after = Get-AuthenticatedReviewedBlob -RelativePath ([string]$reviewedBootstrapPaths[$name]) -Label "reviewed $name bootstrap recheck"
        if ($after.ObjectId -ne $before.ObjectId -or $after.Size -ne $before.Size -or $after.Sha256 -ne $before.Sha256) {
          throw "Reviewed bootstrap changed during qualification: $name"
        }
      }
    }

    Assert-QualificationCoreAuthorities
    Invoke-ReviewedSourceGate -Commit $R -AllowedPaths $reportAllowlist
    function Assert-QualificationNpmAuthority {
      Assert-QualificationCoreAuthorities
      $npmAuthority = (Invoke-QualificationNodeBlob -Binding $reviewedBootstrap.npmAuthority `
        -Arguments @('--node-path', $nodePath, '--npm-root', $npmRoot)) | ConvertFrom-Json -Depth 16
      if ($npmAuthority.version -ne '11.12.1' -or [int]$npmAuthority.entry_count -ne 2169 -or $npmAuthority.root_sha256 -ne $expectedNpmRootSha256 -or [int]$npmAuthority.cli_size -ne 54 -or $npmAuthority.cli_sha256 -ne $expectedNpmCliSha256 -or $npmAuthority.node_path -ne $nodePath) { throw 'Pinned npm authority changed during qualification' }
      return $npmAuthority
    }
    function Assert-QualificationAuthorities {
      Assert-QualificationNpmAuthority | Out-Null
    }

    $npmAuthority = Assert-QualificationNpmAuthority
    $npmCliPath = (Resolve-Path -LiteralPath ([IO.Path]::Combine($npmRoot, 'bin', 'npm-cli.js')) -ErrorAction Stop).Path
    if ($npmCliPath -ne [string]$npmAuthority.npm_cli_path) { throw 'Authenticated npm CLI path mismatch' }
    $npmHome = Join-Path $bootstrapRoot 'npm-home'
    $npmCache = Join-Path $bootstrapRoot 'npm-cache'
    New-Item -ItemType Directory -Path $npmHome,$npmCache -ErrorAction Stop | Out-Null
    $npmEnvironment = [ordered]@{
      HOME = $npmHome
      LANG = 'C'
      LC_ALL = 'C'
      PATH = ((Split-Path -Parent $nodePath) + ':/usr/bin:/bin')
      npm_config_audit = 'false'
      npm_config_cache = $npmCache
      npm_config_fund = 'false'
      npm_config_globalconfig = '/dev/null'
      npm_config_ignore_scripts = 'true'
      npm_config_user_agent = 'npm/11.12.1 node/v24.15.0 linux x64'
      npm_config_update_notifier = 'false'
      npm_config_userconfig = '/nonexistent/.npmrc'
      npm_execpath = $npmCliPath
      npm_node_execpath = $nodePath
    }
    function Invoke-QualificationNpm {
      param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
      )
      Assert-QualificationAuthorities | Out-Null
      $output = Invoke-QualificationNative -FilePath $nodePath -Arguments (@($npmCliPath) + $Arguments) -Environment $npmEnvironment -WorkingDirectory $WorkingDirectory
      Assert-QualificationAuthorities | Out-Null
      return $output
    }
    New-Item -ItemType Directory -Path $releaseRoot -Force -ErrorAction Stop | Out-Null

    $verificationExportManifest = Join-Path $bootstrapRoot 'reviewed-verification-tree-manifest.json'
    Assert-QualificationAuthorities | Out-Null
    Invoke-QualificationNodeBlob -Binding $reviewedBootstrap.exporter -Arguments @('export', '--git-path', $gitPath, '--repository-root', $sourceRoot, '--reviewed-tree', $R, '--output-root', $verificationExportRoot, '--manifest', $verificationExportManifest) | Out-Null
    Invoke-QualificationNodeBlob -Binding $reviewedBootstrap.exporter -Arguments @('verify', '--git-path', $gitPath, '--repository-root', $sourceRoot, '--reviewed-tree', $R, '--output-root', $verificationExportRoot, '--manifest', $verificationExportManifest) | Out-Null
    Assert-QualificationAuthorities | Out-Null
    $verificationExportManifestSha256 = (Get-FileHash -LiteralPath $verificationExportManifest -Algorithm SHA256).Hash.ToLowerInvariant()
    $npmEnvironment.OPENCLAW_REVIEWED_EXPORT_MANIFEST = $verificationExportManifest
    $npmEnvironment.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256 = $verificationExportManifestSha256
    $npmEnvironment.OPENCLAW_REVIEWED_R_SHA = $R
    function Assert-VerificationExportReviewed {
      Invoke-QualificationNodeBlob -Binding $reviewedBootstrap.exporter -Arguments @('verify-mutable', '--output-root', $verificationExportRoot, '--manifest', $verificationExportManifest, '--manifest-sha256', $verificationExportManifestSha256) | Out-Null
    }
    function Invoke-ReviewedVerificationNpm {
      param([Parameter(Mandatory = $true)][string[]]$Arguments)
      Assert-VerificationExportReviewed
      Invoke-QualificationNpm -WorkingDirectory $verificationExportRoot -Arguments $Arguments | Out-Null
      Assert-VerificationExportReviewed
    }
    function Invoke-ReviewedVerificationNode {
      param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
      )
      Assert-QualificationAuthorities
      Assert-VerificationExportReviewed
      Invoke-QualificationNative -FilePath $nodePath -Arguments $Arguments -Environment $npmEnvironment -WorkingDirectory $WorkingDirectory | Out-Null
      Assert-VerificationExportReviewed
      Assert-QualificationAuthorities
    }

    $vendorRoot = Join-Path $verificationExportRoot 'services/openclaw-zalo-cell/vendor/zalouser-bridge'
    $sessionRoot = Join-Path $verificationExportRoot 'services/openclaw-zalo-cell/session-crypto'
    Invoke-ReviewedVerificationNpm -Arguments @('ci', '--ignore-scripts')
    Invoke-ReviewedVerificationNpm -Arguments @('--prefix', 'services/openclaw-zalo-cell/vendor/zalouser-bridge', 'ci', '--ignore-scripts')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('scripts/preflight.mjs')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('scripts/verify-upstream.mjs', '--online')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('scripts/prepare.mjs', '--tarball', '.work/verified-upstream.tgz')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('scripts/build.mjs')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('scripts/pack.mjs')
    Invoke-ReviewedVerificationNode -WorkingDirectory $vendorRoot -Arguments @('scripts/verify-artifact.mjs')
    Invoke-ReviewedVerificationNode -WorkingDirectory $verificationExportRoot -Arguments @('node_modules/vitest/vitest.mjs', 'run', 'services/openclaw-zalo-bridge/test/upstream-contract.test.ts')
    Invoke-ReviewedVerificationNpm -Arguments @('--prefix', 'services/openclaw-zalo-cell/session-crypto', 'ci', '--ignore-scripts')
    Invoke-ReviewedVerificationNode -WorkingDirectory $sessionRoot -Arguments @('node_modules/vitest/vitest.mjs', 'run', '--config', 'package.json', 'src/crypto.test.ts', 'src/daemon.test.ts')
    Invoke-ReviewedVerificationNode -WorkingDirectory $sessionRoot -Arguments @('node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json')
    Invoke-ReviewedVerificationNpm -Arguments @('--prefix', 'services/openclaw-zalo-cell/session-crypto', 'run', 'verify:dist')

    $qualificationExportManifest = Join-Path $bootstrapRoot 'reviewed-qualification-tree-manifest.json'
    Assert-QualificationAuthorities | Out-Null
    Invoke-QualificationNodeBlob -Binding $reviewedBootstrap.exporter -Arguments @('export', '--git-path', $gitPath, '--repository-root', $sourceRoot, '--reviewed-tree', $R, '--output-root', $qualificationExportRoot, '--manifest', $qualificationExportManifest) | Out-Null
    Invoke-QualificationNodeBlob -Binding $reviewedBootstrap.exporter -Arguments @('verify', '--git-path', $gitPath, '--repository-root', $sourceRoot, '--reviewed-tree', $R, '--output-root', $qualificationExportRoot, '--manifest', $qualificationExportManifest) | Out-Null
    Assert-QualificationAuthorities | Out-Null
    $qualificationExportManifestSha256 = (Get-FileHash -LiteralPath $qualificationExportManifest -Algorithm SHA256).Hash.ToLowerInvariant()

    Assert-QualificationAuthorities | Out-Null
    Invoke-ReviewedPowerShellBlob `
      -RelativePath 'services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1' `
      -ApprovedRoot $qualificationExportRoot `
      -Arguments @(
        '-ReviewedTree', $R,
        '-ExpectedM', $M,
        '-MReviewReportPath', $mReviewReport,
        '-RReviewReportPath', $rReviewReport,
        '-ApprovalManifestPath', $approvalManifest,
        '-NodePath', $nodePath,
        '-GitPath', $gitPath,
        '-BuildxPath', $buildxPath,
        '-DockerPath', $dockerPath,
        '-DockerHost', $dockerHost,
        '-GitRepositoryRoot', $sourceRoot,
        '-ReviewedSourceRoot', $qualificationExportRoot,
        '-ReviewedExportManifestPath', $qualificationExportManifest,
        '-ReviewedExportManifestSha256', $qualificationExportManifestSha256,
        '-Platform', 'linux/amd64',
        '-SourceDateEpoch', '1785062400',
        '-EvidencePath', (Join-Path $releaseRoot 'task2-build-evidence.json'),
        '-ReleaseArtifactPath', (Join-Path $releaseRoot 'openclaw-zalo-cell-fork-a-linux-amd64.oci.tar'),
        '-ReproductionArtifactPath', (Join-Path $releaseRoot 'openclaw-zalo-cell-fork-b-linux-amd64.oci.tar'),
        '-StockOciPath', (Join-Path $releaseRoot 'openclaw-zalo-cell-stock-linux-amd64.oci.tar'),
        '-RetainedUpstreamTarballPath', (Join-Path $releaseRoot 'zalouser-2026.7.1-verified.tgz')
      )
    Assert-QualificationAuthorities | Out-Null

    if ((Invoke-QualificationGit -Arguments @('-C', $sourceRoot, 'rev-parse', 'HEAD')).Trim() -ne $R) { throw 'Source HEAD changed after exported-R run' }
    Invoke-ReviewedSourceGate -Commit $R -AllowedPaths @($reportAllowlist + $candidateAllowlist)
  } finally {
    if (Test-Path -LiteralPath $qualificationExportRoot) { Remove-Item -LiteralPath $qualificationExportRoot -Recurse -Force }
    if (Test-Path -LiteralPath $verificationExportRoot) { Remove-Item -LiteralPath $verificationExportRoot -Recurse -Force }
    if (Test-Path -LiteralPath $bootstrapRoot) { Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force }
  }
  return
}

Invoke-ReviewedPowerShellBlob `
  -RelativePath 'services/openclaw-zalo-cell/scripts/create-evidence-child.ps1' `
  -ApprovedRoot $sourceRoot `
  -Arguments @(
    '-ReviewedTree', $ReviewedTree,
    '-ExpectedM', $ExpectedM,
    '-MReviewReportPath', $mReviewReport,
    '-RReviewReportPath', $rReviewReport,
    '-ApprovalManifestPath', $approvalManifest,
    '-CandidateEvidencePath', (Join-Path $releaseRoot 'task2-build-evidence.json'),
    '-CandidateArchivePath', (Join-Path $releaseRoot 'openclaw-zalo-cell-fork-a-linux-amd64.oci.tar'),
    '-CandidateArchiveBPath', (Join-Path $releaseRoot 'openclaw-zalo-cell-fork-b-linux-amd64.oci.tar'),
    '-CandidateStockOciPath', (Join-Path $releaseRoot 'openclaw-zalo-cell-stock-linux-amd64.oci.tar'),
    '-UpstreamTarballPath', (Join-Path $releaseRoot 'zalouser-2026.7.1-verified.tgz'),
    '-NodePath', $nodePath,
    '-GitPath', $gitPath,
    '-DockerPath', ([IO.Path]::GetFullPath($env:OPENCLAW_DOCKER_PATH)),
    '-DockerHost', $env:OPENCLAW_DOCKER_HOST
  )
