[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReleaseSha,
  [Parameter(Mandatory = $true)][string]$HostName,
  [Parameter(Mandatory = $true)][string]$KnownHostsFile,
  [string]$UserName = "root",
  [ValidateRange(1, 65535)][int]$Port = 22,
  [string]$WorkerKey = "vultr-network-center-01",
  [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$MaximumCapturedOutputBytes = 65536

$Stages = @(
  "preflight-systemd-wireguard-firewall",
  "git-archive-reviewed-sha",
  "exclusive-remote-upload",
  "hash-upload-remote-hash",
  "build-tag-label-inspect",
  "emergency-stop-canary",
  "health-heartbeat-readonly-readback",
  "drain-exact-active",
  "switch-current",
  "post-switch-readback",
  "compensating-abort-or-rollback",
  "commit-pointers"
)

function Assert-DeploymentIdentity {
  if ($ReleaseSha -cnotmatch '^[a-f0-9]{40}$') { throw "Release SHA must be exactly 40 lowercase hexadecimal characters." }
  if ($HostName -notmatch '^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$') { throw "Host name is invalid." }
  if ($UserName -cne "root") { throw "Immutable deployment requires the pinned root SSH account." }
  if ($WorkerKey -notmatch '^[a-z0-9][a-z0-9._-]{2,63}$') { throw "Worker key is invalid." }
}

function Invoke-NativeChecked {
  param([Parameter(Mandatory)][string]$FilePath, [Parameter(Mandatory)][string[]]$Arguments, [switch]$Capture,
    [ValidateRange(1, 1048576)][int]$MaximumOutputBytes = $MaximumCapturedOutputBytes)
  if (-not $Capture) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE." }
    return
  }
  $stdoutPath = [IO.Path]::GetTempFileName()
  $stderrPath = [IO.Path]::GetTempFileName()
  try {
    & $FilePath @Arguments 1> $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
    $capturedBytes = (Get-Item -LiteralPath $stdoutPath).Length + (Get-Item -LiteralPath $stderrPath).Length
    if ($capturedBytes -gt $MaximumOutputBytes) { throw "$FilePath output exceeds the capture byte bound." }
    if ($exitCode -ne 0) { throw "$FilePath failed with exit code $exitCode." }
    $captured = (Get-Content -LiteralPath $stdoutPath -Raw) + (Get-Content -LiteralPath $stderrPath -Raw)
    return ($captured -replace '\r?\n\z', '')
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function ConvertFrom-BoundedJson {
  param([AllowEmptyString()][string]$Output, [string]$Description)
  if ([Text.Encoding]::UTF8.GetByteCount($Output) -gt $MaximumCapturedOutputBytes) { throw "$Description exceeds the JSON byte bound." }
  $lines = @($Output -split "`n")
  if ($lines.Count -ne 1 -or $lines[0] -notmatch '^\{.*\}$') { throw "$Description must return exactly one bounded JSON receipt." }
  try { return $lines[0] | ConvertFrom-Json } catch { throw "$Description returned invalid JSON." }
}

function Assert-ExactPropertyNames {
  param($Value, [string[]]$Expected, [string]$Description)
  if ($null -eq $Value -or $Value -isnot [psobject]) { throw "$Description must be an object." }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count -or (($actual -join "`0") -cne ($wanted -join "`0"))) {
    throw "$Description has unknown, missing, or secret-like fields."
  }
}

function Assert-BoundedString {
  param($Value, [string]$Description, [int]$MaximumLength, [string]$Pattern = '')
  if ($Value -isnot [string] -or $Value.Length -gt $MaximumLength -or $Value.Contains("`n") -or $Value.Contains("`r") -or
      ($Pattern -and $Value -cnotmatch $Pattern)) { throw "$Description string is invalid." }
}

function Assert-BooleanValue {
  param($Value, [string]$Description)
  if ($Value -isnot [bool]) { throw "$Description type is invalid." }
}

function Assert-IntegerValue {
  param($Value, [string]$Description, [long]$Minimum, [long]$Maximum)
  if (($Value -isnot [int] -and $Value -isnot [long]) -or [long]$Value -lt $Minimum -or [long]$Value -gt $Maximum) {
    throw "$Description integer is invalid."
  }
}

function Assert-ReleaseSchema {
  param($Release, [string]$Description)
  Assert-ExactPropertyNames $Release @("schemaVersion", "releaseSha", "imageTag", "imageId", "archiveSha256",
    "secretGeneration", "releaseDirectory", "envFile", "projectName", "containerName", "container", "secrets", "security") $Description
  if ($Release.schemaVersion -isnot [int] -or [int]$Release.schemaVersion -ne 2) { throw "$Description schema version is invalid." }
  Assert-BoundedString $Release.releaseSha "$Description release SHA" 40 '^[a-f0-9]{40}$'
  Assert-BoundedString $Release.imageTag "$Description image tag" 128 '^ihome-network-center-worker:[a-f0-9]{40}$'
  Assert-BoundedString $Release.imageId "$Description image ID" 71 '^sha256:[a-f0-9]{64}$'
  Assert-BoundedString $Release.archiveSha256 "$Description archive digest" 64 '^[a-f0-9]{64}$'
  Assert-BoundedString $Release.secretGeneration "$Description secret generation" 64 '^[a-f0-9]{64}$'
  foreach ($name in @("releaseDirectory", "envFile", "projectName", "containerName")) {
    Assert-BoundedString $Release.$name "$Description $name" 512 '^[^\x00-\x1f]+$'
  }
  Assert-ExactPropertyNames $Release.container @("exists", "status", "health", "imageId", "releaseSha", "exactMatch") "$Description container"
  Assert-BooleanValue $Release.container.exists "$Description container exists"
  Assert-BooleanValue $Release.container.exactMatch "$Description container exactMatch"
  Assert-BoundedString $Release.container.status "$Description container status" 32 '^[a-z-]+$'
  Assert-BoundedString $Release.container.health "$Description container health" 32 '^[a-z-]+$'
  foreach ($name in @("imageId", "releaseSha")) {
    if ($null -ne $Release.container.$name) { Assert-BoundedString $Release.container.$name "$Description container $name" 71 '^[a-z0-9:]+$' }
  }
  Assert-ExactPropertyNames $Release.secrets @("persistentAvailable", "runtimeAvailable", "exactMatch") "$Description secrets"
  foreach ($name in @("persistentAvailable", "runtimeAvailable", "exactMatch")) { Assert-BooleanValue $Release.secrets.$name "$Description secrets $name" }
  if ($Release.secrets.exactMatch -cne ($Release.secrets.persistentAvailable -and $Release.secrets.runtimeAvailable)) {
    throw "$Description secret exactness fields are mixed."
  }
  Assert-ExactPropertyNames $Release.security @("user", "readonlyRootfs", "memory", "nanoCpus", "pidsLimit", "restartPolicy",
    "dockerSocketMounted", "exactSecretGenerationMounted", "secretMountSource", "secretMountDestination", "secretMountReadOnly",
    "capDrop", "capDropAll", "securityOpt", "noNewPrivileges", "networkMode", "hostNetwork", "initEnabled", "tmpfs",
    "exactTmpfs", "nodeOptions", "exactNodeOptions") "$Description security"
  foreach ($name in @("readonlyRootfs", "dockerSocketMounted", "exactSecretGenerationMounted", "secretMountReadOnly", "capDropAll",
    "noNewPrivileges", "hostNetwork", "initEnabled", "exactTmpfs", "exactNodeOptions")) { Assert-BooleanValue $Release.security.$name "$Description security $name" }
  foreach ($name in @("memory", "nanoCpus", "pidsLimit")) { Assert-IntegerValue $Release.security.$name "$Description security $name" 0 2147483648 }
  foreach ($name in @("user", "restartPolicy", "secretMountSource", "secretMountDestination", "capDrop", "securityOpt", "networkMode", "tmpfs", "nodeOptions")) {
    Assert-BoundedString $Release.security.$name "$Description security $name" 512 '^[^\x00-\x1f]*$'
  }
  if ($Release.container.exactMatch -and (-not $Release.container.exists -or [string]$Release.container.status -cne "running" -or
      [string]$Release.container.health -cne "healthy" -or [string]$Release.container.imageId -cne [string]$Release.imageId -or
      [string]$Release.container.releaseSha -cne [string]$Release.releaseSha -or -not $Release.secrets.exactMatch -or
      [string]$Release.security.user -cne "10001:10001" -or -not $Release.security.readonlyRootfs -or
      [long]$Release.security.memory -ne 536870912 -or [long]$Release.security.nanoCpus -ne 500000000 -or
      [long]$Release.security.pidsLimit -ne 128 -or [string]$Release.security.restartPolicy -cne "unless-stopped" -or
      $Release.security.dockerSocketMounted -or -not $Release.security.exactSecretGenerationMounted -or
      -not $Release.security.secretMountReadOnly -or [string]$Release.security.capDrop -cne "ALL" -or
      -not $Release.security.capDropAll -or [string]$Release.security.securityOpt -cne "no-new-privileges:true" -or
      -not $Release.security.noNewPrivileges -or [string]$Release.security.networkMode -cne "host" -or
      -not $Release.security.hostNetwork -or -not $Release.security.initEnabled -or -not $Release.security.exactTmpfs -or
      [string]$Release.security.nodeOptions -cne "--max-old-space-size=320" -or -not $Release.security.exactNodeOptions)) {
    throw "$Description exact container/security state is mixed."
  }
  if ($Release.container.exists -and ([string]$Release.container.status -cne "running" -or [string]$Release.container.health -cne "healthy" -or
      [string]$Release.container.imageId -cnotmatch '^sha256:[a-f0-9]{64}$' -or [string]$Release.container.releaseSha -cnotmatch '^[a-f0-9]{40}$' -or
      [string]$Release.security.user -cne "10001:10001" -or -not $Release.security.readonlyRootfs -or
      [long]$Release.security.memory -ne 536870912 -or [long]$Release.security.nanoCpus -ne 500000000 -or
      [long]$Release.security.pidsLimit -ne 128 -or [string]$Release.security.restartPolicy -cne "unless-stopped" -or
      $Release.security.dockerSocketMounted -or -not $Release.security.exactSecretGenerationMounted -or
      -not $Release.security.secretMountReadOnly -or [string]$Release.security.capDrop -cne "ALL" -or
      -not $Release.security.capDropAll -or [string]$Release.security.securityOpt -cne "no-new-privileges:true" -or
      -not $Release.security.noNewPrivileges -or [string]$Release.security.networkMode -cne "host" -or
      -not $Release.security.hostNetwork -or -not $Release.security.initEnabled -or -not $Release.security.exactTmpfs -or
      [string]$Release.security.nodeOptions -cne "--max-old-space-size=320" -or -not $Release.security.exactNodeOptions)) {
    throw "$Description observed container security state is mixed."
  }
  if (-not $Release.container.exists -and $Release.container.exactMatch) { throw "$Description missing container cannot be exact." }
}

function Assert-StateSchema {
  param($State)
  Assert-ExactPropertyNames $State @("schemaVersion", "transition", "lastTransition", "current", "previous", "pending") "Remote state"
  if ($State.schemaVersion -isnot [int] -or [int]$State.schemaVersion -ne 2) { throw "Remote state schema is invalid." }
  if ($null -ne $State.transition) {
    Assert-ExactPropertyNames $State.transition @("operation", "phase") "Remote transition"
    Assert-BoundedString $State.transition.operation "Remote transition operation" 16 '^(promote|rollback)$'
    Assert-BoundedString $State.transition.phase "Remote transition phase" 16 '^(prepared|commit-intent)$'
  }
  if ($null -ne $State.lastTransition) {
    Assert-ExactPropertyNames $State.lastTransition @("schemaVersion", "operation", "phase", "targetReleaseSha") "Remote last transition"
    if ($State.lastTransition.schemaVersion -isnot [int] -or [int]$State.lastTransition.schemaVersion -ne 1) { throw "Remote last transition schema is invalid." }
    Assert-BoundedString $State.lastTransition.operation "Remote last transition operation" 16 '^(promote|rollback)$'
    Assert-BoundedString $State.lastTransition.phase "Remote last transition phase" 16 '^(committed|compensated|finalized)$'
    Assert-BoundedString $State.lastTransition.targetReleaseSha "Remote last transition release" 40 '^[a-f0-9]{40}$'
  }
  foreach ($name in @("current", "previous", "pending")) {
    if ($null -ne $State.$name) {
      Assert-ReleaseSchema $State.$name "Remote $name release"
      if ($State.$name.secrets.exactMatch -cne $true) { throw "Remote $name release secret generation is not exact." }
    }
  }
  return $State
}

function Assert-ReleaseIdentity {
  param($Release, [string]$Description)
  Assert-ReleaseSchema $Release $Description
  if ([string]$Release.releaseSha -cnotmatch '^[a-f0-9]{40}$') { throw "$Description release SHA is invalid." }
  if ([string]$Release.imageId -cnotmatch '^sha256:[a-f0-9]{64}$') { throw "$Description image ID is invalid." }
  if ([string]$Release.secretGeneration -cnotmatch '^[a-f0-9]{64}$') { throw "$Description secret generation is invalid." }
  return $Release
}

function Assert-ExactReleaseState {
  param($State, [ValidateSet("current", "pending")][string]$Slot, [string]$ExpectedReleaseSha,
    [string]$ExpectedImageId = "", [string]$ExpectedSecretGeneration = "")
  $null = Assert-StateSchema -State $State
  if ($null -ne $State.transition) { throw "Remote state still has an unresolved transition." }
  $release = Assert-ReleaseIdentity -Release $State.$Slot -Description "Remote $Slot release"
  if ([string]$release.releaseSha -cne $ExpectedReleaseSha) { throw "Remote $Slot release SHA mismatch." }
  if ($ExpectedImageId -and [string]$release.imageId -cne $ExpectedImageId) { throw "Remote $Slot image ID mismatch." }
  if ($ExpectedSecretGeneration -and [string]$release.secretGeneration -cne $ExpectedSecretGeneration) { throw "Remote $Slot secret generation mismatch." }
  if ($release.container.exactMatch -cne $true -or $release.secrets.exactMatch -cne $true) { throw "Remote $Slot runtime is not an exact healthy match." }
  if (
    [string]$release.security.user -cne "10001:10001" -or
    $release.security.readonlyRootfs -cne $true -or
    [long]$release.security.memory -ne 536870912 -or
    [long]$release.security.nanoCpus -ne 500000000 -or
    [long]$release.security.pidsLimit -ne 128 -or
    [string]$release.security.restartPolicy -cne "unless-stopped" -or
    $release.security.dockerSocketMounted -cne $false -or
    $release.security.exactSecretGenerationMounted -cne $true
  ) { throw "Remote $Slot container security envelope mismatch." }
  return $release
}

function Get-StateIdentityJson {
  param($State)
  $null = Assert-StateSchema $State
  $identity = [ordered]@{ schemaVersion = 2; transition = $State.transition; lastTransition = $State.lastTransition }
  foreach ($slot in @("current", "previous", "pending")) {
    $value = $State.$slot
    $identity[$slot] = if ($null -eq $value) { $null } else { [ordered]@{
      schemaVersion = [int]$value.schemaVersion; releaseSha = [string]$value.releaseSha; imageTag = [string]$value.imageTag
      imageId = [string]$value.imageId; archiveSha256 = [string]$value.archiveSha256
      secretGeneration = [string]$value.secretGeneration; releaseDirectory = [string]$value.releaseDirectory
      envFile = [string]$value.envFile; projectName = [string]$value.projectName; containerName = [string]$value.containerName
    } }
  }
  return ($identity | ConvertTo-Json -Depth 5 -Compress)
}

function Resolve-AmbiguousRemoteMutation {
  param([Parameter(Mandatory)][scriptblock]$StateProvider, [Parameter(Mandatory)]$BeforeState,
    [ValidateSet("current", "pending")][string]$ExpectedSlot, [string]$ExpectedReleaseSha,
    [string]$ExpectedImageId = "", [string]$ExpectedSecretGeneration = "")
  $state = & $StateProvider
  try {
    $release = Assert-ExactReleaseState -State $state -Slot $ExpectedSlot -ExpectedReleaseSha $ExpectedReleaseSha `
      -ExpectedImageId $ExpectedImageId -ExpectedSecretGeneration $ExpectedSecretGeneration
    return [pscustomobject]@{ State = $state; Release = $release; Reconciled = $true }
  } catch {
    if ((Get-StateIdentityJson -State $state) -ceq (Get-StateIdentityJson -State $BeforeState)) {
      throw "Remote mutation did not commit; exact pre-state remains active."
    }
    throw "Remote mutation outcome is mixed or mismatched; manual inspection is required."
  }
}

function Get-ReleaseStatus {
  param([string]$RepositoryRoot, [string]$ExpectedReleaseSha, [switch]$AllowMissing)
  $output = Invoke-NativeChecked -FilePath "node" -Arguments @((Join-Path $RepositoryRoot "scripts/network-center-admin.mjs"),
    "worker-release-status", "--worker-key", $WorkerKey, "--worker-version", $ExpectedReleaseSha) -Capture
  if ($AllowMissing -and $output -ceq "null") { return $null }
  $status = ConvertFrom-BoundedJson $output "Exact worker release status"
  if ($null -eq $status) {
    if ($AllowMissing) { return $null }
    throw "Exact worker release status is missing."
  }
  Assert-ExactPropertyNames $status @("schemaVersion", "workerKey", "workerVersion", "displayName", "status", "startedAt", "heartbeatAt",
    "assignedBuildingCount", "activeAssignmentCount", "activeAssignedBuildingCount", "activeAssignmentHash", "connectionCount",
    "successfulPollCount", "failedPollCount", "pollObservedAt") "Exact worker release status"
  Assert-BoundedString $status.workerKey "Exact worker release status worker key" 64 '^[a-z0-9][a-z0-9._-]{2,63}$'
  Assert-BoundedString $status.workerVersion "Exact worker release status version" 40 '^[a-f0-9]{40}$'
  Assert-BoundedString $status.displayName "Exact worker release status display name" 128 '^.{1,128}$'
  Assert-BoundedString $status.status "Exact worker release status state" 16 '^(ONLINE|DEGRADED|PAUSED|STOPPING)$'
  Assert-BoundedString $status.startedAt "Exact worker release status startedAt" 64 '^\d{4}-'
  Assert-BoundedString $status.heartbeatAt "Exact worker release status heartbeatAt" 64 '^\d{4}-'
  Assert-BoundedString $status.activeAssignmentHash "Exact worker release status assignment hash" 64 '^[a-f0-9]{64}$'
  Assert-IntegerValue $status.assignedBuildingCount "Exact worker release status assigned building count" 0 10000
  Assert-IntegerValue $status.activeAssignmentCount "Exact worker release status active assignment count" 0 10000
  Assert-IntegerValue $status.activeAssignedBuildingCount "Exact worker release status active building count" 0 10000
  $pollValues = @($status.connectionCount, $status.successfulPollCount, $status.failedPollCount, $status.pollObservedAt)
  $nullPollValues = 0; foreach ($value in $pollValues) { if ($null -eq $value) { $nullPollValues += 1 } }
  if ($nullPollValues -notin @(0, 4)) { throw "Exact worker release status poll fields are mixed." }
  if ($null -ne $status.connectionCount) {
    Assert-IntegerValue $status.connectionCount "Exact worker release status connection count" 0 500
    Assert-IntegerValue $status.successfulPollCount "Exact worker release status successful poll count" 0 500
    Assert-IntegerValue $status.failedPollCount "Exact worker release status failed poll count" 0 500
    Assert-BoundedString $status.pollObservedAt "Exact worker release status pollObservedAt" 64 '^\d{4}-'
  }
  if ($status.schemaVersion -isnot [int] -or [int]$status.schemaVersion -ne 1 -or [string]$status.workerKey -cne $WorkerKey -or
      [string]$status.workerVersion -cne $ExpectedReleaseSha -or
      [int]$status.assignedBuildingCount -ne [int]$status.activeAssignedBuildingCount -or
      ($null -ne $status.connectionCount -and [int]$status.successfulPollCount + [int]$status.failedPollCount -ne [int]$status.connectionCount)) {
    throw "Exact worker release status count/hash identity is invalid."
  }
  return $status
}

function Convert-StatusTime {
  param($Value)
  if ($null -eq $Value) { return $null }
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Value, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) { throw "Exact worker release status timestamp is invalid." }
  return $parsed
}

function Wait-WorkerRevision {
  param([string]$RepositoryRoot, [string]$ExpectedReleaseSha, [Nullable[DateTimeOffset]]$MinimumHeartbeatAt,
    [Nullable[DateTimeOffset]]$MinimumPollObservedAt)
  for ($attempt = 0; $attempt -lt 24; $attempt += 1) {
    $status = Get-ReleaseStatus -RepositoryRoot $RepositoryRoot -ExpectedReleaseSha $ExpectedReleaseSha
    $heartbeatAt = Convert-StatusTime $status.heartbeatAt
    $pollAt = Convert-StatusTime $status.pollObservedAt
    if ([string]$status.status -ceq "PAUSED" -and [int]$status.connectionCount -ge 1 -and
        [int]$status.successfulPollCount -eq [int]$status.connectionCount -and [int]$status.failedPollCount -eq 0 -and
        ($null -eq $MinimumHeartbeatAt -or $heartbeatAt -gt $MinimumHeartbeatAt) -and
        ($null -eq $MinimumPollObservedAt -or $pollAt -gt $MinimumPollObservedAt)) { return $status }
    Start-Sleep -Seconds 5
  }
  throw "Worker heartbeat did not read back the exact reviewed release."
}

function Get-PostSwitchHeartbeatFloor {
  param([string]$RepositoryRoot, [string]$ExpectedReleaseSha)
  $status = Get-ReleaseStatus -RepositoryRoot $RepositoryRoot -ExpectedReleaseSha $ExpectedReleaseSha
  $heartbeatAt = Convert-StatusTime $status.heartbeatAt
  $pollObservedAt = Convert-StatusTime $status.pollObservedAt
  if ($null -eq $heartbeatAt -or $null -eq $pollObservedAt) {
    throw "Post-switch worker release status is missing its freshness timestamps."
  }
  $format = "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz"
  return [pscustomobject]@{
    HeartbeatAt = $heartbeatAt.ToString($format, [Globalization.CultureInfo]::InvariantCulture)
    PollObservedAt = $pollObservedAt.ToString($format, [Globalization.CultureInfo]::InvariantCulture)
  }
}

function Confirm-CompensatedReleaseReadback {
  param([string]$RepositoryRoot, [string]$ExpectedReleaseSha, $BaselineStatus)
  if ($null -eq $BaselineStatus -or [string]$BaselineStatus.activeAssignmentHash -cnotmatch '^[a-f0-9]{64}$' -or
      [int]$BaselineStatus.activeAssignmentCount -lt 0 -or
      [int]$BaselineStatus.activeAssignedBuildingCount -lt 0) {
    throw "Pre-deploy assignment baseline is invalid."
  }
  $minimumHeartbeatAt = Convert-StatusTime $BaselineStatus.heartbeatAt
  $minimumPollObservedAt = Convert-StatusTime $BaselineStatus.pollObservedAt
  if ($null -eq $minimumHeartbeatAt -or $null -eq $minimumPollObservedAt) {
    throw "Pre-deploy assignment baseline is missing its freshness timestamps."
  }
  $observed = Wait-WorkerRevision -RepositoryRoot $RepositoryRoot -ExpectedReleaseSha $ExpectedReleaseSha `
    -MinimumHeartbeatAt $minimumHeartbeatAt -MinimumPollObservedAt $minimumPollObservedAt
  $observedCount = [int]$observed.activeAssignedBuildingCount
  if ([string]$observed.activeAssignmentHash -cne [string]$BaselineStatus.activeAssignmentHash -or
      [int]$observed.activeAssignmentCount -ne [int]$BaselineStatus.activeAssignmentCount -or
      $observedCount -ne [int]$BaselineStatus.activeAssignedBuildingCount -or
      $observedCount -ne [int]$observed.assignedBuildingCount) {
    throw "Compensated release assignment count/hash does not match the pre-deploy baseline."
  }
  return $observed
}

function Assert-MutationReceipt {
  param($Receipt, [ValidateSet("stage", "promote", "compensate", "finalize")][string]$Kind, [string]$Description)
  $expected = switch ($Kind) {
    "stage" { @("schemaVersion", "releaseSha", "imageId", "secretGeneration", "canary", "emergencyStop") }
    "promote" { @("schemaVersion", "releaseSha", "imageId", "secretGeneration", "active", "finalization") }
    "compensate" { @("schemaVersion", "releaseSha", "result", "finalization") }
    "finalize" { @("schemaVersion", "releaseSha", "result", "cleanup") }
  }
  Assert-ExactPropertyNames $Receipt $expected "$Description receipt"
  if ($Receipt.schemaVersion -isnot [int] -or [int]$Receipt.schemaVersion -ne 2) { throw "$Description receipt schema is invalid." }
  Assert-BoundedString $Receipt.releaseSha "$Description receipt release SHA" 40 '^[a-f0-9]{40}$'
  if ($Kind -in @("stage", "promote")) {
    Assert-BoundedString $Receipt.imageId "$Description receipt image ID" 71 '^sha256:[a-f0-9]{64}$'
    Assert-BoundedString $Receipt.secretGeneration "$Description receipt secret generation" 64 '^[a-f0-9]{64}$'
  }
  if ($Kind -eq "stage") {
    if ([string]$Receipt.canary -cne "healthy") { throw "$Description receipt canary state is invalid." }
    Assert-BooleanValue $Receipt.emergencyStop "$Description receipt emergency stop"
  } elseif ($Kind -eq "promote") {
    if ([string]$Receipt.active -cne "healthy" -or [string]$Receipt.finalization -cne "required") { throw "$Description receipt state is invalid." }
  } elseif ($Kind -eq "compensate") {
    if ([string]$Receipt.result -cne "compensated" -or [string]$Receipt.finalization -cne "required") { throw "$Description receipt state is invalid." }
  } elseif ([string]$Receipt.result -cne "finalized" -or [string]$Receipt.cleanup -notin @("complete", "deferred")) {
    throw "$Description receipt state is invalid."
  }
  return $Receipt
}

function Assert-UnitState {
  param($State)
  Assert-ExactPropertyNames $State @("schemaVersion", "unit", "activeState", "subState", "result") "Systemd unit state"
  if ($State.schemaVersion -isnot [int] -or [int]$State.schemaVersion -ne 1) { throw "Systemd unit state schema is invalid." }
  if ([string]$State.unit -cne "network-center-worker.service") { throw "Systemd unit identity is invalid." }
  Assert-BoundedString $State.activeState "Systemd active state" 32 '^[a-z-]+$'
  Assert-BoundedString $State.subState "Systemd sub-state" 32 '^[a-z-]+$'
  Assert-BoundedString $State.result "Systemd result" 32 '^[a-z-]+$'
  if ([string]$State.activeState -cne "active" -or [string]$State.subState -notin @("running", "exited") -or
      [string]$State.result -cne "success") { throw "Systemd worker unit is not authoritatively active." }
  return $State
}

function Get-AuthoritativeUnitState {
  param([string]$SshTarget, [string[]]$SshOptions)
  $command = 'active=$(sudo -- systemctl show network-center-worker.service --property=ActiveState --value); sub=$(sudo -- systemctl show network-center-worker.service --property=SubState --value); result=$(sudo -- systemctl show network-center-worker.service --property=Result --value); jq -cn --arg active "$active" --arg sub "$sub" --arg result "$result" ''{schemaVersion:1,unit:"network-center-worker.service",activeState:$active,subState:$sub,result:$result}'''
  $output = Invoke-NativeChecked ssh ($SshOptions + @($SshTarget, $command)) -Capture
  return Assert-UnitState (ConvertFrom-BoundedJson $output "Systemd unit state")
}

function Invoke-SystemdRestartReconciled {
  param([string]$SshTarget, [string[]]$SshOptions)
  try {
    $null = Invoke-NativeChecked ssh ($SshOptions + @($SshTarget, "sudo -- systemctl restart network-center-worker.service")) -Capture
  } catch {
    if ($_.Exception.Message -notmatch 'exit code 255') { throw "Systemd restart failed without a disconnect; compensation is required." }
  }
  return Get-AuthoritativeUnitState $SshTarget $SshOptions
}

function Get-PointerIdentityJson {
  param($State)
  $null = Assert-StateSchema $State
  $value = [ordered]@{}
  foreach ($slot in @("current", "previous", "pending")) {
    $item = $State.$slot
    $value[$slot] = if ($null -eq $item) { $null } else { [ordered]@{
      schemaVersion = [int]$item.schemaVersion; releaseSha = [string]$item.releaseSha; imageTag = [string]$item.imageTag
      imageId = [string]$item.imageId; archiveSha256 = [string]$item.archiveSha256; secretGeneration = [string]$item.secretGeneration
      releaseDirectory = [string]$item.releaseDirectory; envFile = [string]$item.envFile; projectName = [string]$item.projectName
      containerName = [string]$item.containerName
    } }
  }
  return ($value | ConvertTo-Json -Depth 4 -Compress)
}

function Get-ReconciledRemoteState {
  param([string]$SshTarget, [string[]]$SshOptions)
  $output = Invoke-NativeChecked -FilePath "ssh" -Arguments ($SshOptions + @($SshTarget,
    "sudo -- /opt/ihome-network-center/bin/activate-release.sh inspect-state")) -Capture
  $state = Assert-StateSchema -State (ConvertFrom-BoundedJson -Output $output -Description "Remote state")
  if ($null -ne $state.transition) {
    $output = Invoke-NativeChecked -FilePath "ssh" -Arguments ($SshOptions + @($SshTarget,
      "sudo -- /opt/ihome-network-center/bin/activate-release.sh reconcile-state")) -Capture
    $state = Assert-StateSchema -State (ConvertFrom-BoundedJson -Output $output -Description "Remote reconciliation")
  }
  return $state
}

function Invoke-RemoteMutationReconciled {
  param([string]$Command, [string]$Description, [string]$ExpectedSlot, [string]$ExpectedReleaseSha,
    [string]$SshTarget, [string[]]$SshOptions, $BeforeState, [string]$ExpectedImageId = "",
    [string]$ExpectedSecretGeneration = "", [ValidateSet("stage", "promote", "compensate", "finalize")][string]$ReceiptKind,
    [switch]$RequireReceipt)
  $receipt = $null
  $lostReceipt = $false
  try {
    $output = Invoke-NativeChecked -FilePath "ssh" -Arguments ($SshOptions + @($SshTarget, $Command)) -Capture
    $receipt = ConvertFrom-BoundedJson -Output $output -Description $Description
    $receipt = Assert-MutationReceipt $receipt $ReceiptKind $Description
  } catch {
    if ($_.Exception.Message -match 'exit code 255') { $lostReceipt = $true; $receipt = $null }
    else { throw }
  }
  $resolved = Resolve-AmbiguousRemoteMutation -BeforeState $BeforeState -ExpectedSlot $ExpectedSlot `
    -ExpectedReleaseSha $ExpectedReleaseSha -ExpectedImageId $ExpectedImageId `
    -ExpectedSecretGeneration $ExpectedSecretGeneration `
    -StateProvider { Get-ReconciledRemoteState -SshTarget $SshTarget -SshOptions $SshOptions }
  if ($RequireReceipt -and ($lostReceipt -or $null -eq $receipt)) { throw "$Description receipt is required; lost receipt requires compensation." }
  if ($null -ne $receipt) {
    if ([string]$receipt.releaseSha -cne [string]$resolved.Release.releaseSha -or
        ($ReceiptKind -in @("stage", "promote") -and ([string]$receipt.imageId -cne [string]$resolved.Release.imageId -or
        [string]$receipt.secretGeneration -cne [string]$resolved.Release.secretGeneration))) {
      throw "$Description receipt does not match authoritative host state."
    }
  }
  return $resolved
}

function Invoke-CompensatingTransition {
  param($BeforeState, [string]$CandidateReleaseSha, [string]$SshTarget, [string[]]$SshOptions)
  $receipt = $null
  try {
    $output = Invoke-NativeChecked ssh ($SshOptions + @($SshTarget,
      "sudo -- /opt/ihome-network-center/bin/activate-release.sh compensate-last-transition $CandidateReleaseSha")) -Capture
    $receipt = Assert-MutationReceipt (ConvertFrom-BoundedJson $output "Deployment compensation") compensate "Deployment compensation"
  } catch {
    if ($_.Exception.Message -notmatch 'exit code 255') { throw }
  }
  $state = Get-ReconciledRemoteState $SshTarget $SshOptions
  if ((Get-PointerIdentityJson $state) -cne (Get-PointerIdentityJson $BeforeState)) {
    throw "Compensation did not restore every pointer field to the exact pre-state."
  }
  if ($null -eq $state.lastTransition -or [string]$state.lastTransition.phase -cne "compensated" -or
      [string]$state.lastTransition.targetReleaseSha -cne $CandidateReleaseSha) { throw "Compensation journal readback is invalid." }
  if ($null -ne $receipt -and [string]$receipt.releaseSha -cne $CandidateReleaseSha) { throw "Compensation receipt mismatches authoritative state." }
  return [pscustomobject]@{ State = $state; Receipt = $receipt }
}

function Remove-RejectedCandidate {
  param([string]$CandidateReleaseSha, $PreStageState, [string]$SshTarget, [string[]]$SshOptions)
  $state = Get-ReconciledRemoteState $SshTarget $SshOptions
  if ($null -ne $state.pending -and [string]$state.pending.releaseSha -ceq $CandidateReleaseSha) {
    try {
      $null = Invoke-NativeChecked ssh ($SshOptions + @($SshTarget,
        "sudo -- /opt/ihome-network-center/bin/activate-release.sh abort-pending $CandidateReleaseSha")) -Capture
    } catch {
      # Commit-then-disconnect is resolved by the exact state readback below.
      if ($_.Exception.Message -notmatch 'exit code 255') { throw }
    }
    $state = Get-ReconciledRemoteState $SshTarget $SshOptions
  }
  if ($null -ne $state.pending) {
    throw "Rejected candidate canary is still running against production routers."
  }
  if ((Get-PointerIdentityJson $state) -cne (Get-PointerIdentityJson $PreStageState)) {
    throw "Rejected candidate removal did not restore the exact pre-deployment pointer set."
  }
  return $state
}

function Restore-RejectedPromotion {
  param([string]$CandidateReleaseSha, $PreStageState, $PromoteBeforeState, $BaselineAssignmentStatus,
    [string]$RepositoryRoot, [string]$SshTarget, [string[]]$SshOptions)
  # The host journals the pointer set it observes AT PROMOTE TIME as `.before`,
  # and staging has already put the canary in .pending by then. Verifying
  # compensation against the pre-stage snapshot instead would differ in that one
  # slot on every single post-promote failure, reporting a false mixed state and
  # skipping finalization.
  $compensated = Invoke-CompensatingTransition -BeforeState $PromoteBeforeState -CandidateReleaseSha $CandidateReleaseSha `
    -SshTarget $SshTarget -SshOptions $SshOptions
  $null = Assert-ExactReleaseState -State $compensated.State -Slot current -ExpectedReleaseSha $PreStageState.current.releaseSha `
    -ExpectedImageId $PreStageState.current.imageId -ExpectedSecretGeneration $PreStageState.current.secretGeneration
  if ($null -eq $BaselineAssignmentStatus) { throw "Pre-deploy assignment baseline is unavailable after compensation." }
  $null = Confirm-CompensatedReleaseReadback -RepositoryRoot $RepositoryRoot `
    -ExpectedReleaseSha $PreStageState.current.releaseSha -BaselineStatus $BaselineAssignmentStatus
  $null = Invoke-FinalizeTransition $CandidateReleaseSha $SshTarget $SshOptions $compensated.State
  # Restoring `.before` restarts the rejected release's canary, which polls the
  # same production routers as the active worker. Finalization has to land first:
  # aborting earlier would leave the pointer set unequal to `.before` and the host
  # would refuse to finalize.
  return Remove-RejectedCandidate -CandidateReleaseSha $CandidateReleaseSha -PreStageState $PreStageState `
    -SshTarget $SshTarget -SshOptions $SshOptions
}

function Invoke-FinalizeTransition {
  param([string]$ReleaseSha, [string]$SshTarget, [string[]]$SshOptions, $ExpectedState)
  try {
    $output = Invoke-NativeChecked ssh ($SshOptions + @($SshTarget,
      "sudo -- /opt/ihome-network-center/bin/activate-release.sh finalize-last-transition $ReleaseSha")) -Capture
    return Assert-MutationReceipt (ConvertFrom-BoundedJson $output "Deployment finalization") finalize "Deployment finalization"
  } catch {
    if ($_.Exception.Message -notmatch 'exit code 255') { throw }
    $state = Get-ReconciledRemoteState $SshTarget $SshOptions
    if ((Get-PointerIdentityJson $state) -cne (Get-PointerIdentityJson $ExpectedState) -or
        $null -eq $state.lastTransition -or [string]$state.lastTransition.phase -cne "finalized" -or
        [string]$state.lastTransition.targetReleaseSha -cne $ReleaseSha) {
      throw "Deployment finalization disconnect could not be reconciled exactly."
    }
    return [pscustomobject]@{ Reconciled = $true; State = $state }
  }
}

function Invoke-DeploymentMain {
  Assert-DeploymentIdentity
  if ($PlanOnly) { [ordered]@{ releaseSha = $ReleaseSha; host = $HostName; stages = $Stages } | ConvertTo-Json -Compress; return }
  if (-not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) { throw "Pinned known-hosts file is required." }
  $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
  $head = (Invoke-NativeChecked git @("-C", $repositoryRoot, "rev-parse", "HEAD") -Capture).Trim()
  if ($head -cne $ReleaseSha) { throw "Release SHA must equal clean repository HEAD." }
  if ((Invoke-NativeChecked git @("-C", $repositoryRoot, "status", "--porcelain", "--untracked-files=all") -Capture).Trim()) { throw "Deployment requires a clean repository." }
  $sshTarget = "$UserName@$HostName"
  $sshOptions = @("-p", "$Port", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=$KnownHostsFile", "-o", "IdentitiesOnly=yes")
  $scpOptions = @("-P", "$Port", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=$KnownHostsFile", "-o", "IdentitiesOnly=yes")
  $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("network-center-" + [guid]::NewGuid().ToString("N"))
  [IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
  $archivePath = Join-Path $temporaryDirectory "$ReleaseSha.tar.gz"
  $remoteArchive = $null
  $mutationStarted = $false
  $beforeState = $null
  $promoteBeforeState = $null
  $beforeStatus = $null
  $beforeAssignmentStatus = $null
  try {
    $preflight = "sudo -- /bin/sh -c 'systemctl is-active --quiet docker.service && systemctl is-active --quiet wg-quick@wg0.service && systemctl is-active --quiet ihome-network-center-firewall.service && systemctl is-enabled --quiet network-center-worker.service && test `"`$(sysctl -n net.ipv4.ip_forward)`" = 1 && nft --check --file /etc/nftables.d/ihome-network-center.nft'"
    $null = Invoke-NativeChecked ssh ($sshOptions + @($sshTarget, $preflight)) -Capture
    $beforeState = Get-ReconciledRemoteState -SshTarget $sshTarget -SshOptions $sshOptions
    if ($null -ne $beforeState.current) {
      $beforeAssignmentStatus = Get-ReleaseStatus $repositoryRoot $beforeState.current.releaseSha
    }
    $beforeStatus = Get-ReleaseStatus $repositoryRoot $ReleaseSha -AllowMissing
    $priorHeartbeat = if ($null -eq $beforeStatus) { $null } else { Convert-StatusTime $beforeStatus.heartbeatAt }
    $priorPoll = if ($null -eq $beforeStatus) { $null } else { Convert-StatusTime $beforeStatus.pollObservedAt }
    & git -C $repositoryRoot archive --format=tar.gz "--output=$archivePath" $ReleaseSha -- infra/network-center-worker
    if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
    $archiveSha = (Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $remoteArchive = (Invoke-NativeChecked ssh ($sshOptions + @($sshTarget, "umask 077; mktemp --tmpdir=/tmp ihome-network-center-upload.XXXXXXXX.tar.gz")) -Capture).Trim()
    if ($remoteArchive -cnotmatch '^/tmp/ihome-network-center-upload\.[A-Za-z0-9]{8}\.tar\.gz$') { throw "Remote upload path is invalid." }
    Invoke-NativeChecked scp ($scpOptions + @($archivePath, "${sshTarget}:$remoteArchive"))
    $mutationStarted = $true
    $stage = Invoke-RemoteMutationReconciled -Command "sudo -- /opt/ihome-network-center/bin/activate-release.sh stage-candidate $ReleaseSha $remoteArchive $archiveSha" `
      -Description "Candidate staging" -ExpectedSlot pending -ExpectedReleaseSha $ReleaseSha -SshTarget $sshTarget -SshOptions $sshOptions `
      -BeforeState $beforeState -ReceiptKind stage
    # What the host will journal as the promotion's `.before`: the pre-stage set
    # plus the staged canary in .pending.
    $promoteBeforeState = $stage.State
    $null = Wait-WorkerRevision $repositoryRoot $ReleaseSha $priorHeartbeat $priorPoll
    $promote = Invoke-RemoteMutationReconciled -Command "sudo -- /opt/ihome-network-center/bin/activate-release.sh promote-pending $ReleaseSha" `
      -Description "Candidate promotion" -ExpectedSlot current -ExpectedReleaseSha $ReleaseSha `
      -ExpectedImageId $stage.Release.imageId -ExpectedSecretGeneration $stage.Release.secretGeneration `
      -SshTarget $sshTarget -SshOptions $sshOptions -BeforeState $stage.State -ReceiptKind promote -RequireReceipt
    $unitState = Invoke-SystemdRestartReconciled $sshTarget $sshOptions
    $exact = Assert-ExactReleaseState -State (Get-ReconciledRemoteState $sshTarget $sshOptions) -Slot current -ExpectedReleaseSha $ReleaseSha `
      -ExpectedImageId $promote.Release.imageId -ExpectedSecretGeneration $promote.Release.secretGeneration
    $postSwitchFloor = Get-PostSwitchHeartbeatFloor -RepositoryRoot $repositoryRoot -ExpectedReleaseSha $ReleaseSha
    $status = Wait-WorkerRevision $repositoryRoot $ReleaseSha $postSwitchFloor.HeartbeatAt $postSwitchFloor.PollObservedAt
    $assignmentCount = [int]$status.activeAssignedBuildingCount
    if ($assignmentCount -ne [int]$status.assignedBuildingCount) { throw "Assignment count does not match authoritative heartbeat." }
    if ($null -ne $beforeAssignmentStatus -and (
      [string]$status.activeAssignmentHash -cne [string]$beforeAssignmentStatus.activeAssignmentHash -or
      [int]$status.activeAssignmentCount -ne [int]$beforeAssignmentStatus.activeAssignmentCount -or
      $assignmentCount -ne [int]$beforeAssignmentStatus.activeAssignedBuildingCount
    )) { throw "Worker assignments changed during deployment." }
    $null = Invoke-FinalizeTransition $ReleaseSha $sshTarget $sshOptions $promote.State
    [ordered]@{ schemaVersion = 2; releaseSha = $ReleaseSha; archiveSha256 = $archiveSha; imageId = $exact.imageId;
      secretGeneration = $exact.secretGeneration; workerKey = $WorkerKey; assignmentCount = $assignmentCount;
      assignedBuildingCount = [int]$status.assignedBuildingCount; activeAssignmentCount = [int]$status.activeAssignmentCount;
      assignmentHash = [string]$status.activeAssignmentHash; unitState = $unitState; state = "PAUSED"; result = "activated" } | ConvertTo-Json -Depth 4 -Compress
  } catch {
    $cause = $_.Exception.Message
    if (-not $mutationStarted) { throw "Deployment failed before remote mutation. Cause: $cause" }
    try {
      $state = Get-ReconciledRemoteState $sshTarget $sshOptions
      if ($null -ne $promoteBeforeState -and $null -ne $beforeState.current -and $null -ne $state.current -and
          [string]$state.current.releaseSha -ceq $ReleaseSha) {
        $null = Restore-RejectedPromotion -CandidateReleaseSha $ReleaseSha -PreStageState $beforeState `
          -PromoteBeforeState $promoteBeforeState -BaselineAssignmentStatus $beforeAssignmentStatus `
          -RepositoryRoot $repositoryRoot -SshTarget $sshTarget -SshOptions $sshOptions
        throw "Deployment failed after promotion; exact previous state was restored. Cause: $cause"
      }
      if ($null -ne $state.pending -and [string]$state.pending.releaseSha -ceq $ReleaseSha) {
        try {
          $null = Invoke-NativeChecked ssh ($sshOptions + @($sshTarget, "sudo -- /opt/ihome-network-center/bin/activate-release.sh abort-pending $ReleaseSha")) -Capture
        } catch {
          # Commit-then-disconnect is resolved by exact state below; never retry abort blindly.
        }
        $afterAbort = Get-ReconciledRemoteState $sshTarget $sshOptions
        if ((Get-StateIdentityJson $afterAbort) -cne (Get-StateIdentityJson $beforeState)) { throw "Abort did not restore exact pre-state." }
        throw "Deployment failed before promotion; pending candidate was aborted. Cause: $cause"
      }
      if ((Get-StateIdentityJson $state) -ceq (Get-StateIdentityJson $beforeState)) { throw "Deployment failed with exact pre-state unchanged. Cause: $cause" }
      throw "Deployment failed with mixed remote state; manual inspection is required. Cause: $cause"
    } catch {
      if ($_.Exception.Message -match '^Deployment failed') { throw }
      throw "Deployment failed and exact compensation could not be verified. Cause: $cause"
    }
  } finally {
    if ($remoteArchive -and $remoteArchive -cmatch '^/tmp/ihome-network-center-upload\.[A-Za-z0-9]{8}\.tar\.gz$') {
      try { $null = Invoke-NativeChecked ssh ($sshOptions + @($sshTarget, "rm -f -- $remoteArchive")) -Capture } catch {}
    }
    if (Test-Path $temporaryDirectory) { Remove-Item $temporaryDirectory -Recurse -Force }
  }
}

if ($MyInvocation.InvocationName -ne ".") { Invoke-DeploymentMain }
