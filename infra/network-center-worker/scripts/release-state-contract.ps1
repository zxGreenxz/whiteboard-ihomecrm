# Shared release-state contract for the two Windows clients that drive
# /opt/ihome-network-center/bin/activate-release.sh: deploy-vultr.ps1 and
# rollback-vultr.ps1. Dot-sourced by both, so every guard below runs in the
# caller's own scope exactly as if it were written inline.
#
# WHY THIS FILE EXISTS. These functions were carried as a byte-identical copy in
# both scripts, and that copy is the direct cause of every defect in this layer
# being TWO defects:
#   D2 (5.1 promotes native stderr to a terminating error) - copied.
#   D3 (PowerShell 7 parses JSON integers as Int64) - copied.
#   Defect 8 (`previous` names the live container after every promote) - copied,
#            which is how a single readback bug took the deploy path AND the
#            operator's recovery tool out at the same time.
# The copy had also begun to DRIFT silently: rollback-vultr.ps1's
# Invoke-NativeChecked had lost the non-capture branch and the [Parameter(Mandatory)]
# guards that the deploy copy carries.
#
# WHY THE COUPLING IS ACCEPTABLE FOR A RECOVERY TOOL. The stated risk of sharing
# code with the deploy path is that a broken deploy takes the rollback down with
# it. That risk is nominal here, not real:
#   * only the code that was ALREADY byte-identical lives here, so a defect in it
#     was already present in both copies - the coupling existed, it was just
#     invisible;
#   * nothing in this file is deploy-specific: it is the release-state contract
#     plus the ssh/JSON transport. rollback-vultr.ps1 never loads
#     deploy-vultr.ps1, only this file;
#   * rollback-vultr.ps1 was never a portable single file anyway - it already
#     requires the repository (scripts/network-center-admin.mjs) and node to read
#     back worker health, so "copy one .ps1 to a rescue machine" was not a
#     property that existed to lose.
# The remaining risk - an edit made for a deploy reason breaking rollback - is
# covered by the reconciliation suite, which executes every case in this file
# against BOTH scripts.

$MaximumCapturedOutputBytes = 65536

function Resolve-SshOptionPath {
  # OpenSSH parses the VALUE of an `-o Keyword=value` argument with argv_split,
  # and UserKnownHostsFile takes a LIST of files, so a value carrying a space is
  # read as several paths. The default Windows location is
  # `C:\Users\<name with a space>\.ssh\known_hosts`, which becomes the two files
  # `C:\Users\Nguyen` and `Tam\.ssh\known_hosts`: the host-key pin is then never
  # read, and with StrictHostKeyChecking=yes every run dies at
  # "Host key verification failed" with nothing pointing at the real cause.
  #
  # MEASURED, not assumed (OpenSSH_for_Windows_9.5p2, Windows PowerShell 5.1):
  #   ssh -G -o 'UserKnownHostsFile=/x ~/y'  ->  userknownhostsfile /x C:\Users\...\y
  # The tilde in the SECOND word expanded, and tilde expansion is per file, so
  # ssh had already split one argv element into two paths. It is NOT a
  # PowerShell argument-passing bug: PowerShell delivers one argv element.
  #
  # Quoting cannot fix it from Windows PowerShell 5.1, also measured:
  #   "UserKnownHostsFile=`"$p`""   -> the quotes are stripped before ssh sees them
  #   "UserKnownHostsFile=\`"$p\`"" -> the argument is split into TWO argv entries
  # So the space has to go. The 8.3 short name is space-free by construction;
  # if the volume has 8.3 name creation disabled we refuse loudly rather than
  # hand ssh a pin it will not read.
  param([Parameter(Mandatory)][string]$Path)
  $full = (Resolve-Path -LiteralPath $Path).ProviderPath
  if ($full -notmatch '\s') { return $full }
  $short = $null
  try {
    $short = (New-Object -ComObject Scripting.FileSystemObject).GetFile($full).ShortPath
  } catch {
    throw ("Pinned known-hosts path '$full' contains a space and no 8.3 short name could be obtained: " +
      $_.Exception.Message + " Pass -KnownHostsFile a path with no spaces.")
  }
  if ([string]::IsNullOrWhiteSpace($short) -or $short -match '\s') {
    throw ("Pinned known-hosts path '$full' contains a space and 8.3 short names are unavailable on this " +
      "volume, so ssh would read it as several files and silently ignore the pin. " +
      "Pass -KnownHostsFile a path with no spaces.")
  }
  return $short
}

# D7. Invoke-NativeChecked used to discard everything the command printed the
# moment it exited non-zero, so `activate-release.sh`'s own `die` messages -
# which are specific and name the exact guard that refused - were reduced to
# "ssh failed with exit code 1." and the operator was left reconstructing the
# cause from host state. A promote once died this way and the reason could not be
# recovered at all.
#
# The captured text is redacted before it goes anywhere: an exception message
# gets printed, logged, and pasted into reports, so it must not be the thing that
# widens a credential. Shapes are matched rather than values, because the value
# is exactly what must never be written down here.
function Get-RedactedDiagnostic {
  param([string]$StdoutPath, [string]$StderrPath, [int]$MaximumCharacters = 1000)
  $text = ""
  foreach ($path in @($StdoutPath, $StderrPath)) {
    if ([string]::IsNullOrEmpty($path) -or -not (Test-Path -LiteralPath $path)) { continue }
    $chunk = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
    if ($null -ne $chunk) { $text += [string]$chunk }
  }
  if ([string]::IsNullOrEmpty($text)) { return "" }
  $text = $text -replace 'sbp_[A-Za-z0-9]{16,}', '<redacted>'
  $text = $text -replace 'sk-[A-Za-z0-9_-]{16,}', '<redacted>'
  $text = $text -replace 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', '<redacted>'
  $text = $text -replace '(?i)\b(authorization|bearer|api[-_]?key|password|passwd|secret|token)\b([=:]|\s+)\S+', '$1$2<redacted>'
  $text = $text -replace '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----', '<redacted>'
  $text = $text -replace '[\x00-\x08\x0b\x0c\x0e-\x1f]', ' '
  $text = ($text -replace '\s*\r?\n\s*', ' | ').Trim()
  $text = $text.Trim('|').Trim()
  if ($text.Length -eq 0) { return "" }
  if ($text.Length -gt $MaximumCharacters) { $text = $text.Substring(0, $MaximumCharacters) + "..." }
  return " Remote output: $text"
}

function Invoke-NativeChecked {
  param([Parameter(Mandatory)][string]$FilePath, [Parameter(Mandatory)][string[]]$Arguments, [switch]$Capture,
    [ValidateRange(1, 1048576)][int]$MaximumOutputBytes = $MaximumCapturedOutputBytes)
  # Windows PowerShell 5.1 promotes ANY native-command stderr write to a
  # terminating NativeCommandError while $ErrorActionPreference is Stop -- even
  # when the command exits 0. ssh relays the remote command's stderr, and a
  # successful `docker build` writes its entire progress log there, so the whole
  # deployment aborted on a healthy build with the first stderr line as the
  # error. Exit codes remain the authority (checked explicitly below); this only
  # stops a benign diagnostic line from being read as a failure.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
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
    $overBound = $capturedBytes -gt $MaximumOutputBytes
    if ($exitCode -ne 0) {
      # The diagnostic is attached AFTER the sentence the disconnect
      # classification matches on, and Test-SshDisconnect anchors that match at
      # the start of the message, so remote text can never be read as a status.
      $diagnostic = if ($overBound) { " Remote output exceeded the capture byte bound and was withheld." }
        else { Get-RedactedDiagnostic -StdoutPath $stdoutPath -StderrPath $stderrPath }
      throw "$FilePath failed with exit code $exitCode.$diagnostic"
    }
    if ($overBound) { throw "$FilePath output exceeds the capture byte bound." }
    $captured = (Get-Content -LiteralPath $stdoutPath -Raw) + (Get-Content -LiteralPath $stderrPath -Raw)
    return ($captured -replace '\r?\n\z', '')
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

# A dropped ssh session is the ONE remote failure these scripts treat as benign -
# it means "the command may or may not have run, go and read the authoritative
# state". Every site used to decide that with a substring test for
# "exit code 255", which was safe only while failures carried no remote text.
# Now that D7 surfaces the remote output, a remote program printing "exit code
# 255" in a diagnostic would have been misread as a dropped session and its
# mutation silently reconciled. Anchoring on this module's own message format
# removes that entirely.
function Test-SshDisconnect {
  param([string]$Message)
  return ([string]$Message -cmatch '^ssh failed with exit code 255\.')
}

# PowerShell 7's ConvertFrom-Json silently deserialises any ISO-8601-looking
# string into [datetime]; Windows PowerShell 5.1 leaves it a [string]. Every
# guard in these scripts contracts on the wire TEXT, so on 7 a valid
# {"startedAt":"2026-08-01T00:00:00Z"} was rejected outright with "startedAt
# string is invalid" - and worse, `[string]$value` on such a DateTime renders
# "08/01/2026 00:00:00", which Convert-StatusTime then parses as a LOCAL instant
# with no offset. The heartbeat and poll freshness floors would have been silently
# wrong by the host's UTC offset instead of failing loudly.
#
# Normalising back to the round-trip ("o") form makes the receipt contract
# byte-identical on both editions: a UTC value keeps its Z, an offset value keeps
# its offset, and the instant is preserved in both cases. Applied to every
# receipt rather than only to the release status, so a timestamp added to any
# future receipt cannot reintroduce the split.
function ConvertTo-InvariantReceiptText {
  param($Value, [int]$Depth = 0)
  if ($Depth -gt 8) { throw "Receipt nesting exceeds the supported depth." }
  if ($Value -is [datetime]) { return $Value.ToString("o", [Globalization.CultureInfo]::InvariantCulture) }
  if ($Value -is [datetimeoffset]) { return $Value.ToString("o", [Globalization.CultureInfo]::InvariantCulture) }
  if ($Value -is [psobject]) {
    foreach ($property in @($Value.PSObject.Properties)) {
      if ($property.MemberType -ne "NoteProperty") { continue }
      $property.Value = ConvertTo-InvariantReceiptText -Value $property.Value -Depth ($Depth + 1)
    }
  }
  return $Value
}

function ConvertFrom-BoundedJson {
  param([AllowEmptyString()][string]$Output, [string]$Description)
  if ([Text.Encoding]::UTF8.GetByteCount($Output) -gt $MaximumCapturedOutputBytes) { throw "$Description exceeds the JSON byte bound." }
  $lines = @($Output -split "`n")
  if ($lines.Count -ne 1 -or $lines[0] -notmatch '^\{.*\}$') { throw "$Description must return exactly one bounded JSON receipt." }
  try { $parsed = $lines[0] | ConvertFrom-Json } catch { throw "$Description returned invalid JSON." }
  return ConvertTo-InvariantReceiptText -Value $parsed
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

# ConvertFrom-Json materialises a JSON integer as Int32 on Windows PowerShell 5.1
# but as Int64 on PowerShell 7. A guard written as `-isnot [int]` therefore
# rejects every structurally valid receipt on 7.x -- the host returned a correct
# {"schemaVersion":2,...} and the deployment still died with "Remote state schema
# is invalid". Both widths are accepted here, exactly as Assert-IntegerValue
# already did for every other integer in these receipts.
function Test-SchemaVersion {
  param($Value, [int]$Expected)
  if ($Value -isnot [int] -and $Value -isnot [long]) { return $false }
  return ([long]$Value -eq [long]$Expected)
}

function Assert-IntegerValue {
  param($Value, [string]$Description, [long]$Minimum, [long]$Maximum)
  if (($Value -isnot [int] -and $Value -isnot [long]) -or [long]$Value -lt $Minimum -or [long]$Value -gt $Maximum) {
    throw "$Description integer is invalid."
  }
}

function Assert-ReleaseSchema {
  param($Release, [string]$Description, [switch]$ContainerMayBeAnotherRelease)
  Assert-ExactPropertyNames $Release @("schemaVersion", "releaseSha", "imageTag", "imageId", "archiveSha256",
    "secretGeneration", "releaseDirectory", "envFile", "projectName", "containerName", "container", "secrets", "security") $Description
  if (-not (Test-SchemaVersion $Release.schemaVersion 2)) { throw "$Description schema version is invalid." }
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
  # DEFECT 8. `promote_pending` rewrites the promoted candidate's pointer to the
  # FIXED names `ihome-network-center` / `ihome-network-center-worker`, which are
  # the names the outgoing release's pointer already carries. So after every
  # promote, `previous` and `current` name the SAME container, and
  # inspect_pointer_state reports the LIVE container - which belongs to
  # `current` - under the `previous` slot too. Its mounted secret generation is
  # then necessarily current's, so previous.security.exactSecretGenerationMounted
  # is necessarily false and the observed-envelope predicate below was
  # UNCONDITIONALLY TRUE for `previous` after every successful promote.
  #
  # That took out both clients at once: deploy-vultr.ps1 could not complete any
  # deployment with a non-null previous, and rollback-vultr.ps1 - which reads the
  # same state as its very first action - could not run at all. The state that
  # follows a successful deploy was precisely the state in which the recovery
  # tool stopped working.
  #
  # The `previous` pointer is a ROLLBACK TARGET DESCRIPTOR, not a claim about a
  # running container. Asserting live-container exactness against it is a
  # category error. The skip is scoped as narrowly as the evidence allows: it
  # applies only to a slot whose caller declares the container may be shared, and
  # only when the observed container demonstrably carries a DIFFERENT release's
  # identity. A `previous` slot whose container really is its own is still held
  # to the full envelope, and `current` and `pending` are untouched.
  $containerIsAnotherRelease = $ContainerMayBeAnotherRelease -and $Release.container.exists -and
    ([string]$Release.container.releaseSha -cne [string]$Release.releaseSha -or
     [string]$Release.container.imageId -cne [string]$Release.imageId)
  if ($Release.container.exists -and -not $containerIsAnotherRelease -and
      ([string]$Release.container.status -cne "running" -or [string]$Release.container.health -cne "healthy" -or
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
  if (-not (Test-SchemaVersion $State.schemaVersion 2)) { throw "Remote state schema is invalid." }
  if ($null -ne $State.transition) {
    Assert-ExactPropertyNames $State.transition @("operation", "phase") "Remote transition"
    Assert-BoundedString $State.transition.operation "Remote transition operation" 16 '^(promote|rollback)$'
    Assert-BoundedString $State.transition.phase "Remote transition phase" 16 '^(prepared|commit-intent)$'
  }
  if ($null -ne $State.lastTransition) {
    Assert-ExactPropertyNames $State.lastTransition @("schemaVersion", "operation", "phase", "targetReleaseSha") "Remote last transition"
    if (-not (Test-SchemaVersion $State.lastTransition.schemaVersion 1)) { throw "Remote last transition schema is invalid." }
    Assert-BoundedString $State.lastTransition.operation "Remote last transition operation" 16 '^(promote|rollback)$'
    Assert-BoundedString $State.lastTransition.phase "Remote last transition phase" 16 '^(committed|compensated|finalized)$'
    Assert-BoundedString $State.lastTransition.targetReleaseSha "Remote last transition release" 40 '^[a-f0-9]{40}$'
  }
  foreach ($name in @("current", "previous", "pending")) {
    if ($null -ne $State.$name) {
      # Only `previous` can legitimately point at a container that belongs to
      # another release: promote_pending gives the promoted candidate the same
      # fixed container name the outgoing release already had. `current` owns the
      # live container by definition and `pending` runs its own canary container
      # under a per-release name, so neither is granted the allowance.
      Assert-ReleaseSchema $State.$name "Remote $name release" -ContainerMayBeAnotherRelease:($name -ceq "previous")
      if ($State.$name.secrets.exactMatch -cne $true) { throw "Remote $name release secret generation is not exact." }
    }
  }
  return $State
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

# The poll expectation is DERIVED FROM THE DATABASE, never chosen by whoever
# runs the deploy or the rollback.
#
# The previous rule was `connectionCount >= 1 AND successfulPollCount =
# connectionCount AND failedPollCount = 0`. On a green-field fleet there are no
# rows in network_device_connections at all, so a perfectly healthy worker
# reports connections=0 and that rule can never be met: promoting a worker would
# require a reachable router, and onboarding a router requires a promoted
# worker. An operator switch such as -AllowNoConnections would have dissolved
# the deadlock and opened a far worse hole - it gets left on, and then a fleet
# whose routers are ALL unreachable promotes green.
#
# `expectedConnectionCount` comes from
# network_center_admin_worker_release_status_v1 (20260729143000). PostgreSQL
# counts the connections it would actually serve THIS worker under the same
# predicate as network_center_worker_list_connections_v2. The only inputs these
# scripts give that function are the worker key and the release SHA, both
# already pinned, so the client cannot widen, narrow or invent the number it is
# measured against.
#
#   expected = 0 -> exactly zero successful and zero failed polls. "Nothing to
#                   poll" becomes a PROVABLE healthy state instead of a waived
#                   one; every other liveness signal (PAUSED, exact release SHA,
#                   assignment count/hash, heartbeat and poll freshness) still
#                   has to hold.
#   expected > 0 -> successfulPollCount must equal the expectation and there
#                   must be no failures, so a fleet whose connections all fail
#                   still fails the gate.
function Test-ExactPollEvidence {
  param($Status)
  if ($null -eq $Status) { return $false }
  # Poll evidence has to be PRESENT. Get-ReleaseStatus already refuses a mixed
  # set, so one null here means the release has never reported a cycle at all.
  # PowerShell coerces `[int]$null` to 0, so an unguarded numeric comparison
  # would read "never polled" as "polled nothing successfully" and promote a
  # worker that never ran a cycle - the exact hole the flag would have opened.
  if ($null -eq $Status.connectionCount -or $null -eq $Status.successfulPollCount -or
      $null -eq $Status.failedPollCount -or $null -eq $Status.pollObservedAt) { return $false }
  if ([int]$Status.failedPollCount -ne 0) { return $false }
  $expected = [int]$Status.expectedConnectionCount
  if ($expected -eq 0) {
    return ([int]$Status.connectionCount -eq 0 -and [int]$Status.successfulPollCount -eq 0)
  }
  return ([int]$Status.connectionCount -eq $expected -and [int]$Status.successfulPollCount -eq $expected)
}

function Assert-UnitState {
  param($State)
  Assert-ExactPropertyNames $State @("schemaVersion", "unit", "activeState", "subState", "result") "Systemd unit state"
  if (-not (Test-SchemaVersion $State.schemaVersion 1)) { throw "Systemd unit state schema is invalid." }
  if ([string]$State.unit -cne "network-center-worker.service") { throw "Systemd unit identity is invalid." }
  Assert-BoundedString $State.activeState "Systemd active state" 32 '^[a-z-]+$'
  Assert-BoundedString $State.subState "Systemd sub-state" 32 '^[a-z-]+$'
  Assert-BoundedString $State.result "Systemd result" 32 '^[a-z-]+$'
  if ([string]$State.activeState -cne "active" -or [string]$State.subState -notin @("running", "exited") -or
      [string]$State.result -cne "success") { throw "Systemd worker unit is not authoritatively active." }
  return $State
}

# THE TRIGGER BEHIND DEFECT 7, and it had never worked once from Windows.
#
# Windows PowerShell 5.1 STRIPS embedded double quotes when it hands a string to
# a native command. MEASURED on this machine, OpenSSH_for_Windows_9.5p2:
#   $cmd = 'printf %s ''{schemaVersion:1,unit:"network-center-worker.service"}'''
#   & ssh <opts> root@host $cmd
#   PowerShell holds : {schemaVersion:1,unit:"network-center-worker.service"}
#   the host receives: {schemaVersion:1,unit:network-center-worker.service}
# Single quotes survive; double quotes do not.
#
# This readback used to build its receipt with a remote `jq -cn '{... unit:
# "network-center-worker.service" ...}'` program. With the quotes eaten, jq read
# network-center-worker.service as the three undefined identifiers network/0,
# center/0 and worker/0, and jq exits 3 on a compile error - so ssh exited 3 and
# the client threw a bare "ssh failed with exit code 3." on EVERY invocation.
# That is what killed b6bade8's promotion on 2026-08-02 one step before
# finalization, and the green-field hole in the deploy client's catch then left
# the transition journal at `committed`, which blocked every later promote AND
# the rollback path until a human finalized it by hand. It stayed unexplained for
# a day because Invoke-NativeChecked discarded the remote output (D7); the very
# first live run with D7 fixed printed the three jq compile errors verbatim.
#
# The remote command is now built with NO quote characters at all rather than
# with escaped ones: the escaping that survives 5.1 is not the escaping that
# survives 7, so "quote it correctly" is not a fix that holds on both editions.
# systemctl's own Property=Value output needs no quoting, and it stays legible in
# the host's sudo audit log - which is the evidence trail this defect was finally
# reconstructed from.
function Get-WorkerUnitStateCommand {
  param([string]$Unit = "network-center-worker.service")
  return "sudo -- systemctl show $Unit --property=ActiveState --property=SubState --property=Result"
}

function ConvertFrom-SystemdShowText {
  param([AllowEmptyString()][string]$Output, [string]$Unit)
  if ([Text.Encoding]::UTF8.GetByteCount($Output) -gt $MaximumCapturedOutputBytes) { throw "Systemd unit state exceeds the byte bound." }
  $lines = @(@($Output -split '\r?\n') | Where-Object { $_ -cne "" })
  if ($lines.Count -ne 3) { throw "Systemd unit state must return exactly three properties." }
  $values = [ordered]@{}
  foreach ($line in $lines) {
    if ($line -cnotmatch '^(ActiveState|SubState|Result)=([A-Za-z0-9-]*)$') { throw "Systemd unit state property is invalid." }
    if ($values.Contains($Matches[1])) { throw "Systemd unit state repeats a property." }
    $values[$Matches[1]] = $Matches[2]
  }
  foreach ($name in @("ActiveState", "SubState", "Result")) {
    if (-not $values.Contains($name)) { throw "Systemd unit state is missing $name." }
  }
  return [pscustomobject]@{ schemaVersion = 1; unit = $Unit; activeState = [string]$values["ActiveState"]
    subState = [string]$values["SubState"]; result = [string]$values["Result"] }
}

function Get-AuthoritativeUnitState {
  param([string]$SshTarget, [string[]]$SshOptions)
  $unit = "network-center-worker.service"
  $output = Invoke-NativeChecked ssh ($SshOptions + @($SshTarget, (Get-WorkerUnitStateCommand -Unit $unit))) -Capture
  return Assert-UnitState (ConvertFrom-SystemdShowText -Output $output -Unit $unit)
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

# DEFECT 7. The host journals every promote and every rollback, and
# begin_transition REFUSES to start a new one - including a rollback - while the
# last journal is still `committed`. A client that observes a committed mutation
# and then walks away without driving that journal to a terminal phase therefore
# does not merely fail its own run: it strands every later deploy AND the
# recovery path, permanently, until a human runs finalize by hand. That is
# exactly what happened to b6bade8's promotion, and it blocked the next promote
# until it was finalized manually.
#
# This is deliberately NOT a rubber stamp. finalize-last-transition is guarded on
# the host: it re-validates the journal, requires the live pointer set to equal
# the journal's `.after`, and requires pointer_exact_healthy on the current
# pointer. If the switch is genuinely broken the host refuses and the journal
# stays `committed` - and the caller reports that too, instead of losing it.
# It never throws, so the ORIGINAL failure cause is never replaced by a second
# one raised while cleaning up after it.
function Complete-AbandonedTransition {
  param([string]$ReleaseSha, [string]$SshTarget, [string[]]$SshOptions)
  try {
    $output = Invoke-NativeChecked -FilePath "ssh" -Arguments ($SshOptions + @($SshTarget,
      "sudo -- /opt/ihome-network-center/bin/activate-release.sh finalize-last-transition $ReleaseSha")) -Capture
    $receipt = ConvertFrom-BoundedJson -Output $output -Description "Abandoned transition finalization"
    if ([string]$receipt.releaseSha -cne $ReleaseSha -or [string]$receipt.result -cne "finalized") {
      return "left unfinalized (the host did not confirm finalization)"
    }
    return "finalized"
  } catch {
    return "left unfinalized ($($_.Exception.Message))"
  }
}
