import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const text = async (path: string) => await readFile(resolve(root, path), "utf8");

describe("Task 20 watchdog and recovery contracts", () => {
  it("owns the exact host guard shell/service/timer paths and valid source", async () => {
    const paths = [
      "infra/openclaw-zalo/scripts/openclaw-host-guard.sh",
      "infra/openclaw-zalo/systemd/user/openclaw-host-guard.service",
      "infra/openclaw-zalo/systemd/user/openclaw-host-guard.timer",
    ];
    await Promise.all(paths.map((path) => access(resolve(root, path), constants.R_OK)));
    const guard = await text(paths[0]!);
    for (const threshold of [
      "router_p95_regression\" 20", "router_error_rate\" 1", "ram_percent\" 75",
      "swap_percent\" 10", "load_one\" 12", "root_free_gib\" 200", "root_free_percent\" 20",
    ]) expect(guard).toContain(threshold);
    expect(guard).toContain("PAUSE_OUTBOUND_AI_MEDIA");
    expect(guard).toContain("openclaw_zalo.manage_operations");
    expect(guard).toContain("stop --timeout 30 cell bridge");

    // Fail-closed: mốc trip phải được ghi TRƯỚC khi gọi Edge, và lỗi gọi Edge
    // không được ngăn cưỡng chế cục bộ (pause ngay + dừng cell/bridge sau 10 phút).
    expect(guard).toContain('post_guard "$guard_state" "$fingerprint" || post_failed=1');
    expect(guard).toContain('post_guard CLEAR_PENDING "host-guard:clear-pending-manual-resume" || post_failed=1');
    const postIndex = guard.indexOf('post_guard "$guard_state"');
    const stopIndex = guard.indexOf("stop --timeout 30 cell bridge");
    // `write_state` được GỌI (thụt lề trong nhánh trip) trước lần post đầu tiên.
    const writeCallIndex = guard.search(/^\s+write_state\s*$/mu);
    expect(writeCallIndex).toBeGreaterThan(-1);
    expect(postIndex).toBeGreaterThan(-1);
    expect(writeCallIndex).toBeLessThan(postIndex);
    expect(stopIndex).toBeGreaterThan(postIndex);
    expect(guard).toMatch(/if \[ "\$post_failed" -ne 0 \]; then[\s\S]*exit 1/u);

    // Operation ID tất định để post lại không nhân bản incident/notification.
    expect(guard).toContain("derive_operation_id()");
    expect(guard).toContain('operation_id=$(derive_operation_id "$guard_state" "$fingerprint" "$trip_since")');
    expect(guard).not.toMatch(/operation_id=[^\n]*random\/uuid/u);
    expect(guard).not.toMatch(/systemctl\s+(?:stop|restart|kill)\s+(?:9router|cli-proxy)|docker\s+--host|\/var\/run\/docker\.sock/iu);

    // Auth tới Edge là envelope Ed25519 riêng của host, KHÔNG phải bearer dùng chung.
    expect(guard).not.toMatch(/Authorization:\s*Bearer|openclaw_watchdog_token/iu);
    expect(guard).toContain("openclaw_watchdog_envelope_key.pem");
    expect(guard).toContain("openssl pkeyutl -sign -rawin -inkey");
    expect(guard).toContain("X-OpenClaw-Watchdog-Envelope");
    expect(guard).toContain("X-OpenClaw-Watchdog-Signature");
    // Header phải đi qua stdin: /proc/<pid>/cmdline đọc được bởi mọi user cục bộ
    // và envelope+chữ ký còn replay được trong cửa sổ 60 giây.
    expect(guard).toContain("curl --config -");
    expect(guard).not.toMatch(/--header "X-OpenClaw-Watchdog/u);
    // openssl hỏng không được biến thành chữ ký rỗng gửi đi.
    expect(guard).toMatch(/if ! openssl pkeyutl -sign -rawin/u);
    expect(guard).toContain("watchdog envelope signing failed");
    expect(guard).toContain("watchdog envelope signature is malformed");
    expect(guard).toMatch(/trap 'rm -f "\$preimage_file"' EXIT HUP INT TERM/u);
    expect(guard).toContain("ihome-openclaw-watchdog-envelope-v1");
    expect(guard).toContain("ENVELOPE_AUDIENCE='openclaw-watchdog-edge'");
    expect(guard).toContain('"operation":"host.guard"');
    // Envelope là JCS: khoá phải sắp xếp tăng dần, nếu không Edge tính chữ ký khác.
    const envelopeTemplate = guard.match(/printf '(\{"audience".*?)' \\/u)?.[1] ?? "";
    const envelopeKeys = [...envelopeTemplate.matchAll(/"([A-Za-z0-9]+)":/gu)].map((match) => match[1]);
    expect(envelopeKeys).toEqual([...envelopeKeys].sort());
    expect(envelopeKeys).toEqual([
      "audience", "bodySha256", "keyGeneration", "method", "nonce",
      "operation", "organizationId", "path", "timestamp", "version",
    ]);
    // Nonce phải mới mỗi lần thử; `curl --retry` gửi lại nonce cũ nên bị cấm.
    expect(guard).toContain("nonce=$(cat /proc/sys/kernel/random/uuid)");
    expect(guard).not.toContain("--retry-all-errors");
    const attemptLoop = guard.indexOf('while [ "$attempt" -le 3 ]');
    const nonceIndex = guard.indexOf("nonce=$(cat /proc/sys/kernel/random/uuid)");
    expect(attemptLoop).toBeGreaterThan(-1);
    expect(attemptLoop).toBeLessThan(nonceIndex);

    const service = await text(paths[1]!);
    expect(service).toContain("DOCKER_HOST=unix:///run/user/%U/docker.sock");
    expect(service).toContain("openclaw-host-guard.sh --runtime-env");
    expect(service).not.toContain("User=root");
    const timer = await text(paths[2]!);
    expect(timer).toContain("OnCalendar=*-*-* *:*:00");
    expect(timer).toContain("Persistent=true");

    if (process.platform !== "win32") {
      for (const script of [paths[0]!, "infra/openclaw-zalo/scripts/restore-drill.sh", "infra/openclaw-zalo/scripts/migrate-cell.sh"]) {
        const result = spawnSync("sh", ["-n", resolve(root, script)], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      }
    }
  });

  // Chữ ký do POSIX sh + openssl tạo phải khớp TỪNG BYTE với cách Edge (WebCrypto)
  // dựng preimage. JCS lệch một byte là hỏng âm thầm, chỉ lộ ở production.
  // Chạy ở mọi nền có `sh` + `openssl` (CI Linux và Git Bash trên Windows).
  const shellToolingAvailable = ["sh", "openssl"].every((tool) =>
    spawnSync(tool, tool === "sh" ? ["-c", "exit 0"] : ["version"], { encoding: "utf8" }).status === 0
  );
  it.skipIf(!shellToolingAvailable)(
    "signs an envelope that WebCrypto verifies byte-for-byte",
    async () => {
      const { mkdtemp, writeFile, chmod, mkdir, readFile: read } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const workspace = await mkdtemp(resolve(tmpdir(), "openclaw-host-guard-"));
      // `sh` ở đây là POSIX shell (Git Bash trên Windows), nên mọi đường dẫn nhúng
      // vào script phải là POSIX: `C:\a\b` trong nháy kép của sh là chuỗi escape.
      const posix = (value: string) =>
        process.platform === "win32"
          ? value.replace(/\\/gu, "/").replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`)
          : value;
      const keyFile = resolve(workspace, "key.pem");
      const run = (command: string, args: string[], options: Record<string, unknown> = {}) => {
        const result = spawnSync(command, args, { encoding: "utf8", ...options });
        expect(result.status, `${command}: ${result.stderr}`).toBe(0);
        return result.stdout;
      };
      run("openssl", ["genpkey", "-algorithm", "ed25519", "-out", keyFile]);
      await chmod(keyFile, 0o400);
      const publicKeyDer = spawnSync(
        "openssl",
        ["pkey", "-in", keyFile, "-pubout", "-outform", "DER"],
        { encoding: "buffer" },
      ).stdout;

      // Bọc curl giả để bắt header/body mà không chạm mạng.
      const binDir = resolve(workspace, "bin");
      await mkdir(binDir);
      const captureFile = resolve(workspace, "capture.txt");
      // Script gửi header qua `curl --config -` (stdin), không qua argv, nên stub
      // phải đọc cả hai: dòng cấu hình `header = "..."` ở stdin và --data-binary ở argv.
      await writeFile(
        resolve(binDir, "curl"),
        `#!/bin/sh\n: > "${posix(captureFile)}"\nwhile [ "$#" -gt 0 ]; do\n` +
          `  case "$1" in\n    --data-binary) printf 'BODY\\t%s\\n' "$2" >> "${posix(captureFile)}"; shift 2 ;;\n` +
          `    *) shift ;;\n  esac\ndone\n` +
          `sed -n 's/^header = "\\(.*\\)"$/HEADER\\t\\1/p' >> "${posix(captureFile)}"\nexit 0\n`,
        { mode: 0o755 },
      );

      // Trích ĐÚNG vùng mã ký của script thật, không chép lại logic.
      const guard = await text("infra/openclaw-zalo/scripts/openclaw-host-guard.sh");
      const start = guard.indexOf("OPERATION_ID_DOMAIN=");
      const end = guard.indexOf("post_failed=0");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const harness = [
        "#!/bin/sh",
        "set -eu",
        "organization_id=dddd0000-0000-4000-8000-000000000001",
        "cell_id=dddd2000-0000-4000-8000-000000000001",
        "key_generation=7",
        `operations_dir="${posix(workspace)}"`,
        `signing_key_file="${posix(keyFile)}"`,
        "watchdog_url=https://project.supabase.co/functions/v1/openclaw-watchdog",
        "trip_since=1785062400",
        "ram_percent=76.00",
        "swap_percent=0.00",
        "load_one=0.14",
        "root_free_percent=93.90",
        "root_free_gib=1126.00",
        "router_p95_regression=0",
        "router_error_rate=0",
        // Windows không có /proc/sys/kernel/random/uuid; nguồn nonce đã được kiểm
        // riêng ở assertion tĩnh phía trên, ở đây chỉ cần chữ ký tất định.
        process.platform === "win32"
          ? guard.slice(start, end).replace(
              "$(cat /proc/sys/kernel/random/uuid)",
              "$(printf dddd9000-0000-4000-8000-000000000001)",
            )
          : guard.slice(start, end),
        'post_guard TRIPPED "host-guard:ram"',
      ].join("\n").replace(/\r\n/gu, "\n");
      const harnessFile = resolve(workspace, "sign-only.sh");
      await writeFile(harnessFile, harness, { mode: 0o755 });
      run("sh", [posix(harnessFile)], {
        env: { ...process.env, PATH: `${posix(binDir)}:${process.env.PATH}` },
      });

      const capture = await read(captureFile, "utf8");
      const headerValue = (name: string) =>
        (capture.split("\n").find((row) => row.startsWith(`HEADER\t${name}:`)) ?? "")
          .split(": ").slice(1).join(": ").trim();
      const envelopeHeader = headerValue("X-OpenClaw-Watchdog-Envelope");
      const signature = headerValue("X-OpenClaw-Watchdog-Signature");
      const body = (capture.split("\n").find((row) => row.startsWith("BODY\t")) ?? "").slice(5);
      expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);

      const fromBase64Url = (value: string) =>
        Buffer.from(value.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
      const envelope = JSON.parse(fromBase64Url(envelopeHeader).toString("utf8")) as
        Record<string, unknown>;
      const canonical = `{${Object.keys(envelope).sort()
        .map((key) => `${JSON.stringify(key)}:${JSON.stringify(envelope[key])}`).join(",")}}`;
      // Header phải ĐÃ canonical sẵn, không phải chỉ canonical hoá được.
      expect(fromBase64Url(envelopeHeader).toString("utf8")).toBe(canonical);
      expect(envelope).toMatchObject({
        version: 1,
        audience: "openclaw-watchdog-edge",
        operation: "host.guard",
        method: "POST",
        path: "/functions/v1/openclaw-watchdog",
        keyGeneration: 7,
      });
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
      );
      expect(envelope.bodySha256).toBe(
        [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      );

      const publicKey = await crypto.subtle.importKey(
        "spki",
        publicKeyDer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const verified = await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode(`ihome-openclaw-watchdog-envelope-v1\0${canonical}`),
      );
      expect(verified).toBe(true);
    },
  );

  it("requires restore RPO/RTO, R2 grace, key rotation and plaintext proof", async () => {
    const source = await text("infra/openclaw-zalo/scripts/restore-drill.sh");
    for (const required of [
      "rpo_seconds\" -le 900", "rto_seconds\" -le 14400", "--grace-seconds 604800",
      "openclaw_runtime_credential", "openclaw_maintenance_credential",
      "openclaw_gateway_device_token", "openclaw_audit_private_key",
      "session-reencrypt-atomic", "session-require-fresh-qr-login",
      "prove-no-plaintext-session-snapshot", "plaintextSessionSnapshotFound\\\":false",
    ]) expect(source).toContain(required);
    expect(source).toContain("dddd0000-0000-4000-8000-000000000001");
    expect(source).not.toContain("aaaa0000-0000-4000-8000-000000000001");

    // RTO phải đo bằng đồng hồ diễn tập bao quanh chính lần restore, và chỉ
    // enforce SAU khi restore xong — không lấy mốc thời gian do caller khai.
    const measuredStart = source.indexOf("measured_restore_start=$(date +%s)");
    const restoreCall = source.indexOf("run_adapter supabase-restore-test");
    const measuredEnd = source.indexOf("measured_restore_end=$(date +%s)");
    const rtoCompute = source.indexOf("rto_seconds=$((measured_restore_end - measured_restore_start))");
    const rtoGate = source.indexOf('"$rto_seconds" -le 14400');
    for (const index of [measuredStart, restoreCall, measuredEnd, rtoCompute, rtoGate]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(measuredStart).toBeLessThan(restoreCall);
    expect(restoreCall).toBeLessThan(measuredEnd);
    expect(measuredEnd).toBeLessThan(rtoCompute);
    expect(rtoCompute).toBeLessThan(rtoGate);
    // Con số caller khai chỉ còn là metadata, không phải nguồn của actualRtoSeconds.
    expect(source).toContain("declared_rto_seconds=$((restore_end_epoch - restore_start_epoch))");
    expect(source).toContain('\\"rtoMeasurement\\":\\"drill-clock\\"');
    expect(source).toContain('\\"actualRtoSeconds\\":$rto_seconds');
  });

  it("freezes migration in GLOBAL_STOP/drain/fence/revoke/relogin order", async () => {
    const source = await text("infra/openclaw-zalo/scripts/migrate-cell.sh");
    const sequence = [
      "run global-stop", "run drain-outbox", "run freeze-outbox",
      "run move-expired-dispatching-to-unknown", "run snapshot-old-cotenants",
      "run provision-new-rootless-cell", "run rotate-workload-credentials",
      "run acquire-higher-fencing-lease", "run revoke-old-credential-and-lease",
      "run require-fresh-qr-login", "run sync-history --hours 48",
      "run reconcile-gaps-and-unknown", "run controlled-smoke", "run compare-cotenants",
      "run resume-organization",
    ];
    let previous = -1;
    for (const marker of sequence) {
      const index = source.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    expect(source).toContain("--supabase-copy false --r2-copy false");
    expect(source).toContain("target_rto_seconds=3600");
    expect(source).toContain("GLOBAL_STOP remains active");
  });

  it("documents required evidence, co-tenant comparison, and quota gates", async () => {
    const runbookPaths = [
      "deploy.md", "operations.md", "backup-restore.md", "vps-migration.md",
      "rollback.md", "secret-rotation.md", "capacity.md",
    ].map((name) => `docs/openclaw-zalo/runbooks/${name}`);
    const combined = (await Promise.all(runbookPaths.map(text))).join("\n");
    for (const required of [
      "RPO <= 15 minutes", "RTO <= 4 hours", "GLOBAL_STOP", "UNKNOWN",
      "fresh QR", "48-hour history", "co-tenant", "restore drill", "60%", "80%", "90%", "100%",
      "openclaw_zalo.manage_operations", "Supabase and R2", "not copied",
    ]) expect(combined.toLowerCase()).toContain(required.toLowerCase());
    expect(combined).toContain("actual RPO/RTO");
    expect(combined).toContain("no plaintext session snapshot");
  });
});
