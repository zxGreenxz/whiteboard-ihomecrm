import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// `.pathname.slice(1)` hỏng ở CẢ HAI nền tảng, không chỉ Windows: `.pathname` giữ
// nguyên percent-encoding (đường dẫn có dấu cách thành `%20`), còn `.slice(1)` cắt
// mất dấu `/` đầu — mẹo đó chỉ đúng cho dạng `/C:/...` của Windows, trên Linux nó
// biến đường dẫn tuyệt đối thành tương đối. Dòng này chạy ở TOP-LEVEL nên khi ném
// lỗi thì cả file không load được và vitest báo "0 test" — suite biến mất mà không
// có gì đỏ. fileURLToPath xử lý đúng cả hai việc.
const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const deploy = join(workerRoot, "scripts", "deploy-vultr.ps1");
const rollback = join(workerRoot, "scripts", "rollback-vultr.ps1");
const contract = join(workerRoot, "scripts", "release-state-contract.ps1");
const roots: string[] = [];

// The release-state contract used to be a byte-identical copy inside BOTH
// clients, which is why every defect in it (D2, D3 and defect 8) was two
// defects. It now lives in one dot-sourced file. Source-level assertions have to
// follow it there, but they must not become satisfiable by a file the script
// never loads - so reading the effective source also PROVES the dot-source line
// is present in the script itself.
function effectiveSource(script: string): string {
  const source = readFileSync(script, "utf8");
  expect(source, `${script} must dot-source release-state-contract.ps1`).toMatch(
    /^\. \(Join-Path \$PSScriptRoot "release-state-contract\.ps1"\)$/m,
  );
  return `${source}\n${readFileSync(contract, "utf8")}`;
}
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

/**
 * Hàm cuối cùng mà mỗi script định nghĩa — dùng làm bằng chứng "đã nạp TRỌN VẸN".
 *
 * Chọn hàm cuối chứ không phải hàm bất kỳ là có chủ đích: nếu dot-source dừng
 * giữa chừng, một hàm ở đầu file vẫn tồn tại và chốt chặn sẽ nói dối là đã nạp xong.
 */
const SENTINEL: ReadonlyArray<readonly [string, string]> = [
  ["deploy-vultr.ps1", "Invoke-DeploymentMain"],
  ["rollback-vultr.ps1", "Invoke-RollbackMain"],
];

export function sentinelCuaScript(script: string): string {
  const hit = SENTINEL.find(([ten]) => script.replaceAll("\\", "/").endsWith(`/${ten}`));
  if (!hit) {
    // Không đoán bừa: script mới mà quên khai ở đây thì phải nổ ngay, chứ không
    // được im lặng dùng sentinel của script khác — đó đúng là lỗi vừa sửa.
    throw new Error(
      `Chưa khai sentinel cho '${script}'. Thêm vào SENTINEL: [tên file, hàm CUỐI CÙNG script đó định nghĩa].`,
    );
  }
  return hit[1];
}

function run(script: string, body: string, executable = "powershell.exe") {
  const sentinel = sentinelCuaScript(script);
  const root = mkdtempSync(join(tmpdir(), "network-center-pwsh-reconcile-"));
  roots.push(root);
  const harness = join(root, "harness.ps1");
  const parameters = script === deploy
    ? `-ReleaseSha '${shaB}' -HostName 'test.invalid' -KnownHostsFile 'ignored' -PlanOnly`
    : `-HostName 'test.invalid' -KnownHostsFile 'ignored' -PlanOnly`;
  // `$ErrorActionPreference='Stop'` + kiểm tra sau khi dot-source: nếu không có,
  // harness này có thể IM LẶNG KHÔNG KIỂM GÌ. Đã đo được điều đó: trên máy có
  // execution policy mặc định, dot-source bị từ chối ("not digitally signed"),
  // các hàm của script deploy không bao giờ được nạp — nhưng harness vẫn thoát 0.
  // Mọi ca đòi THẤT BẠI thì đỏ (đúng như đang thấy), còn mọi ca đòi THÀNH CÔNG
  // sẽ xanh mà chẳng kiểm gì cả. Một harness không phân biệt được "script chạy và
  // trả 0" với "script không nạp được" thì không dùng để kết luận gì được.
  writeFileSync(
    harness,
    `$ErrorActionPreference='Stop'\n` +
      `. '${script.replaceAll("'", "''")}' ${parameters}\n` +
      // Chốt chặn: hàm ĐẶC TRƯNG CHO CHÍNH script đang dot-source. Không có nó
      // nghĩa là dot-source hỏng, và phải nổ thành mã thoát riêng chứ không đi tiếp.
      //
      // Trước 11/08/2026 chỗ này ghi cứng `Invoke-RemoteMutationReconciled` cho CẢ
      // hai script. Hàm đó chỉ có trong deploy-vultr.ps1; rollback-vultr.ps1 định
      // nghĩa `Invoke-RollbackMutationReconciled`. Nên mọi ca dot-source rollback
      // đều nổ chốt chặn dù dot-source hoàn toàn thành công — 29 ca ĐỎ GIẢ.
      //
      // Đáng nói hơn: khoảng trống `deployment-assets-windows-only` đã ghi nguyên
      // nhân là "29/76 test cần ngữ nghĩa PowerShell 7". Đo lại 11/08 thì sai:
      // dot-source rollback dưới PowerShell 5.1 chạy tốt, chỉ là chốt chặn hỏi sai
      // tên hàm. Một chẩn đoán ghi vào sổ mà không ai đo lại sẽ sống lâu hơn sự thật.
      `if (-not (Get-Command ${sentinel} -ErrorAction SilentlyContinue)) {\n` +
      `  Write-Error 'HARNESS: dot-source that bai — khong nap duoc script deploy'\n` +
      `  exit 97\n` +
      `}\n` +
      `${body}\n`,
    "utf8",
  );
  // -ExecutionPolicy Bypass: script trong repo không được ký, nên trên máy dùng
  // policy mặc định (RemoteSigned/AllSigned) PowerShell từ chối nạp. Runner CI
  // Linux không bao giờ gặp — đây đúng loại lệch môi trường làm test chết âm thầm.
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
    { encoding: "utf8", windowsHide: true },
  );
  // Khi executable không tồn tại (Linux không có powershell.exe), spawnSync trả
  // `error` và `status = null`. Rất nhiều ca ở dưới khẳng định
  // `expect(result.status).not.toBe(0)` — và `null !== 0` là ĐÚNG, nên chúng XANH
  // mà chưa hề chạy PowerShell lần nào. Đó là kiểu tệ nhất: không phải test đỏ oan,
  // mà là test báo xanh trong khi không kiểm gì. Phải nổ rõ ràng thay vì để lọt.
  if (result.error) {
    throw new Error(
      `Khong chay duoc '${executable}': ${result.error.message}\n` +
        `Suite nay can PowerShell. Bo qua se khien moi assertion "status khac 0" xanh gia.`,
    );
  }
  if (result.status === 97) {
    throw new Error(
      `Harness khong nap duoc ${script}. Test se vo nghia neu bo qua.\n${result.stderr}`,
    );
  }
  return result;
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
  return "ActiveState=active\`nSubState=exited\`nResult=success"
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
  return "ActiveState=inactive\`nSubState=dead\`nResult=exit-code"
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
      const code = effectiveSource(script).split(/\r?\n/u).filter((line) => !line.trimStart().startsWith("#")).join("\n");
      expect(code).not.toMatch(/AllowNoConnection|SkipPoll|IgnorePoll|WaivePoll|NoConnections/i);
      // The count the gate compares against must come from the server payload,
      // never from a literal in the script. Read from the EFFECTIVE source (the
      // script plus the contract it dot-sources) so moving the gate into the
      // shared file cannot satisfy this by relocation, and so a script that
      // stopped loading the contract fails the assertion in effectiveSource.
      expect(effectiveSource(script)).toMatch(/\$expected = \[int\]\$Status\.expectedConnectionCount/);
      expect(effectiveSource(script)).not.toMatch(/connectionCount -ge 1/);
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

// ---------------------------------------------------------------------------
// Defects 7 and 8, and the D7 diagnosability gap. All three were unreachable
// until 2026-08-03, because they need a host whose `previous` slot is non-null -
// and f678e5e's promotion over b6bade8 was the FIRST promote in this project's
// history with a previous release. Every fixture that decides these cases is
// therefore built from the host's OWN receipt rather than from a hand-written
// shape that might not be the shape production produces.
// ---------------------------------------------------------------------------

// CAPTURED, not hand-written. `sudo -- activate-release.sh inspect-state` on
// 139.180.130.31 on 2026-08-03 with f678e5e promoted over b6bade8, stored
// verbatim in test/support/live-inspect-state-post-promote.json. The two facts
// that matter are both in it: previous.releaseSha is b6bade8 while
// previous.container.releaseSha is f678e5e (promote_pending gives the promoted
// release the SAME fixed container name the outgoing release already had), and
// previous.security.exactSecretGenerationMounted is therefore false.
const liveState = JSON.parse(
  readFileSync(join(workerRoot, "test", "support", "live-inspect-state-post-promote.json"), "utf8"),
) as { current: { releaseSha: string }; previous: { releaseSha: string; container: { releaseSha: string } } };
const liveReceipt = JSON.stringify(liveState);
const liveCurrentSha = liveState.current.releaseSha;
const livePreviousSha = liveState.previous.releaseSha;
const scriptName = (script: string) => (script === deploy ? "deploy" : "rollback");

describe("post-promote previous slot, abandoned transitions and remote diagnostics", () => {
  it("captured fixture really is a post-promote receipt with a foreign container under previous", () => {
    // Guards the fixture itself: if it were ever regenerated from a host with a
    // null previous, every defect-8 case below would pass vacuously.
    expect(livePreviousSha).not.toBe(liveCurrentSha);
    expect(liveState.previous.container.releaseSha).toBe(liveCurrentSha);
  });

  for (const script of [deploy, rollback]) {
    const label = scriptName(script);

    it(`${label}: accepts the host's real post-promote receipt where previous names the live container`, () => {
      const result = run(script, `
$state = ConvertFrom-BoundedJson -Output '${liveReceipt}' -Description 'Remote state'
$null = Assert-StateSchema $state
"$([string]$state.current.releaseSha)|$([string]$state.previous.releaseSha)|$([string]$state.previous.container.releaseSha)|$($state.previous.security.exactSecretGenerationMounted)"`);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe(`${liveCurrentSha}|${livePreviousSha}|${liveCurrentSha}|False`);
    });

    it(`${label}: still refuses a previous slot whose container really is its own and is mixed`, () => {
      // The skip is scoped to a container that demonstrably belongs to ANOTHER
      // release. A `previous` pointer whose live container carries its own
      // identity is still held to the whole observed envelope, so the fix
      // cannot be read as "previous is never checked".
      const result = run(script, `
$state = ConvertFrom-BoundedJson -Output '${liveReceipt}' -Description 'Remote state'
$state.previous.container.releaseSha = $state.previous.releaseSha
$state.previous.container.imageId = $state.previous.imageId
$state.previous.security.exactSecretGenerationMounted = $true
$state.previous.security.secretMountReadOnly = $true
$state.previous.security.readonlyRootfs = $false
$null = Assert-StateSchema $state`);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/previous release observed container security state is mixed/i);
    });

    it(`${label}: still refuses a current slot whose observed container security is mixed`, () => {
      const result = run(script, `
$state = ConvertFrom-BoundedJson -Output '${liveReceipt}' -Description 'Remote state'
$state.current.container.exactMatch = $false
$state.current.security.readonlyRootfs = $false
$null = Assert-StateSchema $state`);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/current release observed container security state is mixed/i);
    });

    it(`${label}: surfaces the remote command's own output when it exits non-zero`, () => {
      // D7. The captured stdout/stderr used to be dropped in the `finally`, so
      // the host's own `die` text - which names the exact guard that refused -
      // was reduced to "ssh failed with exit code N." and a real promote failure
      // could not be diagnosed from the client at all.
      const result = run(script, `
Invoke-NativeChecked -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-Command','[Console]::Error.WriteLine(''network-center activation: the prior deployment transition requires explicit finalization''); exit 1') -Capture`);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/exit code 1/);
      expect(output).toMatch(/the prior deployment transition requires explicit finalization/);
    });

    it(`${label}: redacts credential shapes out of the surfaced remote output`, () => {
      const result = run(script, `
Invoke-NativeChecked -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-Command','[Console]::Error.WriteLine(''request failed authorization: Bearer sbp_0123456789abcdef0123456789abcdef''); exit 1') -Capture`);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain("sbp_0123456789abcdef0123456789abcdef");
      expect(output).toMatch(/redacted/);
    });

    it(`${label}: classifies a dropped ssh session by message shape, not by a substring of remote output`, () => {
      // Surfacing remote output made the old `-match 'exit code 255'` test
      // unsafe: a remote program printing that string would have had its
      // mutation silently reconciled as a dropped session.
      const result = run(script, `
"$(Test-SshDisconnect 'ssh failed with exit code 255.')|$(Test-SshDisconnect 'ssh failed with exit code 1. Remote output: container exited, exit code 255')|$(Test-SshDisconnect 'node failed with exit code 255.')"`);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("True|False|False");
    });
  }

  it("deploy: a remote failure quoting exit code 255 is not reconciled as a systemd disconnect", () => {
    const result = run(deploy, `
function Invoke-NativeChecked { throw 'ssh failed with exit code 1. Remote output: docker reported exit code 255' }
function Get-AuthoritativeUnitState { throw 'the disconnect path must not be reached' }
Invoke-SystemdRestartReconciled -SshTarget 'root@test' -SshOptions @()`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Systemd restart failed without a disconnect/);
  });

  it("deploy: finalizes a committed promotion that has no previous release to compensate to", () => {
    // DEFECT 7 exactly as it happened. b6bade8's promote committed, a later step
    // failed, and because `beforeState.current` was null on the green-field host
    // the catch took neither the compensate branch nor the abort branch. The
    // journal stayed `committed`, and begin_transition then refused every later
    // promote AND the rollback path until a human finalized it by hand.
    const result = run(deploy, `${stateFactory}
$script:commands = New-Object System.Collections.ArrayList
function Invoke-NativeChecked { param($FilePath, $Arguments, [switch]$Capture, [int]$MaximumOutputBytes)
  $null = $script:commands.Add([string]$Arguments[-1])
  return '{"schemaVersion":2,"releaseSha":"${shaB}","result":"finalized","cleanup":"complete"}' }
function Restore-RejectedPromotion { throw 'compensation is impossible without a previous release' }
$greenfield = New-State $null $null $null
$committed = New-State (New-Release '${shaB}' '${imageB}' '${generationB}') $null $null
$resolution = Resolve-CommittedPromotionFailure -State $committed -BeforeState $greenfield -PromoteBeforeState $greenfield -BaselineAssignmentStatus $null -CandidateReleaseSha '${shaB}' -RepositoryRoot 'repo' -SshTarget 'root@test' -SshOptions @()
"$resolution@@$($script:commands -join '|')"`);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const [resolution, commands] = result.stdout.trim().split("@@");
    expect(resolution).toMatch(/no previous release to compensate to/);
    expect(resolution).toMatch(/transition was finalized/);
    expect(commands).toContain(`finalize-last-transition ${shaB}`);
  });

  it("deploy: reports the journal as still unfinalized when the host refuses to finalize", () => {
    // The host guards finalize-last-transition on the pointer set and on
    // pointer_exact_healthy, so this path can never rubber-stamp a broken
    // switch - and when the host refuses, that refusal has to reach the operator
    // instead of replacing the original failure.
    const result = run(deploy, `${stateFactory}
function Invoke-NativeChecked { throw 'ssh failed with exit code 1. Remote output: network-center activation: finalization pointer set is mixed' }
$greenfield = New-State $null $null $null
$committed = New-State (New-Release '${shaB}' '${imageB}' '${generationB}') $null $null
Resolve-CommittedPromotionFailure -State $committed -BeforeState $greenfield -PromoteBeforeState $greenfield -BaselineAssignmentStatus $null -CandidateReleaseSha '${shaB}' -RepositoryRoot 'repo' -SshTarget 'root@test' -SshOptions @()`);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/left unfinalized/);
    expect(result.stdout).toMatch(/finalization pointer set is mixed/);
  });

  it("deploy: still compensates back to the previous release when there is one", () => {
    const result = run(deploy, `${stateFactory}
$script:restored = 'no'
function Restore-RejectedPromotion { $script:restored = 'yes' }
function Complete-AbandonedTransition { throw 'a compensable promotion must not be finalized in place' }
$before = New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
$committed = New-State (New-Release '${shaB}' '${imageB}' '${generationB}') (New-Release '${shaA}' '${imageA}' '${generationA}') $null
$resolution = Resolve-CommittedPromotionFailure -State $committed -BeforeState $before -PromoteBeforeState $before -BaselineAssignmentStatus $null -CandidateReleaseSha '${shaB}' -RepositoryRoot 'repo' -SshTarget 'root@test' -SshOptions @()
"$resolution@@$script:restored"`);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("exact previous state was restored@@yes");
  });

  it("deploy: leaves the remaining failure classification alone when the promotion never committed", () => {
    const result = run(deploy, `${stateFactory}
function Complete-AbandonedTransition { throw 'nothing was committed; there is no journal to finalize' }
function Restore-RejectedPromotion { throw 'nothing was committed; there is nothing to compensate' }
$before = New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
$unchanged = New-State (New-Release '${shaA}' '${imageA}' '${generationA}') $null $null
$resolution = Resolve-CommittedPromotionFailure -State $unchanged -BeforeState $before -PromoteBeforeState $before -BaselineAssignmentStatus $null -CandidateReleaseSha '${shaB}' -RepositoryRoot 'repo' -SshTarget 'root@test' -SshOptions @()
if ($null -ne $resolution) { throw "expected no resolution, got: $resolution" }
'unclassified'`);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("unclassified");
  });

  // The rollback harness drives the REAL Invoke-RollbackMain end to end with the
  // host calls stubbed, because the defect lives in its control flow rather than
  // in any one helper. It is also the exact live scenario: rolling back onto
  // b6bade8, whose mounted credential map is `{}` so it can never satisfy the
  // poll gate, leaves the pointer swap committed while the readback fails.
  const rollbackMainHarness = (waitBody: string) => `${stateFactory}
$script:commands = New-Object System.Collections.ArrayList
$knownHosts = [IO.Path]::GetTempFileName()
Set-Content -LiteralPath $knownHosts -Value 'pinned' -Encoding ascii
$script:KnownHostsFile = $knownHosts
$script:HostName = 'test.invalid'
$script:PlanOnly = $false
$currentRelease = New-Release '${shaB}' '${imageB}' '${generationB}'
$previousRelease = New-Release '${shaA}' '${imageA}' '${generationA}'
$before = New-State $currentRelease $previousRelease $null
$after = New-State $previousRelease $currentRelease $null
function Invoke-NativeChecked { param($FilePath, $Arguments, [switch]$Capture, [int]$MaximumOutputBytes)
  $null = $script:commands.Add([string]$Arguments[-1])
  return '{"schemaVersion":2,"releaseSha":"${shaA}","result":"finalized","cleanup":"complete"}' }
function Get-ReconciledRemoteState { return $before }
function Get-ReleaseStatus { param([string]$RepositoryRoot, [string]$ExpectedReleaseSha)
  [pscustomobject]@{ workerVersion = $ExpectedReleaseSha; activeAssignmentHash = ('9' * 64); activeAssignmentCount = 2;
    activeAssignedBuildingCount = 2; assignedBuildingCount = 2; expectedConnectionCount = 1; successfulPollCount = 1;
    heartbeatAt = '2026-08-01T00:05:00Z'; pollObservedAt = '2026-08-01T00:04:59Z' } }
function Invoke-RollbackMutationReconciled { [pscustomobject]@{ State = $after; Release = $previousRelease; Reconciled = $true } }
function Get-AuthoritativeUnitState { [pscustomobject]@{ schemaVersion = 1; unit = 'network-center-worker.service';
  activeState = 'active'; subState = 'exited'; result = 'success' } }
${waitBody}
$outcome = 'no-error'
try { $null = Invoke-RollbackMain } catch { $outcome = $_.Exception.Message }
Remove-Item -LiteralPath $knownHosts -Force -ErrorAction SilentlyContinue
"$outcome@@$($script:commands -join '|')"`;

  it("rollback: finalizes the committed pointer swap when the post-switch readback fails", () => {
    const result = run(rollback, rollbackMainHarness(
      `function Wait-WorkerRevision { throw 'Rollback worker heartbeat did not read back exact previous revision.' }`,
    ));
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const [outcome, commands] = result.stdout.trim().split("@@");
    expect(outcome).toMatch(/Rollback switched to the previous release but its readback failed/);
    expect(outcome).toMatch(/transition was finalized/);
    expect(outcome).toMatch(/did not read back exact previous revision/);
    expect(commands).toContain(`finalize-last-transition ${shaA}`);
  });

  it("rollback: a healthy readback still finalizes exactly once and reports the swap", () => {
    const result = run(rollback, rollbackMainHarness(`function Wait-WorkerRevision {
  [pscustomobject]@{ activeAssignmentHash = ('9' * 64); activeAssignmentCount = 2; activeAssignedBuildingCount = 2;
    assignedBuildingCount = 2; expectedConnectionCount = 1; successfulPollCount = 1 } }`));
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const [outcome, commands] = result.stdout.trim().split("@@");
    expect(outcome).toBe("no-error");
    expect(commands.split("|").filter((command) => command.includes("finalize-last-transition"))).toHaveLength(1);
  });

  it("keeps the shared release-state contract in exactly one place", () => {
    // The copy is what turned each of D2, D3 and defect 8 into two defects, and
    // it had already begun to drift (the rollback copy of Invoke-NativeChecked
    // had lost its non-capture branch and its Mandatory guards). Re-introducing
    // a local override of any contract function must fail here.
    const contractSource = readFileSync(contract, "utf8");
    const shared = [...contractSource.matchAll(/^function ([A-Za-z][A-Za-z-]+) \{/gm)].map((match) => match[1]);
    expect(shared).toContain("Assert-ReleaseSchema");
    expect(shared).toContain("Invoke-NativeChecked");
    expect(shared).toContain("Complete-AbandonedTransition");
    expect(shared.length).toBeGreaterThan(10);
    for (const script of [deploy, rollback]) {
      const source = readFileSync(script, "utf8");
      expect(source).toMatch(/^\. \(Join-Path \$PSScriptRoot "release-state-contract\.ps1"\)$/m);
      const redefined = shared.filter((name) => new RegExp(`^function ${name}\\b`, "m").test(source));
      expect(redefined, `${script} re-defines shared contract functions`).toEqual([]);
    }
    // The recovery path may depend on the contract; it must never depend on the
    // deploy client, which is the coupling that would make a broken deploy break
    // the rollback.
    expect(readFileSync(rollback, "utf8")).not.toMatch(/deploy-vultr\.ps1/);
  });
});

// ---------------------------------------------------------------------------
// The trigger behind defect 7, found by RUNNING the repaired rollback against
// production: Windows PowerShell 5.1 strips embedded double quotes on the way to
// a native command, so the remote jq program that built the systemd receipt lost
// the quotes around the unit name, jq compile-errored, and jq exits 3. Every
// invocation of Get-AuthoritativeUnitState from Windows had always failed with a
// bare "ssh failed with exit code 3."
// ---------------------------------------------------------------------------
describe("remote commands survive PowerShell native-argument quoting", () => {
  it("Windows PowerShell 5.1 really does strip embedded double quotes from native arguments", () => {
    // The measurement the fix is built on, reproduced locally against a native
    // command instead of ssh so it needs no host. If this ever stops being true
    // the fix is still correct, but the reason recorded next to it is not.
    const result = run(deploy, `
$probeScript = [IO.Path]::GetTempFileName() + '.ps1'
Set-Content -LiteralPath $probeScript -Value '[Console]::Out.Write($args[0])' -Encoding ascii
$probe = 'x{a:"b"}y'
$echoed = & powershell.exe -NoProfile -NonInteractive -File $probeScript $probe
Remove-Item -LiteralPath $probeScript -Force -ErrorAction SilentlyContinue
"$probe|$echoed"`);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const [held, received] = result.stdout.trim().split("|");
    expect(held).toBe('x{a:"b"}y');
    expect(received).toBe("x{a:b}y");
  });

  for (const script of [deploy, rollback]) {
    const label = scriptName(script);

    it(`${label}: builds the systemd readback command with no quote characters at all`, () => {
      const result = run(script, `
$command = Get-WorkerUnitStateCommand
if ($command -match '["'']') { throw "quote character survived in: $command" }
$command`);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe(
        "sudo -- systemctl show network-center-worker.service --property=ActiveState --property=SubState --property=Result",
      );
    });

    it(`${label}: reads the unit state out of systemctl's own Property=Value output`, () => {
      const result = run(script, `
$state = ConvertFrom-SystemdShowText -Output "ActiveState=active\`nSubState=exited\`nResult=success" -Unit 'network-center-worker.service'
$null = Assert-UnitState $state
$state | ConvertTo-Json -Compress`);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1, unit: "network-center-worker.service", activeState: "active", subState: "exited", result: "success",
      });
    });

    it(`${label}: refuses systemctl output that is short, repeated, renamed or unparseable`, () => {
      const cases = [
        "ActiveState=active`nSubState=exited",
        "ActiveState=active`nActiveState=active`nResult=success",
        "ActiveState=active`nSubState=exited`nUnexpected=success",
        "ActiveState=active`nSubState=exited`nResult=success`nExtra=1",
        "jq: error: network/0 is not defined at <top-level>, line 1, column 23:",
      ];
      for (const output of cases) {
        const result = run(script, `
$null = ConvertFrom-SystemdShowText -Output "${output}" -Unit 'network-center-worker.service'`);
        expect(result.status, `accepted ${output}`).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toMatch(/Systemd unit state/i);
      }
    });

    it(`${label}: an inactive unit is still refused after the format change`, () => {
      const result = run(script, `
$null = Assert-UnitState (ConvertFrom-SystemdShowText -Output "ActiveState=failed\`nSubState=failed\`nResult=exit-code" -Unit 'network-center-worker.service')`);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/not authoritatively active/i);
    });
  }

  it("deploy: builds the preflight command with no quote characters that PowerShell can eat", () => {
    const result = run(deploy, `
$command = Get-PreflightCommand
if ($command -match '"') { throw "double quote survived in: $command" }
$command`);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    // Single quotes are safe - PowerShell passes them through untouched - and the
    // remote sh needs them to keep the compound command in one argv element.
    expect(result.stdout.trim()).toMatch(/^sudo -- \/bin\/sh -c '.*'$/);
    expect(result.stdout).toContain("sysctl -n net.ipv4.ip_forward | grep -qx 1");
    expect(result.stdout).not.toContain("test ");
  });
});
