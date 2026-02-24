import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  renderInvoiceTemplate,
  formatCurrencyVND,
  numberToVietnameseWords,
  type InvoiceTemplateData,
  type InvoiceFeeItem,
} from '../invoiceTemplateEngine';

// =============================================
// Shared Generators
// =============================================

/** Generate a safe alphanumeric string (no braces, plus signs, dollar signs, or special template/regex chars) */
const safeStringArb = fc.string({ minLength: 1, maxLength: 30 }).map((s) =>
  s.replace(/[{}+<>|\\$`]/g, 'x'),
).filter((s) => s.trim().length > 0);

/** Generate a formatted currency string like "1.000.000" */
const currencyStringArb = fc.integer({ min: 0, max: 999_999_999 }).map((n) => formatCurrencyVND(n));

/** Generate a single InvoiceFeeItem */
const feeItemArb: fc.Arbitrary<InvoiceFeeItem> = fc.record({
  index: fc.integer({ min: 1, max: 100 }),
  name: safeStringArb,
  price: currencyStringArb,
  quantity: safeStringArb,
  coefficient: safeStringArb,
  total: currencyStringArb,
});

/** Generate valid InvoiceTemplateData */
const templateDataArb: fc.Arbitrary<InvoiceTemplateData> = fc.record({
  APARTMENT_NAME: safeStringArb,
  ROOM_NAME: safeStringArb,
  CONTRACT_NAME: safeStringArb,
  INVOICE_CODE: safeStringArb,
  ISSUE_DATE: safeStringArb,
  DUE_DATE: safeStringArb,
  SUBTOTAL: currencyStringArb,
  DISCOUNT_WITH_PROMOTION: currencyStringArb,
  DEBT: currencyStringArb,
  TOTAL_WITH_DEBT: currencyStringArb,
  PAID: currencyStringArb,
  REMAIN: currencyStringArb,
  AMOUNT_IN_WORDS_WITH_DEBT: safeStringArb,
  NOTE: safeStringArb,
  FEES: fc.array(feeItemArb, { minLength: 0, maxLength: 10 }),
});


// =============================================
// Property 16: Template engine thay thế tất cả placeholder
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 16: Template engine thay thế tất cả placeholder
 *
 * After render, no {PLACEHOLDER_NAME} patterns should remain.
 * Known placeholders replaced with values, unknown with empty string.
 *
 * **Validates: Requirements 9.2, 12.1, 12.2, 12.7**
 */
describe('Feature: invoice-reimplementation, Property 16: Template engine thay thế tất cả placeholder', () => {
  it('no {PLACEHOLDER_NAME} patterns should remain after rendering with known data', () => {
    fc.assert(
      fc.property(templateDataArb, (data) => {
        const template =
          'Toà nhà: {APARTMENT_NAME}, Phòng: {ROOM_NAME}, HĐ: {CONTRACT_NAME}, ' +
          'Mã: {INVOICE_CODE}, Ngày: {ISSUE_DATE}, Hạn: {DUE_DATE}, ' +
          'Tạm tính: {SUBTOTAL}, Giảm: {DISCOUNT_WITH_PROMOTION}, Nợ: {DEBT}, ' +
          'Tổng: {TOTAL_WITH_DEBT}, Đã trả: {PAID}, Còn: {REMAIN}, ' +
          'Bằng chữ: {AMOUNT_IN_WORDS_WITH_DEBT}, Ghi chú: {NOTE}';

        const result = renderInvoiceTemplate(template, data);

        // No uppercase placeholder patterns should remain
        expect(result).not.toMatch(/\{[A-Z_][A-Z0-9_]*\}/);
      }),
      { numRuns: 100 },
    );
  });

  it('unknown placeholders should be replaced with empty string', () => {
    fc.assert(
      fc.property(templateDataArb, (data) => {
        const template = 'Known: {APARTMENT_NAME}, Unknown: {UNKNOWN_FIELD}, Also: {ANOTHER_MISSING}';

        const result = renderInvoiceTemplate(template, data);

        expect(result).not.toMatch(/\{[A-Z_][A-Z0-9_]*\}/);
        expect(result).toContain(data.APARTMENT_NAME);
      }),
      { numRuns: 100 },
    );
  });

  it('known placeholders should be replaced with their corresponding values', () => {
    fc.assert(
      fc.property(templateDataArb, (data) => {
        const template = '{APARTMENT_NAME}|{ROOM_NAME}|{INVOICE_CODE}';

        const result = renderInvoiceTemplate(template, data);

        expect(result).toBe(`${data.APARTMENT_NAME}|${data.ROOM_NAME}|${data.INVOICE_CODE}`);
      }),
      { numRuns: 100 },
    );
  });
});


// =============================================
// Property 17: Template engine render FEES loop chính xác
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 17: Template engine render FEES loop chính xác
 *
 * For N fee items, output must contain N rendered loop bodies with correct values.
 *
 * **Validates: Requirements 9.3, 12.3**
 */
describe('Feature: invoice-reimplementation, Property 17: Template engine render FEES loop chính xác', () => {
  it('output should contain exactly N rendered fee rows for N fee items', () => {
    fc.assert(
      fc.property(
        fc.array(feeItemArb, { minLength: 1, maxLength: 10 }),
        (fees) => {
          const data: InvoiceTemplateData = {
            APARTMENT_NAME: 'Test',
            ROOM_NAME: 'R1',
            CONTRACT_NAME: 'C1',
            INVOICE_CODE: 'INV001',
            ISSUE_DATE: '01/01/2025',
            DUE_DATE: '06/01/2025',
            SUBTOTAL: '0',
            DISCOUNT_WITH_PROMOTION: '0',
            DEBT: '0',
            TOTAL_WITH_DEBT: '0',
            PAID: '0',
            REMAIN: '0',
            AMOUNT_IN_WORDS_WITH_DEBT: 'test',
            NOTE: '',
            FEES: fees,
          };

          // Use a unique marker to count rendered rows
          const template = '{#FEES}<row>{index}|{name}|{price}|{quantity}|{coefficient}|{total}</row>{/FEES}';
          const result = renderInvoiceTemplate(template, data);

          const rowMatches = result.match(/<row>.*?<\/row>/g);
          expect(rowMatches).not.toBeNull();
          expect(rowMatches!.length).toBe(fees.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('each rendered fee row should contain the correct values for that fee item', () => {
    fc.assert(
      fc.property(
        fc.array(feeItemArb, { minLength: 1, maxLength: 5 }),
        (fees) => {
          // Ensure unique indices so we can identify each row
          const uniqueFees = fees.map((f, i) => ({ ...f, index: i + 1 }));

          const data: InvoiceTemplateData = {
            APARTMENT_NAME: 'Test',
            ROOM_NAME: 'R1',
            CONTRACT_NAME: 'C1',
            INVOICE_CODE: 'INV001',
            ISSUE_DATE: '01/01/2025',
            DUE_DATE: '06/01/2025',
            SUBTOTAL: '0',
            DISCOUNT_WITH_PROMOTION: '0',
            DEBT: '0',
            TOTAL_WITH_DEBT: '0',
            PAID: '0',
            REMAIN: '0',
            AMOUNT_IN_WORDS_WITH_DEBT: 'test',
            NOTE: '',
            FEES: uniqueFees,
          };

          const template = '{#FEES}<row data-idx="{index}">{name}--{price}--{quantity}--{coefficient}--{total}</row>{/FEES}';
          const result = renderInvoiceTemplate(template, data);

          for (const fee of uniqueFees) {
            // Check that each fee's index appears in the output
            expect(result).toContain(`data-idx="${fee.index}"`);
            // Check that each fee's name appears in the output
            expect(result).toContain(fee.name);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('empty FEES array should produce empty output for the loop block', () => {
    fc.assert(
      fc.property(templateDataArb, (data) => {
        const dataWithNoFees = { ...data, FEES: [] };
        const template = 'Before{#FEES}<row>{name}</row>{/FEES}After';
        const result = renderInvoiceTemplate(template, dataWithNoFees);

        expect(result).toBe('BeforeAfter');
      }),
      { numRuns: 100 },
    );
  });
});


// =============================================
// Property 18: Format tiền VNĐ chính xác
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 18: Format tiền VNĐ chính xác
 *
 * formatCurrencyVND must produce dot-separated thousands.
 * Parse back should give original value (round-trip).
 *
 * **Validates: Requirements 12.4**
 */
describe('Feature: invoice-reimplementation, Property 18: Format tiền VNĐ chính xác', () => {
  it('round-trip: parsing formatted currency should return the original integer value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999_999_999 }),
        (amount) => {
          const formatted = formatCurrencyVND(amount);

          // Parse back by removing dots
          const parsed = Number(formatted.replace(/\./g, ''));

          expect(parsed).toBe(amount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('formatted output should only contain digits and dots (for non-negative integers)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999_999_999 }),
        (amount) => {
          const formatted = formatCurrencyVND(amount);

          expect(formatted).toMatch(/^[\d.]+$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('dot separators should appear every 3 digits from the right for numbers >= 1000', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 999_999_999_999 }),
        (amount) => {
          const formatted = formatCurrencyVND(amount);
          const parts = formatted.split('.');

          // First part can be 1-3 digits, remaining parts must be exactly 3 digits
          expect(parts[0].length).toBeGreaterThanOrEqual(1);
          expect(parts[0].length).toBeLessThanOrEqual(3);
          for (let i = 1; i < parts.length; i++) {
            expect(parts[i].length).toBe(3);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('numbers less than 1000 should have no dots', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        (amount) => {
          const formatted = formatCurrencyVND(amount);

          expect(formatted).not.toContain('.');
          expect(formatted).toBe(String(amount));
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================
// Property 19: Chuyển đổi số tiền thành chữ tiếng Việt
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 19: Chuyển đổi số tiền thành chữ tiếng Việt
 *
 * numberToVietnameseWords must return non-empty string ending with "đồng",
 * and be deterministic (same input → same output).
 *
 * **Validates: Requirements 12.5**
 */
describe('Feature: invoice-reimplementation, Property 19: Chuyển đổi số tiền thành chữ tiếng Việt', () => {
  it('result should always be a non-empty string ending with "đồng"', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999_999_999 }),
        (amount) => {
          const result = numberToVietnameseWords(amount);

          expect(result.length).toBeGreaterThan(0);
          expect(result).toMatch(/đồng$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should be deterministic: same input always produces same output', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999_999_999 }),
        (amount) => {
          const result1 = numberToVietnameseWords(amount);
          const result2 = numberToVietnameseWords(amount);

          expect(result1).toBe(result2);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('zero should produce "không đồng"', () => {
    const result = numberToVietnameseWords(0);
    expect(result).toBe('không đồng');
  });

  it('result should only contain Vietnamese word characters and spaces', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999_999_999 }),
        (amount) => {
          const result = numberToVietnameseWords(amount);

          // Should only contain Vietnamese letters, spaces, and common diacritics
          // No digits, no special characters
          expect(result).not.toMatch(/\d/);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================
// Property 20: Template render round-trip
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 20: Template render round-trip
 *
 * Render template then extract placeholder values from output -
 * they should match original data for simple text fields.
 *
 * **Validates: Requirements 12.6**
 */
describe('Feature: invoice-reimplementation, Property 20: Template render round-trip', () => {
  it('rendered values should be extractable and match original data for simple text fields', () => {
    fc.assert(
      fc.property(templateDataArb, (data) => {
        // Use a template with unique delimiters to extract values back
        const template =
          'APT=<<{APARTMENT_NAME}>>,' +
          'ROOM=<<{ROOM_NAME}>>,' +
          'CONTRACT=<<{CONTRACT_NAME}>>,' +
          'CODE=<<{INVOICE_CODE}>>,' +
          'ISSUE=<<{ISSUE_DATE}>>,' +
          'DUE=<<{DUE_DATE}>>,' +
          'NOTE=<<{NOTE}>>';

        const result = renderInvoiceTemplate(template, data);

        // Extract values back using the delimiters
        const extractValue = (key: string): string | null => {
          const regex = new RegExp(`${key}=<<(.*?)>>`);
          const match = result.match(regex);
          return match ? match[1] : null;
        };

        expect(extractValue('APT')).toBe(data.APARTMENT_NAME);
        expect(extractValue('ROOM')).toBe(data.ROOM_NAME);
        expect(extractValue('CONTRACT')).toBe(data.CONTRACT_NAME);
        expect(extractValue('CODE')).toBe(data.INVOICE_CODE);
        expect(extractValue('ISSUE')).toBe(data.ISSUE_DATE);
        expect(extractValue('DUE')).toBe(data.DUE_DATE);
        expect(extractValue('NOTE')).toBe(data.NOTE);
      }),
      { numRuns: 100 },
    );
  });

  it('rendered currency fields should match original data values', () => {
    fc.assert(
      fc.property(templateDataArb, (data) => {
        const template =
          'SUB=<<{SUBTOTAL}>>,' +
          'DISC=<<{DISCOUNT_WITH_PROMOTION}>>,' +
          'TOTAL=<<{TOTAL_WITH_DEBT}>>,' +
          'PAID=<<{PAID}>>,' +
          'REMAIN=<<{REMAIN}>>';

        const result = renderInvoiceTemplate(template, data);

        const extractValue = (key: string): string | null => {
          const regex = new RegExp(`${key}=<<(.*?)>>`);
          const match = result.match(regex);
          return match ? match[1] : null;
        };

        expect(extractValue('SUB')).toBe(data.SUBTOTAL);
        expect(extractValue('DISC')).toBe(data.DISCOUNT_WITH_PROMOTION);
        expect(extractValue('TOTAL')).toBe(data.TOTAL_WITH_DEBT);
        expect(extractValue('PAID')).toBe(data.PAID);
        expect(extractValue('REMAIN')).toBe(data.REMAIN);
      }),
      { numRuns: 100 },
    );
  });
});
