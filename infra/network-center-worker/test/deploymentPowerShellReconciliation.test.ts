import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const workerRoot = resolve(new URL("../", import.meta.url).pathname.slice(1));
const deploy = join(workerRoot, "scripts", "deploy-vultr.ps1");
const rollback = join(workerRoot, "scripts", "rollback-vultr.ps1");
const roots: string[] = [];
const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const imageA = `sha256:${"1".repeat(64)}`;
const imageB = `sha256:${"2".repeat(64)}`;
const generationA = "3".repeat(64);
const generationB = "4".repeat(64);

// These scripts have to survive BOTH PowerShell editions. Two defects found on
// the live rollout each broke exactly one of them: Windows PowerShell 5.1
// promotes native stderr to a terminating error (so a successful remote step
// killed the run), and PowerShell 7's ConvertFrom-Json yields Int64 where 5.1
// yields Int32 (so `-isnot [int]` rejected every valid receipt). Together they
// meant the deploy path ran on NEITHER edition, and neither was caught because
// the .ps1 files were only ever AST-parsed. Every case below actually executes.
//
// Windows PowerShell 5.1 is always present on win32. PowerShell 7 is used when
// `pwsh` is on PATH, or when NETWORK_CENTER_PWSH points at one. Tests that
// depend on PS7-only semantics must therefore ALSO carry an
// edition-independent arm (an explicitly typed [long] reproduces exactly what
// PS7's parser produces), so a missing pwsh degrades coverage instead of
// silently passing.
interface PowerShellEdition {
  readonly label: string;
  readonly executable: string;
}

function resolvePowerShellEditions(): PowerShellEdition[] {
  const editions: PowerShellEdition[] = [{ label: "windows-powershell-5.1", executable: "powershell.exe" }];
  const candidates = [process.env.NETWORK_CENTER_PWSH?.trim(), "pwsh.exe", "pwsh"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const executable of candidates) {
    const probe = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8", windowsHide: true,
    });
    const version = probe.status === 0 ? probe.stdout.trim() : "";
    if (/^([7-9]|\d{2,})\./.test(version)) {
      editions.push({ label: `powershell-${version}`, executable });
      break;
    }
  }
  return editions;
}

const editions = resolvePowerShellEditions();

function run(script: string, body: string, executable = "powershell.exe") {
  const root = mkdtempSync(join(tmpdir(), "network-center-pwsh-reconcile-"));
  roots.push(root);
  const harness = join(root, "harness.ps1");
  const parameters = script === deploy
    ? `-ReleaseSha '${shaB}' -HostName 'test.invalid' -KnownHostsFile 'ignored' -PlanOnly`
    : `-HostName 'test.invalid' -KnownHostsFile 'ignored' -PlanOnly`;
  writeFileSync(harness, `. '${script.replaceAll("'", "''")}' ${parameters}\n${body}\n`, "utf8");
  return spawnSync(executable, ["-NoProfile", "-NonInteractive", "-File", harness], {
    encoding: "utf8", windowsHide: true,
  });
}

// A complete worker-release-status payload as the admin CLI prints it. Overrides
// are applied verbatim so a case can drop a key, null a field, or change a
// count without the helper silently repairing it.
function releaseStatusJson(overrides: Record<string, unknown> = {}) {
  const status: Record<string, unknown> = {
    schemaVersion: 1,
    workerKey: "vultr-network-center-01",
    workerVersion: shaB,
    displayName: "Vultr Network Center",
    status: "PAUSED",
    startedAt: "2026-08-01T00:00:00Z",
    heartbeatAt: "2026-08-01T00:05:00Z",
    assignedBuildingCount: 2,
    activeAssignmentCount: 2,
    activeAssignedBuildingCount: 2,
    activeAssignmentHash: "9".repeat(64),
    expectedConnectionCount: 0,
    connectionCount: 0,
    successfulPollCount: 0,
    failedPollCount: 0,
    pollObservedAt: "2026-08-01T00:04:59Z",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete status[key];
    else status[key] = value;
  }
  return JSON.stringify(status);
}

// Drives the real Wait-WorkerRevision against one fixed status payload. Sleeping
// is stubbed out so the 24-attempt rejection path returns immediately instead of
// taking two minutes; the loop itself, the poll gate and the freshness checks
// are the production ones.
function waitWorkerRevisionBody(script: string, status: string) {
  const call = script === deploy
    ? `Wait-WorkerRevision -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaB}' -MinimumHeartbeatAt $null -MinimumPollObservedAt $null`
    : `Wait-WorkerRevision -RepositoryRoot 'repo' -ReleaseSha '${shaB}' -MinimumHeartbeatAt $null -MinimumPollObservedAt $null`;
  return `
function Start-Sleep { param([int]$Seconds) }
$script:statusCalls = 0
function Invoke-NativeChecked { $script:statusCalls++; return '${status.replaceAll("'", "''")}' }
$observed = ${call}
[ordered]@{ statusCalls = $script:statusCalls; expectedConnectionCount = $observed.expectedConnectionCount;
  successfulPollCount = $observed.successfulPollCount } | ConvertTo-Json -Compress`;
}

const stateFactory = `
function New-Release([string]$sha,[string]$image,[string]$generation,[bool]$exact=$true) {
  [pscustomobject]@{ schemaVersion=2; releaseSha=$sha; imageTag="ihome-network-center-worker:$sha"; imageId=$image;
    archiveSha256=('9' * 64); secretGeneration=$generation; releaseDirectory="/opt/ihome-network-center/releases/$sha";
    envFile="/opt/ihome-network-center/releases/$sha/.env"; projectName='ihome-network-center'; containerName='worker';
    container=[pscustomobject]@{ exists=$exact; status=$(if($exact){'running'}else{'missing'}); health=$(if($exact){'healthy'}else{'missing'});
      imageId=$(if($exact){$image}else{$null}); releaseSha=$(if($exact){$sha}else{$null}); exactMatch=$exact };
    secrets=[pscustomobject]@{ persistentAvailable=$true; runtimeAvailable=$exact; exactMatch=$exact };
    security=[pscustomobject]@{ user='10001:10001'; readonlyRootfs=$true; memory=536870912; nanoCpus=500000000;
      pidsLimit=128; restartPolicy='unless-stopped'; dockerSocketMounted=$false; exactSecretGenerationMounted=$true;
      secretMountSource="/run/ihome-network-center/secret-generations/$generation"; secretMountDestination='/run/secrets/network-center';
      secretMountReadOnly=$true; capDrop='ALL'; capDropAll=$true; securityOpt='no-new-privileges:true';
      noNewPrivileges=$true; networkMode='host'; hostNetwork=$true; initEnabled=$true;
      tmpfs='/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700'; exactTmpfs=$true;
      nodeOptions='--max-old-space-size=320'; exactNodeOptions=$true } }
}
function New-State($current,$previous,$pending,$transition=$null) {
  [pscustomobject]@{ schemaVersion=2; transition=$transition; lastTransition=$null; current=$current; previous=$previous; pending=$pending }
}
`;

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    expect(dirname(root)).toBe(tmpdir());
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PowerShell deployment reconciliation", () => {
  it("rejects a committed promote when the SSH receipt is lost so the caller can compensate", () => {
    const result = run(deploy, `${stateFactory}
$before=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
$after=New-State (New-Release '${shaB}' '${imageB}' '${generationB}') (New-Release '${shaA}' '${imageA}' '${generationA}') $null
function Invoke-NativeChecked { throw 'ssh failed with exit code 255.' }
function Get-ReconciledRemoteState { return $after }
$resolved=Invoke-RemoteMutationReconciled -Command 'promote' -Description 'Candidate promotion' -ExpectedSlot current -ExpectedReleaseSha '${shaB}' -ExpectedImageId '${imageB}' -ExpectedSecretGeneration '${generationB}' -SshTarget 'root@test' -SshOptions @() -BeforeState $before -ReceiptKind promote -RequireReceipt
$resolved | ConvertTo-Json -Depth 10 -Compress`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/receipt.*required|lost.*receipt/i);
  });

  it("rejects a malformed promote receipt even when committed state is exact", () => {
    const result = run(deploy, `${stateFactory}
$before=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
$after=New-State (New-Release '${shaB}' '${imageB}' '${generationB}') (New-Release '${shaA}' '${imageA}' '${generationA}') $null
function Invoke-NativeChecked { return 'not-json' }
function Get-ReconciledRemoteState { return $after }
$resolved=Invoke-RemoteMutationReconciled -Command 'promote' -Description 'Candidate promotion' -ExpectedSlot current -ExpectedReleaseSha '${shaB}' -SshTarget 'root@test' -SshOptions @() -BeforeState $before -ReceiptKind promote -RequireReceipt
$resolved | ConvertTo-Json -Depth 10 -Compress`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/json|receipt/i);
  });

  it("fails closed when an ambiguous promote leaves exact pre-state unchanged", () => {
    const result = run(deploy, `${stateFactory}
$before=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
Resolve-AmbiguousRemoteMutation -BeforeState $before -ExpectedSlot current -ExpectedReleaseSha '${shaB}' -StateProvider { $before }`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/exact pre-state remains active/i);
  });

  it("rejects a committed release whose container security envelope is wrong", () => {
    const result = run(deploy, `${stateFactory}
$before=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
$target=New-Release '${shaB}' '${imageB}' '${generationB}'; $target.security.readonlyRootfs=$false
$after=New-State $target (New-Release '${shaA}' '${imageA}' '${generationA}') $null
Resolve-AmbiguousRemoteMutation -BeforeState $before -ExpectedSlot current -ExpectedReleaseSha '${shaB}' -StateProvider { $after }`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/mixed|mismatched/i);
  });

  it("accepts a standalone rollback committed before disconnect", () => {
    const result = run(rollback, `${stateFactory}
$current=New-Release '${shaB}' '${imageB}' '${generationB}'
$expected=New-Release '${shaA}' '${imageA}' '${generationA}'
$before=New-State $current $expected $null
$after=New-State $expected $current $null
function Invoke-NativeChecked { throw 'ssh failed with exit code 255.' }
function Get-ReconciledRemoteState { return $after }
$resolved=Invoke-RollbackMutationReconciled -SshTarget 'root@test' -SshOptions @() -BeforeState $before -ExpectedRelease $expected
$resolved | ConvertTo-Json -Depth 10 -Compress`);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { Reconciled: boolean; Release: { releaseSha: string } };
    expect(parsed).toMatchObject({ Reconciled: true, Release: { releaseSha: shaA } });
  });

  it("rejects malformed or multiple remote receipts", () => {
    for (const script of [deploy, rollback]) {
      for (const output of ["not-json", "{}\n{}", '{"schemaVersion":2', `{"value":"${"x".repeat(65_536)}"}`]) {
        const escaped = output.replaceAll("'", "''").replaceAll("\n", "`n");
        const result = run(script, `ConvertFrom-BoundedJson -Output '${escaped}' -Description 'Injected receipt'`);
        expect(result.status).not.toBe(0);
      }
    }
  });

  it("bounds native captured output before any JSON parsing", () => {
    for (const script of [deploy, rollback]) {
      const result = run(script, `
Invoke-NativeChecked -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-Command','[Console]::Write((''x'' * 4096))') -Capture -MaximumOutputBytes 1024`);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/byte bound/i);
    }
  });

  it("rejects unknown or secret-like fields and invalid nested state types", () => {
    const cases = [
      `$state=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null; $state | Add-Member -NotePropertyName password -NotePropertyValue 'leak'; Assert-StateSchema $state`,
      `$state=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null; $state.current | Add-Member -NotePropertyName unexpected -NotePropertyValue 'x'; Assert-StateSchema $state`,
      `$state=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null; $state.current.container.exactMatch='true'; Assert-StateSchema $state`,
      `$state=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null; $state.current.secrets.runtimeAvailable=$false; Assert-StateSchema $state`,
    ];
    for (const script of [deploy, rollback]) {
      for (const body of cases) {
        const result = run(script, `${stateFactory}\n${body}`);
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toMatch(/schema|field|type|unknown|secret|mixed/i);
      }
    }
  });

  it("accepts restart disconnect only when authoritative unit readback is active", () => {
    const success = run(deploy, `
$script:calls=0
function Invoke-NativeChecked {
  $script:calls++
  if ($script:calls -eq 1) { throw 'ssh failed with exit code 255.' }
  return '{"schemaVersion":1,"unit":"network-center-worker.service","activeState":"active","subState":"exited","result":"success"}'
}
Invoke-SystemdRestartReconciled -SshTarget 'root@test' -SshOptions @() | ConvertTo-Json -Compress`);
    expect(success.status, success.stderr).toBe(0);
    expect(JSON.parse(success.stdout)).toMatchObject({ activeState: "active", subState: "exited", result: "success" });

    const ordinaryFailure = run(deploy, `
$script:calls=0
function Invoke-NativeChecked { $script:calls++; throw 'ssh failed with exit code 1.' }
Invoke-SystemdRestartReconciled -SshTarget 'root@test' -SshOptions @()`);
    expect(ordinaryFailure.status).not.toBe(0);
    expect(`${ordinaryFailure.stdout}${ordinaryFailure.stderr}`).toMatch(/restart/i);

    const inactive = run(deploy, `
$script:calls=0
function Invoke-NativeChecked {
  $script:calls++
  if ($script:calls -eq 1) { throw 'ssh failed with exit code 255.' }
  return '{"schemaVersion":1,"unit":"network-center-worker.service","activeState":"inactive","subState":"dead","result":"exit-code"}'
}
Invoke-SystemdRestartReconciled -SshTarget 'root@test' -SshOptions @()`);
    expect(inactive.status).not.toBe(0);
    expect(`${inactive.stdout}${inactive.stderr}`).toMatch(/active|unit/i);
  });

  it("requires compensation and finalize commands to restore the exact full pointer identity", () => {
    const result = run(deploy, `${stateFactory}
$previous=New-Release '${"c".repeat(40)}' 'sha256:${"7".repeat(64)}' '${"8".repeat(64)}'
$before=New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $previous $null
$hostAfterCompensate=New-State $before.current $before.previous $null
$hostAfterCompensate.lastTransition=[pscustomobject]@{ schemaVersion=1; operation='promote'; phase='compensated'; targetReleaseSha='${shaB}' }
function Invoke-NativeChecked { return '{"schemaVersion":2,"releaseSha":"${shaB}","result":"compensated","finalization":"required"}' }
function Get-ReconciledRemoteState { return $hostAfterCompensate }
$resolved=Invoke-CompensatingTransition -BeforeState $before -CandidateReleaseSha '${shaB}' -SshTarget 'root@test' -SshOptions @()
$resolved | ConvertTo-Json -Depth 10 -Compress`);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { State: { current: { releaseSha: string }; previous: { releaseSha: string }; pending: null } };
    expect(parsed.State.current.releaseSha).toBe(shaA);
    expect(parsed.State.previous.releaseSha).toBe("c".repeat(40));
    expect(parsed.State.pending).toBeNull();
    expect(readFileSync(deploy, "utf8")).toMatch(/finalize-last-transition/);
  });

  it("compensates against the promote-time baseline and stops the rejected candidate canary", () => {
    // stage-candidate leaves the canary in .pending, so the pointer set the host
    // journals as `.before` when it promotes still carries it. Comparing the
    // compensated state against the PRE-STAGE snapshot reported a false mixed
    // state on every post-promote failure; the canary also has to be aborted, or
    // the rejected release keeps polling the 15 production routers.
    const result = run(deploy, `${stateFactory}
$currentA=New-Release '${shaA}' '${imageA}' '${generationA}'
$previousC=New-Release '${"c".repeat(40)}' 'sha256:${"7".repeat(64)}' '${"8".repeat(64)}'
$canary=New-Release '${shaB}' '${imageB}' '${generationB}'
$preStage=New-State $currentA $previousC $null
$promoteBefore=New-State $currentA $previousC $canary
$hostAfterCompensate=New-State $currentA $previousC $canary
$hostAfterCompensate.lastTransition=[pscustomobject]@{ schemaVersion=1; operation='promote'; phase='compensated'; targetReleaseSha='${shaB}' }
$hostAfterAbort=New-State $currentA $previousC $null
$hostAfterAbort.lastTransition=[pscustomobject]@{ schemaVersion=1; operation='promote'; phase='finalized'; targetReleaseSha='${shaB}' }
$script:commands=@()
$script:aborted=$false
function Invoke-NativeChecked {
  param([string]$FilePath,[string[]]$Arguments,[switch]$Capture,[int]$MaximumOutputBytes)
  $command=$Arguments[$Arguments.Count-1]
  $script:commands+=$command
  if ($command -match 'compensate-last-transition') { return '{"schemaVersion":2,"releaseSha":"${shaB}","result":"compensated","finalization":"required"}' }
  if ($command -match 'finalize-last-transition') { return '{"schemaVersion":2,"releaseSha":"${shaB}","result":"finalized","cleanup":"complete"}' }
  if ($command -match 'abort-pending') { $script:aborted=$true; return '' }
  throw "Unexpected remote command: $command"
}
function Get-ReconciledRemoteState { if ($script:aborted) { return $hostAfterAbort } return $hostAfterCompensate }
function Confirm-CompensatedReleaseReadback { return [pscustomobject]@{ activeAssignedBuildingCount=3 } }
$baseline=[pscustomobject]@{ activeAssignmentHash=('5' * 64) }
$final=Restore-RejectedPromotion -CandidateReleaseSha '${shaB}' -PreStageState $preStage -PromoteBeforeState $promoteBefore -BaselineAssignmentStatus $baseline -RepositoryRoot 'repo' -SshTarget 'root@test' -SshOptions @()
[ordered]@{ pending=$final.pending; commands=$script:commands } | ConvertTo-Json -Depth 5 -Compress`);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as { pending: unknown; commands: string[] };
    expect(parsed.pending).toBeNull();
    const compensate = parsed.commands.findIndex((command) => command.includes("compensate-last-transition"));
    const finalize = parsed.commands.findIndex((command) => command.includes("finalize-last-transition"));
    const abort = parsed.commands.findIndex((command) => command.includes(`abort-pending ${shaB}`));
    expect(compensate).toBeGreaterThanOrEqual(0);
    expect(finalize).toBeGreaterThan(compensate);
    // Aborting before finalization would leave the pointer set unequal to the
    // journalled `.before` and the host would refuse to finalize.
    expect(abort).toBeGreaterThan(finalize);
  });

  it("refuses to report a restored deployment while the rejected canary is still pending", () => {
    const result = run(deploy, `${stateFactory}
$currentA=New-Release '${shaA}' '${imageA}' '${generationA}'
$canary=New-Release '${shaB}' '${imageB}' '${generationB}'
$preStage=New-State $currentA $null $null
$promoteBefore=New-State $currentA $null $canary
$hostAfterCompensate=New-State $currentA $null $canary
$hostAfterCompensate.lastTransition=[pscustomobject]@{ schemaVersion=1; operation='promote'; phase='compensated'; targetReleaseSha='${shaB}' }
function Invoke-NativeChecked {
  param([string]$FilePath,[string[]]$Arguments,[switch]$Capture,[int]$MaximumOutputBytes)
  $command=$Arguments[$Arguments.Count-1]
  if ($command -match 'compensate-last-transition') { return '{"schemaVersion":2,"releaseSha":"${shaB}","result":"compensated","finalization":"required"}' }
  if ($command -match 'finalize-last-transition') { return '{"schemaVersion":2,"releaseSha":"${shaB}","result":"finalized","cleanup":"complete"}' }
  return ''
}
function Get-ReconciledRemoteState { return $hostAfterCompensate }
function Confirm-CompensatedReleaseReadback { return [pscustomobject]@{ activeAssignedBuildingCount=3 } }
$baseline=[pscustomobject]@{ activeAssignmentHash=('5' * 64) }
Restore-RejectedPromotion -CandidateReleaseSha '${shaB}' -PreStageState $preStage -PromoteBeforeState $promoteBefore -BaselineAssignmentStatus $baseline -RepositoryRoot 'repo' -SshTarget 'root@test' -SshOptions @()`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/canary is still running|still pending/i);
  });

  it("reconciles a lost finalization receipt only from exact pointers and a finalized durable journal", () => {
    const result = run(deploy, `${stateFactory}
$expected=New-State (New-Release '${shaB}' '${imageB}' '${generationB}') (New-Release '${shaA}' '${imageA}' '${generationA}') $null
$expected.lastTransition=[pscustomobject]@{ schemaVersion=1; operation='promote'; phase='committed'; targetReleaseSha='${shaB}' }
$finalized=New-State $expected.current $expected.previous $null
$finalized.lastTransition=[pscustomobject]@{ schemaVersion=1; operation='promote'; phase='finalized'; targetReleaseSha='${shaB}' }
function Invoke-NativeChecked { throw 'ssh failed with exit code 255.' }
function Get-ReconciledRemoteState { return $finalized }
Invoke-FinalizeTransition -ReleaseSha '${shaB}' -SshTarget 'root@test' -SshOptions @() -ExpectedState $expected | ConvertTo-Json -Depth 10 -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ Reconciled: true });
  });

  it("emits versioned exact deploy and rollback evidence", () => {
    const deploySource = readFileSync(deploy, "utf8");
    const rollbackSource = readFileSync(rollback, "utf8");
    for (const field of ["schemaVersion", "imageId", "secretGeneration", "assignmentCount", "assignedBuildingCount", "activeAssignmentCount", "assignmentHash", "unitState"]) {
      expect(deploySource).toContain(field);
      expect(rollbackSource).toContain(field);
    }
    expect(rollbackSource).toContain("assignedBuildingCount");
    expect(rollbackSource).toContain("assignmentHash");
  });

  it("requires fresh restored-release telemetry and the pre-deploy assignment baseline after compensation", () => {
    const result = run(deploy, `
$baseline=[pscustomobject]@{ heartbeatAt='2026-08-01T01:00:00Z'; pollObservedAt='2026-08-01T01:00:01Z'; activeAssignmentHash='${"5".repeat(64)}'; activeAssignmentCount=5; activeAssignedBuildingCount=3 }
function Wait-WorkerRevision { [pscustomobject]@{ heartbeatAt='2026-08-01T01:00:02Z'; pollObservedAt='2026-08-01T01:00:03Z'; activeAssignmentHash='${"5".repeat(64)}'; activeAssignmentCount=5; activeAssignedBuildingCount=3; assignedBuildingCount=3 } }
Confirm-CompensatedReleaseReadback -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaA}' -BaselineStatus $baseline | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ activeAssignedBuildingCount: 3 });

    const mismatch = run(deploy, `
$baseline=[pscustomobject]@{ heartbeatAt='2026-08-01T01:00:00Z'; pollObservedAt='2026-08-01T01:00:01Z'; activeAssignmentHash='${"5".repeat(64)}'; activeAssignmentCount=5; activeAssignedBuildingCount=3 }
function Wait-WorkerRevision { [pscustomobject]@{ heartbeatAt='2026-08-01T01:00:02Z'; pollObservedAt='2026-08-01T01:00:03Z'; activeAssignmentHash='${"6".repeat(64)}'; activeAssignmentCount=5; activeAssignedBuildingCount=3; assignedBuildingCount=3 } }
Confirm-CompensatedReleaseReadback -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaA}' -BaselineStatus $baseline`);
    expect(mismatch.status).not.toBe(0);
    expect(`${mismatch.stdout}${mismatch.stderr}`).toMatch(/assignment/i);

    const rowMismatch = run(deploy, `
$baseline=[pscustomobject]@{ heartbeatAt='2026-08-01T01:00:00Z'; pollObservedAt='2026-08-01T01:00:01Z'; activeAssignmentHash='${"5".repeat(64)}'; activeAssignmentCount=5; activeAssignedBuildingCount=3 }
function Wait-WorkerRevision { [pscustomobject]@{ heartbeatAt='2026-08-01T01:00:02Z'; pollObservedAt='2026-08-01T01:00:03Z'; activeAssignmentHash='${"5".repeat(64)}'; activeAssignmentCount=4; activeAssignedBuildingCount=3; assignedBuildingCount=3 } }
Confirm-CompensatedReleaseReadback -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaA}' -BaselineStatus $baseline`);
    expect(rowMismatch.status).not.toBe(0);
    expect(`${rowMismatch.stdout}${rowMismatch.stderr}`).toMatch(/assignment/i);
  });

  it("uses current release assignments but previous release telemetry as the rollback floor", () => {
    const result = run(rollback, `${stateFactory}
$current=New-Release '${shaB}' '${imageB}' '${generationB}'
$previous=New-Release '${shaA}' '${imageA}' '${generationA}'
$state=New-State $current $previous $null
$currentStatus=[pscustomobject]@{ workerVersion='${shaB}'; activeAssignmentHash='${"7".repeat(64)}'; activeAssignmentCount=6; activeAssignedBuildingCount=4; heartbeatAt='2026-08-01T02:00:00Z'; pollObservedAt='2026-08-01T02:00:01Z' }
$targetStatus=[pscustomobject]@{ workerVersion='${shaA}'; activeAssignmentHash='${"8".repeat(64)}'; activeAssignmentCount=2; activeAssignedBuildingCount=1; heartbeatAt='2026-07-31T02:00:00Z'; pollObservedAt='2026-07-31T02:00:01Z' }
New-RollbackReadbackBaseline -BeforeState $state -CurrentStatus $currentStatus -TargetStatus $targetStatus | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      AssignmentHash: "7".repeat(64), AssignmentRowCount: 6, AssignmentBuildingCount: 4,
      MinimumHeartbeatAt: "2026-07-31T02:00:00+00:00",
      MinimumPollObservedAt: "2026-07-31T02:00:01+00:00",
    });
  });

  it("rejects release status without the active assignment row count", () => {
    const result = run(deploy, `
function Invoke-NativeChecked { return '{"schemaVersion":1,"workerKey":"vultr-network-center-01","workerVersion":"${shaB}","displayName":"worker","status":"PAUSED","startedAt":"2026-08-01T00:00:00Z","heartbeatAt":"2026-08-01T00:00:01Z","assignedBuildingCount":1,"activeAssignedBuildingCount":1,"activeAssignmentHash":"${"9".repeat(64)}","connectionCount":1,"successfulPollCount":1,"failedPollCount":0,"pollObservedAt":"2026-08-01T00:00:01Z"}' }
Get-ReleaseStatus -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaB}'`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/assignment|schema|field/i);
  });

  it("captures the final heartbeat floor only after the switch", () => {
    const result = run(deploy, `
function Get-ReleaseStatus { [pscustomobject]@{ heartbeatAt='2026-08-01T03:00:00Z'; pollObservedAt='2026-08-01T03:00:01Z' } }
Get-PostSwitchHeartbeatFloor -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaB}' | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      HeartbeatAt: "2026-08-01T03:00:00+00:00",
      PollObservedAt: "2026-08-01T03:00:01+00:00",
    });
  });

  it("offers no operator switch that waives the poll evidence", () => {
    // The green-field deadlock had an obvious "fix": a -AllowNoConnections flag.
    // It would get left on, and then a fleet where every router is unreachable
    // promotes green. The expectation is derived from the database precisely so
    // nobody has to choose, and that must stay true.
    for (const script of [deploy, rollback]) {
      const source = readFileSync(script, "utf8");
      const parameters = source.match(/^param\(([\s\S]*?)^\)/m)?.[1];
      expect(parameters).toBeTruthy();
      const switches = [...(parameters ?? "").matchAll(/\[switch\]\$(\w+)/g)].map((match) => match[1]);
      expect(switches).toEqual(["PlanOnly"]);
      // Comments deliberately DISCUSS the rejected flag, so only executable
      // lines are searched for one.
      const code = source.split(/\r?\n/u).filter((line) => !line.trimStart().startsWith("#")).join("\n");
      expect(code).not.toMatch(/AllowNoConnection|SkipPoll|IgnorePoll|WaivePoll|NoConnections/i);
      // The count the gate compares against must come from the server payload,
      // never from a literal in the script.
      expect(source).toMatch(/\$expected = \[int\]\$Status\.expectedConnectionCount/);
      expect(source).not.toMatch(/connectionCount -ge 1/);
    }
  });
});

describe.each(editions)("PowerShell deployment gate on $label", (edition) => {
  const scripts = [["deploy", deploy], ["rollback", rollback]] as const;

  for (const [label, script] of scripts) {
    it(`${label}: promotes a fleet the server says has nothing to poll`, () => {
      // The deadlock: production has zero rows in network_device_connections, so
      // a healthy worker reports connections=0. The old gate demanded
      // connectionCount >= 1, which needs a reachable router, which needs a
      // promoted worker. With the expectation derived from the database this is
      // a provable healthy state - and it is proved, not waived: the poll
      // evidence still has to be present, PAUSED, and exactly zero/zero.
      const result = run(script, waitWorkerRevisionBody(script, releaseStatusJson()), edition.executable);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        statusCalls: 1, expectedConnectionCount: 0, successfulPollCount: 0,
      });
    });

    it(`${label}: refuses a zero expectation that reports polls it was never given`, () => {
      const result = run(script, waitWorkerRevisionBody(script, releaseStatusJson({
        connectionCount: 1, successfulPollCount: 1, failedPollCount: 0,
      })), edition.executable);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/did not read back/i);
    });

    it(`${label}: refuses a zero expectation with no poll evidence at all`, () => {
      // [int]$null is 0 in PowerShell, so a release that never ran a cycle would
      // otherwise satisfy "0 expected, 0 polled" without polling anything.
      const result = run(script, waitWorkerRevisionBody(script, releaseStatusJson({
        connectionCount: null, successfulPollCount: null, failedPollCount: null, pollObservedAt: null,
      })), edition.executable);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/did not read back/i);
    });

    it(`${label}: promotes only when every provisioned connection polled cleanly`, () => {
      const result = run(script, waitWorkerRevisionBody(script, releaseStatusJson({
        expectedConnectionCount: 3, connectionCount: 3, successfulPollCount: 3, failedPollCount: 0,
      })), edition.executable);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ expectedConnectionCount: 3, successfulPollCount: 3 });
    });

    it(`${label}: still fails when the provisioned connections are failing`, () => {
      // The hole an -AllowNoConnections switch would have opened stays shut.
      const result = run(script, waitWorkerRevisionBody(script, releaseStatusJson({
        expectedConnectionCount: 3, connectionCount: 3, successfulPollCount: 0, failedPollCount: 3,
      })), edition.executable);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/did not read back/i);
    });

    it(`${label}: still fails when the worker polled fewer than it was provisioned`, () => {
      const result = run(script, waitWorkerRevisionBody(script, releaseStatusJson({
        expectedConnectionCount: 3, connectionCount: 1, successfulPollCount: 1, failedPollCount: 0,
      })), edition.executable);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/did not read back/i);
    });

    it(`${label}: still requires the paused canary state`, () => {
      const result = run(script, waitWorkerRevisionBody(script, releaseStatusJson({ status: "ONLINE" })), edition.executable);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/did not read back/i);
    });

    it(`${label}: rejects a status payload with no server expectation in it`, () => {
      // Without the server's number there is nothing to compare the claim
      // against, and the client must not invent one.
      const result = run(script, `
function Invoke-NativeChecked { return '${releaseStatusJson({ expectedConnectionCount: undefined }).replaceAll("'", "''")}' }
Get-ReleaseStatus -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaB}'`, edition.executable);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/unknown, missing, or secret-like/i);
    });

    it(`${label}: parses a real remote status receipt end to end on this edition`, () => {
      // D3 lives here: ConvertFrom-Json yields Int32 on 5.1 and Int64 on 7, so
      // the schemaVersion guard has to accept both widths. This case exercises
      // whichever the running edition actually produces.
      const result = run(script, `
function Invoke-NativeChecked { return '${releaseStatusJson({
        expectedConnectionCount: 2, connectionCount: 2, successfulPollCount: 2, failedPollCount: 0,
      }).replaceAll("'", "''")}' }
$status = Get-ReleaseStatus -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaB}'
"$($status.schemaVersion.GetType().Name)|$($status.expectedConnectionCount)"`, edition.executable);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toMatch(/^Int(32|64)\|2$/);
    });

    it(`${label}: normalises PowerShell 7 style DateTime receipt fields back to wire text`, () => {
      // Third edition split, found only by executing these scripts on 7:
      // ConvertFrom-Json there returns [datetime] for ISO-8601 strings, so the
      // guards that contract on text rejected every valid status, and
      // [string]$dateTime renders "08/01/2026 00:00:00" - which Convert-StatusTime
      // reads as a LOCAL instant, silently shifting the freshness floors by the
      // host's UTC offset. Shadowing ConvertFrom-Json reproduces exactly that
      // parser on any edition, so this case is non-vacuous on 5.1 too.
      const result = run(script, `
function ConvertFrom-Json {
  param([Parameter(ValueFromPipeline = $true)][string]$InputObject)
  [pscustomobject]@{ schemaVersion = 1; workerKey = 'vultr-network-center-01'; workerVersion = '${shaB}';
    displayName = 'Vultr Network Center'; status = 'PAUSED';
    startedAt = [datetime]::new(2026, 8, 1, 0, 0, 0, [DateTimeKind]::Utc);
    heartbeatAt = [datetime]::new(2026, 8, 1, 0, 5, 0, [DateTimeKind]::Utc);
    assignedBuildingCount = 2; activeAssignmentCount = 2; activeAssignedBuildingCount = 2;
    activeAssignmentHash = '${"9".repeat(64)}'; expectedConnectionCount = 0; connectionCount = 0;
    successfulPollCount = 0; failedPollCount = 0;
    pollObservedAt = [datetime]::new(2026, 8, 1, 0, 4, 59, [DateTimeKind]::Utc) }
}
function Invoke-NativeChecked { return '{"receipt":"ignored"}' }
$status = Get-ReleaseStatus -RepositoryRoot 'repo' -ExpectedReleaseSha '${shaB}'
$heartbeatAt = Convert-StatusTime $status.heartbeatAt
"$($status.startedAt.GetType().Name)|$($status.startedAt)|$($heartbeatAt.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture))"`, edition.executable);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      // Convert-StatusTime yields a DateTimeOffset, whose round-trip form spells
      // UTC as +00:00 rather than Z; the instant is what matters here.
      expect(result.stdout.trim()).toBe("String|2026-08-01T00:00:00.0000000Z|2026-08-01T00:05:00.0000000+00:00");
    });

    it(`${label}: accepts an Int64 schemaVersion exactly as PowerShell 7 parses one`, () => {
      // Edition-independent arm of D3: an explicit [long] is byte-for-byte what
      // PowerShell 7's ConvertFrom-Json hands these guards, so this case fails
      // against the unfixed script even on Windows PowerShell 5.1. Without it,
      // a machine with no pwsh would have "passed" while testing nothing.
      const result = run(script, `${stateFactory}
$state = New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
$state.schemaVersion = [long]2
$state.current.schemaVersion = [long]2
if ($state.schemaVersion -isnot [long]) { throw 'harness failed to produce an Int64 schema version.' }
$null = Assert-StateSchema $state
'accepted'`, edition.executable);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("accepted");
    });

    it(`${label}: treats a successful native command that writes to stderr as success`, () => {
      // D2: Windows PowerShell 5.1 promotes ANY native stderr write to a
      // terminating error under $ErrorActionPreference = "Stop", even at exit 0.
      // ssh relays the remote command's stderr, so a healthy remote step killed
      // the run. Exit status stays the authority.
      const result = run(script, `
$out = Invoke-NativeChecked -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-Command','[Console]::Error.WriteLine(''benign progress''); [Console]::Out.Write(''receipt-ok''); exit 0') -Capture
if ([string]$out -notmatch 'receipt-ok') { throw "captured output lost the receipt: $out" }
'tolerated'`, edition.executable);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("tolerated");
    });

    it(`${label}: still fails a native command that exits non-zero while writing stderr`, () => {
      const result = run(script, `
Invoke-NativeChecked -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-Command','[Console]::Error.WriteLine(''real failure''); exit 7') -Capture`, edition.executable);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/exit code 7/i);
    });
  }
});
