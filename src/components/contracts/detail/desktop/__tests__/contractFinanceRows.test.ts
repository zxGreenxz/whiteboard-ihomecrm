import { describe, expect, it } from "vitest";

import {
  dungBangTaiChinh,
  type HoaDonChoBang,
  type PhieuCocChoBang,
  type QuyetToanChoBang,
} from "../contractFinanceRows";

const COC = { total_deposit: 3_900_000, deposit_paid: 3_900_000, deposit_remaining: 0 };

const PHIEU_COC: PhieuCocChoBang[] = [
  {
    id: "pt-1",
    code: "PT2608184",
    total_amount: 3_900_000,
    voucher_date: "2026-08-20",
    approval_status: "APPROVED",
    account: { name: "Hiệp Thu" },
  },
];

const HD_THANG_9: HoaDonChoBang = {
  id: "inv-9",
  invoice_number: "HD09",
  billing_month: "2026-09",
  status: "PAID",
  total_amount: 4_150_000,
  paid_amount: 4_150_000,
  invoice_items: [{ from_date: "2026-09-06", to_date: "2026-09-30" }],
  payments: [],
};

const HD_THANG_10: HoaDonChoBang = {
  id: "inv-10",
  invoice_number: "HD10",
  billing_month: "2026-10",
  status: "APPROVED",
  total_amount: 4_150_000,
  paid_amount: 0,
  invoice_items: [],
  payments: [],
};

const QUYET_TOAN: QuyetToanChoBang = {
  termination_type: "NORMAL",
  actual_move_out_date: "2026-09-12",
  total_deposit: 3_900_000,
  outstanding_debt: 1_071_500,
  early_termination_fee: 0,
  refund_amount: 2_828_500,
  posted_refund: 1_450_000,
  posted_refund_count: 1,
  posted_refund_codes: ["PC2607119"],
};

const dongChinh = (kq: ReturnType<typeof dungBangTaiChinh>) =>
  kq.nhom.flatMap((n) => n.dong).filter((d) => !d.laDongCon);

describe("dungBangTaiChinh — tổng khớp số in trong file thiết kế", () => {
  it("HĐ đang hoạt động: 3.900.000 cọc + 4.150.000 hoá đơn = 8.050.000", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: PHIEU_COC,
      invoices: [HD_THANG_9],
      terminationInfo: null,
    });
    expect(kq.tong).toEqual({
      soHoaDon: 1,
      soTien: 8_050_000,
      daThu: 8_050_000,
      conNo: 0,
      noHoaDon: 0,
      thieuCoc: 0,
      chuaHoanKhach: 0,
    });
  });

  it("HĐ còn công nợ: thêm hoá đơn chưa thu = 12.200.000, nợ 4.150.000", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: PHIEU_COC,
      invoices: [HD_THANG_9, HD_THANG_10],
      terminationInfo: null,
    });
    expect(kq.tong).toEqual({
      soHoaDon: 2,
      soTien: 12_200_000,
      daThu: 8_050_000,
      conNo: 4_150_000,
      noHoaDon: 4_150_000,
      thieuCoc: 0,
      chuaHoanKhach: 0,
    });
  });

  it("HĐ đã thanh lý: cộng cả net quyết toán = 10.878.500, đã thu 9.500.000", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "TERMINATED" },
      depositVouchers: PHIEU_COC,
      invoices: [HD_THANG_9],
      terminationInfo: QUYET_TOAN,
    });
    expect(kq.tong).toEqual({
      soHoaDon: 1,
      soTien: 10_878_500,
      daThu: 9_500_000,
      conNo: 1_378_500,
      noHoaDon: 0,
      thieuCoc: 0,
      chuaHoanKhach: 1_378_500,
    });
  });
});

describe("dungBangTaiChinh — tách theo CHIỀU tiền", () => {
  it("tiền phải hoàn khách KHÔNG bị gộp vào 'còn phải thu'", () => {
    // Ca thật HĐT-075854 (158PVC/403): conNo của bảng = 3.700.000, nhưng
    // 3.293.500 trong đó là tiền CHỦ NHÀ phải hoàn khách (phiếu chi còn chờ
    // duyệt), chỉ 406.500 mới là tiền thu về. Dán một nhãn "còn phải thu" cho
    // cả 3.700.000 là nói sai chiều tiền.
    const kq = dungBangTaiChinh({
      contract: {
        total_deposit: 3_700_000,
        deposit_paid: 3_293_500,
        deposit_remaining: 406_500,
        status: "TERMINATED",
      },
      depositVouchers: [],
      invoices: [],
      terminationInfo: { ...QUYET_TOAN, refund_amount: 3_293_500, posted_refund: 0,
        posted_refund_count: 0, posted_refund_codes: [] },
    });
    expect(kq.tong.conNo).toBe(3_700_000);
    expect(kq.tong.thieuCoc).toBe(406_500);
    expect(kq.tong.chuaHoanKhach).toBe(3_293_500);
    expect(kq.tong.noHoaDon).toBe(0);
  });

  it("nợ hoá đơn chỉ đếm dòng hoá đơn", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: [],
      invoices: [HD_THANG_9, HD_THANG_10],
      terminationInfo: null,
    });
    expect(kq.tong.noHoaDon).toBe(4_150_000);
    expect(kq.tong.chuaHoanKhach).toBe(0);
    expect(kq.tong.thieuCoc).toBe(0);
  });

  it("bỏ cọc thì không có gì phải hoàn khách", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "TERMINATED" },
      depositVouchers: [],
      invoices: [],
      terminationInfo: {
        ...QUYET_TOAN,
        termination_type: "FORFEIT",
        early_termination_fee: 3_900_000,
        posted_refund: 0,
        posted_refund_count: 0,
        posted_refund_codes: [],
      },
    });
    expect(kq.tong.chuaHoanKhach).toBe(0);
  });
});

describe("dungBangTaiChinh — cấu trúc nhóm", () => {
  it("dòng con không được cộng vào tổng", () => {
    // Phiếu thu cọc và từng lần thanh toán là CHI TIẾT của dòng cha. Cộng vào
    // là đếm hai lần đúng số tiền đó.
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: PHIEU_COC,
      invoices: [
        {
          ...HD_THANG_9,
          payments: [
            { id: "pay-1", amount: 4_150_000, payment_date: "2026-09-08", payment_method: "CASH", notes: null },
          ],
        },
      ],
      terminationInfo: null,
    });
    expect(kq.tong.soTien).toBe(8_050_000);
    expect(dongChinh(kq)).toHaveLength(2);
    // 2 dòng chính + 1 phiếu cọc + 1 lần trả tiền
    expect(kq.nhom.flatMap((n) => n.dong)).toHaveLength(4);
  });

  it("chưa thanh lý thì không có nhóm quyết toán", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: [],
      invoices: [],
      terminationInfo: null,
    });
    expect(kq.nhom.map((n) => n.khoa)).toEqual(["TIEN_COC", "HOA_DON"]);
  });

  it("có hồ sơ thanh lý nhưng HĐ chưa TERMINATED thì vẫn không hiện nhóm đó", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: [],
      invoices: [],
      terminationInfo: QUYET_TOAN,
    });
    expect(kq.nhom.map((n) => n.khoa)).toEqual(["TIEN_COC", "HOA_DON"]);
  });

  it("nêu rõ lệch giữa hồ sơ và phiếu đã vào sổ", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "TERMINATED" },
      depositVouchers: [],
      invoices: [],
      terminationInfo: QUYET_TOAN,
    });
    const nhom = kq.nhom.find((n) => n.khoa === "QUYET_TOAN");
    expect(nhom?.canhBao).toContain("PC2607119");
    expect(nhom?.canhBao).toContain("1.378.500");
  });

  it("khớp hồ sơ với phiếu thì không cảnh báo", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "TERMINATED" },
      depositVouchers: [],
      invoices: [],
      terminationInfo: { ...QUYET_TOAN, posted_refund: 2_828_500 },
    });
    expect(kq.nhom.find((n) => n.khoa === "QUYET_TOAN")?.canhBao).toBeNull();
  });

  it("hoá đơn đã huỷ vẫn cộng vào tổng nhưng được đánh dấu", () => {
    // Giữ NGUYÊN công thức outstandingAmount đang chạy (nó cộng mọi hoá đơn
    // chưa xoá mềm). Đánh dấu để con số vẫn giải thích được.
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: [],
      invoices: [{ ...HD_THANG_10, status: "CANCELLED" }],
      terminationInfo: null,
    });
    expect(kq.tong.soTien).toBe(8_050_000);
    const dong = dongChinh(kq).find((d) => d.id === "inv-10");
    expect(dong?.daHuy).toBe(true);
  });

  it("phiếu cọc đầu kỳ được chú là không vào sổ quỹ", () => {
    const kq = dungBangTaiChinh({
      contract: { ...COC, status: "ACTIVE" },
      depositVouchers: [
        { ...PHIEU_COC[0]!, posting_status: "NOT_APPLICABLE" },
      ],
      invoices: [],
      terminationInfo: null,
    });
    const con = kq.nhom[0]?.dong.find((d) => d.laDongCon);
    expect(con?.ghiChu).toContain("không vào sổ quỹ");
  });

  it("không có cọc, không hoá đơn thì tổng bằng 0 chứ không NaN", () => {
    const kq = dungBangTaiChinh({
      contract: { total_deposit: null, deposit_paid: null, deposit_remaining: null, status: "DRAFT" },
      depositVouchers: [],
      invoices: [],
      terminationInfo: null,
    });
    expect(kq.tong).toEqual({
      soHoaDon: 0,
      soTien: 0,
      daThu: 0,
      conNo: 0,
      noHoaDon: 0,
      thieuCoc: 0,
      chuaHoanKhach: 0,
    });
  });

  it("đã thu vượt số phải thu thì còn nợ là 0, không âm", () => {
    const kq = dungBangTaiChinh({
      contract: { total_deposit: 0, deposit_paid: 0, deposit_remaining: 0, status: "ACTIVE" },
      depositVouchers: [],
      invoices: [{ ...HD_THANG_9, total_amount: 1_000_000, paid_amount: 1_200_000 }],
      terminationInfo: null,
    });
    expect(kq.tong.conNo).toBe(0);
    expect(dongChinh(kq).find((d) => d.id === "inv-9")?.conNo).toBe(0);
  });
});
