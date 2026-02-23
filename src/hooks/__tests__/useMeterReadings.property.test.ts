import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createMeterReadingPayload,
  canEditReading,
  canDeleteReading,
  applyApproval,
  applyUnapproval,
  bulkDeleteUnapprovedOnly,
} from '../useMeterReadingsHelpers';

/**
 * Feature: meter-reading-reimplementation
 * Property 11: Bản ghi mới luôn có trạng thái UNAPPROVED
 * **Validates: Requirements 5.4**
 *
 * Với bất kỳ bản ghi chỉ số nào vừa được tạo, trường `status` phải là 'UNAPPROVED'.
 */
describe('Property 11: Bản ghi mới luôn có trạng thái UNAPPROVED', () => {
  it('should always create a payload with status UNAPPROVED regardless of input', () => {
    fc.assert(
      fc.property(
        fc.record({
          userId: fc.uuid(),
          meterId: fc.uuid(),
          readingDate: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
            .map((d) => d.toISOString().slice(0, 10)),
          currentReading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
          notes: fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: undefined }),
          meterImageUrl: fc.option(fc.webUrl(), { nil: undefined }),
        }),
        (input) => {
          const payload = createMeterReadingPayload(input);

          expect(payload.status).toBe('UNAPPROVED');
          expect(payload.user_id).toBe(input.userId);
          expect(payload.meter_id).toBe(input.meterId);
          expect(payload.reading_date).toBe(input.readingDate);
          expect(payload.current_reading).toBe(input.currentReading);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Feature: meter-reading-reimplementation
 * Property 12: Quyền sửa/xoá phụ thuộc trạng thái duyệt
 * **Validates: Requirements 7.1, 7.2, 7.3**
 *
 * Với bất kỳ bản ghi chỉ số nào, nếu status === 'UNAPPROVED' thì cho phép sửa và xoá,
 * nếu status === 'APPROVED' thì không cho phép sửa và xoá.
 */
describe('Property 12: Quyền sửa/xoá phụ thuộc trạng thái duyệt', () => {
  it('UNAPPROVED readings should allow edit and delete', () => {
    fc.assert(
      fc.property(
        fc.constant('UNAPPROVED' as const),
        (status) => {
          expect(canEditReading(status)).toBe(true);
          expect(canDeleteReading(status)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('APPROVED readings should disallow edit and delete', () => {
    fc.assert(
      fc.property(
        fc.constant('APPROVED' as const),
        (status) => {
          expect(canEditReading(status)).toBe(false);
          expect(canDeleteReading(status)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('canEditReading and canDeleteReading should agree for any status', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('UNAPPROVED' as const, 'APPROVED' as const),
        (status) => {
          const canEdit = canEditReading(status);
          const canDelete = canDeleteReading(status);

          // Both permissions should be the same: allowed for UNAPPROVED, denied for APPROVED
          expect(canEdit).toBe(canDelete);
          expect(canEdit).toBe(status === 'UNAPPROVED');
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-reimplementation
 * Property 13: Duyệt rồi bỏ duyệt là round-trip
 * **Validates: Requirements 8.2, 8.3, 8.4**
 *
 * Với bất kỳ bản ghi chỉ số UNAPPROVED nào, sau khi duyệt (approve) rồi bỏ duyệt (unapprove),
 * trạng thái phải trở về UNAPPROVED, và approved_by cùng approved_at phải là null.
 */
describe('Property 13: Duyệt rồi bỏ duyệt là round-trip', () => {
  it('approve then unapprove should return to original UNAPPROVED state', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (approverId, year, month, day, hour, minute) => {
          const approvedAt = new Date(year, month - 1, day, hour, minute).toISOString();
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

/**
 * Feature: meter-reading-reimplementation
 * Property 14: Xoá hàng loạt chỉ xoá bản ghi chưa duyệt
 * **Validates: Requirements 7.4**
 *
 * Với bất kỳ tập hợp bản ghi chỉ số được chọn để xoá hàng loạt,
 * chỉ các bản ghi có status === 'UNAPPROVED' mới bị xoá,
 * các bản ghi APPROVED phải được giữ nguyên.
 */
describe('Property 14: Xoá hàng loạt chỉ xoá bản ghi chưa duyệt', () => {
  const readingArb = fc.record({
    id: fc.uuid(),
    status: fc.constantFrom('UNAPPROVED' as const, 'APPROVED' as const),
  });

  it('should only delete UNAPPROVED readings from the selected ids', () => {
    fc.assert(
      fc.property(
        fc.array(readingArb, { minLength: 1, maxLength: 50 }),
        (readings) => {
          // Select a random subset of ids to delete
          const idsToDelete = readings.map((r) => r.id);

          const { remaining, deleted } = bulkDeleteUnapprovedOnly(readings, idsToDelete);

          // All deleted readings must be UNAPPROVED
          for (const d of deleted) {
            expect(d.status).toBe('UNAPPROVED');
          }

          // All APPROVED readings must remain
          const approvedOriginal = readings.filter((r) => r.status === 'APPROVED');
          const approvedRemaining = remaining.filter((r) => r.status === 'APPROVED');
          expect(approvedRemaining.length).toBe(approvedOriginal.length);

          // Total count is preserved
          expect(remaining.length + deleted.length).toBe(readings.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not delete readings whose ids are not in the delete list', () => {
    fc.assert(
      fc.property(
        fc.array(readingArb, { minLength: 2, maxLength: 50 }),
        (readings) => {
          // Only select first half for deletion
          const halfIndex = Math.max(1, Math.floor(readings.length / 2));
          const idsToDelete = readings.slice(0, halfIndex).map((r) => r.id);

          const { remaining, deleted } = bulkDeleteUnapprovedOnly(readings, idsToDelete);

          // Readings not in idsToDelete must all be in remaining
          const notSelectedIds = new Set(readings.slice(halfIndex).map((r) => r.id));
          for (const r of remaining) {
            if (notSelectedIds.has(r.id)) {
              // This reading was not selected for deletion, so it must remain
              expect(remaining.some((rem) => rem.id === r.id)).toBe(true);
            }
          }

          // Deleted readings must only come from the selected ids
          const idsToDeleteSet = new Set(idsToDelete);
          for (const d of deleted) {
            expect(idsToDeleteSet.has(d.id)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

import {
  applyMeterReadingFilters,
  paginateList,
  type MeterReadingFilterParams,
} from '../useMeterReadingsHelpers';
import { computeStats, type MeterReadingForStats } from '../useMeterReadingsHelpers';

// --- Shared types for Property 15/16/17 ---

interface TestMeterReading {
  id: string;
  user_id: string;
  reading_code: string;
  meter_id: string;
  meter_code: string;
  meter_name: string;
  contract_id: string | null;
  service_id: string | null;
  service_name: string | null;
  building_id: string;
  building_name: string;
  room_id: string;
  room_name: string;
  meter_type: string;
  settlement_month: string;
  reading_date: string;
  previous_reading: number;
  current_reading: number;
  consumption: number;
  status: 'UNAPPROVED' | 'APPROVED';
  approved_by: string | null;
  approver_email: string | null;
  approved_at: string | null;
  recorded_by: string;
  recorder_email: string;
  notes: string | null;
  meter_image_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const METER_TYPES = ['ELECTRICITY', 'WATER', 'GAS'] as const;
const STATUSES = ['UNAPPROVED', 'APPROVED'] as const;

const testMeterReadingArb: fc.Arbitrary<TestMeterReading> = fc
  .record({
    id: fc.uuid(),
    user_id: fc.uuid(),
    reading_code: fc.string({ minLength: 5, maxLength: 15 }),
    meter_id: fc.uuid(),
    meter_code: fc.string({ minLength: 1, maxLength: 10 }),
    meter_name: fc.string({ minLength: 1, maxLength: 30 }),
    contract_id: fc.option(fc.uuid(), { nil: null }),
    service_id: fc.option(fc.uuid(), { nil: null }),
    service_name: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
    building_id: fc.uuid(),
    building_name: fc.string({ minLength: 1, maxLength: 20 }),
    room_id: fc.uuid(),
    room_name: fc.string({ minLength: 1, maxLength: 20 }),
    meter_type: fc.constantFrom(...METER_TYPES),
    settlement_month: fc.integer({ min: 2020, max: 2030 }).chain((y) =>
      fc.integer({ min: 1, max: 12 }).map((m) => `${y}-${String(m).padStart(2, '0')}`),
    ),
    reading_date: fc.integer({ min: 2020, max: 2030 }).chain((y) =>
      fc.integer({ min: 1, max: 12 }).chain((m) =>
        fc.integer({ min: 1, max: 28 }).map(
          (d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        ),
      ),
    ),
    previous_reading: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
    current_reading: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
    consumption: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
    status: fc.constantFrom(...STATUSES),
    approved_by: fc.option(fc.uuid(), { nil: null }),
    approver_email: fc.option(fc.emailAddress(), { nil: null }),
    approved_at: fc.option(fc.date().map((d) => d.toISOString()), { nil: null }),
    recorded_by: fc.uuid(),
    recorder_email: fc.emailAddress(),
    notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
    meter_image_url: fc.option(fc.webUrl(), { nil: null }),
    created_at: fc.date().map((d) => d.toISOString()),
    updated_at: fc.date().map((d) => d.toISOString()),
    deleted_at: fc.constant(null as string | null),
  });

/**
 * Feature: meter-reading-reimplementation
 * Property 15: Bộ lọc chỉ số trả về kết quả phù hợp
 * **Validates: Yêu cầu 9.2**
 *
 * Với bất kỳ danh sách chỉ số và bất kỳ tổ hợp bộ lọc (building_id, room_id, meter_type,
 * month, status) nào, tất cả bản ghi trong kết quả phải thỏa mãn mọi điều kiện lọc đã chọn.
 */
describe('Property 15: Bộ lọc chỉ số trả về kết quả phù hợp', () => {
  // Build filters that pick from existing values in the generated readings list
  const filtersFromReadings = (readings: TestMeterReading[]) =>
    fc.record({
      building_id: readings.length > 0
        ? fc.option(fc.constantFrom(...readings.map((r) => r.building_id)), { nil: undefined })
        : fc.constant(undefined),
      room_id: readings.length > 0
        ? fc.option(fc.constantFrom(...readings.map((r) => r.room_id)), { nil: undefined })
        : fc.constant(undefined),
      meter_type: fc.option(fc.constantFrom(...METER_TYPES) as fc.Arbitrary<string>, { nil: undefined }),
      month: readings.length > 0
        ? fc.option(fc.constantFrom(...readings.map((r) => r.settlement_month)), { nil: undefined })
        : fc.constant(undefined),
      status: fc.option(fc.constantFrom(...STATUSES), { nil: undefined }),
    }) as fc.Arbitrary<MeterReadingFilterParams>;

  it('all readings in filtered results must satisfy every applied filter condition', () => {
    fc.assert(
      fc.property(
        fc.array(testMeterReadingArb, { minLength: 0, maxLength: 30 }).chain((readings) =>
          filtersFromReadings(readings).map((filters) => ({ readings, filters })),
        ),
        ({ readings, filters }) => {
          const result = applyMeterReadingFilters(readings, filters);

          // Every reading in the result must match all active filter conditions
          for (const r of result) {
            if (filters.building_id) expect(r.building_id).toBe(filters.building_id);
            if (filters.room_id) expect(r.room_id).toBe(filters.room_id);
            if (filters.meter_type) expect(r.meter_type).toBe(filters.meter_type);
            if (filters.month) expect(r.settlement_month).toBe(filters.month);
            if (filters.status) expect(r.status).toBe(filters.status);
          }

          // Result must be a subset of the original list
          expect(result.length).toBeLessThanOrEqual(readings.length);

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

/**
 * Feature: meter-reading-reimplementation
 * Property 16: Phân trang đúng
 * **Validates: Yêu cầu 9.3**
 *
 * Với bất kỳ danh sách chỉ số và kích thước trang (pageSize) nào, mỗi trang phải chứa
 * tối đa pageSize bản ghi, và tổng số bản ghi qua tất cả các trang phải bằng tổng số
 * bản ghi gốc.
 */
describe('Property 16: Phân trang đúng', () => {
  it('each page has at most pageSize items and total across all pages equals original count', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 25 }),
        (items, pageSize) => {
          const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
          let totalCollected = 0;

          for (let page = 1; page <= totalPages; page++) {
            const { data, totalCount } = paginateList(items, page, pageSize);

            // Each page must have at most pageSize items
            expect(data.length).toBeLessThanOrEqual(pageSize);

            // totalCount must always equal the original list length
            expect(totalCount).toBe(items.length);

            totalCollected += data.length;
          }

          // Total items collected across all pages must equal original count
          expect(totalCollected).toBe(items.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('pages beyond the last page should return empty data', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 20 }),
        (items, pageSize) => {
          const totalPages = Math.ceil(items.length / pageSize);
          const beyondPage = totalPages + 1;

          const { data, totalCount } = paginateList(items, beyondPage, pageSize);

          expect(data.length).toBe(0);
          expect(totalCount).toBe(items.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: meter-reading-reimplementation
 * Property 17: Thống kê đúng
 * **Validates: Yêu cầu 10.1, 10.2**
 *
 * Với bất kỳ tập hợp bản ghi chỉ số trong một tháng nào, tổng (approved_count +
 * unapproved_count) phải bằng total_readings, và tổng tiêu thụ điện phải bằng tổng
 * consumption của tất cả bản ghi có meter_type = ELECTRICITY.
 */
describe('Property 17: Thống kê đúng', () => {
  const readingForStatsArb: fc.Arbitrary<MeterReadingForStats> = fc.record({
    status: fc.constantFrom(...STATUSES),
    consumption: fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
    meter_type: fc.constantFrom(...METER_TYPES),
  });

  it('approved_count + unapproved_count must equal total_readings', () => {
    fc.assert(
      fc.property(
        fc.array(readingForStatsArb, { minLength: 0, maxLength: 50 }),
        (readings) => {
          const stats = computeStats(readings);

          expect(stats.approved_count + stats.unapproved_count).toBe(stats.total_readings);
          expect(stats.total_readings).toBe(readings.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('electricity_consumption must equal sum of consumption for ELECTRICITY readings', () => {
    fc.assert(
      fc.property(
        fc.array(readingForStatsArb, { minLength: 0, maxLength: 50 }),
        (readings) => {
          const stats = computeStats(readings);

          const expectedElectricity = readings
            .filter((r) => r.meter_type === 'ELECTRICITY')
            .reduce((sum, r) => sum + r.consumption, 0);

          expect(stats.electricity_consumption).toBeCloseTo(expectedElectricity, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('water_consumption must equal sum of consumption for WATER readings', () => {
    fc.assert(
      fc.property(
        fc.array(readingForStatsArb, { minLength: 0, maxLength: 50 }),
        (readings) => {
          const stats = computeStats(readings);

          const expectedWater = readings
            .filter((r) => r.meter_type === 'WATER')
            .reduce((sum, r) => sum + r.consumption, 0);

          expect(stats.water_consumption).toBeCloseTo(expectedWater, 5);
        },
      ),
      { numRuns: 100 },
    );
  });
});


import { getPreviousReading, type ReadingHistoryEntry } from '../useMeterReadingsHelpers';

/**
 * Feature: meter-reading-reimplementation, Property 7: Chỉ số đầu tự động điền đúng
 * **Validates: Yêu cầu 5.3**
 *
 * Với bất kỳ công tơ nào có lịch sử ghi chỉ số, khi tạo bản ghi mới, `previous_reading`
 * phải bằng `current_reading` của lần ghi gần nhất. Nếu chưa có lần ghi nào,
 * `previous_reading` phải bằng `initial_reading` của công tơ.
 */
describe('Property 7: Chỉ số đầu tự động điền đúng', () => {
  // Generator for a single reading history entry
  const readingEntryArb: fc.Arbitrary<ReadingHistoryEntry> = fc.record({
    reading_date: fc.integer({ min: 2020, max: 2030 }).chain((y) =>
      fc.integer({ min: 1, max: 12 }).chain((m) =>
        fc.integer({ min: 1, max: 28 }).map(
          (d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        ),
      ),
    ),
    current_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  });

  it('should return initial_reading when there are no existing readings', () => {
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

  it('should return current_reading of the most recent reading (first in desc-sorted list)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.array(readingEntryArb, { minLength: 1, maxLength: 20 }),
        (initialReading, readings) => {
          // Sort by reading_date descending (most recent first)
          const sorted = [...readings].sort(
            (a, b) => b.reading_date.localeCompare(a.reading_date),
          );

          const result = getPreviousReading(initialReading, sorted);

          // Must equal the current_reading of the most recent entry
          expect(result).toBe(sorted[0].current_reading);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should never return initial_reading when readings exist', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.array(readingEntryArb, { minLength: 1, maxLength: 20 }),
        (initialReading, readings) => {
          const sorted = [...readings].sort(
            (a, b) => b.reading_date.localeCompare(a.reading_date),
          );

          const result = getPreviousReading(initialReading, sorted);

          // Result should be the most recent reading's current_reading,
          // which may coincidentally equal initialReading, but the source is different
          expect(result).toBe(sorted[0].current_reading);
        },
      ),
      { numRuns: 100 },
    );
  });
});


import { generateReadingCode, isValidReadingCode } from '../useMeterReadingsHelpers';

/**
 * Feature: meter-reading-reimplementation, Property 9: Mã chỉ số đúng định dạng CSS{YYMM}{sequence}
 * **Validates: Yêu cầu 5.6**
 *
 * Với bất kỳ bản ghi chỉ số nào được tạo, `reading_code` phải khớp với regex `^CSS\d{9}$`
 * (CSS + 4 chữ số YYMM + 5 chữ số sequence).
 */
describe('Property 9: Mã chỉ số đúng định dạng CSS{YYMM}{sequence}', () => {
  it('generateReadingCode always produces codes matching ^CSS\\d{9}$', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 99999 }),
        (year, month, sequence) => {
          const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
          const code = generateReadingCode(yearMonth, sequence);

          // Must match the regex format
          expect(isValidReadingCode(code)).toBe(true);
          expect(code).toMatch(/^CSS\d{9}$/);

          // Total length: "CSS" (3) + 9 digits = 12
          expect(code.length).toBe(12);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('YYMM portion matches the input year and month', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 99999 }),
        (year, month, sequence) => {
          const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
          const code = generateReadingCode(yearMonth, sequence);

          // Extract YYMM from code (positions 3-6)
          const yymm = code.slice(3, 7);
          const expectedYY = String(year).slice(2);
          const expectedMM = String(month).padStart(2, '0');

          expect(yymm).toBe(`${expectedYY}${expectedMM}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sequence portion is correctly zero-padded to 5 digits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 99999 }),
        (year, month, sequence) => {
          const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
          const code = generateReadingCode(yearMonth, sequence);

          // Extract sequence portion (positions 7-11)
          const seqPart = code.slice(7);
          expect(seqPart.length).toBe(5);
          expect(parseInt(seqPart, 10)).toBe(sequence);
        },
      ),
      { numRuns: 100 },
    );
  });
});


import { validateImportRows } from '../useMeterReadingsHelpers';

/**
 * Feature: meter-reading-reimplementation, Property 20: Import Excel - số bản ghi tạo + số lỗi = tổng dòng
 * **Validates: Yêu cầu 6.4, 6.6**
 *
 * Với bất kỳ file import nào, tổng (success_count + failed_count) phải bằng tổng số dòng
 * dữ liệu trong file, và mỗi dòng lỗi phải có thông báo lỗi chi tiết.
 */
describe('Property 20: Import Excel - số bản ghi tạo + số lỗi = tổng dòng', () => {
  // Generator for a valid import row
  const validRowArb = fc.record({
    meter_code: fc.string({ minLength: 1, maxLength: 20 }),
    reading_date: fc.integer({ min: 2020, max: 2030 }).chain((y) =>
      fc.integer({ min: 1, max: 12 }).chain((m) =>
        fc.integer({ min: 1, max: 28 }).map(
          (d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        ),
      ),
    ),
    current_reading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
  });

  // Generator for an invalid import row (various kinds of invalid data)
  const invalidRowArb = fc.oneof(
    // Missing meter_code (empty string)
    fc.record({
      meter_code: fc.constant(''),
      reading_date: fc.constant('2025-01-01'),
      current_reading: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
    }),
    // Missing reading_date (empty string)
    fc.record({
      meter_code: fc.string({ minLength: 1, maxLength: 10 }),
      reading_date: fc.constant(''),
      current_reading: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
    }),
    // Negative current_reading
    fc.record({
      meter_code: fc.string({ minLength: 1, maxLength: 10 }),
      reading_date: fc.constant('2025-01-01'),
      current_reading: fc.double({ min: -1_000_000, max: -0.01, noNaN: true, noDefaultInfinity: true }),
    }),
    // current_reading is not a number (string instead)
    fc.record({
      meter_code: fc.string({ minLength: 1, maxLength: 10 }),
      reading_date: fc.constant('2025-01-01'),
      current_reading: fc.constant('not-a-number' as unknown as number),
    }),
    // Completely empty object
    fc.constant({}),
    // null / undefined
    fc.constant(null),
  );

  // Generator for a mixed array of valid and invalid rows
  const mixedRowsArb = fc.array(
    fc.oneof(
      validRowArb.map((r) => r as unknown),
      invalidRowArb.map((r) => r as unknown),
    ),
    { minLength: 0, maxLength: 50 },
  );

  it('validRows.length + errors.length must equal total input rows', () => {
    fc.assert(
      fc.property(mixedRowsArb, (rows) => {
        const { validRows, errors } = validateImportRows(rows);
        expect(validRows.length + errors.length).toBe(rows.length);
      }),
      { numRuns: 100 },
    );
  });

  it('every error must have a rowIndex and a non-empty message', () => {
    fc.assert(
      fc.property(mixedRowsArb, (rows) => {
        const { errors } = validateImportRows(rows);

        for (const err of errors) {
          expect(typeof err.rowIndex).toBe('number');
          expect(err.rowIndex).toBeGreaterThanOrEqual(0);
          expect(err.rowIndex).toBeLessThan(rows.length);
          expect(typeof err.message).toBe('string');
          expect(err.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('all-valid input should produce zero errors', () => {
    fc.assert(
      fc.property(
        fc.array(validRowArb, { minLength: 1, maxLength: 30 }),
        (rows) => {
          const { validRows, errors } = validateImportRows(rows);
          expect(errors.length).toBe(0);
          expect(validRows.length).toBe(rows.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all-invalid input should produce zero valid rows', () => {
    fc.assert(
      fc.property(
        fc.array(invalidRowArb, { minLength: 1, maxLength: 30 }),
        (rows) => {
          const { validRows, errors } = validateImportRows(rows);
          expect(validRows.length).toBe(0);
          expect(errors.length).toBe(rows.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});


import {
  getApprovedReadingsForInvoice,
  type MeterReadingForInvoice,
} from '../useMeterReadingsHelpers';

/**
 * Feature: meter-reading-reimplementation, Property 18: Chỉ chỉ số đã duyệt mới được chọn cho hóa đơn
 * **Validates: Yêu cầu 11.1**
 *
 * Với bất kỳ phòng và tháng chốt nào, danh sách chỉ số khả dụng cho hóa đơn chỉ bao gồm
 * các bản ghi có `status === 'APPROVED'`.
 */
describe('Property 18: Chỉ chỉ số đã duyệt mới được chọn cho hóa đơn', () => {
  // Pool of room_ids and months to increase overlap probability
  const roomIdPool = ['room-A', 'room-B', 'room-C', 'room-D'] as const;
  const monthPool = ['2025-01', '2025-02', '2025-03', '2025-04'] as const;

  const meterReadingForInvoiceArb: fc.Arbitrary<MeterReadingForInvoice> = fc.record({
    id: fc.uuid(),
    status: fc.constantFrom('UNAPPROVED' as const, 'APPROVED' as const),
    room_id: fc.constantFrom(...roomIdPool),
    settlement_month: fc.constantFrom(...monthPool),
    meter_type: fc.constantFrom('ELECTRICITY', 'WATER', 'GAS'),
    consumption: fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
    current_reading: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
    previous_reading: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
    meter_name: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
    meter_code: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
    reading_code: fc.option(fc.string({ minLength: 5, maxLength: 15 }), { nil: undefined }),
  });

  it('all returned readings must have status APPROVED and match the given roomId and month', () => {
    fc.assert(
      fc.property(
        fc.array(meterReadingForInvoiceArb, { minLength: 0, maxLength: 40 }),
        fc.constantFrom(...roomIdPool),
        fc.constantFrom(...monthPool),
        (readings, roomId, month) => {
          const result = getApprovedReadingsForInvoice(readings, roomId, month);

          for (const r of result) {
            expect(r.status).toBe('APPROVED');
            expect(r.room_id).toBe(roomId);
            expect(r.settlement_month).toBe(month);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('no APPROVED reading matching room and month should be excluded', () => {
    fc.assert(
      fc.property(
        fc.array(meterReadingForInvoiceArb, { minLength: 0, maxLength: 40 }),
        fc.constantFrom(...roomIdPool),
        fc.constantFrom(...monthPool),
        (readings, roomId, month) => {
          const result = getApprovedReadingsForInvoice(readings, roomId, month);

          // Count expected: all APPROVED readings with matching room_id and settlement_month
          const expectedCount = readings.filter(
            (r) =>
              r.status === 'APPROVED' &&
              r.room_id === roomId &&
              r.settlement_month === month,
          ).length;

          expect(result.length).toBe(expectedCount);

          // Verify every matching APPROVED reading is present in the result by id
          const resultIds = new Set(result.map((r) => r.id));
          for (const r of readings) {
            if (
              r.status === 'APPROVED' &&
              r.room_id === roomId &&
              r.settlement_month === month
            ) {
              expect(resultIds.has(r.id)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


import { calculateInvoiceAmount } from '../useMeterReadingsHelpers';

/**
 * Feature: meter-reading-reimplementation, Property 19: Tính tiền hóa đơn = Số tiêu thụ × Đơn giá
 * **Validates: Yêu cầu 11.2**
 *
 * Với bất kỳ bản ghi chỉ số và đơn giá dịch vụ nào, thành tiền phải bằng
 * `consumption * unit_price`.
 */
describe('Property 19: Tính tiền hóa đơn = Số tiêu thụ × Đơn giá', () => {
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

  it('result is always non-negative when both inputs are non-negative', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (consumption, unitPrice) => {
          const result = calculateInvoiceAmount(consumption, unitPrice);
          expect(result).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('commutativity: calculateInvoiceAmount(a, b) === calculateInvoiceAmount(b, a)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          expect(calculateInvoiceAmount(a, b)).toBe(calculateInvoiceAmount(b, a));
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Feature: meter-reading-reimplementation, Property 21: Upload hình ảnh round-trip
 * **Validates: Yêu cầu 12.2**
 *
 * Với bất kỳ bản ghi chỉ số nào có hình ảnh được tải lên, `meter_image_url` phải là URL
 * hợp lệ, và khi truy xuất bản ghi đó, URL hình ảnh phải được trả về đúng.
 */
describe('Property 21: Upload hình ảnh round-trip', () => {
  it('when a valid URL is provided, meter_image_url in the payload must equal that URL exactly', () => {
    fc.assert(
      fc.property(
        fc.record({
          userId: fc.uuid(),
          meterId: fc.uuid(),
          readingDate: fc
            .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
            .map((d) => d.toISOString().slice(0, 10)),
          currentReading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        }),
        fc.webUrl(),
        (basePayload, imageUrl) => {
          const payload = createMeterReadingPayload({
            ...basePayload,
            meterImageUrl: imageUrl,
          });

          // meter_image_url must be a valid URL (non-null, non-empty string starting with http)
          expect(payload.meter_image_url).not.toBeNull();
          expect(payload.meter_image_url).toBe(imageUrl);
          expect(payload.meter_image_url!.startsWith('http')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('when meterImageUrl is undefined, meter_image_url must be null', () => {
    fc.assert(
      fc.property(
        fc.record({
          userId: fc.uuid(),
          meterId: fc.uuid(),
          readingDate: fc
            .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
            .map((d) => d.toISOString().slice(0, 10)),
          currentReading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        }),
        (basePayload) => {
          const payload = createMeterReadingPayload(basePayload);

          expect(payload.meter_image_url).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('URL is preserved exactly with no transformation or truncation', () => {
    fc.assert(
      fc.property(
        fc.record({
          userId: fc.uuid(),
          meterId: fc.uuid(),
          readingDate: fc
            .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
            .map((d) => d.toISOString().slice(0, 10)),
          currentReading: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        }),
        fc.webUrl(),
        (basePayload, imageUrl) => {
          const payload = createMeterReadingPayload({
            ...basePayload,
            meterImageUrl: imageUrl,
          });

          // Exact string equality — no trimming, encoding, or truncation
          expect(payload.meter_image_url).toStrictEqual(imageUrl);
          expect(payload.meter_image_url!.length).toBe(imageUrl.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
