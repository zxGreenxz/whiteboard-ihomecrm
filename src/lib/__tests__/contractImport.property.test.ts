import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock supabase client to avoid localStorage dependency in test environment
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {},
}));

import { validateContractImportRow } from '../contractExcelHelpers';

// =============================================
// Shared Arbitraries
// =============================================

const validPaymentCycles = ['1 tháng', '3 tháng', '6 tháng', '12 tháng'];

/** Generate a valid date string in DD/MM/YYYY format */
function validDateArb(minYear = 2023, maxYear = 2025): fc.Arbitrary<string> {
  return fc.record({
    year: fc.integer({ min: minYear, max: maxYear }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  }).map(({ year, month, day }) =>
    `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
  );
}

/** Generate a valid start_date + end_date pair where end > start */
function validDatePairArb(): fc.Arbitrary<{ start: string; end: string }> {
  return fc.record({
    year: fc.integer({ min: 2023, max: 2025 }),
    month: fc.integer({ min: 1, max: 11 }),
    day: fc.integer({ min: 1, max: 28 }),
  }).map(({ year, month, day }) => ({
    start: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
    end: `${String(day).padStart(2, '0')}/${String(month + 1).padStart(2, '0')}/${year}`,
  }));
}

/** Generate a non-empty alphanumeric string (avoids slow unicode filtering) */
const nonEmptyStringArb = fc.integer({ min: 1, max: 30 }).chain(len =>
  fc.array(
    fc.integer({ min: 97, max: 122 }).map(c => String.fromCharCode(c)),
    { minLength: len, maxLength: len },
  ).map(chars => chars.join('')),
);

/** Generate a valid phone number (digits only) */
const phoneArb = fc.array(
  fc.integer({ min: 0, max: 9 }),
  { minLength: 9, maxLength: 11 },
).map(digits => digits.join(''));

/** Generate a complete valid import row */
function validImportRowArb(): fc.Arbitrary<Record<string, unknown>> {
  return fc.record({
    room_name: nonEmptyStringArb,
    customer_name: nonEmptyStringArb,
    customer_phone: phoneArb,
    signed_date: validDateArb(),
    dates: validDatePairArb(),
    rent_price: fc.nat({ max: 100_000_000 }),
    payment_cycle: fc.constantFrom(...validPaymentCycles),
    deposit: fc.nat({ max: 50_000_000 }),
  }).map(({ room_name, customer_name, customer_phone, signed_date, dates, rent_price, payment_cycle, deposit }) => ({
    room_name,
    customer_name,
    customer_phone,
    signed_date,
    start_date: dates.start,
    end_date: dates.end,
    rent_price,
    payment_cycle,
    deposit,
  }));
}

// =============================================
// Property 15: Excel import row validation
// =============================================

/**
 * Feature: lease-contract-management
 * Property 15: Excel import row validation
 *
 * For any set of Excel import rows, rows with valid data (non-empty room name,
 * customer name, phone, valid dates, non-negative rent, valid payment cycle,
 * non-negative deposit, end_date > start_date) should be accepted.
 * Rows with missing required fields or invalid data should be rejected
 * with per-row error messages.
 *
 * **Validates: Requirements 11.4, 11.5**
 */
describe('Property 15: Excel import row validation', () => {
  it('should accept all valid import rows', () => {
    fc.assert(
      fc.property(validImportRowArb(), (row) => {
        const result = validateContractImportRow(row);
        expect(result.valid).toBe(true);
        if (result.valid) {
          const data = result.data;
          expect(data.room_name).toBeTruthy();
          expect(data.customer_name).toBeTruthy();
          expect(data.customer_phone).toBeTruthy();
          expect(data.signed_date).toBeTruthy();
          expect(data.start_date).toBeTruthy();
          expect(data.end_date).toBeTruthy();
          expect(data.rent_price).toBeGreaterThanOrEqual(0);
          expect(data.deposit).toBeGreaterThanOrEqual(0);
          expect(data.payment_cycle).toBeTruthy();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should reject rows with missing required fields', () => {
    const requiredFields = [
      'room_name', 'customer_name', 'customer_phone',
      'signed_date', 'start_date', 'end_date',
      'rent_price', 'payment_cycle', 'deposit',
    ] as const;

    fc.assert(
      fc.property(
        validImportRowArb(),
        fc.constantFrom(...requiredFields),
        (row, fieldToRemove) => {
          const invalidRow = { ...row };
          delete invalidRow[fieldToRemove];

          const result = validateContractImportRow(invalidRow);
          expect(result.valid).toBe(false);
          if (result.valid === false) {
            expect(result.errors.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject rows with negative rent_price', () => {
    fc.assert(
      fc.property(
        validImportRowArb(),
        fc.integer({ min: -100_000_000, max: -1 }),
        (row, negativeRent) => {
          const invalidRow = { ...row, rent_price: negativeRent };
          const result = validateContractImportRow(invalidRow);
          expect(result.valid).toBe(false);
          if (result.valid === false) {
            expect(result.errors.some((e: string) => e.includes('Tiền thuê'))).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject rows with negative deposit', () => {
    fc.assert(
      fc.property(
        validImportRowArb(),
        fc.integer({ min: -50_000_000, max: -1 }),
        (row, negativeDeposit) => {
          const invalidRow = { ...row, deposit: negativeDeposit };
          const result = validateContractImportRow(invalidRow);
          expect(result.valid).toBe(false);
          if (result.valid === false) {
            expect(result.errors.some((e: string) => e.includes('Tiền cọc'))).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject rows with invalid payment cycle', () => {
    // Use known-invalid values instead of filtering random strings
    const invalidCycles = fc.constantFrom(
      'weekly', 'biweekly', '2 tháng', '5 tháng', 'daily', 'abc', 'xyz', '0 tháng', '24 tháng',
    );

    fc.assert(
      fc.property(validImportRowArb(), invalidCycles, (row, badCycle) => {
        const invalidRow = { ...row, payment_cycle: badCycle };
        const result = validateContractImportRow(invalidRow);
        expect(result.valid).toBe(false);
        if (result.valid === false) {
          expect(result.errors.some((e: string) => e.includes('Chu kỳ TT'))).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should reject rows where end_date is before or equal to start_date', () => {
    fc.assert(
      fc.property(
        validImportRowArb(),
        fc.record({
          year: fc.integer({ min: 2023, max: 2025 }),
          month: fc.integer({ min: 2, max: 12 }),
          day: fc.integer({ min: 1, max: 28 }),
        }),
        (row, dateInfo) => {
          // Set end_date to be before start_date
          const startDate = `${String(dateInfo.day).padStart(2, '0')}/${String(dateInfo.month).padStart(2, '0')}/${dateInfo.year}`;
          const endDate = `${String(dateInfo.day).padStart(2, '0')}/${String(dateInfo.month - 1).padStart(2, '0')}/${dateInfo.year}`;

          const invalidRow = { ...row, start_date: startDate, end_date: endDate };
          const result = validateContractImportRow(invalidRow);
          expect(result.valid).toBe(false);
          if (result.valid === false) {
            expect(result.errors.some((e: string) => e.includes('Ngày KT phải sau Ngày BĐ'))).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should preserve optional fields in valid rows', () => {
    fc.assert(
      fc.property(
        validImportRowArb(),
        nonEmptyStringArb,
        nonEmptyStringArb,
        (row, idNumber, notes) => {
          const rowWithOptionals = {
            ...row,
            customer_id_number: idNumber,
            notes,
          };
          const result = validateContractImportRow(rowWithOptionals);
          expect(result.valid).toBe(true);
          if (result.valid) {
            expect(result.data.customer_id_number).toBe(idNumber.trim() || undefined);
            expect(result.data.notes).toBe(notes.trim() || undefined);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
