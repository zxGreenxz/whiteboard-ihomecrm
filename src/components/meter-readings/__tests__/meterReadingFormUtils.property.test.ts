import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  isLoadEnabled,
  mapMeterToReading,
  getPreviousReadingFromList,
  createMeterReadingPayload,
  getMeterNameFromList,
} from '../meterReadingFormUtils';
import type { UnrecordedMeter } from '../meterReadingFormUtils';

// --- Shared Arbitraries ---

const meterTypeArb = fc.constantFrom('ELECTRICITY' as const, 'WATER' as const, 'GAS' as const);

const unrecordedMeterArb: fc.Arbitrary<UnrecordedMeter> = fc.record({
  meter_id: fc.uuid(),
  meter_code: fc.string({ minLength: 1, maxLength: 20 }),
  meter_name: fc.string({ maxLength: 50 }),
  room_name: fc.string({ maxLength: 50 }),
  meter_type_value: meterTypeArb,
  last_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  last_reading_date: fc.option(
    fc.tuple(
      fc.integer({ min: 2020, max: 2099 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
    ).map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
    { nil: null },
  ),
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 4: Load enabled requires building and month
 *
 * isLoadEnabled trả về true iff cả buildingId và month non-empty.
 *
 * **Validates: Yêu cầu 2.2**
 */
describe('Feature: meter-reading-full-reimplementation, Property 4: Load enabled requires building and month', () => {
  it('should return true when both buildingId and month are non-empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (buildingId, month) => {
          expect(isLoadEnabled({ buildingId, month })).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return false when buildingId is empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        (month) => {
          expect(isLoadEnabled({ buildingId: '', month })).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return false when month is empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (buildingId) => {
          expect(isLoadEnabled({ buildingId, month: '' })).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return false when both are empty', () => {
    expect(isLoadEnabled({ buildingId: '', month: '' })).toBe(false);
  });
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 5: Map meter to reading uses correct field
 *
 * mapMeterToReading tạo entry đúng field mapping:
 * meter_id === meter.meter_id, current_reading === 0, notes === '', meter_image_url === ''.
 *
 * **Validates: Yêu cầu 2.8, 8.1**
 */
describe('Feature: meter-reading-full-reimplementation, Property 5: Map meter to reading uses correct field', () => {
  it('should map meter_id and set defaults correctly for any UnrecordedMeter', () => {
    fc.assert(
      fc.property(unrecordedMeterArb, (meter) => {
        const entry = mapMeterToReading(meter);

        expect(entry.meter_id).toBe(meter.meter_id);
        expect(entry.current_reading).toBe(0);
        expect(entry.notes).toBe('');
        expect(entry.meter_image_url).toBe('');
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 6: Previous reading from list
 *
 * getPreviousReadingFromList trả về last_reading của meter tương ứng, hoặc 0 nếu không tìm thấy.
 *
 * **Validates: Yêu cầu 2.3**
 */
describe('Feature: meter-reading-full-reimplementation, Property 6: Previous reading from list', () => {
  it('should return last_reading when meter is found in list', () => {
    fc.assert(
      fc.property(
        fc.array(unrecordedMeterArb, { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 19 }),
        (meters, indexRaw) => {
          const index = indexRaw % meters.length;
          const target = meters[index];

          const result = getPreviousReadingFromList(target.meter_id, meters);

          expect(result).toBe(target.last_reading);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return 0 when meter is not found in list', () => {
    fc.assert(
      fc.property(
        fc.array(unrecordedMeterArb, { minLength: 0, maxLength: 20 }),
        fc.uuid(),
        (meters, unknownId) => {
          // Ensure unknownId is not in the list
          fc.pre(!meters.some((m) => m.meter_id === unknownId));

          const result = getPreviousReadingFromList(unknownId, meters);

          expect(result).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 11: New reading payload always UNAPPROVED
 *
 * createMeterReadingPayload luôn có status='UNAPPROVED'.
 * notes và meter_image_url là null khi không cung cấp.
 * user_id, meter_id, reading_date, current_reading khớp input.
 *
 * **Validates: Yêu cầu 2.4, 8.10**
 */
describe('Feature: meter-reading-full-reimplementation, Property 11: New reading payload always UNAPPROVED', () => {
  const payloadInputArb = fc.record({
    user_id: fc.uuid(),
    meter_id: fc.uuid(),
    reading_date: fc.tuple(
      fc.integer({ min: 2020, max: 2099 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
    ).map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
    current_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    notes: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    meter_image_url: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
  });

  it('should always produce status UNAPPROVED and match input fields', () => {
    fc.assert(
      fc.property(payloadInputArb, (input) => {
        const payload = createMeterReadingPayload(input);

        expect(payload.status).toBe('UNAPPROVED');
        expect(payload.user_id).toBe(input.user_id);
        expect(payload.meter_id).toBe(input.meter_id);
        expect(payload.reading_date).toBe(input.reading_date);
        expect(payload.current_reading).toBe(input.current_reading);
      }),
      { numRuns: 100 },
    );
  });

  it('should set notes and meter_image_url to null when not provided', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.constant('2025-01-15'),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (user_id, meter_id, reading_date, current_reading) => {
          const payload = createMeterReadingPayload({
            user_id,
            meter_id,
            reading_date,
            current_reading,
          });

          expect(payload.notes).toBeNull();
          expect(payload.meter_image_url).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should pass through notes and meter_image_url when provided', () => {
    fc.assert(
      fc.property(payloadInputArb, (input) => {
        const payload = createMeterReadingPayload(input);

        if (input.notes) {
          expect(payload.notes).toBe(input.notes);
        } else {
          expect(payload.notes).toBeNull();
        }

        if (input.meter_image_url) {
          expect(payload.meter_image_url).toBe(input.meter_image_url);
        } else {
          expect(payload.meter_image_url).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-full-reimplementation
 * Property 22: Meter name from list
 *
 * getMeterNameFromList trả về meter_name (hoặc meter_code nếu meter_name rỗng),
 * hoặc '' nếu không tìm thấy.
 *
 * **Validates: Yêu cầu 2.3**
 */
describe('Feature: meter-reading-full-reimplementation, Property 22: Meter name from list', () => {
  it('should return meter_name when meter is found and meter_name is non-empty', () => {
    const meterWithNameArb = fc.record({
      meter_id: fc.uuid(),
      meter_code: fc.string({ minLength: 1, maxLength: 20 }),
      meter_name: fc.string({ minLength: 1, maxLength: 50 }),
      room_name: fc.string({ maxLength: 50 }),
      meter_type_value: meterTypeArb,
      last_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
      last_reading_date: fc.constant(null as string | null),
    });

    fc.assert(
      fc.property(
        fc.array(meterWithNameArb, { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 19 }),
        (meters, indexRaw) => {
          const index = indexRaw % meters.length;
          const target = meters[index];

          const result = getMeterNameFromList(target.meter_id, meters);

          expect(result).toBe(target.meter_name);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return meter_code when meter_name is empty', () => {
    const meterWithEmptyNameArb = fc.record({
      meter_id: fc.uuid(),
      meter_code: fc.string({ minLength: 1, maxLength: 20 }),
      meter_name: fc.constant(''),
      room_name: fc.string({ maxLength: 50 }),
      meter_type_value: meterTypeArb,
      last_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
      last_reading_date: fc.constant(null as string | null),
    });

    fc.assert(
      fc.property(
        fc.array(meterWithEmptyNameArb, { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 19 }),
        (meters, indexRaw) => {
          const index = indexRaw % meters.length;
          const target = meters[index];

          const result = getMeterNameFromList(target.meter_id, meters);

          expect(result).toBe(target.meter_code);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return empty string when meter is not found', () => {
    fc.assert(
      fc.property(
        fc.array(unrecordedMeterArb, { minLength: 0, maxLength: 20 }),
        fc.uuid(),
        (meters, unknownId) => {
          fc.pre(!meters.some((m) => m.meter_id === unknownId));

          const result = getMeterNameFromList(unknownId, meters);

          expect(result).toBe('');
        },
      ),
      { numRuns: 100 },
    );
  });
});
