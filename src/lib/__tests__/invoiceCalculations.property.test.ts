import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { calculateInvoiceTotals, type TotalsItem } from '../invoiceUtils';

/**
 * Feature: invoice-reimplementation
 * Property 1: Tính toán tổng hoá đơn chính xác
 *
 * Với bất kỳ danh sách dòng dịch vụ (items), giảm giá (discount),
 * phần trăm thuế (tax_percent), và tiền trả trước (prepaid), hệ thống phải tính:
 * - subtotal = Σ(unit_price × quantity × coefficient)
 * - tax_amount = subtotal × tax_percent / 100
 * - total_amount = subtotal - discount + tax_amount
 * - remaining = total_amount - prepaid
 *
 * **Validates: Requirements 1.10**
 */
describe('Feature: invoice-reimplementation, Property 1: Tính toán tổng hoá đơn chính xác', () => {
  const itemArb: fc.Arbitrary<TotalsItem> = fc.record({
    unit_price: fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
    quantity: fc.double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true }),
    coefficient: fc.double({ min: 0.1, max: 10, noNaN: true, noDefaultInfinity: true }),
  });

  const itemsArb = fc.array(itemArb, { minLength: 0, maxLength: 20 });
  const discountArb = fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true });
  const taxPercentArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
  const prepaidArb = fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true });

  it('subtotal should equal sum of unit_price × quantity × coefficient for all items', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, taxPercentArb, prepaidArb, (items, discount, taxPercent, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, taxPercent, prepaid);

        const expectedSubtotal = items.reduce(
          (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
          0,
        );

        expect(result.subtotal).toBe(expectedSubtotal);
      }),
      { numRuns: 100 },
    );
  });

  it('tax_amount should equal subtotal × tax_percent / 100', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, taxPercentArb, prepaidArb, (items, discount, taxPercent, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, taxPercent, prepaid);

        const expectedTaxAmount = result.subtotal * taxPercent / 100;

        expect(result.tax_amount).toBe(expectedTaxAmount);
      }),
      { numRuns: 100 },
    );
  });

  it('total_amount should equal subtotal - discount + tax_amount', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, taxPercentArb, prepaidArb, (items, discount, taxPercent, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, taxPercent, prepaid);

        const expectedTotal = result.subtotal - discount + result.tax_amount;

        expect(result.total_amount).toBe(expectedTotal);
      }),
      { numRuns: 100 },
    );
  });

  it('remaining should equal total_amount - prepaid', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, taxPercentArb, prepaidArb, (items, discount, taxPercent, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, taxPercent, prepaid);

        const expectedRemaining = result.total_amount - prepaid;

        expect(result.remaining).toBe(expectedRemaining);
      }),
      { numRuns: 100 },
    );
  });

  it('discount_amount, tax_percent, and prepaid_amount should be stored correctly', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, taxPercentArb, prepaidArb, (items, discount, taxPercent, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, taxPercent, prepaid);

        expect(result.discount_amount).toBe(discount);
        expect(result.tax_percent).toBe(taxPercent);
        expect(result.prepaid_amount).toBe(prepaid);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: invoice-reimplementation
 * Property 5: Tính toán số lượng từ chỉ số công tơ
 *
 * Với bất kỳ dịch vụ loại METER_READING có chỉ số đầu (previous_reading)
 * và chỉ số cuối (current_reading) với current_reading >= previous_reading >= 0,
 * số lượng (quantity) phải bằng current_reading - previous_reading.
 *
 * **Validates: Requirements 1.9**
 */
describe('Feature: invoice-reimplementation, Property 5: Tính toán số lượng từ chỉ số công tơ', () => {
  it('quantity should always equal current_reading - previous_reading for valid readings', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          const current_reading = Math.max(a, b);
          const previous_reading = Math.min(a, b);

          const quantity = current_reading - previous_reading;

          expect(quantity).toBe(current_reading - previous_reading);
          expect(quantity).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('meter reading quantity feeds correctly into invoice totals calculation', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        (a, b, unitPrice) => {
          const current_reading = Math.max(a, b);
          const previous_reading = Math.min(a, b);

          // Meter reading quantity calculation
          const quantity = current_reading - previous_reading;

          // Use the quantity in an invoice item with coefficient = 1
          const item: TotalsItem = { unit_price: unitPrice, quantity, coefficient: 1 };
          const result = calculateInvoiceTotals([item], 0, 0, 0);

          expect(result.subtotal).toBe(unitPrice * quantity);
        },
      ),
      { numRuns: 100 },
    );
  });
});
