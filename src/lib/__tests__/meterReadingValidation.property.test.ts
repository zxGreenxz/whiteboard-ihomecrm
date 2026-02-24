import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  calculateConsumption,
  generateReadingCode,
  isValidReadingCode,
  validateReadingValue,
  validateImportRows,
  meterReadingFormSchema,
} from '../meterReadingValidation';

/**
 * Feature: meter-reading-full-reimplementation
 * Property 8: Consumption calculation
 *
 * Với mọi currentReading >= previousReading >= 0,
 * calculateConsumption trả về currentReading - previousReading.
 *
 * **Validates: Yêu cầu 2.5**
 */
describe('Feature: meter-reading-full-reimplementation, Property 8: Consumption calculation', () => {
  it('consumption should always equal currentReading - previousReading for valid readings', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          const currentReading = Math.max(a, b);
          const previousReading = Math.min(a, b);

          const consumption = calculateConsumption(currentReading, previousReading);

          expect(consumption).toBe(currentReading - previousReading);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Feature: meter-reading-full-reimplementation
 * Property 9: Reading code generation and validation
 *
 * Với mọi yearMonth hợp lệ và sequence 1-99999,
 * generateReadingCode tạo code pass isValidReadingCode.
 *
 * **Validates: Yêu cầu 2.6, 8.3**
 */
describe('Feature: meter-reading-full-reimplementation, Property 9: Reading code generation and validation', () => {
  const validYearMonthArb = fc
    .tuple(
      fc.integer({ min: 2020, max: 2099 }),
      fc.integer({ min: 1, max: 12 }),
    )
    .map(([year, month]) => `${year}-${String(month).padStart(2, '0')}`);

  const sequenceArb = fc.integer({ min: 1, max: 99999 });

  it('generated code should always pass isValidReadingCode', () => {
    fc.assert(
      fc.property(validYearMonthArb, sequenceArb, (yearMonth, sequence) => {
        const code = generateReadingCode(yearMonth, sequence);

        expect(isValidReadingCode(code)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('generated code should match pattern CSS{YY}{MM}{5-digit-seq}', () => {
    fc.assert(
      fc.property(validYearMonthArb, sequenceArb, (yearMonth, sequence) => {
        const code = generateReadingCode(yearMonth, sequence);
        const [year, month] = yearMonth.split('-');
        const yy = year.slice(-2);

        expect(code).toMatch(/^CSS\d{4}\d{5}$/);
        expect(code.slice(3, 5)).toBe(yy);
        expect(code.slice(5, 7)).toBe(month);
        expect(code.slice(7)).toBe(String(sequence).padStart(5, '0'));
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 10: Validation rejects current < previous
 *
 * Với mọi cặp số current < previous, validateReadingValue trả về lỗi;
 * ngược lại trả về null.
 *
 * **Validates: Yêu cầu 2.7, 11.2**
 */
describe('Feature: meter-reading-full-reimplementation, Property 10: Validation rejects current < previous', () => {
  it('should return error when currentReading < previousReading', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          const smaller = Math.min(a, b);
          const larger = Math.max(a, b);
          fc.pre(smaller < larger);

          const result = validateReadingValue(smaller, larger);

          expect(result).toBe('Chỉ số mới phải lớn hơn hoặc bằng chỉ số đầu');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return null when currentReading >= previousReading', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          const currentReading = Math.max(a, b);
          const previousReading = Math.min(a, b);

          const result = validateReadingValue(currentReading, previousReading);

          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 12: Import row validation partition invariant
 *
 * Với mọi array rows, validRows.length + errors.length === rows.length.
 *
 * **Validates: Yêu cầu 3.5, 3.6**
 */
describe('Feature: meter-reading-full-reimplementation, Property 12: Import row validation partition invariant', () => {
  const validImportRowArb = fc.record({
    meter_code: fc.string({ minLength: 1, maxLength: 20 }),
    reading_date: fc.string({ minLength: 1, maxLength: 10 }),
    current_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    notes: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
  });

  const invalidImportRowArb = fc.oneof(
    fc.constant({}),
    fc.constant(null),
    fc.constant(42),
    fc.constant('string'),
    fc.record({
      meter_code: fc.constant(''),
      reading_date: fc.constant(''),
      current_reading: fc.constant(-1),
    }),
  );

  const mixedRowsArb = fc.array(
    fc.oneof(validImportRowArb, invalidImportRowArb),
    { minLength: 0, maxLength: 50 },
  );

  it('validRows.length + errors.length should always equal rows.length', () => {
    fc.assert(
      fc.property(mixedRowsArb, (rows) => {
        const { validRows, errors } = validateImportRows(rows);

        expect(validRows.length + errors.length).toBe(rows.length);
      }),
      { numRuns: 100 },
    );
  });

  it('every error should have a rowIndex and non-empty message', () => {
    fc.assert(
      fc.property(mixedRowsArb, (rows) => {
        const { errors } = validateImportRows(rows);

        for (const error of errors) {
          expect(typeof error.rowIndex).toBe('number');
          expect(error.rowIndex).toBeGreaterThanOrEqual(0);
          expect(error.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 21: Validation schema round-trip
 *
 * Với mọi valid MeterReadingFormValues,
 * serialize→deserialize→parse trả về kết quả tương đương.
 *
 * **Validates: Yêu cầu 11.1, 11.5**
 */
describe('Feature: meter-reading-full-reimplementation, Property 21: Validation schema round-trip', () => {
  const validMeterReadingFormArb = fc.record({
    building_id: fc.uuid(),
    room_id: fc.uuid(),
    meter_type: fc.option(
      fc.constantFrom('ELECTRICITY' as const, 'WATER' as const, 'GAS' as const),
      { nil: null },
    ),
    settlement_month: fc
      .tuple(
        fc.integer({ min: 2020, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
      )
      .map(([y, m]) => `${y}-${String(m).padStart(2, '0')}`),
    reading_date: fc
      .tuple(
        fc.integer({ min: 2020, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      )
      .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
    readings: fc.array(
      fc.record({
        meter_id: fc.uuid(),
        current_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        notes: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
        meter_image_url: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
      }),
      { minLength: 1, maxLength: 10 },
    ),
  });

  it('serialize→deserialize→parse should produce equivalent result', () => {
    fc.assert(
      fc.property(validMeterReadingFormArb, (formValues) => {
        // First parse to get the canonical form
        const parsed = meterReadingFormSchema.parse(formValues);

        // Serialize to JSON and deserialize
        const serialized = JSON.stringify(parsed);
        const deserialized = JSON.parse(serialized);

        // Parse again
        const reparsed = meterReadingFormSchema.parse(deserialized);

        expect(reparsed).toEqual(parsed);
      }),
      { numRuns: 100 },
    );
  });
});
