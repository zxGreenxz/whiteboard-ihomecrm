import { describe, expect, it } from "vitest";

import {
  MUTATING_COMMANDS,
  READ_ONLY_COMMANDS,
  buildMachineReason,
  classifyCommand,
  redactEvidence,
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
