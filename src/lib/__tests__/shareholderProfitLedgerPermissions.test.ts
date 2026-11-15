import { describe, expect, it } from "vitest";

import { ALL_PAGES, featureValue, setPageAll, setPageViewOnly } from "@/lib/permissionPages";
import { ACTION_LABELS, actionsForModule, applyGlobalPreset, buildEmptyPermissions, buildViewOnlyPermissions } from "@/lib/permissions";

/**
 * Ba khoá của sổ tổng lợi nhuận cổ đông (migration 20261115063149). Khoá DB:
 * shareholder_profit.advance_own_cashbook | view_percent | view_building_totals
 * (gate permission-catalog đòi catalog FE == khoá DB).
 *
 * Điểm phải giữ: hai khoá "xem" KHÔNG được ở tier "view" — nút "Chỉ xem" của trang bật mọi feature
 * tier view, tức một cú bấm sẽ cấp quyền xem tỷ lệ % và doanh thu / lợi nhuận toà cho cả vai.
 */
const KHOA_MOI = ["advance_own_cashbook", "view_percent", "view_building_totals"] as const;
const trang = ALL_PAGES.find((p) => p.key === "shareholder_profit")!;

describe("quyền sổ tổng lợi nhuận cổ đông", () => {
  it("đăng ký ba action trong module shareholder_profit, có nhãn tiếng Việt", () => {
    for (const k of KHOA_MOI) expect(actionsForModule("shareholder_profit")).toContain(k);
    expect(ACTION_LABELS.advance_own_cashbook).toBe("Chi tạm ứng lợi nhuận từ sổ quỹ mình giữ");
    expect(ACTION_LABELS.view_percent).toBe("Xem tỷ lệ % chia lợi nhuận");
    expect(ACTION_LABELS.view_building_totals).toBe("Xem doanh thu / lợi nhuận toà");
  });

  it("trang Lợi nhuận cổ đông có đủ ba feature, cả ba ở tier nhạy cảm (không khoá nào tier view)", () => {
    const theo = Object.fromEntries(trang.features.map((ft) => [ft.action, ft.tier]));
    for (const k of KHOA_MOI) expect(theo[k], k).toBe("elevated");
    expect(trang.features.filter((ft) => ft.tier === "view").map((ft) => ft.action)).toEqual(["view"]);
  });

  it("mô tả xem số toà nói rõ: kèm quyền dòng tiền thì thấy cột TỔNG chi chia lợi nhuận (mọi cổ đông + lương điều hành)", () => {
    // cashbook_cash_flow_profit_payout_v1 nhận view_building_totals toàn công ty — số là tổng của cả công ty,
    // không chỉ phần của người được cấp; người cấp quyền phải đọc được điều đó ở màn phân quyền.
    const desc = trang.features.find((ft) => ft.action === "view_building_totals")?.desc ?? "";
    expect(desc).toContain("Kèm quyền xem báo cáo dòng tiền");
    expect(desc).toContain("cột tổng chi chia lợi nhuận theo tháng / toà (cộng của mọi cổ đông và lương điều hành)");
  });

  it("nút 'Chỉ xem' của trang và preset 'chỉ xem' / 'quản lý' KHÔNG bật ba khoá", () => {
    const chiXem = setPageViewOnly(setPageAll(buildEmptyPermissions(), trang, true), trang);
    for (const ft of trang.features) expect(featureValue(chiXem, ft), ft.action).toBe(ft.action === "view");

    for (const p of [applyGlobalPreset(buildEmptyPermissions(), "view"), applyGlobalPreset(buildEmptyPermissions(), "manage"), buildViewOnlyPermissions()]) {
      for (const k of KHOA_MOI) expect(p.shareholder_profit?.[k], k).toBe(false);
    }
  });
});
