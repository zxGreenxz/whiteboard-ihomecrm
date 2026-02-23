import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { meterFormSchema, validateReadingValue, calculateConsumption } from '../meterReadingValidation';

/**
 * Feature: meter-reading-reimplementation
 * Property 3: Validation từ chối input thiếu trường bắt buộc
 * Validates: Yêu cầu 2.6
 *
 * Với bất kỳ đối tượng meter input nào mà thiếu ít nhất một trường bắt buộc
 * (building_id, room_id, meter_type, code), Zod schema validation phải từ chối
 * và trả về lỗi tương ứng cho trường bị thiếu.
 */

const REQUIRED_FIELDS = ['building_id', 'room_id', 'meter_type', 'code'] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];

// Generator for a valid complete meter input
const validMeterInputArb = fc.record({
  building_id: fc.uuid(),
  room_id: fc.uuid(),
  meter_type: fc.constantFrom('ELECTRICITY' as const, 'WATER' as const, 'GAS' as const),
  code: fc.string({ minLength: 1, maxLength: 50 }),
  service_id: fc.uuid(),
  initial_reading: fc.nat({ max: 99999 }),
  installation_date: fc.constant('2024-01-01'),
  location_note: fc.constant(''),
  manufacturer: fc.constant(''),
  model: fc.constant(''),
  serial_number: fc.constant(''),
  notes: fc.constant(''),
});

// Generator: pick a non-empty subset of required fields to omit
const fieldsToOmitArb = fc
  .subarray([...REQUIRED_FIELDS], { minLength: 1 })
  .filter((arr) => arr.length >= 1);

describe('Property 3: Validation từ chối input thiếu trường bắt buộc', () => {
  it('should reject any meter input missing at least one required field and report errors for each missing field', () => {
    fc.assert(
      fc.property(
        validMeterInputArb,
        fieldsToOmitArb,
        (validInput, fieldsToOmit) => {
          // Create input with required fields removed or set to empty/undefined
          const incompleteInput: Record<string, unknown> = { ...validInput };

          for (const field of fieldsToOmit) {
            if (field === 'meter_type') {
              // For enum field, delete it entirely to trigger required_error
              delete incompleteInput[field];
            } else {
              // For string fields, set to empty string to trigger min(1) validation
              incompleteInput[field] = '';
            }
          }

          const result = meterFormSchema.safeParse(incompleteInput);

          // Must be rejected
          expect(result.success).toBe(false);

          if (!result.success) {
            const errorPaths = result.error.issues.map((issue) => issue.path[0]);

            // Each omitted field must have a corresponding error
            for (const field of fieldsToOmit) {
              expect(errorPaths).toContain(field);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-reimplementation
 * Property 10: Validation từ chối chỉ số mới < chỉ số đầu
 * Validates: Yêu cầu 5.7
 *
 * Với bất kỳ cặp giá trị (current_reading, previous_reading) nào mà
 * current_reading < previous_reading, hàm validation phải trả về lỗi
 * "Chỉ số mới phải lớn hơn hoặc bằng chỉ số đầu".
 */
describe('Property 10: Validation từ chối chỉ số mới < chỉ số đầu', () => {
  it('should return error when currentReading < previousReading', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          // Ensure current < previous by assigning min to current, max to previous
          const smaller = Math.min(a, b);
          const larger = Math.max(a, b);

          // Skip when values are equal (not a valid case for this property)
          fc.pre(smaller < larger);

          const currentReading = smaller;
          const previousReading = larger;

          const result = validateReadingValue(currentReading, previousReading);

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
          // Ensure current >= previous
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
 * Feature: meter-reading-reimplementation
 * Property 8: Số tiêu thụ = Chỉ số mới - Chỉ số đầu
 * Validates: Yêu cầu 5.5
 *
 * Với bất kỳ bản ghi chỉ số nào, `consumption` phải luôn bằng
 * `current_reading - previous_reading`.
 */
describe('Property 8: Số tiêu thụ = Chỉ số mới - Chỉ số đầu', () => {
  it('consumption should always equal currentReading - previousReading for valid readings', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          // Ensure currentReading >= previousReading (valid reading)
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
