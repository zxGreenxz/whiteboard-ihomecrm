import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const migrationPath =
  "supabase/migrations/20260827140000_chu_cong_ty_doi_co_kqkd_phieu_bo_coc.sql";
const sql = readFileSync(join(process.cwd(), migrationPath), "utf8");

/**
 * Thân hàm ĐANG CHẠY = lần CREATE cuối cùng trên toàn bộ thư mục migration.
 *
 * Bắt buộc dùng khuôn này cho mọi khẳng định VỀ HÀNH VI hàm (xem
 * scripts/check-migration-test-liveness.mjs): ghim một file cụ thể thì vế
 * `actual` thành hằng số và test xanh vĩnh viễn kể cả khi một file muộn hơn
 * định nghĩa lại hàm.
 */
function thanHamDangChay(tenHam: string, schema = "public"): string {
  const signature = `FUNCTION ${schema}.${tenHam}(`;
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let hit: string | null = null;
  for (const f of files) {
    const body = readFileSync(join(MIG_DIR, f), "utf8");
    if (body.includes(signature)) hit = body;
  }
  expect(hit, `không thấy định nghĩa nào của ${tenHam}`).not.toBeNull();
  const body = hit as string;
  let start = -1;
  for (let i = body.indexOf(signature); i >= 0; i = body.indexOf(signature, i + 1)) {
    if (/\bCREATE\s+(OR\s+REPLACE\s+)?$/i.test(body.slice(Math.max(0, i - 24), i))) {
      start = i;
    }
  }
  expect(start, `không thấy định nghĩa của ${tenHam}`).toBeGreaterThan(-1);
  const tag = /\bAS (\$[A-Za-z_]*\$)/.exec(body.slice(start))?.[1] ?? "$$";
  const open = body.indexOf(tag, start);
  const close = body.indexOf(tag, open + tag.length);
  expect(close, signature).toBeGreaterThan(open);
  return body.slice(start, close + tag.length);
}

// ── Cấu trúc file (khẳng định VỀ CHÍNH FILE NÀY — ghim file là đúng) ────────

describe("Migration đổi cờ KQKD phiếu bỏ cọc — cấu trúc file", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("nạp lại schema cache của PostgREST sau COMMIT", () => {
    const iCommit = sql.lastIndexOf("COMMIT;");
    const iNotify = sql.indexOf("NOTIFY pgrst");
    expect(iNotify).toBeGreaterThan(iCommit);
  });

  it("cấp quyền theo cặp REVOKE/GRANT cho cả hai RPC public", () => {
    for (const chuKy of [
      "public.set_forfeit_voucher_kqkd_v1(uuid, boolean, text)",
      "public.is_company_owner_self_v1()",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${chuKy}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${chuKy}`);
    }
  });

  it("helper nhận diện chủ công ty KHÔNG được cấp cho authenticated", () => {
    // Nó là vị ngữ nội bộ, không phải API. Cấp cho authenticated là biến một
    // phép kiểm thành một endpoint dò quyền.
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION app_private.ie_actor_is_company_owner_v1(uuid, uuid)\n  FROM PUBLIC, anon, authenticated, service_role;",
    );
    expect(sql).not.toContain(
      "GRANT EXECUTE ON FUNCTION app_private.ie_actor_is_company_owner_v1",
    );
  });

  it("có chốt chặn drift trước khi vá và smoke sau khi vá", () => {
    expect(sql).toMatch(/DO \$va_assert\$/);
    expect(sql).toMatch(/DO \$smoke\$/);
    // Vá tại chỗ phải NÉM khi mất neo, không được im lặng bỏ qua.
    expect(sql).toContain("không còn vế kqkd mà bản vá này neo vào");
  });

  it("tự bỏ qua khi đã vá (idempotent)", () => {
    expect(sql).toContain("position('revenue.business_result_accounting IS FALSE' IN v_def) > 0");
  });
});

// ── Bất biến của cặp bỏ cọc: nới ĐÚNG một vế ───────────────────────────────

describe("Bất biến cặp bỏ cọc", () => {
  it("nới vế kqkd của chân DOANH THU theo cờ override", () => {
    expect(sql).toContain("WHEN revenue.business_result_accounting IS FALSE THEN 0");
    expect(sql).toContain("ELSE v_authorization.amount");
  });

  it("KHÔNG nới vế kqkd của chân ĐỐI ỨNG — nó phải bằng 0 vĩnh viễn", () => {
    // Chân cấn cọc là bút toán TIÊU cọc. Nới vế này là cho phép đếm tiền tiêu
    // cọc thành lợi nhuận. File phải kiểm nó còn nguyên cả trước lẫn sau khi vá.
    expect(sql).toContain("COALESCE(offset_voucher.kqkd_amount, 0) = 0");
    expect(sql).not.toContain("offset_voucher.business_result_accounting");
  });

  it("không đụng bất kỳ vế nào khác của bất biến", () => {
    // Chỉ có đúng một `replace(` trong toàn file, và nó nhắm vào v_neo.
    expect(sql.match(/v_def := replace\(/g)).toHaveLength(1);
  });
});

// ── Hành vi RPC (đo ĐỊNH NGHĨA ĐANG CHẠY, không ghim file) ─────────────────

describe("set_forfeit_voucher_kqkd_v1 — hành vi", () => {
  const than = thanHamDangChay("set_forfeit_voucher_kqkd_v1");

  it("là SECURITY DEFINER với search_path ghim", () => {
    expect(than).toContain("SECURITY DEFINER");
    expect(than).toContain("SET search_path TO 'pg_catalog', 'app_private', 'public'");
  });

  it("khoá phiếu trước mọi phép kiểm", () => {
    expect(than).toContain("FOR UPDATE");
  });

  it("bắt buộc lý do", () => {
    expect(than).toContain("char_length(v_reason) < 8");
    expect(than).toContain("22023");
  });

  it("chỉ nhận chân DOANH THU của cặp bỏ cọc", () => {
    expect(than).toContain("'termination.forfeit_revenue'");
    // Không được có nhánh nào nhận chân đối ứng.
    expect(than).not.toContain("'termination.forfeit_offset'");
  });

  it("cửa hẹp: chủ công ty hoặc super admin, KHÔNG mượn quyền theo toà", () => {
    expect(than).toContain("public.is_super_admin()");
    expect(than).toContain("app_private.ie_actor_is_company_owner_v1");
    // ie_can_edit_money_axis_v1 nhận cả quyền income_expenses.edit theo TOÀ —
    // quá rộng cho một quyết định chính sách kế toán cấp công ty.
    expect(than).not.toContain("ie_can_edit_money_axis_v1");
  });

  it("giữ ba khoá thời gian và tự canh chiều mà assert bỏ sót", () => {
    expect(than).toContain("app_private.assert_period_open_for_edit_v1");
    // assert_period_open_for_edit_v1 đọc GIÁ TRỊ CŨ của cờ nên chiều
    // FALSE→TRUE lọt qua nó; RPC phải tự tra profit_monthly.
    expect(than).toContain("v.business_result_accounting IS FALSE AND p_kqkd IS TRUE");
    expect(than).toContain("public.profit_monthly");
    expect(than).toContain("[PROFIT_LOCKED]");
  });

  it("mở năng lực writer thanh lý và chỉ đóng thứ mình đã mở", () => {
    expect(than).toContain("app_private.begin_accounting_chain_write_v1()");
    expect(than).toContain("app_private.end_accounting_chain_write_v1()");
    expect(than).toContain("v_opened_writer");
  });

  it("chỉ ghi ĐÚNG một cột nghiệp vụ", () => {
    const iUpdate = than.indexOf("UPDATE public.income_expenses");
    const iWhere = than.indexOf("WHERE id = p_voucher", iUpdate);
    const doanSet = than.slice(iUpdate, iWhere);
    expect(doanSet).toContain("business_result_accounting = p_kqkd");
    expect(doanSet).toContain("updated_at = now()");
    for (const cotCam of [
      "total_amount",
      "account_id",
      "approval_status",
      "voucher_date",
      "building_id",
      "contract_id",
    ]) {
      expect(doanSet).not.toContain(`${cotCam} =`);
    }
  });

  it("tự kiểm lại cặp phiếu TRONG cùng transaction trước khi commit", () => {
    expect(than).toContain(
      "app_private.require_termination_forfeit_authorization_v1(p_voucher, false, false)",
    );
  });

  it("ghi nhật ký kèm lý do", () => {
    expect(than).toContain("app_private.append_income_expense_event_v1");
    expect(than).toContain("'KQKD_OVERRIDE'");
    expect(than).toContain("v_reason");
  });

  it("gọi lại cùng giá trị là no-op, không ghi nhật ký rác", () => {
    expect(than).toContain("v.business_result_accounting IS NOT DISTINCT FROM p_kqkd");
    expect(than).toContain("'changed', false");
  });
});

describe("ie_actor_is_company_owner_v1 — nhận diện chủ công ty", () => {
  const than = thanHamDangChay("ie_actor_is_company_owner_v1", "app_private");

  it("nhận CẢ vai 'Chủ công ty' mà is_org_owner_v1 bỏ sót", () => {
    // Đo prod 27/08/2026: vai này có system_key = NULL nên is_org_owner_v1 trả
    // false cho chính chủ doanh nghiệp. Đây là lý do tồn tại của hàm.
    expect(than).toContain("'TENANT_OWNER'");
    expect(than).toContain("'Chủ công ty'");
    expect(than).toContain("'Chủ sở hữu tổ chức'");
  });

  it("chỉ tính binding và membership CÒN HIỆU LỰC", () => {
    expect(than).toContain("m.status = 'ACTIVE'");
    expect(than).toContain("rb.valid_to IS NULL OR rb.valid_to > now()");
    expect(than).toContain("m.valid_to IS NULL OR m.valid_to > now()");
  });

  it("neo theo VAI, không theo quyền gắn ở scope tổ chức", () => {
    // Đo prod: trong org DEMO vai "Quản Lý Tòa" cũng được gắn scope
    // ORGANIZATION, nên neo theo quyền sẽ cho sale/kỹ thuật lọt cửa.
    expect(than).not.toContain("role_permissions");
    expect(than).not.toContain("authorization_scopes");
  });
});
