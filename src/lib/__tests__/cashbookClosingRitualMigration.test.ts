import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ALL_PAGE_FEATURES, featureKey } from "@/lib/permissionPages";
import { ACTION_LABELS, actionsForModule } from "@/lib/permissions";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const perms = readMigration("20260730160000_cashbook_closing_permissions.sql");
const ritual = readMigration("20260730170000_cashbook_closing_ritual.sql");
const handover = readMigration("20260730180000_handover_confirm_open_period.sql");

/** Bỏ comment: các file này cảnh báo về đúng những mẫu mà bài test đi tìm. */
const permsCode = perms.replace(/--[^\n]*/g, "");
/** Gộp xuống dòng để bắt được câu GRANT trải trên hai dòng. */
const ritualFlat = ritual.replace(/\s+/g, " ");

describe("Đợt 6 — migration quyền đi TRƯỚC và tự chứng minh", () => {
  it("thêm đúng hai khoá vào permission_definitions", () => {
    expect(perms).toContain("'cashbooks.close'");
    expect(perms).toContain("'cashbooks.close_confirm'");
    expect(perms).toContain("INSERT INTO public.permission_definitions");
  });

  it("KHÔNG đặt requires_cashbook_possession trên khoá", () => {
    // Người XÁC NHẬN là bên NHẬN bàn giao — theo định nghĩa họ chưa giữ sổ.
    // Đặt possession=true là khoá vĩnh viễn vế thứ hai của nghi thức.
    expect(perms).toMatch(/requires_cashbook_possession[\s\S]{0,400}?false/);
    expect(perms).toContain("assert_cashbook_access_v2");
  });

  it("KHÔNG dùng lối tắt member_type='OWNER'", () => {
    // Lối tắt đó đi vòng qua tenant_emergency_denies và mọi tầng DENY.
    expect(permsCode).not.toMatch(/member_type\s*=\s*'OWNER'/);
  });

  it("tự ASSERT trước COMMIT rằng nghi thức HAI BÊN chạy được", () => {
    expect(perms).toContain("authorize_tenant_action_v3");
    expect(perms).toMatch(/KHÔNG sổ quỹ nào có đủ hai bên để chốt/);
    // Assert phải hỏi theo phạm vi CASHBOOK — writer sẽ hỏi như vậy, và cạnh
    // BUILDING không phủ CASHBOOK.
    expect(perms).toMatch(/'cashbooks\.close', NULL, bk\.id/);
  });

  it("cấp quyền đề nghị theo sổ ĐANG GIỮ, không cấp tràn theo vai trò", () => {
    expect(perms).toContain("cashbook_possession_bindings");
    expect(perms).toContain("'CUSTODIAN'");
    expect(perms).toContain("member_permission_overrides");
    expect(perms).toContain("'SCOPED'");
  });

  it("khoá xác nhận hẹp hơn: chỉ vai trò chủ sở hữu", () => {
    expect(perms).toMatch(
      /'cashbooks\.close_confirm'[\s\S]{0,200}?FROM public\.organization_roles r\s*\n\s*WHERE r\.name = 'Chủ sở hữu tổ chức'/,
    );
  });
});

describe("Đợt 6 — nghi thức chốt sổ", () => {
  it("một cơ sở số dư duy nhất, sao chép đúng công thức của accounts_with_balance", () => {
    expect(ritual).toContain("cashbook_balance_as_of_v1");
    expect(ritual).toContain("p.event_kind IN ('POSTING', 'REVERSAL')");
    expect(ritual).toContain("p.posted_on <= p_as_of");
    expect(ritual).toContain("l.organization_id = a.organization_id");
    expect(ritual).toContain("POSTING_TRUTH_BY_POSTED_ON");
  });

  it("người xác nhận PHẢI khác người đề nghị — chặn ở tầng bảng", () => {
    expect(ritual).toContain("closure_request_two_party_chk");
    expect(ritual).toMatch(/CHECK \(confirmer_user_id <> proposed_by\)/);
    expect(ritual).toContain("Người đề nghị không tự xác nhận được");
  });

  it("mỗi sổ chỉ một đề nghị đang chờ", () => {
    expect(ritual).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_cashbook_closure_request_pending[\s\S]{0,200}WHERE status = 'PENDING'/);
  });

  it("ép ngày chốt = HÔM NAY", () => {
    // Đếm tiền là đếm BÂY GIỜ; so với số dư một ngày quá khứ thì phần chênh
    // chính là giao dịch ở giữa, và hệ thống sẽ khoá vĩnh viễn con số sai.
    expect(ritual).toContain("v_today date := CURRENT_DATE");
    expect(ritual).toMatch(/closed_through ÉP = HÔM NAY/);
  });

  it("chạy LẠI blockers ở bước xác nhận và fail cứng", () => {
    expect(ritual).toMatch(/sổ đã đổi kể từ lúc đề nghị/);
    // Nhưng phải loại hai mã vô nghĩa ở phía người ký, nếu không người xác nhận
    // duy nhất sẽ tự chặn chính mình và không ai ký được bao giờ.
    expect(ritual).toContain("b.code NOT IN ('CLOSURE_PENDING', 'NO_CONFIRMER')");
  });

  it("tuyệt đối không duyệt hộ ở bước xác nhận", () => {
    const confirmFn = ritual.slice(
      ritual.indexOf("FUNCTION public.confirm_cashbook_closing_v1"),
      ritual.indexOf("FUNCTION public.list_cashbook_closings_v1"),
    );
    expect(confirmFn.length).toBeGreaterThan(500);
    expect(confirmFn).not.toMatch(/approve_income_expense|post_approved_income_expense/i);
    expect(confirmFn).toMatch(/KHÔNG "duyệt hộ"/);
  });

  it("tính lại số dư TƯƠI lúc ký và chặn nếu đã trôi", () => {
    expect(ritual).toMatch(/Số dư hệ thống đã đổi từ % thành %/);
    expect(ritual).toContain("USING ERRCODE = '40001'");
  });

  it("hai bên phải khai CÙNG một con số", () => {
    expect(ritual).toMatch(/Số tiền bạn đếm \(%\) khác số người giao khai \(%\)/);
  });

  it("có hậu điều kiện kỳ THẬT SỰ đóng sau khi ghi biên bản", () => {
    expect(ritual).toContain("Ghi biên bản xong nhưng kỳ chưa đóng");
    expect(ritual).toContain("cashbook_closed_through_v1");
  });

  it("blockers chặn đúng những thứ làm hỏng số đã ký", () => {
    for (const code of [
      "VIRTUAL_CASHBOOK", "ALREADY_CLOSED", "CLOSURE_PENDING",
      "PENDING_APPROVAL", "APPROVED_NOT_POSTED", "HANDOVER_PENDING", "NO_CONFIRMER",
    ]) {
      expect(ritual).toContain(`'${code}'`);
    }
    // Hai cái chỉ CẢNH BÁO, không chặn.
    expect(ritual).toMatch(/'HANDOVER_BECOMES_FINAL'; blocking := false/);
    expect(ritual).toMatch(/'MISSING_ATTACHMENTS'; blocking := false/);
  });

  it("hàm nội bộ không lộ ra client", () => {
    expect(ritual).toContain(
      "REVOKE ALL ON FUNCTION app_private.cashbook_balance_as_of_v1(uuid, date)",
    );
    expect(ritual).toContain(
      "REVOKE ALL ON app_private.cashbook_closure_requests\n  FROM PUBLIC, anon, authenticated, service_role",
    );
    for (const g of [
      "public.cashbook_closing_blockers_v1(uuid)",
      "public.propose_cashbook_closing_v1(uuid, numeric, uuid, text)",
      "public.confirm_cashbook_closing_v1(uuid, numeric)",
      "public.cancel_cashbook_closing_v1(uuid, text)",
      "public.list_cashbook_closings_v1(uuid)",
      "public.cashbook_close_confirmers_v1(uuid)",
    ]) {
      expect(ritualFlat).toContain(`GRANT EXECUTE ON FUNCTION ${g} TO authenticated`);
    }
  });

  it("hàm đọc số dư công khai vẫn tự giới hạn phạm vi nhìn", () => {
    // Doctrine Đợt 0: hàm tổng hợp SECURITY DEFINER không tự kiểm phạm vi là
    // cửa đọc tồn quỹ sổ người khác.
    expect(ritual).toMatch(
      /FUNCTION public\.cashbook_balance_as_of_v1[\s\S]{0,1600}?assert_cashbook_access_v2/,
    );
  });
});

describe("Đợt 6 — bàn giao tiền mặt không kẹt vì kỳ đã chốt", () => {
  it("vá theo neo, có kiểm mẫu và idempotent", () => {
    expect(handover).toContain("Không khớp mẫu neo trong confirm_cash_handover");
    expect(handover).toMatch(/IF position\('v_handover_date' IN v_def\) > 0 THEN/);
    expect(handover).toContain("Vá confirm_cash_handover thất bại");
  });

  it("MỘT ngày chung cho cả hai chân", () => {
    // Hai ngày khác nhau tạo cửa sổ "tiền trên đường": tổng tiền mặt toàn tổ
    // chức hụt đúng NET trong khoảng lệch.
    expect(handover).toContain("v_h.from_account_id, v_handover_date,");
    expect(handover).toContain("v_to, v_handover_date,");
    expect(handover).toMatch(/GREATEST\(/);
    expect(handover).toMatch(/MỘT NGÀY CHUNG CHO CẢ HAI CHÂN/);
  });

  it("gọi full-qualified vì hàm gốc SET search_path='public'", () => {
    expect(handover).toContain("app_private.cashbook_closed_through_v1");
  });

  it("có trần, không đẻ phiếu ngày tương lai", () => {
    expect(handover).toContain("CURRENT_DATE + 31");
  });

  it("neo phần TÍNH là dòng comment trước INSERT, không phải dòng trong VALUES", () => {
    // Neo vào dòng `..., CURRENT_DATE,` là chèn câu lệnh gán vào giữa danh sách
    // VALUES(...) — lỗi cú pháp chỉ lộ ra lúc EXECUTE.
    expect(handover).toContain("v_anchor_calc text := '  -- ── 1 phiếu CHI tổng");
  });
});

describe("Đợt 6 — catalog quyền phía FE khớp khoá server", () => {
  it("hai khoá mới có mặt trong registry trang Sổ quỹ", () => {
    const keys = new Set(ALL_PAGE_FEATURES.map((f) => featureKey(f)));
    expect(keys.has("cashbooks.close")).toBe(true);
    expect(keys.has("cashbooks.close_confirm")).toBe(true);
  });

  it("có nhãn tiếng Việt và nằm trong danh sách action của module", () => {
    expect(ACTION_LABELS.close).toBeTruthy();
    expect(ACTION_LABELS.close_confirm).toBeTruthy();
    const actions = actionsForModule("cashbooks");
    expect(actions).toContain("close");
    expect(actions).toContain("close_confirm");
  });
});
