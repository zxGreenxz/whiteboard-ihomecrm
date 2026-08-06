import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { calculateInvoiceTotals, type TotalsItem } from '../invoiceUtils';

/**
 * Feature: invoice-reimplementation
 * Property 1: Tính toán tổng hoá đơn chính xác
 *
 * Với bất kỳ danh sách dòng dịch vụ (items), giảm giá (discount),
 * và tiền trả trước (prepaid), hệ thống phải tính:
 * - subtotal = Σ(unit_price × quantity × coefficient)
 * - total_amount = subtotal - discount
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
  const prepaidArb = fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true });

  it('subtotal should equal sum of unit_price × quantity × coefficient for all items', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, prepaidArb, (items, discount, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, prepaid);

        const expectedSubtotal = items.reduce(
          (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
          0,
        );

        expect(result.subtotal).toBe(expectedSubtotal);
      }),
      { numRuns: 100 },
    );
  });

  it('total_amount should equal subtotal - discount', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, prepaidArb, (items, discount, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, prepaid);

        const expectedTotal = result.subtotal - discount;

        expect(result.total_amount).toBe(expectedTotal);
      }),
      { numRuns: 100 },
    );
  });

  it('remaining should equal total_amount - prepaid', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, prepaidArb, (items, discount, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, prepaid);

        const expectedRemaining = result.total_amount - prepaid;

        expect(result.remaining).toBe(expectedRemaining);
      }),
      { numRuns: 100 },
    );
  });

  it('discount_amount and prepaid_amount should be stored correctly', () => {
    fc.assert(
      fc.property(itemsArb, discountArb, prepaidArb, (items, discount, prepaid) => {
        const result = calculateInvoiceTotals(items, discount, prepaid);

        expect(result.discount_amount).toBe(discount);
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

          // Hai khẳng định cũ ở đây là TAUTOLOGY: `expect(quantity).toBe(
          // current_reading - previous_reading)` so một biểu thức với CHÍNH biểu
          // thức vừa tính ra nó, và `>= 0` đúng theo cấu tạo vì current = max,
          // previous = min. Không chạm code sản xuất lần nào, không bao giờ đỏ
          // được — trong khi nhãn ghi "Validates: Requirements 1.9".
          //
          // Thay bằng tính chất THẬT trên calculateInvoiceTotals: số lượng vào
          // thành tiền TUYẾN TÍNH. Nhân đôi chỉ số tiêu thụ thì thành tiền nhân
          // đôi — đây mới là điều hoá đơn phụ thuộc vào.
          const donGia = 3500;
          const mot: TotalsItem = { unit_price: donGia, quantity, coefficient: 1 };
          const hai: TotalsItem = { unit_price: donGia, quantity: quantity * 2, coefficient: 1 };

          expect(calculateInvoiceTotals([mot], 0, 0).subtotal).toBeCloseTo(donGia * quantity, 6);
          expect(calculateInvoiceTotals([hai], 0, 0).subtotal).toBeCloseTo(
            calculateInvoiceTotals([mot], 0, 0).subtotal * 2,
            6,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('chỉ số LÙI cho thành tiền ÂM — hàm KHÔNG tự kẹp về 0', () => {
    // Hành vi đáng biết và chưa test nào khoá: nếu chỉ số mới NHỎ HƠN chỉ số cũ
    // (công tơ bị thay, nhập nhầm), calculateInvoiceTotals cho ra thành tiền ÂM
    // chứ không kẹp về 0. Đó là lựa chọn ĐÚNG — kẹp im lặng sẽ biến một số liệu
    // sai thành một hoá đơn trông hợp lệ. Nhưng nó nghĩa là việc CHẶN phải nằm ở
    // tầng nhập liệu, không phải ở đây; khoá lại để không ai "sửa" thành kẹp.
    const item: TotalsItem = { unit_price: 3500, quantity: -10, coefficient: 1 };
    expect(calculateInvoiceTotals([item], 0, 0).subtotal).toBe(-35000);
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
          const result = calculateInvoiceTotals([item], 0, 0);

          expect(result.subtotal).toBe(unitPrice * quantity);
        },
      ),
      { numRuns: 100 },
    );
  });
});
