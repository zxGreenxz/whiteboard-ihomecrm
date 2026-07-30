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
  [string]$ApprovalManifestPath,

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

if ($PSVersionTable.PSVersion -ne [version]'7.6.2') {
  throw "PowerShell 7.6.2 is required; current runtime is $($PSVersionTable.PSVersion)"
}

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$script:BaseNativeEnvironment = [ordered]@{
  HOME = '/nonexistent'
  LANG = 'C'
  LC_ALL = 'C'
}
$script:NativeEnvironmentAllowedKeys = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::Ordinal
)
foreach ($environmentName in @(
    'HOME', 'LANG', 'LC_ALL',
    'GIT_ATTR_NOSYSTEM', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME',
    'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS',
    'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'
  )) {
  [void]$script:NativeEnvironmentAllowedKeys.Add($environmentName)
}

function Assert-NativeEnvironmentAllowlist {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Environment
  )

  foreach ($binding in $Environment.GetEnumerator()) {
    $name = [string]$binding.Key
    if ([string]::IsNullOrEmpty($name) -or $name.Contains('=') -or $name.Contains([char]0) -or
        -not $script:NativeEnvironmentAllowedKeys.Contains($name)) {
      throw "Environment name is not approved for native execution: $name"
    }
    if ($null -eq $binding.Value -or ([string]$binding.Value).Contains([char]0)) {
      throw "Environment value is invalid for native execution: $name"
    }
  }
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Collections.IDictionary]$Environment = $script:BaseNativeEnvironment
  )

  Assert-NativeEnvironmentAllowlist -Environment $Environment
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

function Invoke-NativeCheckedBytes {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Collections.IDictionary]$Environment = $script:BaseNativeEnvironment,
    [byte[]]$InputBytes
  )

  Assert-NativeEnvironmentAllowlist -Environment $Environment
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
  foreach ($argument in $Arguments) {
    $startInfo.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $stdout = [IO.MemoryStream]::new()
  try {
    if (-not $process.Start()) {
      throw "Unable to start native command: $FilePath"
    }
    $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if ($null -ne $InputBytes) {
      $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
      $process.StandardInput.BaseStream.Close()
    }
    $process.WaitForExit()
    $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $script:LASTEXITCODE = $process.ExitCode
    if ($process.ExitCode -ne 0) {
      throw "Native command failed ($($process.ExitCode)): $FilePath $($Arguments -join ' ')`n$stderr"
    }
    if (-not [string]::IsNullOrEmpty($stderr)) {
      throw "Native command wrote unexpected stderr: $FilePath $($Arguments -join ' ')`n$stderr"
    }
    $result = $stdout.ToArray()
    return ,$result
  } finally {
    $stdout.Dispose()
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

function Get-BytesSha256 {
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

function Get-GitBlobObjectId {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  return Get-GitObjectId -Type 'blob' -Bytes $Bytes
}

function Get-GitBlobSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$ObjectId,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $blob = Get-AuthenticatedGitBlobByOid -ObjectId $ObjectId -Label $Label
  return $blob.Sha256
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
  Invoke-ReviewedSourceGate -Commit $ExpectedHead -AllowedPaths $sourceGateAllowlist | Out-Null
  $indexTree = @(Invoke-Git @('-C', $sourceRoot, 'write-tree'))
  $expectedTree = @(Invoke-Git @('-C', $sourceRoot, 'rev-parse', "$ExpectedHead^{tree}"))
  if ($LASTEXITCODE -ne 0 -or $indexTree.Count -ne 1 -or $expectedTree.Count -ne 1 -or
      $indexTree[0].Trim() -ne $expectedTree[0].Trim()) {
    throw "Source index is not the exact expected tree $Context"
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
    [pscustomobject]@{ Path = $approvalManifest; Label = 'Task 2 approval manifest'; Expected = $approvalManifestSha256 }
  )
  foreach ($binding in $bindings) {
    Assert-NoReparseChain -Path $binding.Path -Label "$($binding.Label) $Context"
    $item = Get-Item -LiteralPath $binding.Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "$($binding.Label) must remain a regular non-reparse file $Context"
    }
    $actual = if ($binding.Label -eq 'candidate evidence') {
      Get-BytesSha256 -Bytes (Get-RegularFileBytesNoFollow -Path $binding.Path -Label "$($binding.Label) $Context")
    } else {
      (Get-FileHash -LiteralPath $binding.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
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

function Invoke-NodeBytesChecked {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [byte[]]$InputBytes
  )
  $beforeItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
  $beforeSha256 = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($beforeItem.Length -ne $expectedNodeSize -or $beforeSha256 -ne $expectedNodeSha256) {
    throw 'Node authority changed before byte-stream execution'
  }
  $output = Invoke-NativeCheckedBytes -FilePath $nodePath -Arguments $Arguments -InputBytes $InputBytes
  $afterItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
  $afterSha256 = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($afterItem.Length -ne $beforeItem.Length -or $afterSha256 -ne $beforeSha256) {
    throw 'Node authority changed during byte-stream execution'
  }
  return ,$output
}

$script:ReadNoFollowScript = @'
const fs = require("node:fs");
const path = process.argv[1];
const before = fs.lstatSync(path, { bigint: true });
if (!before.isFile() || before.isSymbolicLink()) throw new Error("nofollow source is not a regular file");
const descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
try {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
    throw new Error("nofollow source changed before binding");
  }
  const bytes = fs.readFileSync(descriptor);
  const handleAfter = fs.fstatSync(descriptor, { bigint: true });
  const pathAfter = fs.lstatSync(path, { bigint: true });
  if (!pathAfter.isFile() || pathAfter.isSymbolicLink() ||
      handleAfter.dev !== opened.dev || handleAfter.ino !== opened.ino ||
      pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
      handleAfter.size !== opened.size || pathAfter.size !== opened.size ||
      handleAfter.mtimeNs !== opened.mtimeNs || handleAfter.ctimeNs !== opened.ctimeNs ||
      pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
      BigInt(bytes.length) !== opened.size) {
    throw new Error("nofollow source changed while reading");
  }
  process.stdout.write(bytes);
} finally {
  fs.closeSync(descriptor);
}
'@

$script:WriteNoFollowScript = @'
const fs = require("node:fs");
const path = process.argv[1];
const bytes = fs.readFileSync(0);
const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
  (fs.constants.O_NOFOLLOW ?? 0);
const descriptor = fs.openSync(path, flags, 0o600);
let binding;
try {
  fs.writeFileSync(descriptor, bytes);
  fs.fsyncSync(descriptor);
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile() || opened.size !== BigInt(bytes.length)) {
    throw new Error("nofollow destination write is incomplete");
  }
  binding = opened;
} finally {
  fs.closeSync(descriptor);
}
const after = fs.lstatSync(path, { bigint: true });
if (!after.isFile() || after.isSymbolicLink() ||
    after.dev !== binding.dev || after.ino !== binding.ino ||
    after.size !== binding.size || after.mtimeNs !== binding.mtimeNs || after.ctimeNs !== binding.ctimeNs) {
  throw new Error("nofollow destination path binding changed");
}
'@

function Get-RegularFileBytesNoFollow {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw "$Label path must be absolute" }
  Assert-NoReparseChain -Path $Path -Label $Label
  $bytes = Invoke-NodeBytesChecked -Arguments @('-e', $script:ReadNoFollowScript, $Path)
  return ,$bytes
}

function Write-RegularFileBytesNoFollow {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][byte[]]$Bytes,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw "$Label path must be absolute" }
  Assert-NoReparseChain -Path $Path -Label $Label
  Invoke-NodeBytesChecked -Arguments @('-e', $script:WriteNoFollowScript, $Path) -InputBytes $Bytes | Out-Null
  $written = Get-RegularFileBytesNoFollow -Path $Path -Label $Label
  if ($written.Length -ne $Bytes.Length -or
      (Get-BytesSha256 -Bytes $written) -ne (Get-BytesSha256 -Bytes $Bytes)) {
    throw "$Label nofollow copy changed bytes"
  }
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

function Invoke-GitBytes {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [byte[]]$InputBytes
  )
  $trustedArguments = @(
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false',
    '-c', 'core.attributesFile=/dev/null'
  ) + $Arguments
  $bytes = Invoke-NativeCheckedBytes -FilePath $GitPath -Environment $gitEnvironment -Arguments $trustedArguments -InputBytes $InputBytes
  return ,$bytes
}

function Get-AuthenticatedGitObjectByOid {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ObjectId,
    [Parameter(Mandatory = $true)][ValidateSet('blob', 'tree', 'commit')][string]$ExpectedType,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $type = @(Invoke-Git @('-C', $sourceRoot, 'cat-file', '-t', $ObjectId))
  if ($type.Count -ne 1 -or $type[0].Trim() -ne $ExpectedType) {
    throw "$Label Git object is not an exact $ExpectedType"
  }
  $sizeOutput = @(Invoke-Git @('-C', $sourceRoot, 'cat-file', '-s', $ObjectId))
  $size = 0L
  if ($sizeOutput.Count -ne 1 -or
      -not [int64]::TryParse($sizeOutput[0].Trim(), [Globalization.NumberStyles]::None,
        [Globalization.CultureInfo]::InvariantCulture, [ref]$size) -or $size -lt 0) {
    throw "$Label Git blob size is invalid"
  }
  $bytes = Invoke-GitBytes -Arguments @('-C', $sourceRoot, 'cat-file', $ExpectedType, $ObjectId)
  if ($bytes.LongLength -ne $size) { throw "$Label Git object bytes do not match its declared size" }
  if ((Get-GitObjectId -Type $ExpectedType -Bytes $bytes) -ne $ObjectId) {
    throw "$Label Git object hash does not authenticate its raw bytes"
  }
  return [pscustomobject]@{
    ObjectId = $ObjectId
    Type = $ExpectedType
    Size = $size
    Sha256 = Get-BytesSha256 -Bytes $bytes
    Bytes = $bytes
  }
}

function Get-AuthenticatedGitBlobByOid {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ObjectId,
    [Parameter(Mandatory = $true)][string]$Label
  )
  return Get-AuthenticatedGitObjectByOid -ObjectId $ObjectId -ExpectedType 'blob' -Label $Label
}

function Get-AuthenticatedGitTreeByOid {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ObjectId,
    [Parameter(Mandatory = $true)][string]$Label
  )
  return Get-AuthenticatedGitObjectByOid -ObjectId $ObjectId -ExpectedType 'tree' -Label $Label
}

function Get-AuthenticatedGitCommitByOid {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ObjectId,
    [Parameter(Mandatory = $true)][string]$Label
  )
  return Get-AuthenticatedGitObjectByOid -ObjectId $ObjectId -ExpectedType 'commit' -Label $Label
}

function Get-GitCommitBinding {
  param(
    [Parameter(Mandatory = $true)][pscustomobject]$Commit,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $text = [Text.UTF8Encoding]::new($false, $true).GetString([byte[]]$Commit.Bytes)
  $headerEnd = $text.IndexOf("`n`n", [StringComparison]::Ordinal)
  if ($headerEnd -lt 0) { throw "$Label Git commit has no header terminator" }
  $headers = @($text.Substring(0, $headerEnd) -split "`n")
  $treeHeaders = @($headers | Where-Object { $_ -match '^tree [0-9a-f]{40}$' })
  $parentHeaders = @($headers | Where-Object { $_ -match '^parent [0-9a-f]{40}$' })
  if ($treeHeaders.Count -ne 1) { throw "$Label Git commit must contain exactly one tree header" }
  return [pscustomobject]@{
    Tree = $treeHeaders[0].Substring(5)
    Parents = @($parentHeaders | ForEach-Object { $_.Substring(7) })
  }
}

function Find-AuthenticatedGitTreeEntry {
  param(
    [Parameter(Mandatory = $true)][pscustomobject]$Tree,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $bytes = [byte[]]$Tree.Bytes
  $position = 0
  $match = $null
  while ($position -lt $bytes.Length) {
    $nul = -1
    for ($index = $position; $index -lt $bytes.Length; $index += 1) {
      if ($bytes[$index] -eq 0) { $nul = $index; break }
    }
    if ($nul -le $position -or $nul + 20 -ge $bytes.Length) {
      throw "$Label Git tree encoding is malformed"
    }
    $header = [Text.UTF8Encoding]::new($false, $true).GetString(
      [byte[]]$bytes[$position..($nul - 1)]
    )
    $separator = $header.IndexOf(' ', [StringComparison]::Ordinal)
    if ($separator -le 0 -or $separator -eq $header.Length - 1) {
      throw "$Label Git tree entry header is malformed"
    }
    $mode = $header.Substring(0, $separator)
    $entryName = $header.Substring($separator + 1)
    $oidBytes = [byte[]]$bytes[($nul + 1)..($nul + 20)]
    $oid = [Convert]::ToHexString($oidBytes).ToLowerInvariant()
    if ($entryName -eq $Name) {
      if ($null -ne $match) { throw "$Label Git tree contains a duplicate path segment" }
      $match = [pscustomobject]@{ Mode = $mode; Name = $entryName; ObjectId = $oid }
    }
    $position = $nul + 21
  }
  if ($position -ne $bytes.Length) { throw "$Label Git tree has trailing malformed bytes" }
  if ($null -eq $match) { throw "$Label path segment is absent from the authenticated Git tree: $Name" }
  return $match
}

function Get-AuthenticatedReviewedBlob {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($RelativePath.Contains('\') -or $RelativePath.StartsWith('/') -or
      @($RelativePath.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) {
    throw "$Label reviewed path is not portable"
  }
  $commit = Get-AuthenticatedGitCommitByOid -ObjectId $ReviewedTree -Label 'reviewed R commit'
  $commitBinding = Get-GitCommitBinding -Commit $commit -Label 'reviewed R commit'
  $tree = Get-AuthenticatedGitTreeByOid -ObjectId $commitBinding.Tree -Label 'reviewed R root tree'
  $segments = @($RelativePath.Split('/'))
  for ($index = 0; $index -lt $segments.Count; $index += 1) {
    $entry = Find-AuthenticatedGitTreeEntry -Tree $tree -Name $segments[$index] -Label $Label
    if ($index -lt $segments.Count - 1) {
      if ($entry.Mode -ne '40000') { throw "$Label parent path is not an authenticated Git tree" }
      $tree = Get-AuthenticatedGitTreeByOid -ObjectId $entry.ObjectId -Label "$Label parent tree"
      continue
    }
    if ($entry.Mode -notin @('100644', '100755')) {
      throw "$Label is not an authenticated regular Git blob"
    }
    return Get-AuthenticatedGitBlobByOid -ObjectId $entry.ObjectId -Label $Label
  }
  throw "Unable to resolve exact ReviewedTree blob for $Label"
}

function Assert-ReviewedMaterializedBlob {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $reviewedBlob = Get-AuthenticatedReviewedBlob -RelativePath $RelativePath -Label $Label
  $materialized = Get-RegularFileBytesNoFollow -Path $Path -Label $Label
  if ($materialized.LongLength -ne $reviewedBlob.Size -or
      (Get-BytesSha256 -Bytes $materialized) -ne $reviewedBlob.Sha256 -or
      (Get-GitBlobObjectId -Bytes $materialized) -ne $reviewedBlob.ObjectId) {
    throw "$Label does not match the exact raw ReviewedTree Git blob"
  }
}

function Get-PortableRepositoryPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $relative = [IO.Path]::GetRelativePath($sourceRoot, [IO.Path]::GetFullPath($Path))
  if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '.' -or $relative -eq '..' -or
      $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
    throw "$Label escaped the source repository"
  }
  $portable = $relative.Replace([IO.Path]::DirectorySeparatorChar, '/')
  if ($portable.Contains('\') -or
      @($portable.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) {
    throw "$Label is not a portable repository path"
  }
  return $portable
}

function Remove-TrustedTemporaryDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $canonical = [IO.Path]::GetFullPath($Path)
  $relative = [IO.Path]::GetRelativePath($tempRoot, $canonical)
  if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '.' -or $relative -eq '..' -or
      $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
    throw "Refusing to clean $Label outside the canonical temp root"
  }
  Assert-NoReparseChain -Path $canonical -Label $Label
  $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label is not a real directory"
  }
  Remove-Item -LiteralPath $canonical -Recurse -Force -ErrorAction Stop
}

function Invoke-ReviewedSourceGate {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit,
    [Parameter(Mandatory = $true)][string[]]$AllowedPaths
  )
  $toolRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('ihome-openclaw-source-gate-' + [guid]::NewGuid().ToString('N'))))
  $toolPath = Join-Path $toolRoot 'verify-reviewed-source-gate.mjs'
  $primaryError = $null
  $cleanupError = $null
  $result = @()
  try {
    New-Item -ItemType Directory -Path $toolRoot -ErrorAction Stop | Out-Null
    Assert-NoReparseChain -Path $toolRoot -Label 'reviewed source gate bootstrap root'
    $toolBlob = Get-AuthenticatedReviewedBlob -RelativePath 'services/openclaw-zalo-cell/scripts/verify-reviewed-source-gate.mjs' -Label 'reviewed source gate bootstrap'
    Write-RegularFileBytesNoFollow -Path $toolPath -Bytes $toolBlob.Bytes -Label 'reviewed source gate bootstrap'
    $arguments = @(
      $toolPath,
      '--git-path', $GitPath,
      '--repository-root', $sourceRoot,
      '--reviewed-tree', $Commit,
      '--git-sha256', $actualGitSha256
    )
    foreach ($allowedPath in $AllowedPaths) {
      $arguments += @('--allow-untracked', $allowedPath)
    }
    $result = @(Invoke-NodeChecked -Arguments $arguments)
    if ($result.Count -ne 1) { throw 'Reviewed source gate returned an invalid result record' }
    $gateRecord = $result[0] | ConvertFrom-Json -Depth 8 -ErrorAction Stop
    $reportedAllowed = @($gateRecord.allowed_untracked_paths | ForEach-Object { [string]$_ })
    if ([string]$gateRecord.reviewed_tree -ne $Commit -or
        $reportedAllowed.Count -ne $AllowedPaths.Count -or
        @($AllowedPaths | Where-Object { $reportedAllowed -cnotcontains $_ }).Count -ne 0 -or
        @($reportedAllowed | Where-Object { $AllowedPaths -cnotcontains $_ }).Count -ne 0) {
      throw 'Reviewed source gate result does not preserve the exact retained candidate/report allowlist'
    }
    Assert-ReviewedMaterializedBlob -Path $toolPath -RelativePath 'services/openclaw-zalo-cell/scripts/verify-reviewed-source-gate.mjs' -Label 'reviewed source gate bootstrap after execution'
  } catch {
    $primaryError = $_
  } finally {
    try {
      Remove-TrustedTemporaryDirectory -Path $toolRoot -Label 'reviewed source gate bootstrap root'
    } catch {
      $cleanupError = $_
    }
    if ($null -ne $primaryError) {
      if ($null -ne $cleanupError) {
        [Console]::Error.WriteLine('Reviewed source gate bootstrap cleanup also failed: ' + $cleanupError.Exception.Message)
      }
      throw $primaryError
    }
    if ($null -ne $cleanupError) { throw $cleanupError }
  }
  return @($result)
}

function Invoke-ReviewedTreeExporterCommand {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('export', 'verify')][string]$Command,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath
  )
  $toolRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('ihome-openclaw-tree-export-' + [guid]::NewGuid().ToString('N'))))
  $toolPath = Join-Path $toolRoot 'export-reviewed-tree.mjs'
  $primaryError = $null
  $cleanupError = $null
  try {
    New-Item -ItemType Directory -Path $toolRoot -ErrorAction Stop | Out-Null
    Assert-NoReparseChain -Path $toolRoot -Label 'reviewed tree exporter bootstrap root'
    $toolBlob = Get-AuthenticatedReviewedBlob -RelativePath 'services/openclaw-zalo-cell/scripts/export-reviewed-tree.mjs' -Label 'reviewed tree exporter bootstrap'
    Write-RegularFileBytesNoFollow -Path $toolPath -Bytes $toolBlob.Bytes -Label 'reviewed tree exporter bootstrap'
    Invoke-NodeChecked -Arguments @(
      $toolPath, $Command,
      '--git-path', $GitPath,
      '--repository-root', $sourceRoot,
      '--reviewed-tree', $Commit,
      '--output-root', $OutputRoot,
      '--manifest', $ManifestPath
    ) | Out-Null
    Invoke-NodeChecked -Arguments @(
      $toolPath, 'verify',
      '--git-path', $GitPath,
      '--repository-root', $sourceRoot,
      '--reviewed-tree', $ReviewedTree,
      '--output-root', $OutputRoot,
      '--manifest', $ManifestPath
    ) | Out-Null
    Assert-ReviewedMaterializedBlob -Path $toolPath -RelativePath 'services/openclaw-zalo-cell/scripts/export-reviewed-tree.mjs' -Label 'reviewed tree exporter bootstrap after execution'
  } catch {
    $primaryError = $_
  } finally {
    try {
      Remove-TrustedTemporaryDirectory -Path $toolRoot -Label 'reviewed tree exporter bootstrap root'
    } catch {
      $cleanupError = $_
    }
    if ($null -ne $primaryError) {
      if ($null -ne $cleanupError) {
        [Console]::Error.WriteLine('Reviewed tree exporter bootstrap cleanup also failed: ' + $cleanupError.Exception.Message)
      }
      throw $primaryError
    }
    if ($null -ne $cleanupError) { throw $cleanupError }
  }
}

function Assert-ReviewedTreeExport {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath
  )
  Invoke-ReviewedTreeExporterCommand -Command 'verify' -Commit $Commit -OutputRoot $OutputRoot -ManifestPath $ManifestPath
}

function Invoke-ReviewedTreeExport {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath
  )
  Invoke-ReviewedTreeExporterCommand -Command 'export' -Commit $Commit -OutputRoot $OutputRoot -ManifestPath $ManifestPath
  Assert-ReviewedTreeExport -Commit $Commit -OutputRoot $OutputRoot -ManifestPath $ManifestPath
}

function Invoke-EvidenceReplay {
  param(
    [Parameter(Mandatory = $true)][string]$eCellRoot,
    [Parameter(Mandatory = $true)][string]$eDestination,
    [Parameter(Mandatory = $true)][string]$eSchema,
    [Parameter(Mandatory = $true)][string]$eLock,
    [Parameter(Mandatory = $true)][string]$eVerifier,
    [Parameter(Mandatory = $true)][string]$eBehaviorRunner,
    [Parameter(Mandatory = $true)][string]$Context
  )
  $before = Get-RegularFileBytesNoFollow -Path $eDestination -Label "$Context before verifier replay"
  if ((Get-BytesSha256 -Bytes $before) -ne $candidateEvidenceSha256) {
    throw "$Context bytes differ from the retained candidate before verifier replay"
  }
  foreach ($binding in @(
      [pscustomobject]@{ Path = $eVerifier; Relative = 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs'; Label = 'Verifier' },
      [pscustomobject]@{ Path = $eSchema; Relative = 'services/openclaw-zalo-cell/build-evidence.schema.v1.json'; Label = 'Evidence schema' },
      [pscustomobject]@{ Path = $eLock; Relative = 'services/openclaw-zalo-cell/image-lock.json'; Label = 'Image lock' },
      [pscustomobject]@{ Path = $eBehaviorRunner; Relative = 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs'; Label = 'Behavior runner' }
    )) {
    Assert-ReviewedMaterializedBlob -Path $binding.Path -RelativePath $binding.Relative -Label "$($binding.Label) $Context"
  }
  $verifyArgs = @(
    $eVerifier,
    '--mode', 'evidence-replay-v1',
    '--approval-manifest', $approvalManifest,
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
  foreach ($binding in @(
      [pscustomobject]@{ Path = $eVerifier; Relative = 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs'; Label = 'Verifier' },
      [pscustomobject]@{ Path = $eSchema; Relative = 'services/openclaw-zalo-cell/build-evidence.schema.v1.json'; Label = 'Evidence schema' },
      [pscustomobject]@{ Path = $eLock; Relative = 'services/openclaw-zalo-cell/image-lock.json'; Label = 'Image lock' },
      [pscustomobject]@{ Path = $eBehaviorRunner; Relative = 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs'; Label = 'Behavior runner' }
    )) {
    Assert-ReviewedMaterializedBlob -Path $binding.Path -RelativePath $binding.Relative -Label "$($binding.Label) $Context after execution"
  }
  $after = Get-RegularFileBytesNoFollow -Path $eDestination -Label "$Context after verifier replay"
  if ($after.LongLength -ne $before.LongLength -or
      (Get-BytesSha256 -Bytes $after) -ne $candidateEvidenceSha256) {
    throw "$Context bytes changed during verifier replay"
  }
  Assert-RetainedAuthorityBindings -Context "after $Context verifier replay"
  return $after
}

function Assert-EvidenceOnlyExportDelta {
  param(
    [Parameter(Mandatory = $true)][string]$ReviewedManifestPath,
    [Parameter(Mandatory = $true)][string]$EvidenceManifestPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$EvidenceCommit,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$EvidenceObjectId,
    [Parameter(Mandatory = $true)][byte[]]$EvidenceBytes
  )
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  $reviewedManifest = $utf8.GetString(
    (Get-RegularFileBytesNoFollow -Path $ReviewedManifestPath -Label 'reviewed R export manifest')
  ) | ConvertFrom-Json -Depth 16
  $evidenceManifest = $utf8.GetString(
    (Get-RegularFileBytesNoFollow -Path $EvidenceManifestPath -Label 'evidence E export manifest')
  ) | ConvertFrom-Json -Depth 16
  if ($reviewedManifest.reviewed_tree -ne $ReviewedTree -or
      $evidenceManifest.reviewed_tree -ne $EvidenceCommit -or
      @($evidenceManifest.entries).Count -ne @($reviewedManifest.entries).Count + 1) {
    throw 'R and E reviewed export manifests have invalid checkpoint bindings or counts'
  }
  $evidenceEntries = @{}
  foreach ($entry in @($evidenceManifest.entries)) {
    if ($evidenceEntries.ContainsKey([string]$entry.path)) {
      throw 'E reviewed export manifest contains a duplicate path'
    }
    $evidenceEntries[[string]$entry.path] = $entry
  }
  foreach ($entry in @($reviewedManifest.entries)) {
    if (-not $evidenceEntries.ContainsKey([string]$entry.path)) {
      throw "E reviewed export lost an R path: $($entry.path)"
    }
    $actual = $evidenceEntries[[string]$entry.path]
    foreach ($field in @('type', 'mode', 'git_object_id', 'git_object_size', 'content_size', 'content_sha256')) {
      if ([string]$actual.$field -ne [string]$entry.$field) {
        throw "E reviewed export changed R path metadata: $($entry.path) $field"
      }
    }
    $evidenceEntries.Remove([string]$entry.path)
  }
  $evidencePath = 'services/openclaw-zalo-cell/build-evidence.json'
  if ($evidenceEntries.Count -ne 1 -or -not $evidenceEntries.ContainsKey($evidencePath)) {
    throw 'E reviewed export delta is not the sole build-evidence path'
  }
  $record = $evidenceEntries[$evidencePath]
  if ($record.type -ne 'blob' -or $record.mode -ne '100644' -or
      $record.git_object_id -ne $EvidenceObjectId -or
      [int64]$record.git_object_size -ne $EvidenceBytes.LongLength -or
      [int64]$record.content_size -ne $EvidenceBytes.LongLength -or
      $record.content_sha256 -ne (Get-BytesSha256 -Bytes $EvidenceBytes)) {
    throw 'E reviewed export evidence entry is not the exact added 100644 blob'
  }
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
if (-not [IO.Path]::IsPathFullyQualified($ApprovalManifestPath)) {
  throw 'ApprovalManifestPath must be absolute'
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
$approvalManifest = [IO.Path]::GetFullPath($ApprovalManifestPath)
$expectedApprovalManifest = [IO.Path]::GetFullPath("/opt/openclaw-tools/reviewed-task2/$ReviewedTree/approval-manifest-v1.json")
if ($ApprovalManifestPath -cne $approvalManifest -or $approvalManifest -cne $expectedApprovalManifest) {
  throw 'ApprovalManifestPath must be the exact canonical R-bound Task 2 approval manifest path'
}
Assert-NoReparseChain -Path $approvalManifest -Label 'Task 2 approval manifest'
$approvalManifestItem = Get-Item -LiteralPath $approvalManifest -Force -ErrorAction Stop
if ($approvalManifestItem.PSIsContainer -or
    ($approvalManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'ApprovalManifestPath must be a regular non-reparse file'
}
$approvalManifestSha256 = (Get-FileHash -LiteralPath $approvalManifest -Algorithm SHA256).Hash.ToLowerInvariant()
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
    [pscustomobject]@{ Path = $approvalManifest; Label = 'Task 2 approval manifest' }
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

$candidateEvidenceBytes = Get-RegularFileBytesNoFollow -Path $candidateEvidence -Label 'candidate evidence initial binding'
$candidateEvidenceSha256 = Get-BytesSha256 -Bytes $candidateEvidenceBytes
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

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRootItem = Get-Item -LiteralPath $tempRoot -Force -ErrorAction Stop
if (-not $tempRootItem.PSIsContainer -or
    ($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Temp root must be a regular non-reparse directory'
}
Assert-NoReparseChain -Path $tempRoot -Label 'temp root'
$sourceGateAllowlist = @(
  Get-PortableRepositoryPath -Path $candidateEvidence -Label 'candidate evidence allowlist path'
  Get-PortableRepositoryPath -Path $candidateArchive -Label 'candidate archive A allowlist path'
  Get-PortableRepositoryPath -Path $candidateArchiveB -Label 'candidate archive B allowlist path'
  Get-PortableRepositoryPath -Path $candidateStockOci -Label 'candidate stock OCI allowlist path'
  Get-PortableRepositoryPath -Path $upstreamTarball -Label 'retained upstream tgz allowlist path'
  Get-PortableRepositoryPath -Path $mReviewReport -Label 'M review report allowlist path'
  Get-PortableRepositoryPath -Path $rReviewReport -Label 'R review report allowlist path'
)
if (@($sourceGateAllowlist | Sort-Object -Unique).Count -ne $sourceGateAllowlist.Count) {
  throw 'Reviewed source gate retained candidate/report allowlist contains duplicate paths'
}

Assert-SourceWorktreeState -ExpectedHead $ReviewedTree -Context 'before detached E creation'
Assert-RetainedAuthorityBindings -Context 'before detached E creation'

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
$zeroOid = '0000000000000000000000000000000000000000'
$stagingRef = "refs/ihome/openclaw/evidence-staging/$([guid]::NewGuid().ToString('N'))"
$stagingRefCreated = $false
$primaryError = $null
$cleanupError = $null
try {
  Invoke-Git @('worktree', 'add', '--detach', '--no-checkout', $eWorktree, $ReviewedTree) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create detached E worktree' }
  Assert-NoReparseChain -Path $eWorktree -Label 'detached E worktree'
  if (((Invoke-Git @('-C', $eWorktree, 'rev-parse', 'HEAD')) -join "`n").Trim() -ne $ReviewedTree) {
    throw 'Detached E worktree is not exact ReviewedTree'
  }

  Invoke-Git @('-C', $eWorktree, 'read-tree', $ReviewedTree) | Out-Null
  $reviewedRootTree = ((Invoke-Git @('-C', $sourceRoot, 'rev-parse', "$ReviewedTree^{tree}")) -join "`n").Trim()
  $initialIndexTree = ((Invoke-Git @('-C', $eWorktree, 'write-tree')) -join "`n").Trim()
  if ($reviewedRootTree -notmatch '^[0-9a-f]{40}$' -or $initialIndexTree -ne $reviewedRootTree) {
    throw 'Detached E temporary index is not the exact ReviewedTree tree'
  }
  $existingEvidence = @(Invoke-Git @('-C', $sourceRoot, 'ls-tree', '--full-tree', $ReviewedTree, '--', 'services/openclaw-zalo-cell/build-evidence.json'))
  if ($existingEvidence.Count -ne 0) { throw 'ReviewedTree already contains build evidence' }

  $reviewedExportRoot = [IO.Path]::GetFullPath((Join-Path $eWorktree 'reviewed-source'))
  $reviewedExportManifest = [IO.Path]::GetFullPath((Join-Path $eWorktree 'reviewed-export-manifest.json'))
  Invoke-ReviewedTreeExport -Commit $ReviewedTree -OutputRoot $reviewedExportRoot -ManifestPath $reviewedExportManifest
  $eDestination = [IO.Path]::GetFullPath((Join-Path $eWorktree 'candidate-build-evidence.json'))
  $eCellRoot = [IO.Path]::GetFullPath((Join-Path $reviewedExportRoot 'services/openclaw-zalo-cell'))
  $eSchema = [IO.Path]::GetFullPath((Join-Path $reviewedExportRoot 'services/openclaw-zalo-cell/build-evidence.schema.v1.json'))
  $eLock = [IO.Path]::GetFullPath((Join-Path $reviewedExportRoot 'services/openclaw-zalo-cell/image-lock.json'))
  $eVerifier = [IO.Path]::GetFullPath((Join-Path $reviewedExportRoot 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs'))
  $eBehaviorRunner = [IO.Path]::GetFullPath((Join-Path $reviewedExportRoot 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs'))
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
  Assert-ReviewedMaterializedBlob -Path $eVerifier -RelativePath 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs' -Label 'Verifier'
  Assert-ReviewedMaterializedBlob -Path $eSchema -RelativePath 'services/openclaw-zalo-cell/build-evidence.schema.v1.json' -Label 'Evidence schema'
  Assert-ReviewedMaterializedBlob -Path $eLock -RelativePath 'services/openclaw-zalo-cell/image-lock.json' -Label 'Image lock'
  Assert-ReviewedMaterializedBlob -Path $eBehaviorRunner -RelativePath 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs' -Label 'Behavior runner'
  $candidateEvidenceBeforeCopy = Get-RegularFileBytesNoFollow -Path $candidateEvidence -Label 'candidate evidence before detached E copy'
  if ((Get-BytesSha256 -Bytes $candidateEvidenceBeforeCopy) -ne $candidateEvidenceSha256) {
    throw 'Candidate evidence changed before detached E copy'
  }
  Write-RegularFileBytesNoFollow -Path $eDestination -Bytes $candidateEvidenceBeforeCopy -Label 'detached E evidence destination'
  if ((Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateArchiveSha256) {
    throw 'Candidate archive changed before E verification'
  }
  Assert-ReviewedTreeExport -Commit $ReviewedTree -OutputRoot $reviewedExportRoot -ManifestPath $reviewedExportManifest
  $verifiedEvidenceBytes = Invoke-EvidenceReplay `
    -eCellRoot $eCellRoot `
    -eDestination $eDestination `
    -eSchema $eSchema `
    -eLock $eLock `
    -eVerifier $eVerifier `
    -eBehaviorRunner $eBehaviorRunner `
    -Context 'candidate evidence'
  Assert-ReviewedTreeExport -Commit $ReviewedTree -OutputRoot $reviewedExportRoot -ManifestPath $reviewedExportManifest

  $evidenceOidOutput = Invoke-GitBytes -Arguments @('-C', $eWorktree, 'hash-object', '-w', '--stdin') -InputBytes $verifiedEvidenceBytes
  $evidenceOid = [Text.Encoding]::ASCII.GetString($evidenceOidOutput).Trim()
  if ($evidenceOid -notmatch '^[0-9a-f]{40}$' -or
      $evidenceOid -ne (Get-GitBlobObjectId -Bytes $verifiedEvidenceBytes)) {
    throw 'Git did not create the exact verified evidence blob'
  }
  $writtenEvidenceBlob = Get-AuthenticatedGitBlobByOid -ObjectId $evidenceOid -Label 'written evidence'
  if ($writtenEvidenceBlob.Size -ne $verifiedEvidenceBytes.LongLength -or
      $writtenEvidenceBlob.Sha256 -ne $candidateEvidenceSha256) {
    throw 'Written evidence Git blob differs from verified nofollow bytes'
  }
  Invoke-Git @('-C', $eWorktree, 'update-index', '--add', '--cacheinfo', '100644', $evidenceOid, 'services/openclaw-zalo-cell/build-evidence.json') | Out-Null
  $eTree = ((Invoke-Git @('-C', $eWorktree, 'write-tree')) -join "`n").Trim()
  if ($eTree -notmatch '^[0-9a-f]{40}$' -or $eTree -eq $reviewedRootTree) {
    throw 'Evidence-only tree was not created from the temporary index'
  }
  $commitMessage = [Text.UTF8Encoding]::new($false).GetBytes(
    "chore(openclaw-zalo): record verified evidence E`n`nCo-Authored-By: Codex <noreply@openai.com>`n"
  )
  $commitOutput = Invoke-GitBytes -Arguments @('-C', $eWorktree, 'commit-tree', $eTree, '-p', $ReviewedTree) -InputBytes $commitMessage
  $E = [Text.Encoding]::ASCII.GetString($commitOutput).Trim()
  if ($E -notmatch '^[0-9a-f]{40}$') { throw 'commit-tree did not return an exact E object ID' }
  $authenticatedECommit = Get-AuthenticatedGitCommitByOid -ObjectId $E -Label 'evidence E commit'
  $authenticatedECommitBinding = Get-GitCommitBinding -Commit $authenticatedECommit -Label 'evidence E commit'
  if ($authenticatedECommitBinding.Tree -ne $eTree -or
      $authenticatedECommitBinding.Parents.Count -ne 1 -or
      $authenticatedECommitBinding.Parents[0] -ne $ReviewedTree) {
    throw 'Authenticated E commit is not the exact evidence tree with sole parent R'
  }
  $authenticatedETree = Get-AuthenticatedGitTreeByOid -ObjectId $eTree -Label 'evidence E tree'
  if ($authenticatedETree.ObjectId -ne $eTree) { throw 'Authenticated E tree binding changed' }
  $committedEvidenceSpec = "$E`:services/openclaw-zalo-cell/build-evidence.json"
  $committedEvidenceOid = @(Invoke-Git @('-C', $sourceRoot, 'rev-parse', "$E`:services/openclaw-zalo-cell/build-evidence.json"))
  if ($committedEvidenceOid.Count -ne 1 -or $committedEvidenceOid[0].Trim() -notmatch '^[0-9a-f]{40}$') {
    throw 'Unable to resolve the committed evidence Git blob'
  }
  $committedEvidenceOid = $committedEvidenceOid[0].Trim()
  if ($committedEvidenceOid -ne $evidenceOid) { throw 'E tree does not reference the exact written evidence blob' }
  $expectedEvidenceMode = '100644'
  $committedEvidenceBlob = Get-AuthenticatedGitBlobByOid -ObjectId $committedEvidenceOid -Label 'committed evidence'
  $committedEvidenceSha256 = Get-GitBlobSha256 -ObjectId $committedEvidenceOid -Label 'committed evidence'
  if ($committedEvidenceBlob.Size -ne $verifiedEvidenceBytes.LongLength -or
      $committedEvidenceSha256 -ne $candidateEvidenceSha256) {
    throw 'Committed evidence Git blob bytes differ from the verified candidate'
  }
  $parentLine = @(Invoke-Git @('-C', $sourceRoot, 'rev-list', '--parents', '-n', '1', $E))
  if ($parentLine.Count -ne 1) { throw 'Unable to read the exact E parent list' }
  $parentFields = @($parentLine[0] -split '\s+')
  if ($parentFields.Count -ne 2 -or $parentFields[1] -ne $ReviewedTree) {
    throw 'E must have exactly one parent and it must be ReviewedTree'
  }
  if (((Invoke-Git @('-C', $sourceRoot, 'rev-parse', "$E^") -join "`n").Trim()) -ne $ReviewedTree) {
    throw 'E is not a direct child of the reviewed tree'
  }
  $committedRawDiff = @(Invoke-Git @('-C', $sourceRoot, 'diff-tree', '--raw', '--no-renames', '--no-commit-id', '-r', $E))
  $expectedRawDiff = ":000000 $expectedEvidenceMode $zeroOid $committedEvidenceOid A`tservices/openclaw-zalo-cell/build-evidence.json"
  if ($committedRawDiff.Count -ne 1 -or $committedRawDiff[0] -ne $expectedRawDiff) {
    throw 'E committed diff is not exactly one added 100644 blob at build-evidence.json'
  }

  Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', $stagingRef, $E, $zeroOid) | Out-Null
  $stagingRefCreated = $true

  $committedExportRoot = [IO.Path]::GetFullPath((Join-Path $eWorktree 'committed-source'))
  $committedExportManifest = [IO.Path]::GetFullPath((Join-Path $eWorktree 'committed-export-manifest.json'))
  Invoke-ReviewedTreeExport -Commit $E -OutputRoot $committedExportRoot -ManifestPath $committedExportManifest
  Assert-EvidenceOnlyExportDelta `
    -ReviewedManifestPath $reviewedExportManifest `
    -EvidenceManifestPath $committedExportManifest `
    -EvidenceCommit $E `
    -EvidenceObjectId $committedEvidenceOid `
    -EvidenceBytes $committedEvidenceBlob.Bytes
  $committedEvidencePath = [IO.Path]::GetFullPath((Join-Path $committedExportRoot 'services/openclaw-zalo-cell/build-evidence.json'))
  $committedCellRoot = [IO.Path]::GetFullPath((Join-Path $committedExportRoot 'services/openclaw-zalo-cell'))
  $committedSchema = [IO.Path]::GetFullPath((Join-Path $committedExportRoot 'services/openclaw-zalo-cell/build-evidence.schema.v1.json'))
  $committedLock = [IO.Path]::GetFullPath((Join-Path $committedExportRoot 'services/openclaw-zalo-cell/image-lock.json'))
  $committedVerifier = [IO.Path]::GetFullPath((Join-Path $committedExportRoot 'services/openclaw-zalo-cell/scripts/verify-image-lock.mjs'))
  $committedBehaviorRunner = [IO.Path]::GetFullPath((Join-Path $committedExportRoot 'services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs'))
  $committedEvidenceBytes = Get-RegularFileBytesNoFollow -Path $committedEvidencePath -Label 'committedEvidence raw E export'
  if ((Get-GitBlobObjectId -Bytes $committedEvidenceBytes) -ne $committedEvidenceOid -or
      (Get-BytesSha256 -Bytes $committedEvidenceBytes) -ne $candidateEvidenceSha256) {
    throw 'Raw E export did not preserve the authenticated committedEvidence blob'
  }
  Assert-ReviewedTreeExport -Commit $E -OutputRoot $committedExportRoot -ManifestPath $committedExportManifest
  Invoke-EvidenceReplay `
    -eCellRoot $committedCellRoot `
    -eDestination $committedEvidencePath `
    -eSchema $committedSchema `
    -eLock $committedLock `
    -eVerifier $committedVerifier `
    -eBehaviorRunner $committedBehaviorRunner `
    -Context 'committedEvidence from authenticated E' | Out-Null
  Assert-ReviewedTreeExport -Commit $E -OutputRoot $committedExportRoot -ManifestPath $committedExportManifest
} catch {
  $primaryError = $_
} finally {
  try {
    $registeredPaths = @(Invoke-Git @('worktree', 'list', '--porcelain') |
      Where-Object { $_ -like 'worktree *' } |
      ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if ($registeredPaths -contains $eWorktree) {
      Invoke-Git @('worktree', 'remove', '--force', $eWorktree) | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Forced detached E worktree removal failed' }
    } elseif (Test-Path -LiteralPath $eWorktree) {
      Remove-TrustedTemporaryDirectory -Path $eWorktree -Label 'unregistered detached E worktree path'
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
  if (($null -ne $primaryError -or $null -ne $cleanupError) -and $stagingRefCreated) {
    try {
      Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', '-d', $stagingRef, $E) | Out-Null
      $stagingRefCreated = $false
    } catch {
      if ($null -eq $cleanupError) {
        $cleanupError = $_
      } else {
        [Console]::Error.WriteLine('Evidence staging ref cleanup also failed: ' + $_.Exception.Message)
      }
    }
  }
  if ($null -ne $primaryError) {
    if ($null -ne $cleanupError) {
      [Console]::Error.WriteLine('Detached E cleanup also failed: ' + $cleanupError.Exception.Message)
    }
    throw $primaryError
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}

if ($null -eq $E -or -not $stagingRefCreated) {
  throw 'Evidence-only child E was not created and retained by its temporary ref'
}
Assert-SourceWorktreeState -ExpectedHead $ReviewedTree -Context 'before E fast-forward'
Assert-RetainedAuthorityBindings -Context 'before E fast-forward'
$branchAdvanced = $false
$indexAdvanced = $false
$evidenceMaterializationAttempted = $false
$fastForwardedEvidence = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'services/openclaw-zalo-cell/build-evidence.json'))
try {
  Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', $sourceBranchRef, $E, $ReviewedTree) | Out-Null
  $branchAdvanced = $true
  $currentBranchRef = @((Invoke-Git @('-C', $sourceRoot, 'symbolic-ref', '--quiet', 'HEAD')))
  if ($currentBranchRef.Count -ne 1 -or $currentBranchRef[0].Trim() -ne $sourceBranchRef) {
    throw 'Source branch ref changed during E compare-and-swap'
  }
  Invoke-Git @('-C', $sourceRoot, 'read-tree', $E) | Out-Null
  $indexAdvanced = $true
  $evidenceMaterializationAttempted = $true
  Write-RegularFileBytesNoFollow -Path $fastForwardedEvidence -Bytes $committedEvidenceBlob.Bytes -Label 'fast-forwarded evidence'
  if (((Invoke-Git @('-C', $sourceRoot, 'rev-parse', 'HEAD') -join "`n").Trim()) -ne $E) {
    throw 'Source worktree did not materialize evidence-only E'
  }
  Assert-SourceWorktreeState -ExpectedHead $E -Context 'after E fast-forward'
  Assert-RetainedAuthorityBindings -Context 'after E fast-forward'
  Assert-NoReparseChain -Path $fastForwardedEvidence -Label 'fast-forwarded evidence'
  $fastForwardedEvidenceBytes = Get-RegularFileBytesNoFollow -Path $fastForwardedEvidence -Label 'fast-forwarded evidence final binding'
  if ((Get-BytesSha256 -Bytes $fastForwardedEvidenceBytes) -ne $candidateEvidenceSha256 -or
      (Get-GitBlobObjectId -Bytes $fastForwardedEvidenceBytes) -ne $committedEvidenceOid) {
    throw 'Fast-forwarded evidence bytes differ from the authenticated E Git blob'
  }
  $retainedE = @((Invoke-Git @('-C', $sourceRoot, 'show-ref', '--verify', '--hash', $stagingRef)))
  if ($retainedE.Count -ne 1 -or $retainedE[0].Trim() -ne $E) {
    throw 'Evidence staging ref stopped retaining exact E before final cleanup'
  }
  Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', '-d', $stagingRef, $E) | Out-Null
  $stagingRefCreated = $false
} catch {
  $fastForwardError = $_
  $rollbackErrors = [Collections.Generic.List[string]]::new()
  $rollbackRefRestored = $false
  if ($branchAdvanced) {
    try {
      Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', $sourceBranchRef, $ReviewedTree, $E) | Out-Null
      $rollbackRefRestored = $true
    } catch {
      $rollbackErrors.Add($_.Exception.Message)
    }
  } else {
    $rollbackRefRestored = $true
  }
  if ($rollbackRefRestored) {
    if ($indexAdvanced) {
      try {
        Invoke-Git @('-C', $sourceRoot, 'read-tree', $ReviewedTree) | Out-Null
        $restoredIndexTree = ((Invoke-Git @('-C', $sourceRoot, 'write-tree')) -join "`n").Trim()
        $reviewedTreeObject = ((Invoke-Git @('-C', $sourceRoot, 'rev-parse', "$ReviewedTree^{tree}")) -join "`n").Trim()
        if ($restoredIndexTree -ne $reviewedTreeObject) {
          throw 'Rollback did not restore the exact reviewed R index tree'
        }
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
    if ($evidenceMaterializationAttempted -and (Test-Path -LiteralPath $fastForwardedEvidence)) {
      try {
        Assert-NoReparseChain -Path $fastForwardedEvidence -Label 'failed fast-forward evidence rollback'
        $failedEvidenceBytes = Get-RegularFileBytesNoFollow -Path $fastForwardedEvidence -Label 'failed fast-forward evidence rollback'
        if ((Get-BytesSha256 -Bytes $failedEvidenceBytes) -ne $candidateEvidenceSha256 -or
            (Get-GitBlobObjectId -Bytes $failedEvidenceBytes) -ne $committedEvidenceOid) {
          throw 'Refusing to remove a rollback evidence leaf that is not the authenticated E blob'
        }
        Remove-Item -LiteralPath $fastForwardedEvidence -Force -ErrorAction Stop
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
    try {
      Assert-SourceWorktreeState -ExpectedHead $ReviewedTree -Context 'after E fast-forward rollback'
      Assert-RetainedAuthorityBindings -Context 'after E fast-forward rollback'
    } catch {
      $rollbackErrors.Add($_.Exception.Message)
    }
  }
  if ($stagingRefCreated -and $rollbackRefRestored) {
    try {
      Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', '-d', $stagingRef, $E) | Out-Null
      $stagingRefCreated = $false
    } catch {
      $rollbackErrors.Add($_.Exception.Message)
    }
  } elseif ($stagingRefCreated) {
    [Console]::Error.WriteLine("Evidence staging ref retained for manual recovery: $stagingRef")
  }
  if ($rollbackErrors.Count -gt 0) {
    [Console]::Error.WriteLine('E fast-forward rollback also failed: ' + ($rollbackErrors -join '; '))
  }
  throw $fastForwardError
}
