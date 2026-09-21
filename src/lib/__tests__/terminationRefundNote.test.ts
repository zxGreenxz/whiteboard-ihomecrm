import { describe, expect, it } from "vitest";

import {
  buildTerminationCard,
  buildTerminationHeaderLines,
  parseTerminationRefundFacts,
  type TerminationRefundFacts,
} from "@/lib/terminationRefundNote";

/** Đúng ca trên ảnh chủ gửi 02/09: cọc 4,2tr · hoàn ngày không ở 700k · thu thêm 1.912.400. */
const goc = (over: Partial<TerminationRefundFacts> = {}): TerminationRefundFacts => ({
  voucher: {
    id: "v1", code: "PC2608070", total_amount: 2_987_600, voucher_date: "2026-08-03",
    approval_status: "UNAPPROVED", account_id: null, notes: "[HOÀN KHÁCH THANH LÝ] …",
  },
  contract: {
    contract_id: "c1", contract_number: "HĐT-056021/01042025", room_name: "104", building_name: "405PVB",
    status: "TERMINATED", start_date: "2025-04-01", end_date: "2026-03-31", expected_move_out_date: null,
    seq_in_year: 1, rent_price: 4_200_000, months: 11, total_deposit: 4_200_000, deposit_paid: 4_200_000,
    deposit_enough: true,
    deposit_vouchers: [
      { id: "d1", code: "PT2504001", voucher_date: "2025-04-01", type: "INCOME",
        deposit_amount: 4_200_000, total_amount: 8_400_000, is_combined: true },
    ],
    today: "2026-09-02", seven_days_date: "2025-04-08", seven_days_ok: true,
    rep_name: "Vũ Minh Nhật", rep_phone: "0901", commission_kind: null, total_amount: null, rate_percent: null,
  },
  end_date: "2026-08-01",
  termination: {
    termination_date: "2026-08-01", actual_move_out_date: "2026-08-01",
    outstanding_debt: 0, early_termination_fee: 1_912_400, deposit_used: 4_200_000,
    rent_refund_amount: 700_000, total_deductions: 1_912_400, refund_amount: 2_287_600,
    status: "COMPLETED", notes: null,
  },
  excess_rent: 0,
  shortfall_mode: null,
  settlement_items: [
    { description: "Tiền điện (2.628 → 3.026)", amount: 1_512_400, type: "SERVICE" },
    { description: "Tiền vệ sinh", amount: 200_000, type: "OTHER" },
    { description: "Phí đổ rác", amount: 200_000, type: "OTHER" },
  ],
  refund_items: [
    { description: "Trả lại khách (cọc sau khấu trừ)", amount: 2_287_600, type_name: "Hoàn cọc thanh lý", is_deposit: true },
    { description: "Hoàn tiền phòng ngày khách không ở", amount: 700_000, type_name: "Hoàn tiền phòng thanh lý", is_deposit: false },
  ],
  ...over,
});

describe("buildTerminationHeaderLines — từng dòng, không gộp cụm", () => {
  it("5 dòng đầu + phiếu cọc gộp hoá đơn ghi rõ phần cọc / tổng phiếu, kết bằng dấu -", () => {
    expect(buildTerminationHeaderLines(goc())).toEqual([
      "[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.",
      "QUYẾT TOÁN THANH LÝ 01/08/2026 — HĐ HĐT-056021/01042025",
      "104/405PVB · bắt đầu 01/04/2025 · kết thúc 01/08/2026 (HĐT-056021/01042025 - 1)",
      "Cọc đã thu: 4.200.000 đ",
      "  · PT2504001 (01/04/2025): cọc 4.200.000 đ / tổng phiếu 8.400.000 đ (gộp hoá đơn)",
      "-",
    ]);
  });

  it("phiếu đã duyệt / đã gán sổ ⇒ không còn nhắc CHỌN SỔ QUỸ", () => {
    const lines = buildTerminationHeaderLines(
      goc({ voucher: { ...goc().voucher, approval_status: "APPROVED", account_id: "a1" } }),
    );
    expect(lines[0]).toBe("[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật).");
  });

  it("sau thanh lý: Cọc đã thu = số đưa vào quyết toán, chỉ liệt kê phiếu THU (bỏ phiếu cấn cọc nội bộ)", () => {
    const c = goc().contract!;
    const lines = buildTerminationHeaderLines(
      goc({
        contract: {
          ...c,
          deposit_paid: 2_287_600, // đã bị trừ bởi phiếu cấn cọc
          deposit_vouchers: [
            ...c.deposit_vouchers,
            { id: "off", code: "PC2608069", voucher_date: "2026-08-01", type: "EXPENSE",
              deposit_amount: 1_912_400, total_amount: 1_912_400, is_combined: false },
          ],
        },
      }),
    );
    expect(lines[3]).toBe("Cọc đã thu: 4.200.000 đ");
    expect(lines).toHaveLength(6);
    expect(lines.some((l) => l.includes("PC2608069"))).toBe(false);
  });

  it("thiếu hợp đồng ⇒ gạch ngang, số cọc vẫn lấy từ hồ sơ thanh lý", () => {
    const lines = buildTerminationHeaderLines(goc({ contract: null }));
    expect(lines[2]).toBe("—/— · bắt đầu — · kết thúc 01/08/2026 (— - ?)");
    expect(lines[3]).toBe("Cọc đã thu: 4.200.000 đ (chưa có phiếu thu cọc)");
  });

  it("không có cả hợp đồng lẫn hồ sơ thanh lý ⇒ 0 đ, không ném", () => {
    const lines = buildTerminationHeaderLines(goc({ contract: null, termination: null }));
    expect(lines[1]).toBe("QUYẾT TOÁN THANH LÝ 01/08/2026 — HĐ —");
    expect(lines[3]).toBe("Cọc đã thu: 0 đ (chưa có phiếu thu cọc)");
  });
});

describe("buildTerminationCard — khung tổng hợp khớp màn thanh lý", () => {
  it("số trên ảnh chủ: khấu trừ 1.912.400, chủ trả khách 2.987.600, khớp phiếu", () => {
    const card = buildTerminationCard(goc())!;
    expect(card.totalDeductions).toBe(1_912_400);
    expect(card.net).toBe(2_987_600);
    expect(card.netLabel).toBe("Chủ nhà trả lại khách");
    expect(card.warning).toBeNull();
    const byLabel = Object.fromEntries(card.rows.map((r) => [r.label, r]));
    expect(byLabel["Tổng công nợ"].amount).toBe(0);
    expect(byLabel["Tiền cọc hoàn trả"].amount).toBe(4_200_000);
    expect(byLabel["Tiền phòng thừa"].amount).toBe(0);
    expect(byLabel["Hoàn lại khách"].amount).toBe(700_000);
    expect(byLabel["Hoàn lại khách"].sub).toEqual([
      { label: "Hoàn tiền phòng ngày khách không ở", amount: 700_000 },
    ]);
    expect(byLabel["Tổng thu thêm"].amount).toBe(1_912_400);
    expect(byLabel["Tổng thu thêm"].sub).toHaveLength(3);
    // Cọc bị cấn 1.912.400 (công nợ 0 + thu thêm) ⇒ có dòng bút toán nội bộ.
    expect(byLabel["Cọc cấn vào khấu trừ (bút toán nội bộ)"].amount).toBe(1_912_400);
  });

  it("khách còn phải trả: net âm, nhãn theo chế độ thiếu", () => {
    const card = buildTerminationCard(
      goc({
        termination: { ...goc().termination!, outstanding_debt: 6_000_000, rent_refund_amount: 0 },
        refund_items: [],
        voucher: { ...goc().voucher, total_amount: 0 },
        shortfall_mode: "DEBT",
      }),
    )!;
    expect(card.net).toBe(4_200_000 - 6_000_000 - 1_912_400);
    expect(card.netLabel).toBe("Khách còn phải trả (ghi nợ — chờ thu)");
  });

  it("phí phạt tách khỏi thu thêm; phiếu lệch số tính lại ⇒ cảnh báo", () => {
    const card = buildTerminationCard(
      goc({
        settlement_items: [
          { description: "Phí phạt thanh lý", amount: 500_000, type: "PENALTY" },
          { description: "Tiền vệ sinh", amount: 200_000, type: "OTHER" },
        ],
        termination: { ...goc().termination!, early_termination_fee: 700_000 },
        voucher: { ...goc().voucher, total_amount: 1 },
      }),
    )!;
    const byLabel = Object.fromEntries(card.rows.map((r) => [r.label, r]));
    expect(byLabel["Phí phạt thanh lý"].amount).toBe(500_000);
    expect(byLabel["Tổng thu thêm"].amount).toBe(200_000);
    expect(card.warning).toMatch(/khác số tính lại/);
  });

  it("không có hồ sơ thanh lý ⇒ null (không dựng khung giả)", () => {
    expect(buildTerminationCard(goc({ termination: null }))).toBeNull();
  });
});

describe("parseTerminationRefundFacts", () => {
  it("ép số dạng chuỗi, loại dòng rác, null khi thiếu voucher", () => {
    expect(parseTerminationRefundFacts(null)).toBeNull();
    expect(parseTerminationRefundFacts({ contract: {} })).toBeNull();
    const f = parseTerminationRefundFacts({
      voucher: { id: "v", total_amount: "100", approval_status: "APPROVED" },
      termination: { outstanding_debt: "5", deposit_used: "10", early_termination_fee: null, rent_refund_amount: "0" },
      excess_rent: "1.5",
      shortfall_mode: "PAID",
      settlement_items: [{ description: "x", amount: "3", type: "OTHER" }, "rac"],
      refund_items: [{ description: "y", amount: 2, is_deposit: "true" }],
    })!;
    expect(f.voucher.total_amount).toBe(100);
    expect(f.termination!.outstanding_debt).toBe(5);
    expect(f.termination!.early_termination_fee).toBe(0);
    expect(f.excess_rent).toBe(1.5);
    expect(f.shortfall_mode).toBe("PAID");
    expect(f.settlement_items).toHaveLength(1);
    expect(f.refund_items[0].is_deposit).toBe(false);
    expect(f.contract).toBeNull();
  });
});
