import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Guard phiếu canonical bị vá NHIỀU ĐỢT ngoài migration (scripts/authz-prepared),
// nên mỗi đợt CREATE OR REPLACE nguyên hàm và đợt sau xoá mất cửa của đợt trước:
// nhánh LINK_CONTRACT biến mất khỏi bản deploy trong khi create_contract_v2 vẫn
// mở scope đó ⇒ mọi hợp đồng ký trên phòng "Đã cọc" chết 55000 trên production.
// Test này chốt: file migration phải giữ ĐỦ mọi cửa, không cửa nào rơi lần nữa.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260805120000_ie_guard_link_contract_scope.sql"),
  "utf8",
);

describe("Guard phiếu canonical — cửa LINK_CONTRACT", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("giữ đủ cả ba cửa flex-writer, không xoá cửa của đợt vá trước", () => {
    for (const scope of ["CASHBOOK_MOVE", "ANNOTATE", "LINK_CONTRACT"]) {
      expect(sql).toContain(`w.scope = '${scope}'`);
    }
  });

  it("cửa LINK_CONTRACT chỉ một chiều NULL -> NOT NULL", () => {
    expect(sql).toContain("if old.contract_id is not null or new.contract_id is null then");
    expect(sql).toContain("link contract scope may only set contract_id from NULL of %");
  });

  it("cửa LINK_CONTRACT chỉ cho đổi contract_id + updated_at", () => {
    expect(sql).toContain("array['contract_id','updated_at']");
    expect(sql).toContain("link contract scope may only change contract_id of %");
  });

  it("KHÔNG nới allowlist token lifecycle bằng contract_id", () => {
    const allowlist = sql.slice(sql.indexOf("ALLOWLIST, not denylist"));
    expect(allowlist).not.toContain("'contract_id'");
  });

  it("giữ nguyên đường canonical: không token thì vẫn frozen", () => {
    expect(sql).toContain("app_private.ie_transition_authorization");
    expect(sql).toContain("canonical income expense % is frozen (update rejected)");
    expect(sql).toContain("canonical income expense % is frozen (delete rejected)");
  });

  it("có chốt chặn drift trước và sau khi replace", () => {
    expect(sql).toMatch(/DO \$preflight\$/);
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/RAISE EXCEPTION 'guard sau replace thiếu cửa/);
  });
});
