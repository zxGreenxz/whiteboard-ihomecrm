import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  computeTerminationSettlement,
  type TerminationSettlementInput,
} from "@/lib/terminationSettlement";

/**
 * Số tiền VND: nguyên, không âm, chặn trần để không tràn numeric(15,2).
 * Dùng số nguyên vì mọi ô tiền trong app đều cắt phần lẻ (CurrencyInput chỉ
 * nhận chữ số) — sinh số lẻ ở đây là kiểm một thứ giao diện không tạo ra được.
 */
const vnd = fc.integer({ min: 0, max: 5_000_000_000 });

const input = fc.record({
  depositPaid: vnd,
  depositRefundRequested: vnd,
  excessRent: vnd,
  outstandingDebt: vnd,
  penaltyFee: vnd,
  extraChargesTotal: vnd,
  customerRefundTotal: vnd,
}) satisfies fc.Arbitrary<TerminationSettlementInput>;

describe("quyết toán thanh lý — bất biến", () => {
  it("hoàn cọc không bao giờ vượt cọc THỰC THU", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = computeTerminationSettlement(i);
        expect(s.deposit).toBeLessThanOrEqual(i.depositPaid);
        expect(s.refundDeposit).toBeLessThanOrEqual(i.depositPaid);
      }),
    );
  });

  it("mọi thành phần đều không âm", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = computeTerminationSettlement(i);
        for (const [ten, v] of Object.entries({
          deposit: s.deposit,
          charges: s.charges,
          appliedDeposit: s.appliedDeposit,
          refundDeposit: s.refundDeposit,
          refundExcess: s.refundExcess,
          chargesLeft: s.chargesLeft,
          owedApplied: s.owedApplied,
          refundOwed: s.refundOwed,
          applied: s.applied,
          totalRefund: s.totalRefund,
          shortfall: s.shortfall,
        })) {
          expect(v, `${ten} âm`).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("khoản hoàn được bảo toàn: cấn + chi thật = tổng nhập", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = computeTerminationSettlement(i);
        expect(s.owedApplied + s.refundOwed).toBe(s.owed);
      }),
    );
  });

  it("tổng chi hoàn đúng bằng phần dương của số quyết toán ròng", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = computeTerminationSettlement(i);
        expect(s.totalRefund).toBe(Math.max(s.net, 0));
      }),
    );
  });

  it("không bao giờ vừa chi hoàn vừa đòi khách trả thêm", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = computeTerminationSettlement(i);
        expect(s.totalRefund > 0 && s.shortfall > 0).toBe(false);
      }),
    );
  });

  /**
   * BẤT BIẾN QUAN TRỌNG NHẤT của đợt này.
   *
   * `contract_terminations.refund_amount` là cột generated = total_deposit −
   * deductions, và nghĩa vụ hoàn cọc đối chiếu chính nó với cọc thật đang giữ.
   * Khoản "Hoàn lại khách" KHÔNG được phép làm xê dịch nhánh cọc, nếu không hai
   * con số đó lệch nhau và cảnh báo VUOT_COC_THAT trở thành vô nghĩa.
   */
  it("thêm 'Hoàn lại khách' KHÔNG làm xê dịch nhánh cọc và credit", () => {
    fc.assert(
      fc.property(input, vnd, (i, khoanHoan) => {
        const khong = computeTerminationSettlement({
          ...i,
          customerRefundTotal: 0,
        });
        const co = computeTerminationSettlement({
          ...i,
          customerRefundTotal: khoanHoan,
        });
        expect(co.appliedDeposit).toBe(khong.appliedDeposit);
        expect(co.refundDeposit).toBe(khong.refundDeposit);
        expect(co.refundExcess).toBe(khong.refundExcess);
      }),
    );
  });

  it("refundDeposit luôn khớp công thức của cột generated refund_amount", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = computeTerminationSettlement(i);
        // refund_amount = total_deposit − deductions; phần dương của nó chính là
        // số cọc hoàn thật.
        expect(s.refundDeposit).toBe(Math.max(s.deposit - s.charges, 0));
      }),
    );
  });

  it("khoản hoàn chỉ cấn vào công nợ CÒN LẠI sau cọc và credit", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = computeTerminationSettlement(i);
        expect(s.owedApplied).toBeLessThanOrEqual(s.chargesLeft);
      }),
    );
  });
});

describe("quyết toán thanh lý — ca cụ thể", () => {
  const ca = (
    p: Partial<TerminationSettlementInput> & { depositPaid: number },
  ) =>
    computeTerminationSettlement({
      depositRefundRequested: p.depositPaid,
      ...p,
    });

  it("cọc 5tr · nợ 8tr · hoàn 2tr → khách trả thêm 1tr, không chi đồng nào", () => {
    const s = ca({
      depositPaid: 5_000_000,
      outstandingDebt: 8_000_000,
      customerRefundTotal: 2_000_000,
    });
    expect(s.appliedDeposit).toBe(5_000_000);
    expect(s.refundDeposit).toBe(0);
    expect(s.owedApplied).toBe(2_000_000);
    expect(s.refundOwed).toBe(0);
    expect(s.totalRefund).toBe(0);
    expect(s.shortfall).toBe(1_000_000);
  });

  it("cọc 5tr · nợ 1tr · hoàn 2tr → chi hoàn 6tr (4tr cọc + 2tr tiền phòng)", () => {
    const s = ca({
      depositPaid: 5_000_000,
      outstandingDebt: 1_000_000,
      customerRefundTotal: 2_000_000,
    });
    expect(s.refundDeposit).toBe(4_000_000);
    expect(s.owedApplied).toBe(0);
    expect(s.refundOwed).toBe(2_000_000);
    expect(s.totalRefund).toBe(6_000_000);
    expect(s.shortfall).toBe(0);
  });

  it("không nợ gì · hoàn 1.290.323 → chi đúng cọc + khoản hoàn", () => {
    const s = ca({
      depositPaid: 3_700_000,
      customerRefundTotal: 1_290_323,
    });
    expect(s.refundDeposit).toBe(3_700_000);
    expect(s.refundOwed).toBe(1_290_323);
    expect(s.totalRefund).toBe(4_990_323);
  });

  it("credit cấn trước khoản hoàn: cọc 5tr · credit 3tr · nợ 6tr · hoàn 2tr", () => {
    const s = ca({
      depositPaid: 5_000_000,
      excessRent: 3_000_000,
      outstandingDebt: 6_000_000,
      customerRefundTotal: 2_000_000,
    });
    expect(s.appliedDeposit).toBe(5_000_000);
    expect(s.refundDeposit).toBe(0);
    expect(s.refundExcess).toBe(2_000_000);
    expect(s.chargesLeft).toBe(0);
    expect(s.owedApplied).toBe(0);
    expect(s.refundOwed).toBe(2_000_000);
    expect(s.totalRefund).toBe(4_000_000);
  });

  it("hoàn cọc nhập vượt cọc thực thu vẫn bị kẹp", () => {
    const s = computeTerminationSettlement({
      depositPaid: 2_000_000,
      depositRefundRequested: 5_000_000,
      customerRefundTotal: 500_000,
    });
    expect(s.deposit).toBe(2_000_000);
    expect(s.totalRefund).toBe(2_500_000);
  });
});
