import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Án lệ 29/07/2026 (NATHAN, phòng 405 toà 1392QT): tạo phiếu thu hạng mục
 * "Tiền Cọc" có chọn phòng → toast "Writer phiếu nháp tổng quát đã tác động
 * trạng thái giữ phòng", không phiếu nào được tạo.
 *
 * Nguyên nhân: 20260727120000 bỏ cờ system_only của hạng mục cọc nên lần đầu
 * tiên phiếu cọc đi qua create_income_expense_v1, trong khi writer còn HAI hậu
 * kiểm viết từ thời phiếu cọc chưa vào được đây ("rooms không được đổi",
 * "contracts.deposit_paid không được đổi"). Hiệu ứng BẮT BUỘC của phiếu cọc
 * (recompute_room_reservation / recompute_contract_deposit_paid) bị chính hậu
 * kiểm coi là writer đụng nhầm state cũ → 23514 → rollback.
 *
 * Vá = NỚI ĐÚNG KHE, không tháo hậu kiểm. Test khoá cả hai chiều: khe mới phải
 * đủ hẹp, và hai chốt 23514 phải còn nguyên.
 */
const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729120000_ie_writer_allow_own_deposit_reconcile.sql",
);
const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

/** Cắt khối hậu kiểm (từ `IF <head>` tới `END IF;` ngay sau câu RAISE của nó). */
function guardBlock(head: string, raiseMessage: string): string {
  const start = sql.lastIndexOf(head);
  expect(start, `không tìm thấy khối "${head}"`).toBeGreaterThan(-1);
  const raise = sql.indexOf(raiseMessage, start);
  expect(raise, `không tìm thấy RAISE "${raiseMessage}"`).toBeGreaterThan(start);
  return sql.slice(start, sql.indexOf("END IF;", raise) + "END IF;".length);
}

const ROOM_GUARD = "Writer phiếu nháp tổng quát đã tác động trạng thái giữ phòng";
const CONTRACT_GUARD =
  "Writer phiếu nháp tổng quát đã tác động trạng thái tiền cọc hợp đồng";

describe("migration 20260729120000 — writer canonical chấp nhận phiếu cọc của chính nó", () => {
  it("migration tồn tại", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(sql.length).toBeGreaterThan(0);
  });

  describe("helper contract_deposit_paid_derived", () => {
    const block = () => {
      const start = sql.indexOf(
        "CREATE OR REPLACE FUNCTION public.contract_deposit_paid_derived(",
      );
      expect(start).toBeGreaterThan(-1);
      return sql.slice(start, sql.indexOf("COMMENT ON FUNCTION", start));
    };

    it("giữ nguyên công thức dẫn xuất: item DEPOSIT, phiếu ĐÃ DUYỆT, THU cộng CHI trừ, chặn dưới 0", () => {
      const body = block();
      expect(body).toMatch(/item\.accounting_class = 'DEPOSIT'/);
      expect(body).toMatch(/voucher\.approval_status = 'APPROVED'/);
      expect(body).toMatch(/voucher\.deleted_at IS NULL/);
      expect(body).toMatch(
        /CASE WHEN voucher\.type = 'EXPENSE' THEN -1 ELSE 1 END/,
      );
      expect(body).toMatch(/GREATEST\(/);
    });

    it("phủ cả 2 đường gắn hợp đồng: contract_id trực tiếp và contract_deposit_links", () => {
      const body = block();
      expect(body).toMatch(/public\.contract_deposit_links link_row/);
      expect(body).toMatch(
        /voucher\.contract_id = p_contract_id OR link_row\.id IS NOT NULL/,
      );
    });

    it("là hàm nội bộ — revoke anon + authenticated", () => {
      expect(sql).toMatch(
        /REVOKE ALL ON FUNCTION public\.contract_deposit_paid_derived\(uuid\) FROM PUBLIC, anon, authenticated;/,
      );
    });
  });

  it("recompute_contract_deposit_paid gọi helper thay vì nhân bản công thức", () => {
    const start = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.recompute_contract_deposit_paid(",
    );
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf("$function$;", start));
    expect(body).toMatch(
      /v_total := public\.contract_deposit_paid_derived\(p_contract_id\);/,
    );
    // Vẫn giữ luật "không có dòng cọc nào thì KHÔNG ghi đè cột" như bản cũ.
    expect(body).toMatch(/IF v_count_any = 0 THEN\n\s*RETURN;/);
    expect(body).toMatch(/deposit_paid IS DISTINCT FROM v_total/);
  });

  it("writer gom cờ 'phiếu có item hạng mục cọc' từ chính item vừa ghi", () => {
    expect(sql).toMatch(/COALESCE\(bool_or\(t\.is_deposit\), false\)/);
    expect(sql).toMatch(/v_stored_pnl_sum, v_stored_has_deposit_item/);
  });

  describe("hậu kiểm PHÒNG", () => {
    const block = () => guardBlock("IF v_room_id IS NOT NULL THEN", ROOM_GUARD);

    it("vẫn RAISE 23514 khi phòng bị đụng ngoài khe cho phép", () => {
      const body = block();
      expect(body).toMatch(new RegExp(`RAISE EXCEPTION '${ROOM_GUARD}'`));
      expect(body).toMatch(/USING ERRCODE = '23514'/);
      expect(body).toMatch(/v_room_status_after IS DISTINCT FROM v_room_status_before/);
      expect(body).toMatch(
        /v_room_updated_at_after IS DISTINCT FROM v_room_updated_at_before/,
      );
    });

    it("khe cho phép ĐỦ HẸP: chỉ phiếu THU cọc chưa gắn HĐ, và chỉ AVAILABLE -> RESERVED", () => {
      const body = block();
      expect(body).toMatch(/v_stored_has_deposit_item/);
      expect(body).toMatch(/AND v_row\.type = 'INCOME'/);
      expect(body).toMatch(/AND v_row\.contract_id IS NULL/);
      expect(body).toMatch(/AND v_room_status_before = 'AVAILABLE'/);
      expect(body).toMatch(/AND v_room_status_after = 'RESERVED'/);
    });

    it("bắt writer chứng minh trạng thái mới khớp predicate chuẩn, không tự tin suông", () => {
      expect(block()).toMatch(/AND public\.room_has_holding_deposit\(v_room_id\)/);
    });
  });

  describe("hậu kiểm HỢP ĐỒNG", () => {
    const block = () =>
      guardBlock("IF p_contract_id IS NOT NULL THEN", CONTRACT_GUARD);

    it("vẫn RAISE 23514 khi tiền cọc hợp đồng bị đụng ngoài khe cho phép", () => {
      const body = block();
      expect(body).toMatch(new RegExp(`RAISE EXCEPTION '${CONTRACT_GUARD}'`));
      expect(body).toMatch(/USING ERRCODE = '23514'/);
      expect(body).toMatch(
        /v_contract_deposit_paid_after IS DISTINCT FROM v_contract_deposit_paid_before/,
      );
    });

    it("chỉ nới cho phiếu CÓ item cọc, và giá trị sau cùng phải bằng SỐ DẪN XUẤT", () => {
      const body = block();
      expect(body).toMatch(/v_stored_has_deposit_item/);
      expect(body).toMatch(
        /IS NOT DISTINCT FROM public\.contract_deposit_paid_derived\(p_contract_id\)/,
      );
    });
  });

  it("không tháo chốt nào khác của writer (KQKD suy từ hạng mục vẫn còn)", () => {
    expect(sql).toMatch(
      /Trigger thu\/chi không tạo đúng các trường tài chính suy diễn/,
    );
    expect(sql).toMatch(
      /FILTER \(WHERE it\.accounting_class = 'PNL'\), 0\)/,
    );
  });
});
