import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  generateMeterName,
  filterActiveMeters,
  filterMeters,
  getPreviousReading,
  applyApproval,
  applyUnapproval,
  canEditReading,
  canDeleteReading,
  bulkDeleteUnapprovedOnly,
  applyMeterReadingFilters,
  paginateList,
  computeStats,
  getApprovedReadingsForInvoice,
  calculateInvoiceAmount,
} from '../useMeterReadingsHelpers';
import type {
  MeterType,
  MeterWithDeletedAt,
  MeterWithRoom,
  MeterFilterParams,
  ReadingHistoryEntry,
  MeterReadingFilterable,
  MeterReadingFilterParams,
  MeterReadingForStats,
  MeterReadingForInvoice,
} from '../useMeterReadingsHelpers';

// ============================================================
// Shared Arbitraries
// ============================================================

const METER_TYPES: MeterType[] = ['ELECTRICITY', 'WATER', 'GAS'];
const STATUSES = ['UNAPPROVED', 'APPROVED'] as const;

const meterTypeArb = fc.constantFrom<MeterType>(...METER_TYPES);
const statusArb = fc.constantFrom<'UNAPPROVED' | 'APPROVED'>(...STATUSES);

const dateStringArb = fc.tuple(
  fc.integer({ min: 2020, max: 2030 }),
  fc.integer({ min: 1, max: 12 }),
  fc.integer({ min: 1, max: 28 }),
).map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

const monthArb = fc.tuple(
  fc.integer({ min: 2020, max: 2030 }),
  fc.integer({ min: 1, max: 12 }),
).map(([y, m]) => `${y}-${String(m).padStart(2, '0')}`);


// ============================================================
// Property 1: Meter name generation follows pattern
// Feature: meter-reading-full-reimplementation, Property 1: Meter name generation follows pattern
// **Validates: Requirements 1.3, 8.4**
// ============================================================

describe('Property 1: Meter name generation follows pattern', () => {
  const TYPE_LABELS: Record<string, string> = {
    ELECTRICITY: 'Điện',
    WATER: 'Nước',
    GAS: 'Gas',
  };

  it('generateMeterName returns "{roomName} - {typeLabel}" for known meter types', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        meterTypeArb,
        (roomName, meterType) => {
          const result = generateMeterName(roomName, meterType);
          const expectedLabel = TYPE_LABELS[meterType];
          expect(result).toBe(`${roomName} - ${expectedLabel}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('generateMeterName uses raw meterType as label for unknown types', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => !['ELECTRICITY', 'WATER', 'GAS'].includes(s),
        ),
        (roomName, unknownType) => {
          const result = generateMeterName(roomName, unknownType);
          expect(result).toBe(`${roomName} - ${unknownType}`);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 2: Active meters filter excludes soft-deleted
// Feature: meter-reading-full-reimplementation, Property 2: Active meters filter excludes soft-deleted
// **Validates: Requirements 1.6, 1.7**
// ============================================================

describe('Property 2: Active meters filter excludes soft-deleted', () => {
  const meterWithDeletedAtArb: fc.Arbitrary<MeterWithDeletedAt> = fc.record({
    id: fc.uuid(),
    deleted_at: fc.option(fc.date().map((d) => d.toISOString()), { nil: null }),
  });

  it('filterActiveMeters returns only meters with deleted_at === null', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithDeletedAtArb, { minLength: 0, maxLength: 50 }),
        (meters) => {
          const result = filterActiveMeters(meters);

          // Every result must have deleted_at === null
          for (const m of result) {
            expect(m.deleted_at).toBeNull();
          }

          // Count invariant: active + soft-deleted = total
          const softDeletedCount = meters.filter((m) => m.deleted_at !== null).length;
          expect(result.length + softDeletedCount).toBe(meters.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 3: Meter filter by building and type
// Feature: meter-reading-full-reimplementation, Property 3: Meter filter by building and type
// **Validates: Requirements 1.7**
// ============================================================

describe('Property 3: Meter filter by building and type', () => {
  const buildingPool = ['bld-A', 'bld-B', 'bld-C'];

  const meterWithRoomArb: fc.Arbitrary<MeterWithRoom> = fc.record({
    id: fc.uuid(),
    building_id: fc.constantFrom(...buildingPool),
    meter_type: meterTypeArb,
    deleted_at: fc.option(fc.date().map((d) => d.toISOString()), { nil: null }),
    room_id: fc.uuid(),
  });

  it('filterMeters returns only meters matching all non-null filter criteria and not soft-deleted', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithRoomArb, { minLength: 0, maxLength: 40 }),
        fc.record({
          building_id: fc.option(fc.constantFrom(...buildingPool), { nil: null }),
          meter_type: fc.option(meterTypeArb, { nil: null }),
        }) as fc.Arbitrary<MeterFilterParams>,
        (meters, filters) => {
          const result = filterMeters(meters, filters);

          for (const m of result) {
            // Must not be soft-deleted
            expect(m.deleted_at).toBeNull();
            // Must match building_id if specified
            if (filters.building_id != null) {
              expect(m.building_id).toBe(filters.building_id);
            }
            // Must match meter_type if specified
            if (filters.meter_type != null) {
              expect(m.meter_type).toBe(filters.meter_type);
            }
          }

          // No matching meter should be excluded
          const expectedCount = meters.filter((m) => {
            if (m.deleted_at !== null) return false;
            if (filters.building_id != null && m.building_id !== filters.building_id) return false;
            if (filters.meter_type != null && m.meter_type !== filters.meter_type) return false;
            return true;
          }).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 7: Previous reading from history
// Feature: meter-reading-full-reimplementation, Property 7: Previous reading from history
// **Validates: Requirements 8.2**
// ============================================================

describe('Property 7: Previous reading from history', () => {
  const readingEntryArb: fc.Arbitrary<ReadingHistoryEntry> = fc.record({
    reading_date: dateStringArb,
    current_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  });

  it('returns initialReading when there are no existing readings', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (initialReading) => {
          const result = getPreviousReading(initialReading, []);
          expect(result).toBe(initialReading);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns current_reading of the first entry when entries exist', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.array(readingEntryArb, { minLength: 1, maxLength: 20 }),
        (initialReading, entries) => {
          const result = getPreviousReading(initialReading, entries);
          expect(result).toBe(entries[0].current_reading);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 13: Approval round-trip
// Feature: meter-reading-full-reimplementation, Property 13: Approval round-trip
// **Validates: Requirements 4.2, 4.4**
// ============================================================

describe('Property 13: Approval round-trip', () => {
  it('applyApproval then applyUnapproval returns UNAPPROVED with null approver info', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map((d) => d.toISOString()),
        (approverId, approvedAt) => {
          const original = {
            status: 'UNAPPROVED' as const,
            approved_by: null as string | null,
            approved_at: null as string | null,
          };

          // Step 1: Approve
          const approved = applyApproval(original, approverId, approvedAt);
          expect(approved.status).toBe('APPROVED');
          expect(approved.approved_by).toBe(approverId);
          expect(approved.approved_at).toBe(approvedAt);

          // Step 2: Unapprove
          const unapproved = applyUnapproval(approved);
          expect(unapproved.status).toBe('UNAPPROVED');
          expect(unapproved.approved_by).toBeNull();
          expect(unapproved.approved_at).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 14: Permission based on approval status
// Feature: meter-reading-full-reimplementation, Property 14: Permission based on approval status
// **Validates: Requirements 5.1, 5.2, 5.3**
// ============================================================

describe('Property 14: Permission based on approval status', () => {
  it('canEditReading and canDeleteReading return true for UNAPPROVED, false for APPROVED', () => {
    fc.assert(
      fc.property(
        statusArb,
        (status) => {
          const canEdit = canEditReading(status);
          const canDelete = canDeleteReading(status);

          if (status === 'UNAPPROVED') {
            expect(canEdit).toBe(true);
            expect(canDelete).toBe(true);
          } else {
            expect(canEdit).toBe(false);
            expect(canDelete).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 15: Bulk delete only removes unapproved
// Feature: meter-reading-full-reimplementation, Property 15: Bulk delete only removes unapproved
// **Validates: Requirements 5.5**
// ============================================================

describe('Property 15: Bulk delete only removes unapproved', () => {
  const readingArb = fc.record({
    id: fc.uuid(),
    status: statusArb,
  });

  it('only deletes UNAPPROVED readings whose id is in the delete set; APPROVED always remain', () => {
    fc.assert(
      fc.property(
        fc.array(readingArb, { minLength: 0, maxLength: 50 }),
        (readings) => {
          // Select all ids for deletion to maximally test the filter
          const idsToDelete = readings.map((r) => r.id);
          const { remaining, deleted } = bulkDeleteUnapprovedOnly(readings, idsToDelete);

          // All deleted must be UNAPPROVED
          for (const d of deleted) {
            expect(d.status).toBe('UNAPPROVED');
            expect(idsToDelete).toContain(d.id);
          }

          // All APPROVED must remain
          const approvedOriginal = readings.filter((r) => r.status === 'APPROVED');
          const approvedRemaining = remaining.filter((r) => r.status === 'APPROVED');
          expect(approvedRemaining.length).toBe(approvedOriginal.length);

          // Total count preserved
          expect(remaining.length + deleted.length).toBe(readings.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 16: Filter readings by criteria
// Feature: meter-reading-full-reimplementation, Property 16: Filter readings by criteria
// **Validates: Requirements 6.2**
// ============================================================

describe('Property 16: Filter readings by criteria', () => {
  const buildingPool = ['bld-1', 'bld-2', 'bld-3'];
  const roomPool = ['room-1', 'room-2', 'room-3'];
  const monthPool = ['2025-01', '2025-02', '2025-03'];

  const filterableReadingArb: fc.Arbitrary<MeterReadingFilterable> = fc.record({
    building_id: fc.constantFrom(...buildingPool),
    room_id: fc.constantFrom(...roomPool),
    meter_type: meterTypeArb as fc.Arbitrary<string>,
    settlement_month: fc.constantFrom(...monthPool),
    status: statusArb,
  });

  it('all readings in filtered results satisfy every applied filter condition', () => {
    fc.assert(
      fc.property(
        fc.array(filterableReadingArb, { minLength: 0, maxLength: 40 }).chain((readings) =>
          fc.record({
            building_id: readings.length > 0
              ? fc.option(fc.constantFrom(...readings.map((r) => r.building_id)), { nil: null })
              : fc.constant(null),
            room_id: readings.length > 0
              ? fc.option(fc.constantFrom(...readings.map((r) => r.room_id)), { nil: null })
              : fc.constant(null),
            meter_type: fc.option(meterTypeArb, { nil: null }),
            month: readings.length > 0
              ? fc.option(fc.constantFrom(...readings.map((r) => r.settlement_month)), { nil: null })
              : fc.constant(null),
            status: fc.option(statusArb, { nil: null }),
          }).map((filters) => ({ readings, filters: filters as MeterReadingFilterParams })),
        ),
        ({ readings, filters }) => {
          const result = applyMeterReadingFilters(readings, filters);

          for (const r of result) {
            if (filters.building_id) expect(r.building_id).toBe(filters.building_id);
            if (filters.room_id) expect(r.room_id).toBe(filters.room_id);
            if (filters.meter_type) expect(r.meter_type).toBe(filters.meter_type);
            if (filters.month) expect(r.settlement_month).toBe(filters.month);
            if (filters.status) expect(r.status).toBe(filters.status);
          }

          // No matching reading should be excluded
          const expectedCount = readings.filter((r) => {
            if (filters.building_id && r.building_id !== filters.building_id) return false;
            if (filters.room_id && r.room_id !== filters.room_id) return false;
            if (filters.meter_type && r.meter_type !== filters.meter_type) return false;
            if (filters.month && r.settlement_month !== filters.month) return false;
            if (filters.status && r.status !== filters.status) return false;
            return true;
          }).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 17: Pagination correctness
// Feature: meter-reading-full-reimplementation, Property 17: Pagination correctness
// **Validates: Requirements 6.3**
// ============================================================

describe('Property 17: Pagination correctness', () => {
  it('returns correct slice and totalCount for any page/pageSize', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 1, max: 10 }),
        (items, pageSize, page) => {
          const { data, totalCount } = paginateList(items, page, pageSize);

          // totalCount always equals original length
          expect(totalCount).toBe(items.length);

          // data length <= pageSize
          expect(data.length).toBeLessThanOrEqual(pageSize);

          // data is the correct slice
          const start = (page - 1) * pageSize;
          const expectedSlice = items.slice(start, start + pageSize);
          expect(data).toEqual(expectedSlice);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('collecting all pages yields the full list', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 25 }),
        (items, pageSize) => {
          const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
          let collected: string[] = [];

          for (let p = 1; p <= totalPages; p++) {
            const { data } = paginateList(items, p, pageSize);
            collected = collected.concat(data);
          }

          expect(collected).toEqual(items);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 18: Stats computation
// Feature: meter-reading-full-reimplementation, Property 18: Stats computation
// **Validates: Requirements 7.1, 7.2, 8.7**
// ============================================================

describe('Property 18: Stats computation', () => {
  const readingForStatsArb: fc.Arbitrary<MeterReadingForStats> = fc.record({
    status: statusArb,
    meter_type: meterTypeArb,
    consumption: fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
  });

  it('total = approved + unapproved, consumption by type is correct', () => {
    fc.assert(
      fc.property(
        fc.array(readingForStatsArb, { minLength: 0, maxLength: 50 }),
        (readings) => {
          const stats = computeStats(readings);

          // total = approved + unapproved
          expect(stats.total_readings).toBe(stats.approved_count + stats.unapproved_count);
          expect(stats.total_readings).toBe(readings.length);

          // approved_count matches
          expect(stats.approved_count).toBe(
            readings.filter((r) => r.status === 'APPROVED').length,
          );

          // consumption by type
          const expectedElec = readings
            .filter((r) => r.meter_type === 'ELECTRICITY')
            .reduce((s, r) => s + r.consumption, 0);
          const expectedWater = readings
            .filter((r) => r.meter_type === 'WATER')
            .reduce((s, r) => s + r.consumption, 0);
          const expectedGas = readings
            .filter((r) => r.meter_type === 'GAS')
            .reduce((s, r) => s + r.consumption, 0);

          expect(stats.electricity_consumption).toBeCloseTo(expectedElec, 5);
          expect(stats.water_consumption).toBeCloseTo(expectedWater, 5);
          expect(stats.gas_consumption).toBeCloseTo(expectedGas, 5);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 19: Approved readings for invoice filter
// Feature: meter-reading-full-reimplementation, Property 19: Approved readings for invoice filter
// **Validates: Requirements 9.1**
// ============================================================

describe('Property 19: Approved readings for invoice filter', () => {
  const roomPool = ['room-A', 'room-B', 'room-C'];
  const monthPool = ['2025-01', '2025-02', '2025-03'];

  const invoiceReadingArb: fc.Arbitrary<MeterReadingForInvoice> = fc.record({
    id: fc.uuid(),
    status: statusArb,
    room_id: fc.constantFrom(...roomPool),
    settlement_month: fc.constantFrom(...monthPool),
  });

  it('returns only APPROVED readings matching roomId and month', () => {
    fc.assert(
      fc.property(
        fc.array(invoiceReadingArb, { minLength: 0, maxLength: 40 }),
        fc.constantFrom(...roomPool),
        fc.constantFrom(...monthPool),
        (readings, roomId, month) => {
          const result = getApprovedReadingsForInvoice(readings, roomId, month);

          // Every result must be APPROVED + matching room + matching month
          for (const r of result) {
            expect(r.status).toBe('APPROVED');
            expect(r.room_id).toBe(roomId);
            expect(r.settlement_month).toBe(month);
          }

          // No matching reading should be excluded
          const expectedCount = readings.filter(
            (r) => r.status === 'APPROVED' && r.room_id === roomId && r.settlement_month === month,
          ).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 20: Invoice amount calculation
// Feature: meter-reading-full-reimplementation, Property 20: Invoice amount calculation
// **Validates: Requirements 9.2**
// ============================================================

describe('Property 20: Invoice amount calculation', () => {
  it('calculateInvoiceAmount(consumption, unitPrice) === consumption * unitPrice', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (consumption, unitPrice) => {
          const result = calculateInvoiceAmount(consumption, unitPrice);
          expect(result).toBe(consumption * unitPrice);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('result is always non-negative for non-negative inputs', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (consumption, unitPrice) => {
          expect(calculateInvoiceAmount(consumption, unitPrice)).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
