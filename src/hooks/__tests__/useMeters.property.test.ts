import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: meter-reading-reimplementation, Property 1: Nhóm công tơ theo phòng đúng
 * Validates: Yêu cầu 1.1
 *
 * Với bất kỳ danh sách công tơ nào, khi nhóm theo phòng, tất cả công tơ trong
 * mỗi nhóm phải có cùng room_id, và tổng số công tơ trong tất cả các nhóm phải
 * bằng tổng số công tơ ban đầu.
 */

// Replicate the types from useMeters.ts to avoid importing Supabase client
type MeterWithRoom = {
  id: string;
  room_id: string | null;
  building_id: string;
  room: { id: string; name: string } | null;
  building: { id: string; name: string } | null;
  [key: string]: unknown;
};

type MetersGroupedByRoom = Record<
  string,
  {
    room: { id: string; name: string } | null;
    building: { id: string; name: string } | null;
    meters: MeterWithRoom[];
  }
>;

/**
 * Replicated grouping logic from useMetersGroupedByRoom in src/hooks/useMeters.ts.
 * This is the exact same algorithm used in the hook's queryFn.
 */
function groupMetersByRoom(meters: MeterWithRoom[]): MetersGroupedByRoom {
  const grouped: MetersGroupedByRoom = {};
  for (const meter of meters) {
    const key = meter.room_id || 'no-room';
    if (!grouped[key]) {
      grouped[key] = {
        room: meter.room,
        building: meter.building,
        meters: [],
      };
    }
    grouped[key].meters.push(meter);
  }
  return grouped;
}

// Generator for a MeterWithRoom object with random room_id
const meterWithRoomArb: fc.Arbitrary<MeterWithRoom> = fc
  .record({
    room_id: fc.option(fc.uuid(), { nil: null }),
    building_id: fc.uuid(),
    roomName: fc.string({ minLength: 1, maxLength: 20 }),
    buildingName: fc.string({ minLength: 1, maxLength: 20 }),
  })
  .map(({ room_id, building_id, roomName, buildingName }) => ({
    id: crypto.randomUUID(),
    room_id,
    building_id,
    room: room_id ? { id: room_id, name: roomName } : null,
    building: { id: building_id, name: buildingName },
  }));

describe('Property 1: Nhóm công tơ theo phòng đúng', () => {
  it('all meters in each group must share the same room_id, and total count across groups must equal original count', () => {
    fc.assert(
      fc.property(fc.array(meterWithRoomArb, { maxLength: 50 }), (meters) => {
        const grouped = groupMetersByRoom(meters);

        // 1) All meters in each group have the same room_id
        for (const [key, group] of Object.entries(grouped)) {
          for (const meter of group.meters) {
            const expectedKey = meter.room_id || 'no-room';
            expect(expectedKey).toBe(key);
          }
        }

        // 2) Total count across all groups equals original count
        const totalInGroups = Object.values(grouped).reduce(
          (sum, group) => sum + group.meters.length,
          0,
        );
        expect(totalInGroups).toBe(meters.length);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-reimplementation, Property 2: Bộ lọc công tơ chỉ trả về kết quả phù hợp
 * Validates: Yêu cầu 1.4
 *
 * Với bất kỳ danh sách công tơ và bất kỳ tổ hợp bộ lọc (building_id, meter_type) nào,
 * tất cả công tơ trong kết quả lọc phải thỏa mãn mọi điều kiện lọc đã chọn.
 */

/**
 * Replicated filtering logic from filterMeters in src/hooks/useMeters.ts.
 * This is the exact same algorithm used in the hook.
 */
function filterMeters(
  meters: MeterWithRoom[],
  filters: { building_id?: string | null; meter_type?: string | null },
): MeterWithRoom[] {
  return meters.filter((meter) => {
    if (filters.building_id && meter.building_id !== filters.building_id) {
      return false;
    }
    if (filters.meter_type && (meter as Record<string, unknown>).meter_type !== filters.meter_type) {
      return false;
    }
    return true;
  });
}

const METER_TYPES = ['ELECTRICITY', 'WATER', 'GAS'] as const;

// Generator for a meter with random building_id and meter_type
const meterWithTypeArb: fc.Arbitrary<MeterWithRoom> = fc
  .record({
    room_id: fc.option(fc.uuid(), { nil: null }),
    building_id: fc.uuid(),
    meter_type: fc.constantFrom(...METER_TYPES),
    roomName: fc.string({ minLength: 1, maxLength: 20 }),
    buildingName: fc.string({ minLength: 1, maxLength: 20 }),
  })
  .map(({ room_id, building_id, meter_type, roomName, buildingName }) => ({
    id: crypto.randomUUID(),
    room_id,
    building_id,
    meter_type,
    room: room_id ? { id: room_id, name: roomName } : null,
    building: { id: building_id, name: buildingName },
  }));

// Generator for filter combinations — picks from existing values or null
const filtersArb = (meters: MeterWithRoom[]) =>
  fc.record({
    building_id: meters.length > 0
      ? fc.option(
          fc.constantFrom(...meters.map((m) => m.building_id)),
          { nil: null },
        )
      : fc.constant(null),
    meter_type: fc.option(fc.constantFrom(...METER_TYPES), { nil: null }),
  });

describe('Property 2: Bộ lọc công tơ chỉ trả về kết quả phù hợp', () => {
  it('all meters in filtered results must satisfy every applied filter condition', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithTypeArb, { minLength: 0, maxLength: 50 }).chain(
          (meters) => filtersArb(meters).map((filters) => ({ meters, filters })),
        ),
        ({ meters, filters }) => {
          const result = filterMeters(meters, filters);

          // Every meter in the result must match all active filter conditions
          for (const meter of result) {
            if (filters.building_id) {
              expect(meter.building_id).toBe(filters.building_id);
            }
            if (filters.meter_type) {
              expect((meter as Record<string, unknown>).meter_type).toBe(filters.meter_type);
            }
          }

          // Result must be a subset of the original list
          expect(result.length).toBeLessThanOrEqual(meters.length);

          // No matching meter should be excluded from the result
          const expectedCount = meters.filter((m) => {
            if (filters.building_id && m.building_id !== filters.building_id) return false;
            if (filters.meter_type && (m as Record<string, unknown>).meter_type !== filters.meter_type) return false;
            return true;
          }).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Feature: meter-reading-reimplementation, Property 5: Soft-delete đảm bảo ẩn khỏi danh sách
 * Validates: Yêu cầu 4.2, 4.4
 *
 * Với bất kỳ công tơ nào đã bị soft-delete (deleted_at != null), công tơ đó không được
 * xuất hiện trong kết quả query danh sách công tơ (query có điều kiện `deleted_at IS NULL`).
 */

// Replicate the filterActiveMeters function from useMeters.ts for pure testing
function filterActiveMeters<T extends { deleted_at: string | null }>(
  meters: T[],
): T[] {
  return meters.filter((meter) => meter.deleted_at === null);
}

type MeterWithDeletedAt = {
  id: string;
  code: string;
  building_id: string;
  room_id: string | null;
  meter_type: string;
  deleted_at: string | null;
};

// Generator for a meter with random deleted_at (some null, some with ISO date strings)
const meterWithDeletedAtArb: fc.Arbitrary<MeterWithDeletedAt> = fc
  .record({
    code: fc.string({ minLength: 1, maxLength: 10 }),
    building_id: fc.uuid(),
    room_id: fc.option(fc.uuid(), { nil: null }),
    meter_type: fc.constantFrom('ELECTRICITY', 'WATER', 'GAS'),
    deleted_at: fc.option(
      fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map((d) => d.toISOString()),
      { nil: null },
    ),
  })
  .map(({ code, building_id, room_id, meter_type, deleted_at }) => ({
    id: crypto.randomUUID(),
    code,
    building_id,
    room_id,
    meter_type,
    deleted_at,
  }));

describe('Property 5: Soft-delete đảm bảo ẩn khỏi danh sách', () => {
  it('no meter with non-null deleted_at should appear in the filtered active list', () => {
    fc.assert(
      fc.property(
        fc.array(meterWithDeletedAtArb, { minLength: 0, maxLength: 50 }),
        (meters) => {
          const activeMeters = filterActiveMeters(meters);

          // 1) No soft-deleted meter should appear in the result
          for (const meter of activeMeters) {
            expect(meter.deleted_at).toBeNull();
          }

          // 2) Every active meter from the original list must be present in the result
          const expectedActive = meters.filter((m) => m.deleted_at === null);
          expect(activeMeters.length).toBe(expectedActive.length);

          // 3) The result must be a subset of the original list
          const activeIds = new Set(activeMeters.map((m) => m.id));
          for (const meter of expectedActive) {
            expect(activeIds.has(meter.id)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Feature: meter-reading-reimplementation, Property 4: Tên công tơ tự sinh đúng định dạng
 * **Validates: Requirements 2.4**
 *
 * Với bất kỳ tên phòng và loại công tơ nào, tên công tơ tự sinh phải chứa tên phòng
 * và tên loại công tơ tương ứng (VD: "Phòng 201 - Điện").
 */

import { generateMeterName, applyMeterUpdate, type MeterBase, type MeterUpdates } from '../useMeterReadingsHelpers';

const METER_TYPE_LABEL_MAP: Record<string, string> = {
  ELECTRICITY: 'Điện',
  WATER: 'Nước',
  GAS: 'Gas',
};

describe('Property 4: Tên công tơ tự sinh đúng định dạng', () => {
  it('generated name must contain the room name and the Vietnamese meter type label', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.constantFrom('ELECTRICITY' as const, 'WATER' as const, 'GAS' as const),
        (roomName, meterType) => {
          const name = generateMeterName(roomName, meterType);

          // Must contain the room name
          expect(name).toContain(roomName);

          // Must contain the Vietnamese label for the meter type
          const expectedLabel = METER_TYPE_LABEL_MAP[meterType];
          expect(name).toContain(expectedLabel);

          // Must follow the format "{roomName} - {label}"
          expect(name).toBe(`${roomName} - ${expectedLabel}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should produce expected names for known examples', () => {
    expect(generateMeterName('Phòng 201', 'ELECTRICITY')).toBe('Phòng 201 - Điện');
    expect(generateMeterName('Phòng 301', 'WATER')).toBe('Phòng 301 - Nước');
    expect(generateMeterName('Phòng 101', 'GAS')).toBe('Phòng 101 - Gas');
  });
});

/**
 * Feature: meter-reading-reimplementation, Property 6: Cập nhật công tơ round-trip
 * **Validates: Requirements 3.1, 3.2, 3.3**
 *
 * Với bất kỳ công tơ hiện có và bất kỳ bộ giá trị cập nhật hợp lệ nào, sau khi cập nhật
 * và đọc lại, các trường đã cập nhật phải phản ánh giá trị mới, và updated_at phải mới hơn
 * trước khi cập nhật.
 */

// Generator for a MeterBase object
const meterBaseArb: fc.Arbitrary<MeterBase> = fc.record({
  id: fc.uuid(),
  code: fc.string({ minLength: 1, maxLength: 20 }),
  building_id: fc.uuid(),
  room_id: fc.option(fc.uuid(), { nil: null }),
  meter_type: fc.constantFrom('ELECTRICITY', 'WATER', 'GAS'),
  name: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
  initial_reading: fc.nat({ max: 99999 }),
  installation_date: fc.option(
    fc.integer({ min: 2020, max: 2030 }).chain((year) =>
      fc.integer({ min: 1, max: 12 }).chain((month) =>
        fc.integer({ min: 1, max: 28 }).map((day) =>
          `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        ),
      ),
    ),
    { nil: null },
  ),
  location_note: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
  manufacturer: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }),
  model: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }),
  serial_number: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }),
  notes: fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: null }),
  updated_at: fc.integer({ min: 2020, max: 2025 }).chain((year) =>
    fc.integer({ min: 1, max: 12 }).chain((month) =>
      fc.integer({ min: 1, max: 28 }).chain((day) =>
        fc.integer({ min: 0, max: 23 }).chain((hour) =>
          fc.integer({ min: 0, max: 59 }).map((minute) =>
            new Date(year, month - 1, day, hour, minute).toISOString(),
          ),
        ),
      ),
    ),
  ),
});

// Generator for partial updates
const meterUpdatesArb: fc.Arbitrary<MeterUpdates> = fc.record({
  code: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  building_id: fc.option(fc.uuid(), { nil: undefined }),
  room_id: fc.option(fc.option(fc.uuid(), { nil: null }), { nil: undefined }),
  meter_type: fc.option(fc.constantFrom('ELECTRICITY', 'WATER', 'GAS'), { nil: undefined }),
  initial_reading: fc.option(fc.nat({ max: 99999 }), { nil: undefined }),
  installation_date: fc.option(
    fc.option(
      fc.integer({ min: 2020, max: 2030 }).chain((year) =>
        fc.integer({ min: 1, max: 12 }).chain((month) =>
          fc.integer({ min: 1, max: 28 }).map((day) =>
            `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          ),
        ),
      ),
      { nil: null },
    ),
    { nil: undefined },
  ),
  location_note: fc.option(fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }), { nil: undefined }),
  manufacturer: fc.option(fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }), { nil: undefined }),
  model: fc.option(fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }), { nil: undefined }),
  serial_number: fc.option(fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }), { nil: undefined }),
  notes: fc.option(fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: null }), { nil: undefined }),
});

// Generator for a future timestamp (always after 2025-07-01)
const futureTimestampArb = fc.integer({ min: 2026, max: 2030 }).chain((year) =>
  fc.integer({ min: 1, max: 12 }).chain((month) =>
    fc.integer({ min: 1, max: 28 }).chain((day) =>
      fc.integer({ min: 0, max: 23 }).chain((hour) =>
        fc.integer({ min: 0, max: 59 }).map((minute) =>
          new Date(year, month - 1, day, hour, minute).toISOString(),
        ),
      ),
    ),
  ),
);

describe('Property 6: Cập nhật công tơ round-trip', () => {
  it('updated fields must reflect new values and updated_at must be newer', () => {
    fc.assert(
      fc.property(
        meterBaseArb,
        meterUpdatesArb,
        futureTimestampArb,
        (meter, updates, newUpdatedAt) => {
          const updated = applyMeterUpdate(meter, updates, newUpdatedAt);

          // 1) updated_at must be the new timestamp (which is always after the original range)
          expect(updated.updated_at).toBe(newUpdatedAt);
          expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
            new Date(meter.updated_at).getTime(),
          );

          // 2) Each field in updates (that is not undefined) must be reflected in the result
          for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
              expect((updated as unknown as Record<string, unknown>)[key]).toEqual(value);
            }
          }

          // 3) Fields NOT in updates must remain unchanged
          const updateKeys = new Set(
            Object.entries(updates)
              .filter(([, v]) => v !== undefined)
              .map(([k]) => k),
          );
          for (const key of Object.keys(meter) as (keyof MeterBase)[]) {
            if (key === 'updated_at') continue; // already checked
            if (!updateKeys.has(key)) {
              expect((updated as unknown as Record<string, unknown>)[key]).toEqual(
                (meter as unknown as Record<string, unknown>)[key],
              );
            }
          }

          // 4) id must never change
          expect(updated.id).toBe(meter.id);
        },
      ),
      { numRuns: 100 },
    );
  });
});
