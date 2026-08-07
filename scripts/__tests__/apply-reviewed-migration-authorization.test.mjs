// Luật GIẤY PHÉP APPLY của forward-only lane (đổi 07/08/2026).
//
// Lane nay tự chạy được, không cần người gõ token. Chỗ đó chỉ an toàn nếu điều
// kiện thay thế được cưỡng chế THẬT — nên file này kiểm đúng ranh giới đó.
//
//   node --test scripts/__tests__/apply-reviewed-migration-authorization.test.mjs
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { SAN_BANG_CO_DU_LIEU, docManifestBackup } from "../apply-reviewed-migration.mjs";

/** Manifest hợp lệ tối thiểu — bản dump đủ tư cách làm đường lùi. */
const HOP_LE = {
  file: "C:/backups/full-20260807.dump",
  kind: "full",
  createdAt: "2026-08-07T10:00:00.000Z",
  sha256: "a".repeat(64),
  tablesWithData: 565,
  excludedTableData: [],
};

const gia = (manifest, { coFile = true, marker = "BACKUP_MANIFEST=C:/x.json" } = {}) =>
  docManifestBackup(
    `dòng linh tinh\n${marker}\n`,
    () => JSON.stringify(manifest),
    () => coFile,
  );

test("bản dump đầy đủ ⇒ phát được giấy phép", () => {
  const r = gia(HOP_LE);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.sha256, HOP_LE.sha256);
});

test("không có dòng BACKUP_MANIFEST ⇒ từ chối", () => {
  const r = docManifestBackup("backup xong rồi nhé", () => "{}", () => true);
  assert.equal(r.ok, false);
  assert.match(r.vi, /BACKUP_MANIFEST/);
});

test("manifest không tồn tại ⇒ từ chối", () => {
  const r = gia(HOP_LE, { coFile: false });
  assert.equal(r.ok, false);
  assert.match(r.vi, /không tồn tại/);
});

test("manifest hỏng ⇒ từ chối, KHÔNG đoán", () => {
  const r = docManifestBackup("BACKUP_MANIFEST=C:/x.json", () => "{ khong phai json", () => true);
  assert.equal(r.ok, false);
  assert.match(r.vi, /hỏng/);
});

test("dump CHỈ SCHEMA ⇒ từ chối — không khôi phục được dữ liệu", () => {
  // Đây là ca nguy hiểm nhất: file tồn tại, sha256 có, pg_dump thoát 0, nhìn như
  // một bản backup thật. Nhưng nó không chứa một dòng dữ liệu nào.
  const r = gia({ ...HOP_LE, kind: "schema" });
  assert.equal(r.ok, false);
  assert.match(r.vi, /CHỈ SCHEMA/);
});

test("dump bỏ dữ liệu bảng nào đó ⇒ từ chối", () => {
  const r = gia({ ...HOP_LE, excludedTableData: ["openclaw_runtime_nonces"] });
  assert.equal(r.ok, false);
  assert.match(r.vi, /THIẾU dữ liệu/);
});

test("dump cụt (dưới sàn) ⇒ từ chối", () => {
  // Án lệ có thật: bản dump đứt giữa chừng VẪN để lại file và pg_dump VẪN thoát 0.
  const r = gia({ ...HOP_LE, tablesWithData: SAN_BANG_CO_DU_LIEU - 1 });
  assert.equal(r.ok, false);
  assert.match(r.vi, /sàn/);
});

test("thiếu sha256 ⇒ từ chối", () => {
  const r = gia({ ...HOP_LE, sha256: undefined });
  assert.equal(r.ok, false);
  assert.match(r.vi, /sha256/);
});

test("--khong-backup mà không có token ⇒ TỪ CHỐI trước khi chạm production", () => {
  // Ranh giới quan trọng nhất của luật mới: đường TỰ ĐỘNG và đường BỎ BACKUP
  // không được dùng chung. Nếu ca này xanh, lane tự động sẽ apply production mà
  // không có điểm khôi phục nào — đúng thứ luật cũ sinh ra để chặn.
  const env = { ...process.env };
  delete env.IHOMECRM_PROMOTION_TOKEN;
  let ma = 0;
  let ra = "";
  try {
    execFileSync(
      process.execPath,
      [
        "scripts/apply-reviewed-migration.mjs",
        "supabase/migrations/20260807140000_ie_guard_handover_scope.sql",
        "--apply",
        "--khong-backup",
        "test tu dong",
      ],
      { encoding: "utf8", stdio: "pipe", env, timeout: 5 * 60 * 1000 },
    );
  } catch (e) {
    ma = e.status ?? 1;
    ra = (e.stdout ?? "") + (e.stderr ?? "");
  }
  assert.equal(ma, 1, "phải từ chối");
  assert.match(ra, /không dùng chung/);
});
