import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { invoiceFormSchema, prepaidValidation } from '../invoiceValidation';
import { validateParsedRows, type ParsedInvoiceRow } from '../invoiceExcelHelpers';

// =============================================
// Shared Generators
// =============================================

/** A valid invoice item that passes the invoiceItemSchema */
const validItemArb = fc.record({
  service_id: fc.option(fc.uuid(), { nil: null }),
  type: fc.constantFrom('RENT', 'SERVICE', 'PENALTY', 'DISCOUNT', 'OTHER' as const),
  description: fc.string({ minLength: 1, maxLength: 50 }),
  unit_price: fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
  quantity: fc.double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true }),
  coefficient: fc.double({ min: 0.1, max: 10, noNaN: true, noDefaultInfinity: true }),
});

/** A fully valid invoice form object that should pass validation */
const validInvoiceFormArb = fc.record({
  building_id: fc.uuid(),
  room_id: fc.uuid(),
  bed_id: fc.option(fc.uuid(), { nil: null }),
  contract_id: fc.uuid(),
  billing_month: fc.integer({ min: 2020, max: 2030 }).chain((year) =>
    fc.integer({ min: 1, max: 12 }).map((month) =>
      `${year}-${String(month).padStart(2, '0')}`
    )
  ),
  issue_date: fc.constant('2025-01-01'),
  due_date: fc.constant('2025-01-15'),
  template_id: fc.option(fc.uuid(), { nil: null }),
  notes: fc.option(fc.string({ maxLength: 100 }), { nil: null }),
  discount_amount: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
  tax_percent: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  prepaid_amount: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
  previous_debt: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
  items: fc.array(validItemArb, { minLength: 1, maxLength: 5 }),
});

/** Required field names that must be non-empty strings */
const requiredStringFields = [
  'building_id',
  'room_id',
  'contract_id',
  'billing_month',
  'issue_date',
  'due_date',
] as const;

// =============================================
// Property 2: Validation từ chối input thiếu trường bắt buộc
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 2: Validation từ chối input thiếu trường bắt buộc
 *
 * Với bất kỳ đối tượng hoá đơn input nào mà thiếu ít nhất một trường bắt buộc
 * (building_id, room_id, contract_id, billing_month, issue_date, due_date)
 * hoặc có danh sách items rỗng, validation schema phải từ chối.
 *
 * **Validates: Requirements 1.13**
 */
describe('Feature: invoice-reimplementation, Property 2: Validation từ chối input thiếu trường bắt buộc', () => {
  it('should reject when any required string field is empty', () => {
    fc.assert(
      fc.property(
        validInvoiceFormArb,
        fc.constantFrom(...requiredStringFields),
        (form, fieldToEmpty) => {
          const invalidForm = { ...form, [fieldToEmpty]: '' };
          const result = invoiceFormSchema.safeParse(invalidForm);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject when items array is empty', () => {
    fc.assert(
      fc.property(validInvoiceFormArb, (form) => {
        const invalidForm = { ...form, items: [] };
        const result = invoiceFormSchema.safeParse(invalidForm);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('should reject when multiple required fields are empty simultaneously', () => {
    fc.assert(
      fc.property(
        validInvoiceFormArb,
        fc.subarray([...requiredStringFields], { minLength: 2 }),
        (form, fieldsToEmpty) => {
          const invalidForm = { ...form };
          for (const field of fieldsToEmpty) {
            (invalidForm as any)[field] = '';
          }
          const result = invoiceFormSchema.safeParse(invalidForm);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should accept a fully valid invoice form', () => {
    fc.assert(
      fc.property(validInvoiceFormArb, (form) => {
        const result = invoiceFormSchema.safeParse(form);
        expect(result.success).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 3: Validation tiền trả trước
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 3: Validation tiền trả trước
 *
 * Với bất kỳ số tiền trả trước (prepaid) và số tiền thừa hiện có (excessBalance)
 * và tổng hoá đơn (totalAmount):
 * - Nếu prepaid > excessBalance hoặc prepaid > totalAmount → reject
 * - Nếu 0 <= prepaid <= min(excessBalance, totalAmount) → accept
 *
 * **Validates: Requirements 1.11, 8.4**
 */
describe('Feature: invoice-reimplementation, Property 3: Validation tiền trả trước', () => {
  const positiveDoubleArb = fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true });

  it('should reject when prepaid exceeds excessBalance', () => {
    fc.assert(
      fc.property(
        positiveDoubleArb,
        positiveDoubleArb,
        (excessBalance, totalAmount) => {
          // Ensure prepaid > excessBalance
          const prepaid = excessBalance + 1;
          const result = prepaidValidation(prepaid, excessBalance, totalAmount);
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject when prepaid exceeds totalAmount', () => {
    fc.assert(
      fc.property(
        positiveDoubleArb,
        positiveDoubleArb,
        (excessBalance, totalAmount) => {
          // Ensure prepaid > totalAmount but <= excessBalance
          const prepaid = totalAmount + 1;
          const largeExcess = prepaid + 1000; // excessBalance is large enough
          const result = prepaidValidation(prepaid, largeExcess, totalAmount);
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject when prepaid is negative', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100_000_000, max: -0.01, noNaN: true, noDefaultInfinity: true }),
        positiveDoubleArb,
        positiveDoubleArb,
        (prepaid, excessBalance, totalAmount) => {
          const result = prepaidValidation(prepaid, excessBalance, totalAmount);
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should accept when 0 <= prepaid <= min(excessBalance, totalAmount)', () => {
    fc.assert(
      fc.property(
        positiveDoubleArb,
        positiveDoubleArb,
        (excessBalance, totalAmount) => {
          const minVal = Math.min(excessBalance, totalAmount);
          // Generate prepaid in [0, minVal]
          const prepaid = minVal * Math.random(); // 0 to minVal
          const result = prepaidValidation(prepaid, excessBalance, totalAmount);
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should accept when prepaid is exactly 0', () => {
    fc.assert(
      fc.property(
        positiveDoubleArb,
        positiveDoubleArb,
        (excessBalance, totalAmount) => {
          const result = prepaidValidation(0, excessBalance, totalAmount);
          expect(result.valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should accept when prepaid equals min(excessBalance, totalAmount)', () => {
    fc.assert(
      fc.property(
        positiveDoubleArb,
        positiveDoubleArb,
        (excessBalance, totalAmount) => {
          const prepaid = Math.min(excessBalance, totalAmount);
          const result = prepaidValidation(prepaid, excessBalance, totalAmount);
          expect(result.valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 22: Excel parsing validation
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 22: Excel parsing validation
 *
 * Với bất kỳ dữ liệu Excel có dòng thiếu trường bắt buộc hoặc sai định dạng,
 * hệ thống phải trả về lỗi chi tiết cho đúng dòng sai, và không tạo hoá đơn cho
 * dòng đó. Các dòng hợp lệ vẫn được xử lý bình thường.
 *
 * **Validates: Requirements 2.4, 2.6**
 */
describe('Feature: invoice-reimplementation, Property 22: Excel parsing validation', () => {
  /** Generator for a valid ParsedInvoiceRow */
  const validRowArb: fc.Arbitrary<ParsedInvoiceRow> = fc.record({
    room_name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    bed_name: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
    services: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
      fc.double({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true }),
      { minKeys: 0, maxKeys: 5 },
    ),
  });

  /** Generator for an invalid row: missing room_name */
  const missingRoomRowArb: fc.Arbitrary<ParsedInvoiceRow> = fc.record({
    room_name: fc.constant(''),
    bed_name: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
    services: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
      fc.double({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true }),
      { minKeys: 0, maxKeys: 3 },
    ),
  });

  /** Generator for an invalid row: NaN service amount */
  const nanServiceRowArb: fc.Arbitrary<ParsedInvoiceRow> = fc.record({
    room_name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    bed_name: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
    services: fc.constant({ 'BadService': NaN }),
  });

  it('valid rows should all pass validation with no errors', () => {
    fc.assert(
      fc.property(
        fc.array(validRowArb, { minLength: 1, maxLength: 10 }),
        (rows) => {
          const result = validateParsedRows(rows);
          expect(result.valid).toHaveLength(rows.length);
          expect(result.errors).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rows with missing room_name should produce errors', () => {
    fc.assert(
      fc.property(
        fc.array(missingRoomRowArb, { minLength: 1, maxLength: 5 }),
        (rows) => {
          const result = validateParsedRows(rows);
          expect(result.valid).toHaveLength(0);
          expect(result.errors).toHaveLength(rows.length);
          for (const error of result.errors) {
            expect(error.message).toContain('Thiếu tên phòng');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rows with NaN service amounts should produce errors', () => {
    fc.assert(
      fc.property(
        fc.array(nanServiceRowArb, { minLength: 1, maxLength: 5 }),
        (rows) => {
          const result = validateParsedRows(rows);
          expect(result.valid).toHaveLength(0);
          expect(result.errors).toHaveLength(rows.length);
          for (const error of result.errors) {
            expect(error.message).toContain('không phải số hợp lệ');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('mixed valid and invalid rows should be correctly partitioned', () => {
    fc.assert(
      fc.property(
        fc.array(validRowArb, { minLength: 1, maxLength: 5 }),
        fc.array(missingRoomRowArb, { minLength: 1, maxLength: 5 }),
        (validRows, invalidRows) => {
          // Interleave valid and invalid rows
          const allRows: ParsedInvoiceRow[] = [];
          const maxLen = Math.max(validRows.length, invalidRows.length);
          for (let i = 0; i < maxLen; i++) {
            if (i < validRows.length) allRows.push(validRows[i]);
            if (i < invalidRows.length) allRows.push(invalidRows[i]);
          }

          const result = validateParsedRows(allRows);

          // Total valid + errors should equal total rows
          expect(result.valid.length + result.errors.length).toBe(allRows.length);

          // All valid results should have non-empty room_name
          for (const row of result.valid) {
            expect(row.room_name.length).toBeGreaterThan(0);
          }

          // All errors should reference correct row numbers (1-indexed, +1 for header)
          for (const error of result.errors) {
            expect(error.row).toBeGreaterThanOrEqual(2);
            expect(error.message.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('error row numbers should be correct Excel row numbers (data row index + 2)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(validRowArb, missingRoomRowArb),
          { minLength: 1, maxLength: 10 },
        ),
        (rows) => {
          const result = validateParsedRows(rows);

          // Collect expected error row numbers
          const expectedErrorRows: number[] = [];
          rows.forEach((row, index) => {
            if (!row.room_name) {
              expectedErrorRows.push(index + 2); // +2 for header offset
            }
          });

          const actualErrorRows = result.errors.map((e) => e.row);
          expect(actualErrorRows).toEqual(expectedErrorRows);
        },
      ),
      { numRuns: 100 },
    );
  });
});
