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
. (Join-Path $PSScriptRoot "release-state-contract.ps1")

$Stages = @("capture-redacted-status-and-assignment-hash", "validate-previous-exact-image", "stop-current",
  "start-previous", "health-revision-readback", "verify-assignment-hash-unchanged", "commit-pointer-swap")

# -ContainerMayBeAnotherRelease is forwarded rather than assumed: this script is
# the only one that reads the `previous` slot, which after every promote names
# the container that belongs to `current` (defect 8). Every OTHER call site keeps
# the full observed-container envelope.
function Assert-ReleaseIdentity {
  param($Release, [string]$Description, [switch]$ContainerMayBeAnotherRelease)
  Assert-ReleaseSchema $Release $Description -ContainerMayBeAnotherRelease:$ContainerMayBeAnotherRelease
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
      "sudo -- /opt/ihome-network-center/bin/rollback-release.sh")) -Capture) "Rollback"
    Assert-ExactPropertyNames $receipt @("schemaVersion", "releaseSha", "imageId", "secretGeneration", "rollback", "finalization") "Rollback receipt"
    if (-not (Test-SchemaVersion $receipt.schemaVersion 2) -or [string]$receipt.rollback -cne "healthy" -or
        [string]$receipt.finalization -cne "required") { throw "Rollback receipt schema is invalid." }
    Assert-BoundedString $receipt.releaseSha "Rollback receipt release SHA" 40 '^[a-f0-9]{40}$'
    Assert-BoundedString $receipt.imageId "Rollback receipt image ID" 71 '^sha256:[a-f0-9]{64}$'
    Assert-BoundedString $receipt.secretGeneration "Rollback receipt secret generation" 64 '^[a-f0-9]{64}$'
  } catch {
    if (Test-SshDisconnect $_.Exception.Message) { $receipt = $null } else { throw }
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
      "sudo -- /opt/ihome-network-center/bin/activate-release.sh finalize-last-transition $ReleaseSha")) -Capture) "Rollback finalization"
    Assert-ExactPropertyNames $receipt @("schemaVersion", "releaseSha", "result", "cleanup") "Rollback finalization receipt"
    if (-not (Test-SchemaVersion $receipt.schemaVersion 2) -or [string]$receipt.releaseSha -cne $ReleaseSha -or
        [string]$receipt.result -cne "finalized" -or [string]$receipt.cleanup -notin @("complete", "deferred")) {
      throw "Rollback finalization receipt is invalid."
    }
    return $receipt
  } catch {
    if (-not (Test-SshDisconnect $_.Exception.Message)) { throw }
    $state = Get-ReconciledRemoteState $SshTarget $SshOptions
    if ((Get-PointerIdentityJson $state) -cne (Get-PointerIdentityJson $ExpectedState) -or
        $null -eq $state.lastTransition -or [string]$state.lastTransition.phase -cne "finalized" -or
        [string]$state.lastTransition.targetReleaseSha -cne $ReleaseSha) {
      throw "Rollback finalization disconnect could not be reconciled exactly."
    }
    return [pscustomobject]@{ Reconciled = $true; State = $state }
  }
}

function Get-ReleaseStatus {
  param([string]$RepositoryRoot, [string]$ExpectedReleaseSha)
  $status = ConvertFrom-BoundedJson (Invoke-NativeChecked node @((Join-Path $RepositoryRoot "scripts/network-center-admin.mjs"),
    "worker-release-status", "--worker-key", $WorkerKey, "--worker-version", $ExpectedReleaseSha) -Capture) "Exact worker release status"
  Assert-ExactPropertyNames $status @("schemaVersion", "workerKey", "workerVersion", "displayName", "status", "startedAt", "heartbeatAt",
    "assignedBuildingCount", "activeAssignmentCount", "activeAssignedBuildingCount", "activeAssignmentHash", "expectedConnectionCount",
    "connectionCount", "successfulPollCount", "failedPollCount", "pollObservedAt") "Exact worker release status"
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
  Assert-IntegerValue $status.expectedConnectionCount "Exact worker release status expected connection count" 0 10000
  $pollValues = @($status.connectionCount, $status.successfulPollCount, $status.failedPollCount, $status.pollObservedAt)
  $nullPollValues = 0; foreach ($value in $pollValues) { if ($null -eq $value) { $nullPollValues += 1 } }
  if ($nullPollValues -notin @(0, 4)) { throw "Exact worker release status poll fields are mixed." }
  if ($null -ne $status.connectionCount) {
    Assert-IntegerValue $status.connectionCount "Exact worker release status connection count" 0 500
    Assert-IntegerValue $status.successfulPollCount "Exact worker release status successful poll count" 0 500
    Assert-IntegerValue $status.failedPollCount "Exact worker release status failed poll count" 0 500
    Assert-BoundedString $status.pollObservedAt "Exact worker release status pollObservedAt" 64 '^\d{4}-'
  }
  if (-not (Test-SchemaVersion $status.schemaVersion 1) -or [string]$status.workerKey -cne $WorkerKey -or
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
    if ($validTimes -and [string]$status.status -ceq "PAUSED" -and (Test-ExactPollEvidence -Status $status) -and
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
  $target = Assert-ReleaseIdentity $BeforeState.previous "Previous release" -ContainerMayBeAnotherRelease
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
  if ($PlanOnly) {
    # The resolved option value is reported so the space-stripping above is
    # observable without running a rollback. Only resolvable when the file is
    # actually there; plan-only has never required it to exist.
    $plannedKnownHosts = if (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf) {
      Resolve-SshOptionPath $KnownHostsFile
    } else { $null }
    [ordered]@{ host = $HostName; stages = $Stages; knownHostsOption = $plannedKnownHosts } |
      ConvertTo-Json -Compress
    return
  }
  if (-not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) { throw "Pinned known-hosts file is required." }
  $knownHostsOption = "UserKnownHostsFile=" + (Resolve-SshOptionPath $KnownHostsFile)
  $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
  $sshTarget = "$UserName@$HostName"
  $sshOptions = @("-p", "$Port", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", $knownHostsOption, "-o", "IdentitiesOnly=yes")
  $beforeState = Get-ReconciledRemoteState $sshTarget $sshOptions
  $current = Assert-ReleaseIdentity $beforeState.current "Current release"
  $expected = Assert-ReleaseIdentity $beforeState.previous "Previous release" -ContainerMayBeAnotherRelease
  $currentStatus = Get-ReleaseStatus $repositoryRoot $current.releaseSha
  $targetStatus = Get-ReleaseStatus $repositoryRoot $expected.releaseSha
  $baseline = New-RollbackReadbackBaseline -BeforeState $beforeState -CurrentStatus $currentStatus -TargetStatus $targetStatus
  $resolved = Invoke-RollbackMutationReconciled -SshTarget $sshTarget -SshOptions $sshOptions `
    -BeforeState $beforeState -ExpectedRelease $expected
  # DEFECT 7, the rollback half. Everything below this line runs with the pointer
  # swap ALREADY committed on the host and journalled as `committed`, and
  # begin_transition refuses every later transition - including the rollback that
  # would undo this one - until that journal is terminal. Throwing straight out
  # of a failed readback therefore does not just abort this run, it strands the
  # recovery path itself, which is exactly how b6bade8's promotion blocked the
  # next deploy. The readback is still allowed to fail loudly; it just may not
  # leave the host wedged on its way out.
  try {
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
  } catch {
    $outcome = Complete-AbandonedTransition -ReleaseSha $expected.releaseSha -SshTarget $sshTarget -SshOptions $sshOptions
    throw ("Rollback switched to the previous release but its readback failed; the transition was $outcome. " +
      "Cause: $($_.Exception.Message)")
  }
  $null = Invoke-FinalizeTransition $expected.releaseSha $sshTarget $sshOptions $resolved.State
  [ordered]@{ schemaVersion = 2; releaseSha = $resolved.Release.releaseSha; imageId = $resolved.Release.imageId;
    secretGeneration = $resolved.Release.secretGeneration; assignmentHash = $afterHash; assignmentCount = $afterCount;
    assignedBuildingCount = [int]$observed.assignedBuildingCount; activeAssignmentCount = [int]$observed.activeAssignmentCount;
    expectedConnectionCount = [int]$observed.expectedConnectionCount; successfulPollCount = [int]$observed.successfulPollCount;
    unitState = $unitState; state = "PAUSED"; result = "rolled-back" } | ConvertTo-Json -Depth 4 -Compress
}

if ($MyInvocation.InvocationName -ne ".") { Invoke-RollbackMain }
