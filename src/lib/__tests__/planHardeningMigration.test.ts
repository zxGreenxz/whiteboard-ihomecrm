import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseMoneyInput, formatMoney, sameMoney } from "@/lib/moneyInput";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const w1 = readMigration("20260730190000_plan_hardening_wave1.sql");
const w2 = readMigration("20260730200000_plan_hardening_wave2.sql");

describe("Siết plan đợt 1 — những lỗ ma trận bới ra", () => {
  it("repeat_* rời khỏi metadata sang trục tiền", () => {
    // Cron recurring_vouchers_daily biến repeat_* thành máy in tiền: nó INSERT
    // phiếu con APPROVED vào SỔ CỦA PHIẾU MẸ. Xếp chúng vào meta là cho người
    // chỉ có income_expenses.edit trên toà bật máy in trên phiếu người khác.
    expect(w1).toContain("v_meta_keys text[] := ARRAY[''name'',''notes'',''attachments''];");
    expect(w1).toMatch(/''repeat_cycle'',''repeat_count'',''repeat_infinity'',''repeat_auto_approve'',/);
    expect(w1).toContain("''payer_name'',''receive_bank_name'',''receive_bank_account'',");
    // Phải có chốt chặn: nếu prod đã đổi thì DỪNG chứ không vá mù.
    expect(w1).toContain("Không khớp mẫu neo v_money_keys — DỪNG, không vá mù");
  });

  it("p_notes = NULL không xoá trắng ghi chú, và vá CẢ assert marker", () => {
    expect(w1).toContain("notes       = COALESCE(p_notes, notes)");
    expect(w1).toContain("COALESCE(p_notes, v_before.notes)");
    expect(w1).toMatch(/Phải vá CẢ HAI chỗ/);
  });

  it("is_org_owner_v1 tôn trọng cửa sổ hiệu lực của BINDING", () => {
    // Cả repo thu hồi vai trò bằng rb.valid_to = now(); thiếu vế này thì người
    // đã bị tước vai chủ vẫn đi thẳng qua Đợt 1/2/4/6.
    expect(w1).toMatch(/COALESCE\(rb\.valid_from, '-infinity'::timestamptz\) <= now\(\)/);
    expect(w1).toMatch(/rb\.valid_to IS NULL OR rb\.valid_to > now\(\)/);
  });

  it("lock_cashbook_period_v1 không còn là cửa cho client", () => {
    expect(w1).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.lock_cashbook_period_v1\(uuid, date, boolean\)\s*\n\s*FROM authenticated, anon, service_role;/,
    );
  });

  it("vị ngữ kỳ-mở soi cả handover_transfer_id", () => {
    expect(w1).toContain("v_row.handover_transfer_id IS NOT NULL");
    expect(w1).toContain("v.handover_transfer_id IS NOT NULL");
  });

  it("chặn ghi tay cột dẫn xuất paid_amount, và guard là SECURITY INVOKER", () => {
    expect(w1).toContain("guard_invoice_derived_columns");
    expect(w1).toContain("a00_invoice_derived_guard");
    expect(w1).toContain("NEW.paid_amount IS DISTINCT FROM OLD.paid_amount");
    // Chỉ nổ với vai client — writer SECURITY DEFINER (postgres) phải đi lọt.
    expect(w1).toContain("current_user NOT IN ('authenticated', 'anon')");
    // KHÔNG được khai SECURITY DEFINER: trong hàm DEFINER thì current_user luôn
    // là postgres nên guard sẽ không chặn được ai.
    const fn = w1.slice(
      w1.indexOf("FUNCTION public.guard_invoice_derived_columns"),
      w1.indexOf("DROP TRIGGER IF EXISTS a00_invoice_derived_guard"),
    );
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  it("KHÔNG revoke cả bảng invoices/payments khỏi authenticated", () => {
    // FE có 8 đường ghi hợp lệ (status, approved_at, notes, subtotal…);
    // revoke cả bảng là gãy app. Chỉ TRUNCATE bị thu hồi.
    expect(w1).toContain("REVOKE TRUNCATE ON public.invoices FROM authenticated;");
    expect(w1).not.toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.invoices FROM authenticated/);
    expect(w1).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoices FROM anon;");
  });
});

describe("Siết plan đợt 2 — vị ngữ đọc phải nói đúng sự thật của writer", () => {
  it("khoá kỳ áp dụng cho CẢ HAI chế độ kế toán", () => {
    // Quyết định #5 nói về KỲ, không nói về chế độ. Bản Đợt 5 đặt vòng kiểm
    // trong nhánh linh hoạt nên Chuẩn kế toán đi thẳng — đo thật đã hoàn tác
    // được khoản thu của tháng lợi nhuận đã chốt.
    expect(w2).toContain("KIỂM KỲ CHO CẢ HAI CHẾ ĐỘ");
    expect(w2).toContain("Không khớp mẫu neo nhánh kiểm kỳ — DỪNG, không vá mù");
  });

  it("can_reverse_collection_v1 kiểm đủ quyền, LIFO và credit như writer", () => {
    const fn = w2.slice(
      w2.indexOf("FUNCTION public.can_reverse_collection_v1"),
      w2.indexOf("FUNCTION public.can_flex_cancel_v1"),
    );
    expect(fn).toContain("'thu_tien.undo'");
    expect(fn).toContain("'NO_PERMISSION'");
    expect(fn).toContain("'NOT_LIFO'");
    expect(fn).toContain("'CREDIT_USED'");
    // Quyền phải kiểm ở CẢ cấp toà lẫn TỪNG sổ quỹ nguồn — writer kiểm hai lần.
    expect(fn).toMatch(/'thu_tien\.undo', v_inv\.building_id, NULL/);
    expect(fn).toMatch(/'thu_tien\.undo', v_inv\.building_id, t\.account_id/);
  });

  it("can_flex_cancel_v1 kiểm đủ như writer", () => {
    const fn = w2.slice(w2.indexOf("FUNCTION public.can_flex_cancel_v1"));
    for (const code of [
      "DELETED", "ALREADY_CANCELLED", "STRICT_MODE", "RESTRICTED",
      "NO_ACTIVE_POSTING", "NO_PERMISSION", "NOT_CUSTODIAN",
    ]) {
      expect(fn).toContain(`'${code}'`);
    }
    expect(fn).toContain("'income_expenses.cancel'");
    expect(fn).toContain("assert_cashbook_access_v2");
    // Chủ tổ chức / super admin vào thẳng — đúng quyết định #4.
    expect(fn).toContain("is_org_owner_v1");
  });

  it("cả hai reader vẫn không rò rỉ sang tổ chức khác", () => {
    for (const fnName of ["can_reverse_collection_v1", "can_flex_cancel_v1"]) {
      const fn = w2.slice(w2.indexOf("FUNCTION public." + fnName));
      expect(fn).toContain("organization_memberships");
    }
  });

  it("cancel_income_expense_flex_v1 kiểm thành viên TRƯỚC mọi thông điệp", () => {
    // Thứ tự cũ để lộ: phiếu có tồn tại không, system_source gì, và cả TÊN SỔ
    // QUỸ + ngày chốt của tổ chức khác qua [CASHBOOK_CLOSED].
    expect(w2).toContain("người ngoài không được nghe");
    expect(w2).toContain("Không thuộc tổ chức của phiếu");
  });
});

describe("Đọc số tiền người dùng gõ", () => {
  it("hiểu dấu chấm phân cách hàng nghìn kiểu Việt", () => {
    // Regex cũ giữ dấu chấm: "2.655.000" -> NaN (nút xác nhận không bao giờ
    // bật) và "-680.000" -> -680 (SAI 1000 lần, ghi thẳng vào biên bản chốt sổ).
    expect(parseMoneyInput("2.655.000")).toBe(2655000);
    expect(parseMoneyInput("2655000")).toBe(2655000);
    expect(parseMoneyInput("-680.000")).toBe(-680000);
    expect(parseMoneyInput("2.655.000đ")).toBe(2655000);
    expect(parseMoneyInput("1.000")).toBe(1000);
  });

  it("rỗng / rác trả null chứ không phải 0", () => {
    // Trả 0 sẽ thành "đã đếm 0đ" — một con số hợp lệ nhưng sai.
    for (const s of ["", "   ", "abc", "-", null, undefined]) {
      expect(parseMoneyInput(s as string)).toBeNull();
    }
  });

  it("so tiền theo đồng, chịu được cả number lẫn string từ jsonb", () => {
    expect(sameMoney(2655000, "2655000")).toBe(true);
    expect(sameMoney("2655000.00", 2655000)).toBe(true);
    expect(sameMoney(2655000, 2655001)).toBe(false);
    expect(sameMoney(null, 1)).toBe(false);
    expect(sameMoney(1, undefined)).toBe(false);
  });

  it("định dạng lại theo kiểu Việt", () => {
    expect(formatMoney(2655000)).toContain("2.655.000");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(Number.NaN)).toBe("—");
  });
});

const w3 = readFileSync(
  resolve(process.cwd(), "supabase/migrations", "20260730210000_plan_hardening_wave3.sql"),
  "utf8",
);

describe("Siết plan đợt 3 — hai lỗi làm Đợt 6 bất khả dụng", () => {
  it("hàm đọc gọi authz phải VOLATILE, không được STABLE", () => {
    // PostgREST chạy hàm STABLE/IMMUTABLE trong transaction READ ONLY, mà
    // authorize_tenant_action_v3 có SELECT … FOR SHARE ⇒ 25006. Đã tái hiện.
    expect(w3).toContain("ALTER FUNCTION %s VOLATILE");
    for (const fn of [
      "cashbook_closing_blockers_v1", "cashbook_close_confirmers_v1",
      "can_reverse_collection_v1", "can_flex_cancel_v1",
    ]) {
      expect(w3).toContain(fn);
    }
    expect(w3).toContain("25006");
  });

  it("cashbook_balance_as_of_v1 tra membership và dùng đúng helper phạm vi nhìn", () => {
    // assert_cashbook_access_v2(...,'KNOWER',NULL) ném 42501 cho MỌI người vì nó
    // không tự tra membership; và nó so possession_kind CHÍNH XÁC nên CUSTODIAN
    // cũng trượt. Helper đúng là ie_visible_cashbook_ids_v1 (doctrine Đợt 0).
    expect(w3).toContain("ie_visible_cashbook_ids_v1");
    expect(w3).toContain("Không có quyền xem sổ quỹ này");
    expect(w3).toMatch(/KHÔNG dùng được ở đây vì nó so/);
  });

  it("chốt sổ lệch thì lập phiếu điều chỉnh NGOÀI KQKD rồi mới ghi biên bản", () => {
    expect(w3).toContain("cashbook.closing.diff");
    expect(w3).toContain("business_result_accounting");
    expect(w3).toMatch(/Thừa quỹ khi chốt sổ/);
    expect(w3).toMatch(/Thiếu quỹ khi chốt sổ/);
    // Hậu điều kiện: số dư PHẢI bằng số hai bên đã đếm, sai thì RAISE.
    expect(w3).toMatch(/vẫn khác số đã đếm \(%\) — DỪNG, không đóng băng con số sai/);
  });

  it("chặn NaN đúng cách — numeric của Postgres KHÁC float", () => {
    // 'NaN'::numeric = 'NaN'::numeric là TRUE, nên phép thử x = x KHÔNG bắt được.
    expect(w3).toContain("p_counted_balance = ''NaN''::numeric");
    expect(w3).toContain("p_counted_balance = 'NaN'::numeric");
    expect(w3).toMatch(/numeric của Postgres KHÁC float/);
  });
});

const w4 = readMigration("20260730220000_voucher_change_log_and_creator_cancel.sql");

describe("Người tạo được huỷ phiếu mình tạo + nhật ký trước/sau", () => {
  it("THÊM cửa người tạo, KHÔNG bỏ cửa người giữ sổ / chủ tổ chức", () => {
    // Bỏ hai cửa cũ thì người giữ sổ hết dọn được phiếu rác của nhân viên đã nghỉ.
    expect(w4).toContain("v.user_id IS DISTINCT FROM v_actor THEN");
    expect(w4).toContain("is_org_owner_v1");
    expect(w4).toMatch(/GIỮ nguyên hai cửa cũ/);
  });

  it("reader can_flex_cancel_v1 khớp cửa mới, không nói dối", () => {
    expect(w4).toContain("v.user_id IS DISTINCT FROM auth.uid() THEN");
  });

  it("nhật ký bắt bằng TRIGGER nên không đường ghi nào lọt", () => {
    // Vá từng writer sẽ sót: annotate, quick edit, compat, huỷ linh hoạt, cầu
    // a85, và cả psql tay. Trigger tóm hết.
    expect(w4).toContain("z99_ie_change_log");
    expect(w4).toContain("z99_ie_items_change_log");
    expect(w4).toMatch(/AFTER UPDATE OR DELETE ON public\.income_expenses/);
    expect(w4).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.income_expense_items/);
  });

  it("lưu giá trị TRƯỚC và SAU, bỏ cột nhiễu", () => {
    expect(w4).toContain("before            jsonb");
    expect(w4).toContain("after             jsonb");
    expect(w4).toContain("changed_cols      text[]");
    // Không lọc nhiễu thì mỗi lần ghi sổ đẻ một dòng rỗng nghĩa.
    expect(w4).toContain("v_noise");
    expect(w4).toMatch(/'updated_at', 'created_at', 'approval_version', 'posting_version'/);
    expect(w4).toContain("RETURN NULL;   -- chỉ nhiễu, không ghi");
  });

  it("nhật ký là append-only, không sửa/xoá/truncate được", () => {
    expect(w4).toContain("a00_ie_change_log_append_only");
    expect(w4).toContain("a00_ie_change_log_no_truncate");
    expect(w4).toMatch(/REVOKE ALL ON app_private\.income_expense_change_log/);
  });

  it("KHÔNG đụng chuỗi hash của income_expense_audit_log", () => {
    // Bảng đó có sequence_no + prev_event_hash + event_hash; thêm cột vào là
    // đụng chính cơ chế toàn vẹn của nó.
    expect(w4).not.toMatch(/ALTER TABLE public\.income_expense_audit_log/);
  });

  it("KHÔNG mở sửa tiền — quyết định #2 giữ nguyên", () => {
    expect(w4).toMatch(/GIỮ NGUYÊN quyết định #2/);
    expect(w4).not.toMatch(/v_money_keys/);
  });
});

const w5 = readMigration("20260730240000_profit_month_lock_guard.sql");
const w6 = readMigration("20260730250000_undo_by_collector_and_batch_cancel_gate.sql");

describe("Khoá tháng đã chốt lợi nhuận — và mở khoá nó", () => {
  it("là TRIGGER chứ không phải vị ngữ", () => {
    // [PROFIT_LOCKED] cũ chỉ là vị ngữ vài hàm gọi khi SỬA/HUỶ. Đo thật: tạo
    // phiếu chi mới 777.000đ vào tháng 06/2026 đã chốt & đã chia — TẠO ĐƯỢC.
    for (const t of ["a02_ie_profit_lock_ins", "a02_ie_profit_lock_upd",
                     "a02_ie_profit_lock_del", "a02_ie_items_profit_lock"]) {
      expect(w5).toContain(t);
    }
  });

  it("chừa cửa cho chủ tổ chức / super admin (chủ chọn phương án 2)", () => {
    expect(w5).toMatch(/is_super_admin\(\) OR app_private\.is_org_owner_v1/);
  });

  it("ba ngoại lệ có chủ ý, không phải sơ hở", () => {
    // 1) ngoài KQKD không góp vào số đã chia
    expect(w5).toContain("business_result_accounting");
    // 2) cron: 07/2026 khoá từ 20/07 trong khi tháng vẫn chạy — chặn là cron chết
    expect(w5).toMatch(/IF v_actor IS NULL THEN/);
    expect(w5).toMatch(/recurring_vouchers_daily/);
    // 3) quyết định #8: vẫn thêm được ảnh/ghi chú
    expect(w5).toContain("'ANNOTATE'");
  });

  it("canh cả hạng mục — đổi chỗ giữ nguyên tổng vẫn phải chặn", () => {
    expect(w5).toMatch(/TỔNG KHÔNG ĐỔI/);
  });

  it("xét cả phía cũ lẫn phía mới", () => {
    // Đẩy phiếu RA khỏi tháng đã chốt cũng là đổi số của tháng đó.
    expect(w5).toMatch(/TG_OP <> 'INSERT' THEN OLD\.building_id/);
    expect(w5).toMatch(/TG_OP <> 'DELETE' THEN NEW\.building_id/);
  });

  it("mở khoá: GRANT hàm đã có sẵn, và chỉ GRANT khi hàm TỰ gác quyền", () => {
    // unlock_profit_month_v1 tồn tại từ trước, gác bằng shareholder_profit.unlock
    // (đúng 2 người có: chủ mỗi org), nhưng ACL là postgres-only nên vô dụng.
    expect(w5).toContain("GRANT EXECUTE ON FUNCTION public.unlock_profit_month_v1(text, uuid[]) TO authenticated");
    expect(w5).toContain("GRANT EXECUTE ON FUNCTION public.lock_profit_month_v1(text, jsonb) TO authenticated");
    expect(w5).toMatch(/không tự gác quyền — KHÔNG GRANT/);
  });
});

describe("Hoàn tác chỉ người đã thu + gác nút huỷ cả đợt", () => {
  it("hoàn tác đòi ĐÚNG người đã thu", () => {
    expect(w6).toContain("CHÍNH NGƯỜI ĐÃ THU");
    expect(w6).toMatch(/src\.user_id = v_actor/);
    expect(w6).toContain("Chỉ người đã thu khoản này mới hoàn tác được");
  });

  it("giữ cửa chủ tổ chức, nếu không khoản thu của nhân viên nghỉ là bất khả hoàn tác", () => {
    expect(w6).toMatch(/nhân viên đã nghỉ là bất khả hoàn tác vĩnh viễn/);
    expect(w6).toMatch(/is_org_owner_v1\(v_collection\.organization_id, v_actor\)/);
  });

  it("reader khớp writer bằng mã NOT_COLLECTOR", () => {
    expect(w6).toContain("'NOT_COLLECTOR'");
  });

  it("huỷ cả đợt có cổng quyền + ghi dấu vết", () => {
    expect(w6).toContain("'income_expenses.cancel'");
    expect(w6).toContain("assert_cashbook_access_v2");
    expect(w6).toContain("income_expense_cancellations");
    expect(w6).toContain("COMPAT_BATCH_CANCEL");
  });
});

const w7 = readMigration("20260730260000_profit_lock_cover_out_of_pnl.sql");
const w8 = readMigration("20260730270000_annotate_evidence_protection.sql");

describe("Khoá kỳ phủ luôn phiếu ngoài KQKD do người dùng tạo", () => {
  it("ranh giới là NGƯỜI TẠO, không phải loại phiếu", () => {
    // Khoá tuốt sẽ chặn luôn hai chân bàn giao tiền mặt (20 phiếu
    // handover.transfer đều ngoài KQKD) — tiền trao tay ngoài đời mà sổ không
    // ghi được. Ranh giới đúng: ngoài KQKD + không có system_source.
    expect(w7).toMatch(/business_result_accounting, true\) OR OLD\.system_source IS NULL/);
    expect(w7).toMatch(/business_result_accounting, true\) OR NEW\.system_source IS NULL/);
    expect(w7).toMatch(/handover\.transfer/);
  });

  it("giữ nguyên cửa chủ + ngoại lệ cron + cửa ANNOTATE", () => {
    expect(w7).toMatch(/is_super_admin\(\) OR app_private\.is_org_owner_v1/);
    expect(w7).toMatch(/IF v_actor IS NULL THEN/);
    expect(w7).toContain("'ANNOTATE'");
  });

  it("hạng mục dùng cùng ranh giới", () => {
    expect(w7).toMatch(/business_result_accounting, true\) OR ie\.system_source IS NULL/);
  });
});

describe("Bảo vệ bằng chứng trên phiếu đã ghi sổ", () => {
  it("gỡ ảnh phiếu ĐÃ GHI SỔ chỉ dành cho chủ tổ chức", () => {
    expect(w8).toContain("TIỀN ĐÃ RỜI KÉT");
    expect(w8).toMatch(/posting_status, ''UNPOSTED''\) <> ''POSTED''/);
    expect(w8).toContain("is_org_owner_v1");
  });

  it("ghi chú trên phiếu đã ghi sổ bị ép sang NỐI THÊM", () => {
    expect(w8).toContain("p_note_mode := ''APPEND''");
  });

  it("KHÔNG chặn việc THÊM ảnh/ghi chú — quyết định #8 còn nguyên", () => {
    expect(w8).toMatch(/Quyết định #8 của chủ KHÔNG bị đụng/);
  });

  it("guard ANNOTATE mới phủ MỌI phiếu, không chỉ 175 phiếu flow-owned", () => {
    // Nhánh cũ nằm sau early-return "không flow-owned" của guard đóng băng.
    expect(w8).toContain("a01_ie_annotate_scope_delta");
    expect(w8).toContain("ie_annotate_scope_delta_guard");
    // Phải là SECURITY INVOKER (không khai DEFINER) và không đụng 4 hàm cấm.
    expect(w8).not.toMatch(/CREATE OR REPLACE FUNCTION app_private\.guard_income_expense_owned_payload/);
  });

  it("trần 5000 ký tự tính trên chuỗi KẾT QUẢ", () => {
    expect(w8).toContain("vượt 5000 ký tự");
  });

  it("ghi rõ p_idempotency_key là tham số chết thay vì im lặng", () => {
    expect(w8).toMatch(/COMMENT ON FUNCTION public\.annotate_income_expense_v1/);
    expect(w8).toMatch(/tham số chết/);
  });
});
