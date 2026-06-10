import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock Supabase client to avoid localStorage dependency in test environment
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
  },
}));

import {
  filterActiveMeters,
  filterMeters,
  groupMetersByRoom,
  type MeterWithRoom,
} from '../useMeters';

// ============================================================
// Shared Arbitraries
// ============================================================

const METER_TYPES = ['ELECTRICITY', 'WATER', 'GAS'] as const;
const meterTypeArb = fc.constantFrom(...METER_TYPES);

// ============================================================
// Property 2: Active meters filter excludes soft-deleted
// Feature: meter-reading-full-reimplementation, Property 2: Active meters filter excludes soft-deleted
// **Validates: Requirements 1.6, 1.7**
// ============================================================

describe('Property 2: Active meters filter excludes soft-deleted', () => {
  // Generator for objects with deleted_at (generic constraint of filterActiveMeters)
  const meterWithDeletedAtArb = fc.record({
    id: fc.uuid(),
    deleted_at: fc.option(
      fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31'), noInvalidDate: true }).map((d) => d.toISOString()),
      { nil: null },
    ),
  });

  it('filterActiveMeters returns only items with deleted_at === null, and count invariant holds', () => {
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

  it('filterActiveMeters preserves order of active items', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithDeletedAtArb, { minLength: 0, maxLength: 50 }),
        (meters) => {
          const result = filterActiveMeters(meters);
          const expectedActive = meters.filter((m) => m.deleted_at === null);

          // Same items in same order
          expect(result.map((m) => m.id)).toEqual(expectedActive.map((m) => m.id));
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

  // Generator for MeterWithRoom - cast to satisfy the Supabase-generated Meter type
  const meterWithRoomArb: fc.Arbitrary<MeterWithRoom> = fc
    .record({
      id: fc.uuid(),
      building_id: fc.constantFrom(...buildingPool),
      meter_type: meterTypeArb,
      room_id: fc.option(fc.uuid(), { nil: null }),
      roomName: fc.string({ minLength: 1, maxLength: 20 }),
      buildingName: fc.string({ minLength: 1, maxLength: 20 }),
    })
    .map(({ id, building_id, meter_type, room_id, roomName, buildingName }) => ({
      id,
      building_id,
      meter_type,
      room_id,
      room: room_id ? { id: room_id, name: roomName } : null,
      building: { id: building_id, name: buildingName },
    })) as fc.Arbitrary<MeterWithRoom>;

  it('filterMeters returns only meters matching all non-null filter criteria', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithRoomArb, { minLength: 0, maxLength: 50 }).chain((meters) =>
          fc.record({
            building_id: meters.length > 0
              ? fc.option(fc.constantFrom(...meters.map((m) => m.building_id)), { nil: null })
              : fc.constant(null as string | null),
            meter_type: fc.option(meterTypeArb as fc.Arbitrary<string>, { nil: null }),
          }).map((filters) => ({ meters, filters })),
        ),
        ({ meters, filters }) => {
          const result = filterMeters(meters, filters);

          // Every result must match all active filter conditions
          for (const m of result) {
            if (filters.building_id) {
              expect(m.building_id).toBe(filters.building_id);
            }
            if (filters.meter_type) {
              expect(m.meter_type).toBe(filters.meter_type);
            }
          }

          // Result is a subset
          expect(result.length).toBeLessThanOrEqual(meters.length);

          // No matching meter should be excluded
          const expectedCount = meters.filter((m) => {
            if (filters.building_id && m.building_id !== filters.building_id) return false;
            if (filters.meter_type && m.meter_type !== filters.meter_type) return false;
            return true;
          }).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('filterMeters with no filters returns all meters', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithRoomArb, { minLength: 0, maxLength: 30 }),
        (meters) => {
          const result = filterMeters(meters, {});
          expect(result.length).toBe(meters.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// groupMetersByRoom: Grouping correctness
// Feature: meter-reading-full-reimplementation
// Tests the groupMetersByRoom export from useMeters.ts
// ============================================================

describe('groupMetersByRoom: Grouping correctness', () => {
  const meterWithRoomArb: fc.Arbitrary<MeterWithRoom> = fc
    .record({
      id: fc.uuid(),
      building_id: fc.uuid(),
      meter_type: meterTypeArb,
      room_id: fc.option(fc.uuid(), { nil: null }),
      roomName: fc.string({ minLength: 1, maxLength: 20 }),
      buildingName: fc.string({ minLength: 1, maxLength: 20 }),
    })
    .map(({ id, building_id, meter_type, room_id, roomName, buildingName }) => ({
      id,
      building_id,
      meter_type,
      room_id,
      room: room_id ? { id: room_id, name: roomName } : null,
      building: { id: building_id, name: buildingName },
    })) as fc.Arbitrary<MeterWithRoom>;

  it('all meters in each group share the same room_id, and total count is preserved', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithRoomArb, { minLength: 0, maxLength: 50 }),
        (meters) => {
          const grouped = groupMetersByRoom(meters);

          // All meters in each group have the same room_id
          for (const [key, group] of Object.entries(grouped)) {
            for (const meter of group.meters) {
              const expectedKey = meter.room_id || 'no-room';
              expect(expectedKey).toBe(key);
            }
          }

          // Total count across all groups equals original count
          const totalInGroups = Object.values(grouped).reduce(
            (sum, group) => sum + group.meters.length,
            0,
          );
          expect(totalInGroups).toBe(meters.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
