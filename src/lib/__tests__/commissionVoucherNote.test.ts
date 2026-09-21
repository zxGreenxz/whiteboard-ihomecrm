import { describe, expect, it } from "vitest";

import {
  buildCommissionNoteLines,
  parseCommissionVoucherFacts,
  trangThaiHopDong,
  type CommissionVoucherFacts,
} from "@/lib/commissionVoucherNote";

const goc = (over: Partial<CommissionVoucherFacts> = {}): CommissionVoucherFacts => ({
  contract_id: "c1",
  contract_number: "HD-2026-00277",
  room_name: "205",
  building_name: "1392QT",
  status: "ACTIVE",
  start_date: "2026-07-28",
  end_date: "2027-08-27",
  expected_move_out_date: null,
  seq_in_year: 2,
  rent_price: 3_500_000,
  months: 13,
  total_deposit: 7_000_000,
  deposit_paid: 7_000_000,
  deposit_enough: true,
  deposit_vouchers: [
    {
      id: "v1", code: "PT2607011", voucher_date: "2026-07-20", type: "INCOME",
      deposit_amount: 3_500_000, total_amount: 6_800_000, is_combined: true,
    },
    {
      id: "v2", code: "PT2607020", voucher_date: "2026-07-25", type: "INCOME",
      deposit_amount: 3_500_000, total_amount: 3_500_000, is_combined: false,
    },
  ],
  today: "2026-09-02",
  seven_days_date: "2026-08-04",
  seven_days_ok: true,
  rep_name: "Đào Lê",
  rep_phone: "0901234567",
  commission_kind: "broker",
  total_amount: 2_100_000,
  rate_percent: 60,
  ...over,
});

describe("buildCommissionNoteLines — 5 dòng chủ chốt", () => {
  it("đủ cọc, đủ 7 ngày, HĐ còn hạn, phiếu gộp hoá đơn ghi rõ phần cọc / tổng phiếu", () => {
    expect(buildCommissionNoteLines(goc())).toEqual([
      "205/1392QT 28/07/2026 (HD-2026-00277 - 2)",
      "Giá phòng 3.500.000 đ · 28/07/2026 - 27/08/2027 (60% - 13 tháng)",
      "Đã cọc đủ: 7.000.000 đ",
      "  · PT2607011 (20/07/2026): cọc 3.500.000 đ / tổng phiếu 6.800.000 đ (gộp hoá đơn)",
      "  · PT2607020 (25/07/2026): 3.500.000 đ",
      "Đã đủ 7 ngày tính từ ngày vào ở 28/07/2026",
      "Đào Lê · 0901234567 · Còn hạn",
    ]);
  });

  it("chưa cọc đủ: ghi đã / phải; phiếu hoàn cọc ghi âm", () => {
    const lines = buildCommissionNoteLines(
      goc({
        deposit_paid: 2_500_000,
        deposit_enough: false,
        deposit_vouchers: [
          { id: "a", code: "PT1", voucher_date: "2026-07-20", type: "INCOME",
            deposit_amount: 3_500_000, total_amount: 3_500_000, is_combined: false },
          { id: "b", code: "PC9", voucher_date: "2026-07-30", type: "EXPENSE",
            deposit_amount: 1_000_000, total_amount: 1_000_000, is_combined: false },
        ],
      }),
    );
    expect(lines[2]).toBe("Chưa cọc đủ: 2.500.000 đ / 7.000.000 đ");
    expect(lines[3]).toBe("  · PT1 (20/07/2026): 3.500.000 đ");
    expect(lines[4]).toBe("  · PC9 (30/07/2026): hoàn cọc −1.000.000 đ");
  });

  it("không có phiếu cọc nào ⇒ nói rõ, không giả vờ đã cọc", () => {
    const lines = buildCommissionNoteLines(
      goc({ deposit_paid: 0, deposit_enough: false, deposit_vouchers: [] }),
    );
    expect(lines[2]).toBe("Chưa cọc: 0 đ / 7.000.000 đ (chưa có phiếu thu cọc)");
    expect(lines).toHaveLength(5);
  });

  it("chưa đủ 7 ngày ⇒ ghi ngày đủ", () => {
    const lines = buildCommissionNoteLines(
      goc({ today: "2026-07-30", seven_days_ok: false }),
    );
    expect(lines.at(-2)).toBe(
      "Chưa đủ 7 ngày tính từ ngày vào ở 28/07/2026 (đủ ngày 04/08/2026)",
    );
  });

  it("thưởng Sale không có % ⇒ ngoặc chỉ ghi số tháng", () => {
    const lines = buildCommissionNoteLines(goc({ commission_kind: "sale", rate_percent: null }));
    expect(lines[1]).toBe("Giá phòng 3.500.000 đ · 28/07/2026 - 27/08/2027 (13 tháng)");
  });

  it("% lẻ giữ 1 chữ số thập phân theo vi-VN", () => {
    const lines = buildCommissionNoteLines(goc({ rate_percent: 33.3 }));
    expect(lines[1]).toContain("(33,3% - 13 tháng)");
  });

  it("thiếu phòng / STT / khách ⇒ dấu gạch, không ném", () => {
    const lines = buildCommissionNoteLines(
      goc({ room_name: null, building_name: null, seq_in_year: null, rep_name: null, rep_phone: null }),
    );
    expect(lines[0]).toBe("—/— 28/07/2026 (HD-2026-00277 - ?)");
    expect(lines.at(-1)).toBe("— (chưa có khách đại diện) · Còn hạn");
  });

  it("trạng thái HĐ hiện tại theo ngày server: sắp hết hạn / quá hạn / đã thanh lý / sắp chuyển đi", () => {
    expect(trangThaiHopDong(goc({ today: "2027-08-10" }))).toBe("EXPIRING");
    expect(trangThaiHopDong(goc({ today: "2027-09-01" }))).toBe("EXPIRED");
    expect(trangThaiHopDong(goc({ status: "TERMINATED" }))).toBe("TERMINATED");
    expect(trangThaiHopDong(goc({ expected_move_out_date: "2026-10-01" }))).toBe("MOVING_OUT");
    expect(buildCommissionNoteLines(goc({ status: "TERMINATED" })).at(-1)).toBe(
      "Đào Lê · 0901234567 · Đã thanh lý",
    );
  });
});

describe("parseCommissionVoucherFacts — không tin cấu trúc jsonb", () => {
  it("ép số dạng chuỗi, loại dòng cọc méo, null khi không phải object", () => {
    expect(parseCommissionVoucherFacts(null)).toBeNull();
    expect(parseCommissionVoucherFacts("x")).toBeNull();
    const f = parseCommissionVoucherFacts({
      contract_number: "HD-1",
      seq_in_year: "3",
      rent_price: "3500000",
      deposit_enough: true,
      commission_kind: "broker",
      deposit_vouchers: [
        { id: "a", code: "PT1", type: "INCOME", deposit_amount: "100", total_amount: 100 },
        { code: "meo", deposit_amount: 5 },
        "rac",
      ],
    });
    expect(f).not.toBeNull();
    expect(f!.seq_in_year).toBe(3);
    expect(f!.rent_price).toBe(3_500_000);
    expect(f!.deposit_vouchers).toHaveLength(1);
    expect(f!.deposit_vouchers[0].deposit_amount).toBe(100);
    expect(f!.commission_kind).toBe("broker");
    expect(f!.today).toBeNull();
  });

  it("commission_kind lạ ⇒ null", () => {
    expect(parseCommissionVoucherFacts({ commission_kind: "khac" })!.commission_kind).toBeNull();
  });
});
