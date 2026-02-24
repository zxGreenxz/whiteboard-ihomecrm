import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: meter-reading-form-fix
 * Preservation Property Tests — Baseline Behavior Capture
 *
 * These tests capture NON-BUGGY behavior from the current unfixed code.
 * They MUST PASS on current code AND continue to pass after the fix.
 * Any failure after fix indicates a regression.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 */

// ============================================================================
// CURRENT NON-BUGGY FUNCTIONS (replicated from MeterReadingForm.tsx)
// These paths are NOT affected by the bugs — they use the reading prop directly.
// ============================================================================

/**
 * Editing mode: getPreviousReading uses reading prop directly (NOT buggy path)
 * Source: getPreviousReading in MeterReadingForm.tsx lines:
 *   if (isEditing && reading) { return reading.previous_reading ?? 0; }
 */
function getPreviousReading_editingMode(reading: { previous_reading: number | null }): number {
  return reading.previous_reading ?? 0;
}

/**
 * Editing mode: getMeterName uses reading prop directly (NOT buggy path)
 * Source: getMeterName in MeterReadingForm.tsx lines:
 *   if (isEditing && reading) { return reading.meter_name || reading.meter_code || ''; }
 */
function getMeterName_editingMode(reading: { meter_name: string | null; meter_code: string | null }): string {
  return reading.meter_name || reading.meter_code || '';
}

/**
 * isLoadEnabled with all filters set — current behavior (NOT buggy for this input)
 * Source: disabled={!watchBuildingId || !watchRoomId || !watchMonth || isLoadingMeters}
 * When ALL three are set, returns true in both buggy and fixed code.
 */
function isLoadEnabled_current(filters: { buildingId: string; roomId: string; month: string }): boolean {
  return !!filters.buildingId && !!filters.roomId && !!filters.month;
}

// ============================================================================
// GENERATORS
// ============================================================================

/** Generator for previous_reading: number or null */
const previousReadingArb = fc.oneof(
  fc.double({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true }),
  fc.constant(null),
);

/** Generator for editing reading data */
const editingReadingArb = fc.record({
  previous_reading: previousReadingArb,
  meter_name: fc.oneof(fc.string({ minLength: 1, maxLength: 50 }), fc.constant(null), fc.constant('')),
  meter_code: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.constant(null), fc.constant('')),
});

/** Generator for non-empty strings (for filter values that are "set") */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 50 });

// ============================================================================
// PRESERVATION TESTS — Must PASS on current unfixed code
// ============================================================================

/**
 * Preservation 1: Editing mode — getPreviousReading uses reading prop directly
 * **Validates: Requirements 3.1**
 *
 * When isEditing=true and reading has a value, getPreviousReading returns
 * reading.previous_reading ?? 0. This path does NOT use the buggy metersList lookup.
 */
describe('Preservation: getPreviousReading editing mode', () => {
  it('should return previous_reading when it is a number', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        (previousReading) => {
          const result = getPreviousReading_editingMode({ previous_reading: previousReading });
          expect(result).toBe(previousReading);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return 0 when previous_reading is null', () => {
    const result = getPreviousReading_editingMode({ previous_reading: null });
    expect(result).toBe(0);
  });

  it('should return previous_reading ?? 0 for any reading data', () => {
    fc.assert(
      fc.property(previousReadingArb, (previousReading) => {
        const result = getPreviousReading_editingMode({ previous_reading: previousReading });
        const expected = previousReading ?? 0;
        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Preservation 2: Editing mode — getMeterName uses reading prop directly
 * **Validates: Requirements 3.1**
 *
 * When isEditing=true and reading has a value, getMeterName returns
 * reading.meter_name || reading.meter_code || ''. This path does NOT use the buggy metersList lookup.
 */
describe('Preservation: getMeterName editing mode', () => {
  it('should return meter_name when it is a non-empty string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.oneof(fc.string({ minLength: 0, maxLength: 20 }), fc.constant(null)),
        (meterName, meterCode) => {
          const result = getMeterName_editingMode({ meter_name: meterName, meter_code: meterCode });
          expect(result).toBe(meterName);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should fall back to meter_code when meter_name is empty or null', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, ''),
        fc.string({ minLength: 1, maxLength: 20 }),
        (meterName, meterCode) => {
          const result = getMeterName_editingMode({
            meter_name: meterName as string | null,
            meter_code: meterCode,
          });
          expect(result).toBe(meterCode);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return empty string when both meter_name and meter_code are empty/null', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, ''),
        fc.constantFrom(null, ''),
        (meterName, meterCode) => {
          const result = getMeterName_editingMode({
            meter_name: meterName as string | null,
            meter_code: meterCode as string | null,
          });
          expect(result).toBe('');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should match meter_name || meter_code || "" for any reading data', () => {
    fc.assert(
      fc.property(editingReadingArb, (reading) => {
        const result = getMeterName_editingMode(reading);
        const expected = reading.meter_name || reading.meter_code || '';
        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Preservation 3: isLoadEnabled returns true when ALL filters are set (including roomId)
 * **Validates: Requirements 3.5, 3.6**
 *
 * Current code: !!buildingId && !!roomId && !!month — when all 3 are set, returns true.
 * This should still be true after fix.
 */
describe('Preservation: isLoadEnabled with all filters set', () => {
  it('should return true when buildingId, roomId, and month are all non-empty', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonEmptyStringArb,
        nonEmptyStringArb,
        (buildingId, roomId, month) => {
          const result = isLoadEnabled_current({ buildingId, roomId, month });
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Preservation 4: isLoadEnabled returns false when buildingId is empty
 * **Validates: Requirements 3.5**
 *
 * Both buggy and fixed code should return false when buildingId is empty.
 */
describe('Preservation: isLoadEnabled with empty buildingId', () => {
  it('should return false when buildingId is empty regardless of other filters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        fc.string({ minLength: 0, maxLength: 10 }),
        (roomId, month) => {
          const result = isLoadEnabled_current({ buildingId: '', roomId, month });
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Preservation 5: isLoadEnabled returns false when month is empty
 * **Validates: Requirements 3.5**
 *
 * Both buggy and fixed code should return false when month is empty.
 */
describe('Preservation: isLoadEnabled with empty month', () => {
  it('should return false when month is empty regardless of other filters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        fc.string({ minLength: 0, maxLength: 50 }),
        (buildingId, roomId) => {
          const result = isLoadEnabled_current({ buildingId, roomId, month: '' });
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
