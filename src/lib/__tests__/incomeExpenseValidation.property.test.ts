import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { incomeExpenseFormSchema, validateTotalAmount, canEditVoucher } from '../incomeExpenseValidation';

/**
 * Feature: thu-chi-reimplementation
 * Property 2: Validation từ chối input thiếu trường bắt buộc
 * **Validates: Yêu cầu 1.7, 2.4**
 *
 * Với bất kỳ đối tượng phiếu thu/chi input nào mà thiếu ít nhất một trường bắt buộc
 * (type, name, building_id, voucher_date) hoặc có danh sách items rỗng,
 * Zod schema validation phải từ chối và trả về lỗi tương ứng cho trường bị thiếu.
 */

const REQUIRED_FIELDS = ['type', 'name', 'building_id', 'voucher_date'] as const;

const validItemArb = fc.record({
  income_expense_type_id: fc.uuid(),
  description: fc.constant(null),
  quantity: fc.integer({ min: 1, max: 100 }),
  unit_price: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
});

const validInputArb = fc.record({
  type: fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  building_id: fc.uuid(),
  room_id: fc.constant(null),
  bed_id: fc.constant(null),
  tenant_id: fc.constant(null),
  voucher_date: fc.constant('2025-01-15'),
  notes: fc.constant(null),
  items: fc.array(validItemArb, { minLength: 1, maxLength: 5 }),
});

const fieldsToOmitArb = fc.subarray([...REQUIRED_FIELDS], { minLength: 1 }).filter(arr => arr.length >= 1);

describe('Property 2: Validation từ chối input thiếu trường bắt buộc', () => {
  it('should reject any voucher input missing at least one required field', () => {
    fc.assert(
      fc.property(validInputArb, fieldsToOmitArb, (validInput, fieldsToOmit) => {
        const incompleteInput: Record<string, unknown> = { ...validInput };
        for (const field of fieldsToOmit) {
          if (field === 'type') {
            delete incompleteInput[field];
          } else {
            incompleteInput[field] = '';
          }
        }
        const result = incomeExpenseFormSchema.safeParse(incompleteInput);
        expect(result.success).toBe(false);
        if (!result.success) {
          const errorPaths = result.error.issues.map(issue => issue.path[0]);
          for (const field of fieldsToOmit) {
            expect(errorPaths).toContain(field);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should reject input with empty items array', () => {
    fc.assert(
      fc.property(validInputArb, (validInput) => {
        const inputWithNoItems = { ...validInput, items: [] };
        const result = incomeExpenseFormSchema.safeParse(inputWithNoItems);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 3: Tổng tiền phiếu = Tổng thành tiền các hạng mục
 * **Validates: Yêu cầu 1.5, 11.8**
 *
 * Với bất kỳ phiếu thu/chi nào có N hạng mục, total_amount phải luôn bằng
 * tổng quantity * unit_price của tất cả hạng mục thuộc phiếu đó.
 */
describe('Property 3: Tổng tiền phiếu = Tổng thành tiền các hạng mục', () => {
  it('validateTotalAmount should equal sum of quantity * unit_price for all items', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            quantity: fc.integer({ min: 1, max: 1000 }),
            unit_price: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (items) => {
          const total = validateTotalAmount(items);
          const expected = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
          expect(total).toBeCloseTo(expected, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('total should be 0 for empty items array', () => {
    expect(validateTotalAmount([])).toBe(0);
  });

  it('total should be non-negative when all unit_prices are non-negative', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            quantity: fc.integer({ min: 1, max: 1000 }),
            unit_price: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (items) => {
          const total = validateTotalAmount(items);
          expect(total).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 4: Quyền sửa/xoá phụ thuộc trạng thái duyệt
 * **Validates: Yêu cầu 3.1, 3.2**
 *
 * Với bất kỳ phiếu thu/chi nào, nếu approval_status === 'UNAPPROVED' thì cho phép sửa và xoá,
 * nếu approval_status === 'APPROVED' thì không cho phép sửa và xoá.
 */
describe('Property 4: Quyền sửa/xoá phụ thuộc trạng thái duyệt', () => {
  it('UNAPPROVED should allow edit', () => {
    expect(canEditVoucher('UNAPPROVED')).toBe(true);
  });

  it('APPROVED should disallow edit', () => {
    expect(canEditVoucher('APPROVED')).toBe(false);
  });

  it('canEditVoucher should return true only for UNAPPROVED', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('UNAPPROVED', 'APPROVED'),
        (status) => {
          expect(canEditVoucher(status)).toBe(status === 'UNAPPROVED');
        },
      ),
      { numRuns: 100 },
    );
  });
});
