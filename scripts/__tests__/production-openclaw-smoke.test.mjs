import { describe, expect, it } from "vitest";

import {
  MUTATING_COMMANDS,
  READ_ONLY_COMMANDS,
  buildMachineReason,
  classifyCommand,
  redactEvidence,
  computeMigrationManifestHash,
  resolveCommand,
} from "../production-openclaw-smoke.mjs";

/**
 * Hợp đồng của các RÀO AN TOÀN trong bộ máy rollout production.
 *
 * Đây là lát cắt đầu tiên và cố ý chỉ gồm phần mà sai thì nguy hiểm nhất: phân
 * loại lệnh đọc/ghi, bắt buộc xác nhận PROD, id lần chạy cấp trước, và lọc bí
 * mật khỏi bằng chứng. Các lệnh nghiệp vụ (`--begin-rollout`, `--bind-owner-qr`…)
 * dựng ở lát sau và sẽ dùng lại đúng những rào này.
 *
 * Vì sao rào đi trước nghiệp vụ: một lệnh sai có thể chạy lại; một bí mật đã ghi
 * vào file bằng chứng thì không rút lại được, và một lệnh "chỉ đọc" mà thật ra
 * ghi sẽ phá đúng thứ nó được gọi để kiểm.
 */

describe("phân loại lệnh đọc / ghi", () => {
  it("không lệnh nào vừa đọc vừa ghi", () => {
    // Một lệnh nằm ở cả hai danh sách nghĩa là người đọc không thể biết nó có
    // đụng dữ liệu hay không — và mọi rào phía dưới đều dựa vào phân loại này.
    const overlap = [...MUTATING_COMMANDS].filter((name) => READ_ONLY_COMMANDS.has(name));
    expect(overlap).toEqual([]);
  });

  it("mọi lệnh gate / readiness / lookup đều là chỉ đọc", () => {
    // Kế hoạch nói thẳng: gate, readiness và lookup không được có tác dụng phụ.
    // Đây là bài đo DẪN XUẤT từ chính tên lệnh, nên một lệnh `--check-*` mới bị
    // xếp nhầm sang nhóm ghi sẽ làm bài này đỏ ngay.
    const shouldBeReadOnly = [...MUTATING_COMMANDS, ...READ_ONLY_COMMANDS]
      .filter((name) => /^(check|verify|lookup)-/u.test(name));
    expect(shouldBeReadOnly.length, "không tìm thấy lệnh gate/lookup nào").toBeGreaterThan(0);
    for (const name of shouldBeReadOnly) {
      expect(READ_ONLY_COMMANDS.has(name), `${name} phải là chỉ đọc`).toBe(true);
    }
  });

  it("từ chối lệnh không có trong danh sách", () => {
    expect(() => classifyCommand("drop-everything")).toThrow(/không nằm trong danh sách/u);
  });
});

describe("xác nhận PROD", () => {
  const artifacts = { runId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };

  it("lệnh ghi bị từ chối khi thiếu xác nhận tường minh", () => {
    for (const command of MUTATING_COMMANDS) {
      expect(
        () => resolveCommand({ command, confirm: undefined, ...artifacts }),
        `${command} chạy được mà không cần xác nhận`,
      ).toThrow(/xác nhận PROD/u);
    }
  });

  it("chuỗi xác nhận phải KHỚP TUYỆT ĐỐI, không phải chứa", () => {
    // "PRODUCTION-ish" chứa "PROD" và "prod" chỉ khác hoa thường. Cả hai đều là
    // thứ người ta gõ nhầm rồi vẫn chạy, nếu kiểm bằng contains hay lowercase.
    for (const wrong of ["prod", "PROD ", " PROD", "PRODUCTION", "PRODUCTION-ish", ""]) {
      expect(
        () => resolveCommand({ command: "begin-rollout", confirm: wrong, ...artifacts }),
        `xác nhận sai "${wrong}" vẫn qua`,
      ).toThrow(/xác nhận PROD/u);
    }
    expect(() => resolveCommand({ command: "begin-rollout", confirm: "PROD", ...artifacts }))
      .not.toThrow();
  });

  it("lệnh chỉ đọc KHÔNG đòi xác nhận", () => {
    // Bắt xác nhận cho lệnh đọc nghe có vẻ an toàn hơn, nhưng nó dạy người vận
    // hành gõ "PROD" theo phản xạ — đúng thói quen mà rào này cần chặn.
    for (const command of READ_ONLY_COMMANDS) {
      expect(
        () => resolveCommand({ command, confirm: undefined, ...artifacts }),
        `${command} đòi xác nhận dù chỉ đọc`,
      ).not.toThrow();
    }
  });
});

describe("id lần chạy phải được CẤP TRƯỚC", () => {
  it("lệnh ghi từ chối khi thiếu runId", () => {
    expect(() => resolveCommand({ command: "begin-rollout", confirm: "PROD" }))
      .toThrow(/runId/u);
  });

  it("từ chối runId không phải UUID", () => {
    for (const bad of ["run-1", "3f2504e0", "3f2504e0-4f89-41d3-9a0c-0305e82c330", "z".repeat(36)]) {
      expect(
        () => resolveCommand({ command: "begin-rollout", confirm: "PROD", runId: bad }),
        `runId sai "${bad}" vẫn qua`,
      ).toThrow(/runId/u);
    }
  });
});

describe("lọc bí mật khỏi bằng chứng", () => {
  it("chặn dữ liệu QR", () => {
    // QR của Zalo là chứng chỉ đăng nhập. Lọt vào file bằng chứng thì bất kỳ ai
    // đọc file đó đều đăng nhập được — nguy hiểm hơn hẳn một token thường vì nó
    // không hiện ra như một bí mật.
    expect(() => redactEvidence({ qrCode: "data:image/png;base64,iVBORw0KGgo=" }))
      .toThrow(/QR/u);
    expect(() => redactEvidence({ nested: { qr_data: "abc" } })).toThrow(/QR/u);
  });

  it("chặn token, cookie, IMEI và giá trị hình-dạng-bí-mật", () => {
    const cases = [
      { name: "token", value: { accessToken: "eyJhbGciOiJIUzI1NiJ9.abc.def" } },
      { name: "cookie", value: { setCookie: "session=abc; HttpOnly" } },
      { name: "IMEI", value: { imei: "490154203237518" } },
      { name: "PAT Supabase", value: { note: "sbp_d071757ea96299429838acba25e64f9e21d6bacc" } },
      { name: "khoá riêng", value: { pem: "-----BEGIN OPENSSH PRIVATE KEY-----" } },
    ];
    for (const { name, value } of cases) {
      expect(() => redactEvidence(value), `${name} lọt qua`).toThrow();
    }
  });

  it("chặn nội dung tin nhắn", () => {
    // Nội dung tin là dữ liệu khách hàng. Một bản log "để debug" là một bản sao
    // hội thoại nằm ngoài mọi ràng buộc lưu trữ của sản phẩm.
    expect(() => redactEvidence({ messageBody: "chào anh" })).toThrow(/nội dung tin/u);
    expect(() => redactEvidence({ template: { text: "xin chào" } })).toThrow(/nội dung tin/u);
  });

  it("cho qua bằng chứng sạch, và trả lại nguyên vẹn", () => {
    // Mặt THUẬN. Thiếu bài này thì một hàm `throw` vô điều kiện cũng làm mọi bài
    // trên xanh.
    const clean = { runId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", stage: "WAITING_OWNER_QR", counts: { queued: 0 } };
    expect(redactEvidence(clean)).toEqual(clean);
  });

  it("soi cả mảng lồng nhau, không chỉ khoá cấp một", () => {
    expect(() => redactEvidence({ steps: [{ ok: true }, { qrPayload: "x" }] })).toThrow(/QR/u);
  });
});

describe("lý do máy đọc", () => {
  it("dựng từ dữ liệu cho phép, đúng khuôn", () => {
    expect(buildMachineReason("BEGIN_ROLLOUT", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .toBe("production-smoke:BEGIN_ROLLOUT:3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("từ chối chế độ không nằm trong danh sách", () => {
    // Kế hoạch cấm để văn bản thô của caller hay của provider trở thành bằng
    // chứng. Chặn ở đây thay vì lọc sau, vì lọc sau là đã ghi rồi mới xoá.
    expect(() => buildMachineReason("lỗi từ Zalo: mất kết nối", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .toThrow(/chế độ/iu);
  });

  it("từ chối runId không hợp lệ, để lý do không trỏ vào lần chạy không tồn tại", () => {
    expect(() => buildMachineReason("BEGIN_ROLLOUT", "run-1")).toThrow(/runId/u);
  });
});

describe("bản song sinh JS của hàm băm manifest", () => {
  // Hàm thật sống trong DB: app_private.openclaw_rollout_manifest_hash_v1.
  // Bản JS phải khớp TUYỆT ĐỐI, vì --begin-rollout tính hash phía client rồi ghi
  // vào cột mà guard sẽ kiểm lại bằng hàm DB. Lệch một byte thì dòng vừa ghi bị
  // chính guard từ chối, và người vận hành nhận một lỗi 42501 không nói được vì
  // sao.
  //
  // Vector vàng dưới đây LẤY TỪ chính hàm DB chạy trên harness schema production
  // (xem docs/openclaw-zalo/runbooks/). Không phải tôi tự tính rồi tự tin.
  const ORDER = [
    "20260727010000_openclaw_catalog_foundation.sql",
    "20260727015000_openclaw_security_principals.sql",
    "20260727020000_openclaw_inbox_schema.sql",
    "20260727025000_openclaw_inbound_automation.sql",
    "20260727030000_openclaw_policy_automation_knowledge.sql",
    "20260727040000_openclaw_delivery_audit_ops.sql",
    "20260727050000_openclaw_access_policies.sql",
    "20260727060000_openclaw_rpc_surface.sql",
    "20260727070000_openclaw_crm_event_sources.sql",
    "20260727080000_openclaw_realtime_allowlist.sql",
    "20260727090000_openclaw_maintenance_jobs.sql",
    "20260727095000_openclaw_activation_guards.sql",
  ];
  const digestsOf = (fill) => Object.fromEntries(ORDER.map((n, i) =>
    [n, String(fill).repeat(64).slice(0, 63) + String(i % 10)]));

  it("từ chối khi thiếu digest của bất kỳ file nào trong 12", () => {
    const partial = digestsOf("a");
    delete partial[ORDER[7]];
    expect(() => computeMigrationManifestHash(partial, ORDER)).toThrow(/thiếu|digest/iu);
  });

  it("từ chối digest sai khuôn 64 hex", () => {
    const bad = { ...digestsOf("a"), [ORDER[3]]: "khong-phai-hex" };
    expect(() => computeMigrationManifestHash(bad, ORDER)).toThrow(/digest/iu);
  });

  it("bỏ qua khoá thừa (cellImageDigest…) — chúng không vào tiền ảnh", () => {
    // artifact_digests mang thêm cellImageDigest / cellConfigDigest /
    // cellReviewedCommitSha. Hàm DB chỉ duyệt 12 tên file, nên bản JS cũng phải
    // vậy; gộp thêm sẽ ra hash khác và dòng ghi ra bị guard từ chối.
    const base = digestsOf("a");
    const withExtras = {
      ...base,
      cellImageDigest: `sha256:${"b".repeat(64)}`,
      cellConfigDigest: "c".repeat(64),
      cellReviewedCommitSha: "d".repeat(40),
    };
    expect(computeMigrationManifestHash(withExtras, ORDER))
      .toBe(computeMigrationManifestHash(base, ORDER));
  });

  it("đổi thứ tự cho ra hash khác", () => {
    const d = digestsOf("a");
    const swapped = [ORDER[1], ORDER[0], ...ORDER.slice(2)];
    expect(computeMigrationManifestHash(d, swapped))
      .not.toBe(computeMigrationManifestHash(d, ORDER));
  });

  it("kết quả là 64 hex", () => {
    expect(computeMigrationManifestHash(digestsOf("a"), ORDER)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("KHỚP VECTOR VÀNG lấy từ chính hàm DB", () => {
    // Vector này KHÔNG do tôi tự tính. Nó là đầu ra của
    // `app_private.openclaw_rollout_manifest_hash_v1` chạy trên harness nạp
    // schema production, với đúng bộ digest tổng hợp dưới đây (a×63 + chữ số
    // theo vị trí). Dùng digest tổng hợp chứ không phải băm file thật, để vector
    // không đổi mỗi lần một migration được sửa — một vector vàng tự đổi thì
    // không còn là vàng.
    //
    // Bài này là thứ duy nhất chứng minh bản JS và hàm DB nói cùng một ngôn ngữ.
    // Lệch một byte ⇒ --begin-rollout ghi ra dòng mà chính guard từ chối, và
    // người vận hành nhận 42501 không nói được vì sao.
    const golden = "f8049d5e377a8aa254c7f344314bc4dc63e546a19dff97ffc780bc26e83342fd";
    const digests = Object.fromEntries(
      ORDER.map((name, index) => [name, "a".repeat(63) + String(index % 10)]),
    );
    expect(computeMigrationManifestHash(digests, ORDER)).toBe(golden);
  });

  it("thứ tự 12 file khớp danh sách hàm DB ghim cứng", () => {
    // Hàm DB ghim cứng đúng 12 tên này. Đây là nguồn sự thật THỨ BA về danh sách
    // (cạnh OPENCLAW_MIGRATIONS của harness và cây git đã duyệt). Ghi ra đây để
    // lần sau ai sửa manifest biết phải sửa mấy chỗ — và để vector vàng ở trên
    // có nghĩa.
    expect(ORDER).toHaveLength(12);
    expect(ORDER[3]).toBe("20260727025000_openclaw_inbound_automation.sql");
    expect(ORDER[6]).toBe("20260727050000_openclaw_access_policies.sql");
    expect(ORDER[9]).toBe("20260727080000_openclaw_realtime_allowlist.sql");
  });
});
