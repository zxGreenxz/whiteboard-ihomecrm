import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// GĐ1 — SỔ ĐĂNG KÝ MIỄN TRỪ, phải tồn tại TRƯỚC khi có bất kỳ generator nào.
//
// Bản kế hoạch đầu tiên gộp ba thứ vào cùng một file migration: tạo bảng miễn
// trừ, chạy vòng sinh policy theo catalog, và gắn event trigger. Gộp như vậy thì
// lần chạy đầu tiên generator luôn quét lên một cái sổ RỖNG — không phải rủi ro,
// mà là điều chắc chắn theo cấu trúc. Hậu quả đo được: nó sẽ dập boundary lên
// `profiles` và tài khoản DEMO mất chính dòng profile của mình (1 → 0).
//
// File migration này vì thế CHỈ tạo bảng và gieo hạt. Generator và event trigger
// nằm ở GĐ5, sau khi sổ đã có nội dung.
const soMienTru = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807190050_gd1_so_mien_tru_org_boundary.sql"),
  "utf8",
);

const doiTen = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807190100_gd1_doi_ten_np_org_boundary.sql"),
  "utf8",
);

const chiLenh = (sql: string) =>
  sql
    .split("\n")
    .filter((d) => !/^\s*--/.test(d))
    .join("\n");

describe("GĐ1 — sổ đăng ký miễn trừ", () => {
  it("chạy trong đúng một transaction", () => {
    expect(soMienTru.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(soMienTru.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("tạo bảng trong app_private với đủ cột bắt buộc", () => {
    expect(soMienTru).toMatch(/CREATE TABLE IF NOT EXISTS app_private\.org_boundary_exemptions/);
    for (const cot of ["table_name", "reason", "decided_by", "expires_at", "replacement_policy"]) {
      expect(soMienTru).toContain(cot);
    }
    expect(soMienTru).toMatch(/table_name\s+text\s+PRIMARY KEY/);
  });

  it("ba cột lý do là NOT NULL — miễn trừ không có lý do là miễn trừ vô hạn", () => {
    expect(soMienTru).toMatch(/reason\s+text\s+NOT NULL/);
    expect(soMienTru).toMatch(/decided_by\s+text\s+NOT NULL/);
    expect(soMienTru).toMatch(/expires_at\s+date\s+NOT NULL/);
  });

  it("TUYỆT ĐỐI chưa có generator hay event trigger — chúng thuộc GĐ5", () => {
    expect(chiLenh(soMienTru)).not.toMatch(/CREATE EVENT TRIGGER/i);
    expect(chiLenh(soMienTru)).not.toMatch(/CREATE POLICY/i);
    expect(chiLenh(soMienTru)).not.toMatch(/FOR .* IN\s+SELECT[\s\S]{0,200}pg_class/i);
  });

  it("gieo đúng 7 bảng ĐÃ ĐO là sẽ hỏng nếu gắn boundary", () => {
    for (const bang of [
      "ai_providers",
      "ai_copilot_settings",
      "profiles",
      "roles",
      "settings",
      "ai_chat_threads",
      "ai_chat_messages",
    ]) {
      expect(soMienTru).toContain(`'${bang}'`);
    }
  });

  it("KHÔNG miễn trừ hai bảng đo được là không rò — chúng thuộc nhóm vá an toàn", () => {
    // Kế hoạch v2 đề xuất miễn trừ cả ai_usage_logs và ai_copilot_entitlements
    // với lý do "phải phân loại tường minh". Đo thật thì cả hai đã được rào sẵn
    // theo chủ sở hữu: ai_usage_logs 124 dòng/1 tổ chức, nathan 0, demo.chunha 0;
    // ai_copilot_entitlements 1 dòng và chủ nó LÀ super admin. Gắn boundary
    // không lấy mất của ai thứ gì, nên miễn trừ chúng là làm sổ nói dối về
    // phạm vi của chính nó. Phân loại tường minh ≠ nhét vào sổ miễn trừ.
    const khoiGieo = soMienTru.slice(
      soMienTru.indexOf("INSERT INTO app_private.org_boundary_exemptions"),
      soMienTru.indexOf("ON CONFLICT (table_name)"),
    );
    expect(khoiGieo).not.toContain("'ai_usage_logs'");
    expect(khoiGieo).not.toContain("'ai_copilot_entitlements'");
    // Và có chốt runtime chặn ai đó nhét lại về sau.
    expect(soMienTru).toMatch(/ai_usage_logs[\s\S]{0,400}RAISE EXCEPTION/);
  });

  it("KHÔNG gieo ba bảng không có cột organization_id — chúng thuộc GĐ7", () => {
    // Generator dò theo cột organization_id nên không bao giờ với tới chúng;
    // gieo vào đây chỉ làm sổ nói dối về phạm vi của chính nó.
    //
    // Chỉ soi ĐÚNG khối INSERT. Soi cả file sẽ báo đỏ nhầm, vì khối verify có
    // nhắc tên ba bảng này — nhưng nhắc để CHẶN chúng, tức đúng thứ ta muốn.
    const khoiGieo = soMienTru.slice(
      soMienTru.indexOf("INSERT INTO app_private.org_boundary_exemptions"),
      soMienTru.indexOf("ON CONFLICT (table_name)"),
    );
    expect(khoiGieo.length).toBeGreaterThan(500);

    for (const bang of [
      "permission_definitions",
      "legacy_owner_allowlist",
      "authorization_migration_exceptions",
    ]) {
      expect(khoiGieo).not.toContain(`'${bang}'`);
    }
  });

  it("có chốt runtime chặn ba bảng đó lọt vào sổ về sau", () => {
    // Test tĩnh chỉ canh được file này. Chốt trong migration canh cả những lần
    // ai đó INSERT tay vào sổ sau này.
    expect(soMienTru).toMatch(/permission_definitions[\s\S]{0,120}RAISE EXCEPTION|RAISE EXCEPTION[\s\S]{0,200}GĐ7/);
  });

  it("mỗi lý do là số đo, không phải lời khai", () => {
    // Sổ miễn trừ hỏng theo đúng một kiểu: lý do viết chung chung thì không ai
    // kiểm lại được, và miễn trừ tạm biến thành vĩnh viễn.
    expect(soMienTru).toMatch(/đo[:\s]/i);
    expect(soMienTru).toMatch(/1\s*→\s*0|7\s*→\s*0|10\s*→\s*0/);
  });

  it("đánh dấu rõ đây là đề xuất tự động, chưa có người phê duyệt", () => {
    expect(soMienTru).toMatch(/CHỜ NGƯỜI PHÊ DUYỆT/);
  });

  it("idempotent — chạy lại không nhân đôi dòng", () => {
    expect(soMienTru).toMatch(/ON CONFLICT \(table_name\) DO (UPDATE|NOTHING)/);
  });

  it("verify đếm lại số dòng và chặn dòng thiếu lý do", () => {
    expect(soMienTru).toMatch(/DO \$verify\$/);
    expect(soMienTru).toMatch(/RAISE EXCEPTION/);
  });

  it("ghi rõ đường rollback", () => {
    expect(soMienTru).toMatch(/ROLLBACK:/);
  });
});

describe("GĐ1 — đổi tên policy sai quy ước", () => {
  it("chạy trong đúng một transaction", () => {
    expect(doiTen.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(doiTen.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("đổi np_org_boundary thành tên khớp quy ước relname||'_org_boundary'", () => {
    expect(doiTen).toMatch(
      /ALTER POLICY np_org_boundary ON public\.notification_preferences\s*\n?\s*RENAME TO notification_preferences_org_boundary;/,
    );
  });

  it("verify khẳng định KHÔNG còn policy nào lệch quy ước", () => {
    expect(doiTen).toMatch(/DO \$verify\$/);
    expect(doiTen).toMatch(/relname \|\| '_org_boundary'/);
    expect(doiTen).toMatch(/RAISE EXCEPTION/);
  });

  it("nêu lý do: tên viết tắt làm gate đếm nhầm là 'thiếu' vĩnh viễn", () => {
    expect(doiTen).toMatch(/272|273|đếm nhầm|thiếu VĨNH VIỄN/i);
  });

  it("ghi rõ đường rollback", () => {
    expect(doiTen).toMatch(/ROLLBACK:/);
  });
});
