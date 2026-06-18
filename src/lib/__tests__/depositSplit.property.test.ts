import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { allocateDepositPortion } from '@/lib/invoiceHelpers';

// =============================================
// Property tests cho allocateDepositPortion (A2 — tách cọc khi thu hoá đơn cũ).
// Bất biến nghiệp vụ: cọc-trước, doanh-thu-sau; tổng cọc đã thu không vượt
// depositInInvoice; mỗi lần thu = depositPortion + revenuePortion = amount.
// =============================================

describe('allocateDepositPortion', () => {
  it('mỗi lần: depositPortion + revenuePortion = paymentAmount; cả hai ≥ 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (paymentAmount, depositInInvoice, paidBefore) => {
          const { depositPortion, revenuePortion } = allocateDepositPortion({
            paymentAmount,
            depositInInvoice,
            paidBefore,
          });
          expect(depositPortion).toBeGreaterThanOrEqual(0);
          expect(revenuePortion).toBeGreaterThanOrEqual(0);
          expect(depositPortion + revenuePortion).toBe(paymentAmount);
          // Không bao giờ phân bổ cọc vượt phần cọc còn lại trên HĐ.
          expect(depositPortion).toBeLessThanOrEqual(
            Math.max(0, depositInInvoice - Math.min(paidBefore, depositInInvoice)),
          );
        },
      ),
    );
  });

  it('HĐ không gộp cọc (depositInInvoice=0) → toàn bộ là doanh thu', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (paymentAmount, paidBefore) => {
          const r = allocateDepositPortion({ paymentAmount, depositInInvoice: 0, paidBefore });
          expect(r.depositPortion).toBe(0);
          expect(r.revenuePortion).toBe(paymentAmount);
        },
      ),
    );
  });

  it('cộng dồn nhiều lần thu (không vượt tổng HĐ): Σcọc = min(Σthu, depositInInvoice)', () => {
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
            });
            sumDeposit += depositPortion;
            sumRevenue += revenuePortion;
            paidBefore += amount;
          }
          const totalPaid = paidBefore;
          expect(sumDeposit).toBe(Math.min(totalPaid, depositInInvoice));
          expect(sumRevenue).toBe(totalPaid - Math.min(totalPaid, depositInInvoice));
        },
      ),
    );
  });

  it('thu đủ toàn HĐ 1 lần: cọc = depositInInvoice, doanh thu = phần còn lại', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000_000 }),
        fc.integer({ min: 0, max: 30_000_000 }),
        (depositInInvoice, revenueOfInvoice) => {
          const total = depositInInvoice + revenueOfInvoice;
          const r = allocateDepositPortion({ paymentAmount: total, depositInInvoice, paidBefore: 0 });
          expect(r.depositPortion).toBe(depositInInvoice);
          expect(r.revenuePortion).toBe(revenueOfInvoice);
        },
      ),
    );
  });
});
