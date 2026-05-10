import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  mapMeterToReading,
  getPreviousReadingFromList,
  getMeterNameFromList,
  formatSimpleMeterName,
  isLoadEnabled,
} from '../meterReadingFormUtils';

/**
 * Feature: meter-reading-form-fix
 * Exploration Property Tests — Fix Validation
 *
 * These tests import the FIXED pure functions from meterReadingFormUtils.ts
 * and assert the EXPECTED (correct) behavior. They validate that the bugfix
 * correctly resolves the field mapping and room filter issues.
 *
 * Originally written to FAIL on buggy inline replicas (confirming bugs exist).
 * Now updated to use fixed functions — all tests should PASS.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
 */

// ============================================================================
// GENERATORS — RPC response schema from get_meters_without_readings
// ============================================================================

/** Generator for a single UnrecordedMeter from RPC response */
const unrecordedMeterArb = fc.record({
  meter_id: fc.uuid(),
  meter_code: fc.string({ minLength: 1, maxLength: 20 }),
  meter_name: fc.string({ minLength: 1, maxLength: 50 }),
  room_name: fc.string({ minLength: 1, maxLength: 30 }),
  meter_type_value: fc.constantFrom('ELECTRICITY', 'WATER', 'GAS'),
  last_reading: fc.double({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true }),
  last_reading_date: fc.option(
    fc.integer({ min: 2020, max: 2030 }).chain((y) =>
      fc.integer({ min: 1, max: 12 }).chain((m) =>
        fc.integer({ min: 1, max: 28 }).map(
          (d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        ),
      ),
    ),
    { nil: null },
  ),
});

// ============================================================================
// FIX VALIDATION TESTS — Should PASS with fixed functions
// ============================================================================

/**
 * Property 1: Field Mapping Đúng Với RPC Response
 * **Validates: Requirements 2.1**
 *
 * mapMeterToReading(meter).meter_id MUST equal meter.meter_id.
 * Fixed code correctly uses meter.meter_id from RPC response.
 */
describe('Fix Validation: mapMeterToReading field mapping (Bug 1.1)', () => {
  it('meter_id in reading data should equal meter.meter_id from RPC response', () => {
    fc.assert(
      fc.property(unrecordedMeterArb, (meter) => {
        const reading = mapMeterToReading(meter);

        // FIXED: reading.meter_id === meter.meter_id
        expect(reading.meter_id).toBe(meter.meter_id);
      }),
      { numRuns: 100 },
    );
  });

  it('meter_id in reading data should never be undefined', () => {
    fc.assert(
      fc.property(unrecordedMeterArb, (meter) => {
        const reading = mapMeterToReading(meter);

        // FIXED: meter_id is always defined (UUID string)
        expect(reading.meter_id).toBeDefined();
        expect(typeof reading.meter_id).toBe('string');
        expect(reading.meter_id.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 1: getPreviousReadingFromList lookup + field access
 * **Validates: Requirements 2.2, 2.4**
 *
 * getPreviousReadingFromList finds meter by meter_id and returns last_reading.
 * Fixed code uses m.meter_id for lookup and meter.last_reading for value.
 */
describe('Fix Validation: getPreviousReadingFromList (Bug 1.2, 1.4)', () => {
  it('should return last_reading when meter exists in list', () => {
    fc.assert(
      fc.property(
        fc.array(unrecordedMeterArb, { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 19 }),
        (meters, indexRaw) => {
          const index = indexRaw % meters.length;
          const targetMeter = meters[index];

          const result = getPreviousReadingFromList(
            targetMeter.meter_id,
            meters,
          );

          // FIXED: result === targetMeter.last_reading
          expect(result).toBe(targetMeter.last_reading);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return 0 when meter does not exist in list', () => {
    fc.assert(
      fc.property(
        fc.array(unrecordedMeterArb, { minLength: 0, maxLength: 10 }),
        fc.uuid(),
        (meters, nonExistentId) => {
          // Ensure the ID doesn't exist in the list
          const filteredMeters = meters.filter((m) => m.meter_id !== nonExistentId);

          const result = getPreviousReadingFromList(nonExistentId, filteredMeters);

          expect(result).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 1: getMeterNameFromList lookup + simplified display
 * **Validates: Requirements 2.2, 2.3**
 *
 * getMeterNameFromList finds meter by meter_id and returns the simplified
 * display name (meter_code with the meter-type prefix stripped).
 */
describe('Fix Validation: getMeterNameFromList (Bug 1.2, 1.3)', () => {
  it('should return formatSimpleMeterName(meter_code) when meter exists', () => {
    fc.assert(
      fc.property(
        fc.array(unrecordedMeterArb, { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 19 }),
        (meters, indexRaw) => {
          const index = indexRaw % meters.length;
          const targetMeter = meters[index];

          const result = getMeterNameFromList(targetMeter.meter_id, meters);

          expect(result).toBe(formatSimpleMeterName(targetMeter.meter_code));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return empty string when meter does not exist', () => {
    fc.assert(
      fc.property(
        fc.array(unrecordedMeterArb, { minLength: 0, maxLength: 10 }),
        fc.uuid(),
        (meters, nonExistentId) => {
          const filteredMeters = meters.filter((m) => m.meter_id !== nonExistentId);

          const result = getMeterNameFromList(nonExistentId, filteredMeters);

          expect(result).toBe('');
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 2: Load Công Tơ Không Cần Phòng
 * **Validates: Requirements 2.5**
 *
 * isLoadEnabled returns true when buildingId + month are set, even if roomId is empty.
 * Fixed code only requires buildingId + month.
 */
describe('Fix Validation: isLoadEnabled room not required (Bug 1.5)', () => {
  it('should return true when buildingId and month are set but roomId is empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (buildingId, month) => {
          const result = isLoadEnabled({
            buildingId,
            month,
          });

          // FIXED: true (buildingId + month is sufficient)
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return false when buildingId is empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (roomId, month) => {
          const result = isLoadEnabled({
            buildingId: '',
            month,
          });

          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return false when month is empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 0, maxLength: 50 }),
        (buildingId, roomId) => {
          const result = isLoadEnabled({
            buildingId,
            month: '',
          });

          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
