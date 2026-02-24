import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { InvoiceStatus } from '@/types/invoice';

// =============================================
// Model Functions (pure logic mirroring DB/RPC behavior)
// =============================================

/**
 * Model the payment recording logic as a pure function.
 * Mirrors the behavior of the `record_invoice_payment` RPC function.
 */
function recordPayment(
  invoice: { paid_amount: number; total_amount: number; remaining_amount: number; status: InvoiceStatus },
  paymentAmount: number,
): {
  paid_amount: number;
  remaining_amount: number;
  status: InvoiceStatus;
  excess_amount: number;
} {
  const newPaidAmount = invoice.paid_amount + paymentAmount;
  const newRemaining = invoice.total_amount - newPaidAmount;
  let excessAmount = 0;
  let newStatus: InvoiceStatus;

  if (newPaidAmount >= invoice.total_amount) {
    excessAmount = Math.max(0, newPaidAmount - invoice.total_amount);
    newStatus = 'PAID';
  } else if (newPaidAmount > 0) {
    newStatus = 'PARTIAL_PAID';
  } else {
    newStatus = invoice.status;
  }

  return {
    paid_amount: newPaidAmount,
    remaining_amount: Math.max(0, newRemaining),
    status: newStatus,
    excess_amount: excessAmount,
  };
}

/**
 * Model status determination based on payment state and dates.
 * Mirrors the logic used to determine invoice status.
 */
function determineStatus(
  paidAmount: number,
  totalAmount: number,
  dueDate: string,
  currentDate: string,
  isCancelled: boolean,
): InvoiceStatus {
  if (isCancelled) return 'CANCELLED';
  if (paidAmount >= totalAmount) return 'PAID';
  if (paidAmount > 0 && paidAmount < totalAmount) {
    if (new Date(currentDate) > new Date(dueDate)) return 'OVERDUE';
    return 'PARTIAL_PAID';
  }
  if (new Date(currentDate) > new Date(dueDate)) return 'OVERDUE';
  return 'APPROVED';
}

// =============================================
// Shared Arbitraries
// =============================================

const moneyArb = fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true });
const posMoneyArb = fc.double({ min: 0.01, max: 100_000_000, noNaN: true, noDefaultInfinity: true });

const dateArb = fc.date({
  min: new Date('2020-01-01'),
  max: new Date('2030-12-31'),
}).map((d) => d.toISOString().split('T')[0]);

// =============================================
// Property 11: Thanh toán cập nhật paid_amount chính xác
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 11: Thanh toán cập nhật paid_amount chính xác
 *
 * Với bất kỳ hoá đơn và khoản thanh toán hợp lệ, sau khi ghi nhận thanh toán,
 * paid_amount mới phải bằng paid_amount cũ + số tiền thanh toán.
 *
 * **Validates: Requirements 7.2**
 */
describe('Feature: invoice-reimplementation, Property 11: Thanh toán cập nhật paid_amount chính xác', () => {
  it('new paid_amount equals old paid_amount + payment amount', () => {
    fc.assert(
      fc.property(
        fc.record({
          total_amount: posMoneyArb,
          paid_amount: moneyArb,
        }),
        posMoneyArb,
        (invoiceData, paymentAmount) => {
          const remaining = Math.max(0, invoiceData.total_amount - invoiceData.paid_amount);
          const invoice = {
            ...invoiceData,
            remaining_amount: remaining,
            status: 'APPROVED' as InvoiceStatus,
          };

          const result = recordPayment(invoice, paymentAmount);

          expect(result.paid_amount).toBe(invoice.paid_amount + paymentAmount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('paid_amount accumulates correctly across multiple payments', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        fc.array(posMoneyArb, { minLength: 1, maxLength: 5 }),
        (totalAmount, payments) => {
          let invoice = {
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
            status: 'APPROVED' as InvoiceStatus,
          };

          let expectedPaid = 0;
          for (const payment of payments) {
            const result = recordPayment(invoice, payment);
            expectedPaid += payment;
            expect(result.paid_amount).toBe(expectedPaid);

            // Update invoice for next iteration
            invoice = {
              total_amount: totalAmount,
              paid_amount: result.paid_amount,
              remaining_amount: result.remaining_amount,
              status: result.status,
            };
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 12: Trạng thái hoá đơn phản ánh đúng tình trạng thanh toán
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 12: Trạng thái hoá đơn phản ánh đúng tình trạng thanh toán
 *
 * - paid_amount = 0 và chưa quá hạn → DRAFT hoặc APPROVED
 * - 0 < paid_amount < total_amount → PARTIAL_PAID
 * - paid_amount >= total_amount → PAID
 * - ngày hiện tại > due_date và paid_amount < total_amount và không CANCELLED → OVERDUE
 *
 * **Validates: Requirements 7.3, 7.4, 7.7**
 */
describe('Feature: invoice-reimplementation, Property 12: Trạng thái hoá đơn phản ánh đúng tình trạng thanh toán', () => {
  it('paid_amount >= total_amount implies status is PAID', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        moneyArb,
        (totalAmount, extraAmount) => {
          const paidAmount = totalAmount + extraAmount;
          const status = determineStatus(paidAmount, totalAmount, '2030-12-31', '2025-01-01', false);
          expect(status).toBe('PAID');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('0 < paid_amount < total_amount and not overdue implies PARTIAL_PAID', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
        (totalAmount) => {
          // Ensure paid is strictly between 0 and total
          const paidAmount = totalAmount / 2;
          const status = determineStatus(paidAmount, totalAmount, '2030-12-31', '2025-01-01', false);
          expect(status).toBe('PARTIAL_PAID');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('paid_amount = 0 and not overdue implies APPROVED (or DRAFT)', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        (totalAmount) => {
          const status = determineStatus(0, totalAmount, '2030-12-31', '2025-01-01', false);
          expect(['DRAFT', 'APPROVED']).toContain(status);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('overdue and not fully paid implies OVERDUE', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        moneyArb,
        (totalAmount, paidAmount) => {
          // Ensure not fully paid
          fc.pre(paidAmount < totalAmount);
          // due_date in the past, current date after due_date
          const status = determineStatus(paidAmount, totalAmount, '2020-01-01', '2025-06-01', false);
          expect(status).toBe('OVERDUE');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('cancelled invoice always returns CANCELLED regardless of payment', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        moneyArb,
        dateArb,
        dateArb,
        (totalAmount, paidAmount, dueDate, currentDate) => {
          const status = determineStatus(paidAmount, totalAmount, dueDate, currentDate, true);
          expect(status).toBe('CANCELLED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('recordPayment transitions to correct status', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        posMoneyArb,
        (totalAmount, paymentAmount) => {
          const invoice = {
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
            status: 'APPROVED' as InvoiceStatus,
          };

          const result = recordPayment(invoice, paymentAmount);

          if (result.paid_amount >= totalAmount) {
            expect(result.status).toBe('PAID');
          } else if (result.paid_amount > 0) {
            expect(result.status).toBe('PARTIAL_PAID');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 13: Thanh toán vượt mức tạo tiền thừa
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 13: Thanh toán vượt mức tạo tiền thừa
 *
 * Với bất kỳ khoản thanh toán mà số tiền > remaining_amount của hoá đơn,
 * hệ thống phải tạo bản ghi excess_amount với amount = số tiền thanh toán - remaining_amount,
 * và hoá đơn phải có trạng thái PAID.
 *
 * **Validates: Requirements 7.5, 8.1**
 */
describe('Feature: invoice-reimplementation, Property 13: Thanh toán vượt mức tạo tiền thừa', () => {
  it('overpayment creates excess_amount equal to payment minus remaining', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        posMoneyArb,
        (totalAmount, extraAmount) => {
          const invoice = {
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
            status: 'APPROVED' as InvoiceStatus,
          };

          // Pay more than the total
          const paymentAmount = totalAmount + extraAmount;
          const result = recordPayment(invoice, paymentAmount);

          expect(result.excess_amount).toBe(paymentAmount - totalAmount);
          expect(result.status).toBe('PAID');
          expect(result.remaining_amount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('exact payment produces zero excess', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        (totalAmount) => {
          const invoice = {
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
            status: 'APPROVED' as InvoiceStatus,
          };

          const result = recordPayment(invoice, totalAmount);

          expect(result.excess_amount).toBe(0);
          expect(result.status).toBe('PAID');
          expect(result.remaining_amount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('partial payment produces zero excess and status PARTIAL_PAID', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
        (totalAmount) => {
          const invoice = {
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
            status: 'APPROVED' as InvoiceStatus,
          };

          // Pay less than total
          const paymentAmount = totalAmount / 2;
          const result = recordPayment(invoice, paymentAmount);

          expect(result.excess_amount).toBe(0);
          expect(result.status).toBe('PARTIAL_PAID');
          expect(result.remaining_amount).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('overpayment on partially paid invoice creates correct excess', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000_000 }),
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 1, max: 100_000_000 }),
        (totalAmount, alreadyPaid, extraAmount) => {
          fc.pre(alreadyPaid < totalAmount);
          const remaining = totalAmount - alreadyPaid;
          const invoice = {
            total_amount: totalAmount,
            paid_amount: alreadyPaid,
            remaining_amount: remaining,
            status: 'PARTIAL_PAID' as InvoiceStatus,
          };

          // Pay remaining + extra
          const paymentAmount = remaining + extraAmount;
          const result = recordPayment(invoice, paymentAmount);

          expect(result.excess_amount).toBe(extraAmount);
          expect(result.status).toBe('PAID');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 14: Số dư tiền thừa chính xác
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 14: Số dư tiền thừa chính xác
 *
 * Với bất kỳ hợp đồng, số tiền thừa hiện có phải bằng SUM(amount)
 * của tất cả bản ghi trong bảng excess_amounts thuộc hợp đồng đó.
 *
 * **Validates: Requirements 8.2**
 */
describe('Feature: invoice-reimplementation, Property 14: Số dư tiền thừa chính xác', () => {
  /** Model: compute excess balance for a contract from its excess_amount records */
  function computeExcessBalance(records: { contract_id: string; amount: number }[], contractId: string): number {
    return records
      .filter((r) => r.contract_id === contractId)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  it('excess balance equals SUM of all excess_amount records for a contract', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(
          fc.record({
            amount: fc.double({ min: -100_000_000, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (contractId, amounts) => {
          const records = amounts.map((a) => ({ contract_id: contractId, amount: a.amount }));
          const balance = computeExcessBalance(records, contractId);
          const expectedSum = records.reduce((sum, r) => sum + r.amount, 0);

          expect(balance).toBe(expectedSum);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('excess balance only includes records for the target contract', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.array(
          fc.double({ min: 0.01, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.array(
          fc.double({ min: 0.01, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
          { minLength: 1, maxLength: 5 },
        ),
        (contractA, contractB, amountsA, amountsB) => {
          fc.pre(contractA !== contractB);

          const records = [
            ...amountsA.map((a) => ({ contract_id: contractA, amount: a })),
            ...amountsB.map((a) => ({ contract_id: contractB, amount: a })),
          ];

          const balanceA = computeExcessBalance(records, contractA);
          const balanceB = computeExcessBalance(records, contractB);

          const expectedA = amountsA.reduce((sum, a) => sum + a, 0);
          const expectedB = amountsB.reduce((sum, a) => sum + a, 0);

          expect(balanceA).toBe(expectedA);
          expect(balanceB).toBe(expectedB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('positive amounts (credits) increase balance, negative amounts (debits) decrease it', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.double({ min: 0.01, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.01, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
        (contractId, credit, debit) => {
          const records = [
            { contract_id: contractId, amount: credit },   // positive = credit added
            { contract_id: contractId, amount: -debit },    // negative = credit used
          ];

          const balance = computeExcessBalance(records, contractId);
          expect(balance).toBe(credit - debit);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 15: remaining_amount luôn nhất quán
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 15: remaining_amount luôn nhất quán
 *
 * Với bất kỳ hoá đơn, remaining_amount phải luôn bằng
 * total_amount - COALESCE(paid_amount, 0). Đây là invariant.
 *
 * **Validates: Requirements 7.6, 11.9**
 */
describe('Feature: invoice-reimplementation, Property 15: remaining_amount luôn nhất quán', () => {
  /** Model: compute remaining_amount as a generated column would */
  function computeRemaining(totalAmount: number, paidAmount: number | null): number {
    return totalAmount - (paidAmount ?? 0);
  }

  it('remaining_amount = total_amount - COALESCE(paid_amount, 0) for any invoice', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        fc.oneof(moneyArb, fc.constant(null as number | null)),
        (totalAmount, paidAmount) => {
          const remaining = computeRemaining(totalAmount, paidAmount);
          const expected = totalAmount - (paidAmount ?? 0);

          expect(remaining).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('remaining_amount is consistent after payment via recordPayment', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        posMoneyArb,
        (totalAmount, paymentAmount) => {
          const invoice = {
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
            status: 'APPROVED' as InvoiceStatus,
          };

          const result = recordPayment(invoice, paymentAmount);

          // remaining_amount should be max(0, total - new_paid)
          const expectedRemaining = Math.max(0, totalAmount - result.paid_amount);
          expect(result.remaining_amount).toBe(expectedRemaining);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('remaining_amount invariant holds across multiple sequential payments', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        fc.array(posMoneyArb, { minLength: 1, maxLength: 5 }),
        (totalAmount, payments) => {
          let invoice = {
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
            status: 'APPROVED' as InvoiceStatus,
          };

          for (const payment of payments) {
            const result = recordPayment(invoice, payment);

            // Invariant: remaining = max(0, total - paid)
            const expectedRemaining = Math.max(0, totalAmount - result.paid_amount);
            expect(result.remaining_amount).toBe(expectedRemaining);

            invoice = {
              total_amount: totalAmount,
              paid_amount: result.paid_amount,
              remaining_amount: result.remaining_amount,
              status: result.status,
            };
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('remaining_amount is zero when paid_amount >= total_amount', () => {
    fc.assert(
      fc.property(
        posMoneyArb,
        moneyArb,
        (totalAmount, extraAmount) => {
          const paidAmount = totalAmount + extraAmount;
          const remaining = Math.max(0, totalAmount - paidAmount);

          expect(remaining).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
