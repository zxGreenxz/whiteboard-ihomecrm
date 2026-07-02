import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { allocateDepositPortion } from '@/lib/invoiceHelpers';

// =============================================
// Property tests cho allocateDepositPortion (phân bổ 1 lần thu HĐ gộp cọc
// thành hạng mục doanh thu + hạng mục cọc trên CÙNG 1 phiếu thu).
// Bất biến nghiệp vụ: PHÒNG-TRƯỚC, CỌC-SAU — tiền thu phủ phần tiền phòng/
// dịch vụ (revenueTotal = collectibleTotal − depositInInvoice) trước, phần
// dư mới vào cọc; mỗi lần thu = depositPortion + revenuePortion = amount.
// =============================================

describe('allocateDepositPortion', () => {
  it('mỗi lần: depositPortion + revenuePortion = paymentAmount; cả hai ≥ 0; doanh thu không vượt phần phòng/DV còn thiếu', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 20_000_000 }), // depositInInvoice
        fc.integer({ min: 0, max: 30_000_000 }), // phần doanh thu của HĐ
        fc.integer({ min: 0, max: 50_000_000 }),
        (paymentAmount, depositInInvoice, revenueOfInvoice, paidBefore) => {
          const collectibleTotal = depositInInvoice + revenueOfInvoice;
          const { depositPortion, revenuePortion } = allocateDepositPortion({
            paymentAmount,
            depositInInvoice,
            paidBefore,
            collectibleTotal,
          });
          expect(depositPortion).toBeGreaterThanOrEqual(0);
          expect(revenuePortion).toBeGreaterThanOrEqual(0);
          expect(depositPortion + revenuePortion).toBe(paymentAmount);
          // Không bao giờ phân bổ doanh thu vượt phần phòng/DV còn thiếu.
          expect(revenuePortion).toBeLessThanOrEqual(
            Math.max(0, revenueOfInvoice - Math.min(paidBefore, revenueOfInvoice)),
          );
        },
      ),
    );
  });

  it('HĐ không gộp cọc (depositInInvoice=0), thu không vượt tổng → toàn bộ là doanh thu', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }), // tổng HĐ
        fc.integer({ min: 0, max: 50_000_000 }), // paidBefore thô
        fc.integer({ min: 0, max: 50_000_000 }), // payment thô
        (collectibleTotal, rawPaidBefore, rawPayment) => {
          // Chuỗi hợp lệ: paidBefore + payment ≤ tổng HĐ.
          const paidBefore = Math.min(rawPaidBefore, collectibleTotal);
          const paymentAmount = Math.min(rawPayment, collectibleTotal - paidBefore);
          const r = allocateDepositPortion({
            paymentAmount,
            depositInInvoice: 0,
            paidBefore,
            collectibleTotal,
          });
          expect(r.depositPortion).toBe(0);
          expect(r.revenuePortion).toBe(paymentAmount);
        },
      ),
    );
  });

  it('cộng dồn nhiều lần thu (không vượt tổng HĐ): Σdoanh thu = min(Σthu, revenueTotal); Σcọc = phần còn lại', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000_000 }), // depositInInvoice
        fc.integer({ min: 0, max: 30_000_000 }), // phần doanh thu của HĐ
        fc.array(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 1, maxLength: 8 }),
        (depositInInvoice, revenueOfInvoice, rawPayments) => {
          const total = depositInInvoice + revenueOfInvoice;
          // Chuỗi thanh toán cộng dồn KHÔNG vượt tổng HĐ (mô phỏng thu nhiều lần).
          let paidBefore = 0;
          let sumDeposit = 0;
          let sumRevenue = 0;
          for (const raw of rawPayments) {
            const remainingInvoice = total - paidBefore;
            if (remainingInvoice <= 0) break;
            const amount = Math.min(raw, remainingInvoice);
            const { depositPortion, revenuePortion } = allocateDepositPortion({
              paymentAmount: amount,
              depositInInvoice,
              paidBefore,
              collectibleTotal: total,
            });
            sumDeposit += depositPortion;
            sumRevenue += revenuePortion;
            paidBefore += amount;
          }
          const totalPaid = paidBefore;
          expect(sumRevenue).toBe(Math.min(totalPaid, revenueOfInvoice));
          expect(sumDeposit).toBe(totalPaid - Math.min(totalPaid, revenueOfInvoice));
        },
      ),
    );
  });

  it('thu đủ toàn HĐ 1 lần: đúng theo hạng mục — doanh thu = phần phòng/DV, cọc = depositInInvoice', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000_000 }),
        fc.integer({ min: 0, max: 30_000_000 }),
        (depositInInvoice, revenueOfInvoice) => {
          const total = depositInInvoice + revenueOfInvoice;
          const r = allocateDepositPortion({
            paymentAmount: total,
            depositInInvoice,
            paidBefore: 0,
            collectibleTotal: total,
          });
          expect(r.depositPortion).toBe(depositInInvoice);
          expect(r.revenuePortion).toBe(revenueOfInvoice);
        },
      ),
    );
  });

  it('case thật 01/481NVK (tổng 5.95tr, cọc gộp 2.3tr): thu 2tr → toàn doanh thu; thu tiếp 1.3tr → chưa chạm cọc; thu nốt 2.65tr → 350k doanh thu + 2.3tr cọc', () => {
    const base = { depositInInvoice: 2_300_000, collectibleTotal: 5_950_000 };
    const p1 = allocateDepositPortion({ ...base, paymentAmount: 2_000_000, paidBefore: 0 });
    expect(p1).toEqual({ depositPortion: 0, revenuePortion: 2_000_000 });
    const p2 = allocateDepositPortion({ ...base, paymentAmount: 1_300_000, paidBefore: 2_000_000 });
    expect(p2).toEqual({ depositPortion: 0, revenuePortion: 1_300_000 });
    const p3 = allocateDepositPortion({ ...base, paymentAmount: 2_650_000, paidBefore: 3_300_000 });
    expect(p3).toEqual({ depositPortion: 2_300_000, revenuePortion: 350_000 });
  });
});
