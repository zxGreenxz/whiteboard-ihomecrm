[CmdletBinding()]
param(
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
$Stages = @("capture-redacted-status-and-assignment-hash", "validate-previous-exact-image", "stop-current",
  "start-previous", "health-revision-readback", "verify-assignment-hash-unchanged", "commit-pointer-swap")

function Invoke-NativeChecked {
  param([string]$FilePath, [string[]]$Arguments, [switch]$Capture,
    [ValidateRange(1, 1048576)][int]$MaximumOutputBytes = $MaximumCapturedOutputBytes)
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

function Assert-BooleanValue { param($Value, [string]$Description); if ($Value -isnot [bool]) { throw "$Description type is invalid." } }
function Assert-IntegerValue {
  param($Value, [string]$Description, [long]$Minimum, [long]$Maximum)
  if (($Value -isnot [int] -and $Value -isnot [long]) -or [long]$Value -lt $Minimum -or [long]$Value -gt $Maximum) { throw "$Description integer is invalid." }
}

function Assert-ReleaseSchema {
  param($Release, [string]$Description)
  Assert-ExactPropertyNames $Release @("schemaVersion", "releaseSha", "imageTag", "imageId", "archiveSha256", "secretGeneration",
    "releaseDirectory", "envFile", "projectName", "containerName", "container", "secrets", "security") $Description
  if ($Release.schemaVersion -isnot [int] -or [int]$Release.schemaVersion -ne 2) { throw "$Description schema version is invalid." }
  Assert-BoundedString $Release.releaseSha "$Description release SHA" 40 '^[a-f0-9]{40}$'
  Assert-BoundedString $Release.imageTag "$Description image tag" 128 '^ihome-network-center-worker:[a-f0-9]{40}$'
  Assert-BoundedString $Release.imageId "$Description image ID" 71 '^sha256:[a-f0-9]{64}$'
  Assert-BoundedString $Release.archiveSha256 "$Description archive digest" 64 '^[a-f0-9]{64}$'
  Assert-BoundedString $Release.secretGeneration "$Description secret generation" 64 '^[a-f0-9]{64}$'
  foreach ($name in @("releaseDirectory", "envFile", "projectName", "containerName")) { Assert-BoundedString $Release.$name "$Description $name" 512 '^[^\x00-\x1f]+$' }
  Assert-ExactPropertyNames $Release.container @("exists", "status", "health", "imageId", "releaseSha", "exactMatch") "$Description container"
  Assert-BooleanValue $Release.container.exists "$Description container exists"; Assert-BooleanValue $Release.container.exactMatch "$Description container exactMatch"
  Assert-BoundedString $Release.container.status "$Description container status" 32 '^[a-z-]+$'; Assert-BoundedString $Release.container.health "$Description container health" 32 '^[a-z-]+$'
  foreach ($name in @("imageId", "releaseSha")) { if ($null -ne $Release.container.$name) { Assert-BoundedString $Release.container.$name "$Description container $name" 71 '^[a-z0-9:]+$' } }
  Assert-ExactPropertyNames $Release.secrets @("persistentAvailable", "runtimeAvailable", "exactMatch") "$Description secrets"
  foreach ($name in @("persistentAvailable", "runtimeAvailable", "exactMatch")) { Assert-BooleanValue $Release.secrets.$name "$Description secrets $name" }
  if ($Release.secrets.exactMatch -cne ($Release.secrets.persistentAvailable -and $Release.secrets.runtimeAvailable)) { throw "$Description secret exactness fields are mixed." }
  Assert-ExactPropertyNames $Release.security @("user", "readonlyRootfs", "memory", "nanoCpus", "pidsLimit", "restartPolicy", "dockerSocketMounted",
    "exactSecretGenerationMounted", "secretMountSource", "secretMountDestination", "secretMountReadOnly", "capDrop", "capDropAll", "securityOpt",
    "noNewPrivileges", "networkMode", "hostNetwork", "initEnabled", "tmpfs", "exactTmpfs", "nodeOptions", "exactNodeOptions") "$Description security"
  foreach ($name in @("readonlyRootfs", "dockerSocketMounted", "exactSecretGenerationMounted", "secretMountReadOnly", "capDropAll", "noNewPrivileges",
    "hostNetwork", "initEnabled", "exactTmpfs", "exactNodeOptions")) { Assert-BooleanValue $Release.security.$name "$Description security $name" }
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
  if ($null -eq $Release -or [string]$Release.releaseSha -cnotmatch '^[a-f0-9]{40}$' -or
      [string]$Release.imageId -cnotmatch '^sha256:[a-f0-9]{64}$' -or
      [string]$Release.secretGeneration -cnotmatch '^[a-f0-9]{64}$') { throw "$Description identity is invalid." }
  return $Release
}

function Assert-ExactReleaseState {
  param($State, [string]$ExpectedReleaseSha, [string]$ExpectedImageId, [string]$ExpectedSecretGeneration)
  $null = Assert-StateSchema $State
  if ($null -ne $State.transition) { throw "Remote state still has a transition." }
  $release = Assert-ReleaseIdentity $State.current "Remote current release"
  if ([string]$release.releaseSha -cne $ExpectedReleaseSha -or [string]$release.imageId -cne $ExpectedImageId -or
      [string]$release.secretGeneration -cne $ExpectedSecretGeneration -or $release.container.exactMatch -cne $true -or
      $release.secrets.exactMatch -cne $true -or [string]$release.security.user -cne "10001:10001" -or
      $release.security.readonlyRootfs -cne $true -or [long]$release.security.memory -ne 536870912 -or
      [long]$release.security.nanoCpus -ne 500000000 -or [long]$release.security.pidsLimit -ne 128 -or
      [string]$release.security.restartPolicy -cne "unless-stopped" -or $release.security.dockerSocketMounted -cne $false -or
      $release.security.exactSecretGenerationMounted -cne $true) { throw "Remote rollback target is not exact healthy." }
  return $release
}

function Get-StateIdentityJson {
  param($State)
  $null = Assert-StateSchema $State
  $value = [ordered]@{ schemaVersion = 2; transition = $State.transition; lastTransition = $State.lastTransition }
  foreach ($slot in @("current", "previous", "pending")) {
    $item = $State.$slot
    $value[$slot] = if ($null -eq $item) { $null } else { [ordered]@{ schemaVersion = [int]$item.schemaVersion;
      releaseSha = [string]$item.releaseSha; imageTag = [string]$item.imageTag; imageId = [string]$item.imageId;
      archiveSha256 = [string]$item.archiveSha256; secretGeneration = [string]$item.secretGeneration;
      releaseDirectory = [string]$item.releaseDirectory; envFile = [string]$item.envFile; projectName = [string]$item.projectName;
      containerName = [string]$item.containerName } }
  }
  return ($value | ConvertTo-Json -Depth 5 -Compress)
}

function Get-PointerIdentityJson {
  param($State)
  $null = Assert-StateSchema $State
  $value = [ordered]@{}
  foreach ($slot in @("current", "previous", "pending")) {
    $item = $State.$slot
    $value[$slot] = if ($null -eq $item) { $null } else { [ordered]@{ schemaVersion = [int]$item.schemaVersion;
      releaseSha = [string]$item.releaseSha; imageTag = [string]$item.imageTag; imageId = [string]$item.imageId;
      archiveSha256 = [string]$item.archiveSha256; secretGeneration = [string]$item.secretGeneration;
      releaseDirectory = [string]$item.releaseDirectory; envFile = [string]$item.envFile; projectName = [string]$item.projectName;
      containerName = [string]$item.containerName } }
  }
  return ($value | ConvertTo-Json -Depth 4 -Compress)
}

function Resolve-AmbiguousRemoteMutation {
  param([scriptblock]$StateProvider, $BeforeState, $ExpectedRelease)
  $state = & $StateProvider
  try {
    $release = Assert-ExactReleaseState $state $ExpectedRelease.releaseSha $ExpectedRelease.imageId $ExpectedRelease.secretGeneration
    return [pscustomobject]@{ State = $state; Release = $release; Reconciled = $true }
  } catch {
    if ((Get-StateIdentityJson $state) -ceq (Get-StateIdentityJson $BeforeState)) { throw "Rollback did not commit; exact pre-state remains active." }
    throw "Rollback outcome is mixed or mismatched; manual inspection is required."
  }
}

function Invoke-RollbackMutationReconciled {
  param([string]$SshTarget, [string[]]$SshOptions, $BeforeState, $ExpectedRelease)
  $receipt = $null
  try {
    $receipt = ConvertFrom-BoundedJson (Invoke-NativeChecked ssh ($SshOptions + @($SshTarget,
      "sudo -- /opt/ihome-network-center/bin/rollback-release.sh"))) "Rollback"
    Assert-ExactPropertyNames $receipt @("schemaVersion", "releaseSha", "imageId", "secretGeneration", "rollback", "finalization") "Rollback receipt"
    if ($receipt.schemaVersion -isnot [int] -or [int]$receipt.schemaVersion -ne 2 -or [string]$receipt.rollback -cne "healthy" -or
        [string]$receipt.finalization -cne "required") { throw "Rollback receipt schema is invalid." }
    Assert-BoundedString $receipt.releaseSha "Rollback receipt release SHA" 40 '^[a-f0-9]{40}$'
    Assert-BoundedString $receipt.imageId "Rollback receipt image ID" 71 '^sha256:[a-f0-9]{64}$'
    Assert-BoundedString $receipt.secretGeneration "Rollback receipt secret generation" 64 '^[a-f0-9]{64}$'
  } catch {
    if ($_.Exception.Message -match 'exit code 255') { $receipt = $null } else { throw }
  }
  $resolved = Resolve-AmbiguousRemoteMutation -BeforeState $BeforeState -ExpectedRelease $ExpectedRelease `
    -StateProvider { Get-ReconciledRemoteState $SshTarget $SshOptions }
  if ($null -ne $receipt -and ([string]$receipt.releaseSha -cne [string]$resolved.Release.releaseSha -or
      [string]$receipt.imageId -cne [string]$resolved.Release.imageId -or
      [string]$receipt.secretGeneration -cne [string]$resolved.Release.secretGeneration)) {
    throw "Rollback receipt mismatches authoritative state."
  }
  return $resolved
}

function Invoke-FinalizeTransition {
  param([string]$ReleaseSha, [string]$SshTarget, [string[]]$SshOptions, $ExpectedState)
  try {
    $receipt = ConvertFrom-BoundedJson (Invoke-NativeChecked ssh ($SshOptions + @($SshTarget,
      "sudo -- /opt/ihome-network-center/bin/activate-release.sh finalize-last-transition $ReleaseSha"))) "Rollback finalization"
    Assert-ExactPropertyNames $receipt @("schemaVersion", "releaseSha", "result", "cleanup") "Rollback finalization receipt"
    if ($receipt.schemaVersion -isnot [int] -or [int]$receipt.schemaVersion -ne 2 -or [string]$receipt.releaseSha -cne $ReleaseSha -or
        [string]$receipt.result -cne "finalized" -or [string]$receipt.cleanup -notin @("complete", "deferred")) {
      throw "Rollback finalization receipt is invalid."
    }
    return $receipt
  } catch {
    if ($_.Exception.Message -notmatch 'exit code 255') { throw }
    $state = Get-ReconciledRemoteState $SshTarget $SshOptions
    if ((Get-PointerIdentityJson $state) -cne (Get-PointerIdentityJson $ExpectedState) -or
        $null -eq $state.lastTransition -or [string]$state.lastTransition.phase -cne "finalized" -or
        [string]$state.lastTransition.targetReleaseSha -cne $ReleaseSha) {
      throw "Rollback finalization disconnect could not be reconciled exactly."
    }
    return [pscustomobject]@{ Reconciled = $true; State = $state }
  }
}

function Assert-UnitState {
  param($State)
  Assert-ExactPropertyNames $State @("schemaVersion", "unit", "activeState", "subState", "result") "Systemd unit state"
  if ($State.schemaVersion -isnot [int] -or [int]$State.schemaVersion -ne 1 -or
      [string]$State.unit -cne "network-center-worker.service") { throw "Systemd unit state schema is invalid." }
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
  return Assert-UnitState (ConvertFrom-BoundedJson (Invoke-NativeChecked ssh ($SshOptions + @($SshTarget, $command))) "Systemd unit state")
}

function Get-ReconciledRemoteState {
  param([string]$SshTarget, [string[]]$SshOptions)
  $state = Assert-StateSchema (ConvertFrom-BoundedJson (Invoke-NativeChecked ssh ($SshOptions + @($SshTarget,
    "sudo -- /opt/ihome-network-center/bin/activate-release.sh inspect-state"))) "Remote state")
  if ($null -ne $state.transition) {
    $state = Assert-StateSchema (ConvertFrom-BoundedJson (Invoke-NativeChecked ssh ($SshOptions + @($SshTarget,
      "sudo -- /opt/ihome-network-center/bin/activate-release.sh reconcile-state"))) "Remote reconciliation")
  }
  return $state
}

function Get-ReleaseStatus {
  param([string]$RepositoryRoot, [string]$ExpectedReleaseSha)
  $status = ConvertFrom-BoundedJson (Invoke-NativeChecked node @((Join-Path $RepositoryRoot "scripts/network-center-admin.mjs"),
    "worker-release-status", "--worker-key", $WorkerKey, "--worker-version", $ExpectedReleaseSha)) "Exact worker release status"
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
    throw "Exact worker release status identity/hash is invalid."
  }
  return $status
}

function Wait-WorkerRevision {
  param([string]$RepositoryRoot, [string]$ReleaseSha, [Nullable[DateTimeOffset]]$MinimumHeartbeatAt,
    [Nullable[DateTimeOffset]]$MinimumPollObservedAt)
  for ($attempt = 0; $attempt -lt 24; $attempt++) {
    $status = Get-ReleaseStatus $RepositoryRoot $ReleaseSha
    $heartbeatAt = [DateTimeOffset]::MinValue
    $pollAt = [DateTimeOffset]::MinValue
    $validTimes = [DateTimeOffset]::TryParse([string]$status.heartbeatAt, [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind, [ref]$heartbeatAt) -and
      [DateTimeOffset]::TryParse([string]$status.pollObservedAt, [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind, [ref]$pollAt)
    if ($validTimes -and [string]$status.status -ceq "PAUSED" -and [int]$status.connectionCount -ge 1 -and
        [int]$status.successfulPollCount -eq [int]$status.connectionCount -and [int]$status.failedPollCount -eq 0 -and
        ($null -eq $MinimumHeartbeatAt -or $heartbeatAt -gt $MinimumHeartbeatAt) -and
        ($null -eq $MinimumPollObservedAt -or $pollAt -gt $MinimumPollObservedAt)) { return $status }
    Start-Sleep -Seconds 5
  }
  throw "Rollback worker heartbeat did not read back exact previous revision."
}

function Convert-StatusTime {
  param($Value)
  $parsed = [DateTimeOffset]::MinValue
  if ($null -eq $Value -or -not [DateTimeOffset]::TryParse([string]$Value,
    [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
    throw "Exact worker release status timestamp is invalid."
  }
  return $parsed
}

function New-RollbackReadbackBaseline {
  param($BeforeState, $CurrentStatus, $TargetStatus)
  $current = Assert-ReleaseIdentity $BeforeState.current "Current release"
  $target = Assert-ReleaseIdentity $BeforeState.previous "Previous release"
  if ($null -eq $CurrentStatus -or [string]$CurrentStatus.workerVersion -cne [string]$current.releaseSha) {
    throw "Current release assignment baseline identity is invalid."
  }
  if ($null -eq $TargetStatus -or [string]$TargetStatus.workerVersion -cne [string]$target.releaseSha) {
    throw "Previous release freshness baseline identity is invalid."
  }
  if ([string]$CurrentStatus.activeAssignmentHash -cnotmatch '^[a-f0-9]{64}$' -or
      [int]$CurrentStatus.activeAssignmentCount -lt 0 -or
      [int]$CurrentStatus.activeAssignedBuildingCount -lt 0) {
    throw "Current release assignment baseline is invalid."
  }
  $format = "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz"
  $minimumHeartbeatAt = Convert-StatusTime $TargetStatus.heartbeatAt
  $minimumPollObservedAt = Convert-StatusTime $TargetStatus.pollObservedAt
  return [pscustomobject]@{
    AssignmentHash = [string]$CurrentStatus.activeAssignmentHash
    AssignmentRowCount = [int]$CurrentStatus.activeAssignmentCount
    AssignmentBuildingCount = [int]$CurrentStatus.activeAssignedBuildingCount
    MinimumHeartbeatAt = $minimumHeartbeatAt.ToString($format, [Globalization.CultureInfo]::InvariantCulture)
    MinimumPollObservedAt = $minimumPollObservedAt.ToString($format, [Globalization.CultureInfo]::InvariantCulture)
  }
}

function Invoke-RollbackMain {
  if ($HostName -notmatch '^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$' -or $UserName -cne "root" -or
      $WorkerKey -notmatch '^[a-z0-9][a-z0-9._-]{2,63}$') { throw "Remote identity is invalid." }
  if ($PlanOnly) { [ordered]@{ host = $HostName; stages = $Stages } | ConvertTo-Json -Compress; return }
  if (-not (Test-Path $KnownHostsFile -PathType Leaf)) { throw "Pinned known-hosts file is required." }
  $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
  $sshTarget = "$UserName@$HostName"
  $sshOptions = @("-p", "$Port", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=$KnownHostsFile", "-o", "IdentitiesOnly=yes")
  $beforeState = Get-ReconciledRemoteState $sshTarget $sshOptions
  $current = Assert-ReleaseIdentity $beforeState.current "Current release"
  $expected = Assert-ReleaseIdentity $beforeState.previous "Previous release"
  $currentStatus = Get-ReleaseStatus $repositoryRoot $current.releaseSha
  $targetStatus = Get-ReleaseStatus $repositoryRoot $expected.releaseSha
  $baseline = New-RollbackReadbackBaseline -BeforeState $beforeState -CurrentStatus $currentStatus -TargetStatus $targetStatus
  $resolved = Invoke-RollbackMutationReconciled -SshTarget $sshTarget -SshOptions $sshOptions `
    -BeforeState $beforeState -ExpectedRelease $expected
  $unitState = Get-AuthoritativeUnitState $sshTarget $sshOptions
  $observed = Wait-WorkerRevision $repositoryRoot $expected.releaseSha $baseline.MinimumHeartbeatAt $baseline.MinimumPollObservedAt
  $afterHash = [string]$observed.activeAssignmentHash
  $afterCount = [int]$observed.activeAssignedBuildingCount
  if ($baseline.AssignmentHash -cne $afterHash -or
      $baseline.AssignmentRowCount -ne [int]$observed.activeAssignmentCount -or
      $baseline.AssignmentBuildingCount -ne $afterCount -or
      $afterCount -ne [int]$observed.assignedBuildingCount) {
    throw "Rollback assignment count/hash does not match authoritative heartbeat."
  }
  $null = Invoke-FinalizeTransition $expected.releaseSha $sshTarget $sshOptions $resolved.State
  [ordered]@{ schemaVersion = 2; releaseSha = $resolved.Release.releaseSha; imageId = $resolved.Release.imageId;
    secretGeneration = $resolved.Release.secretGeneration; assignmentHash = $afterHash; assignmentCount = $afterCount;
    assignedBuildingCount = [int]$observed.assignedBuildingCount; activeAssignmentCount = [int]$observed.activeAssignmentCount;
    unitState = $unitState; state = "PAUSED"; result = "rolled-back" } | ConvertTo-Json -Depth 4 -Compress
}

if ($MyInvocation.InvocationName -ne ".") { Invoke-RollbackMain }
