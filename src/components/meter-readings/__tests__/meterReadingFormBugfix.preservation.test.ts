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

// Import HÀM THẬT thay vì chép lại. Ba hàm dưới đây từng được chép tay vào chính
// file này, và bản chép ĐÃ LỆCH: getMeterName_editingMode viết
// `reading.meter_name || reading.meter_code` trong khi component từ lâu dùng
// `formatSimpleMeterName(reading.meter_code)` và bỏ hẳn meter_name. Test vì thế
// khẳng định một hành vi KHÔNG CÒN TỒN TẠI — xanh, nhưng nói về quá khứ.
import {
  previousReadingWhenEditing,
  meterNameWhenEditing,
  isLoadEnabled,
} from '../meterReadingFormUtils';

const getPreviousReading_editingMode = previousReadingWhenEditing;
const getMeterName_editingMode = meterNameWhenEditing;
// Bản chép cũ đòi CẢ BA (building + room + month). Hàm thật chỉ đòi building và
// month — `roomId` KHÔNG tham gia quyết định. Giữ nguyên chữ ký ba tham số của các
// ca test bên dưới, nhưng gọi hàm thật để chúng đo đúng luật đang chạy.
const isLoadEnabled_current = (f: { buildingId: string; roomId: string; month: string }) =>
  isLoadEnabled({ buildingId: f.buildingId, month: f.month });

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
describe('Preservation: tên công tơ khi ĐANG SỬA', () => {
  // Bốn ca cũ ở đây khẳng định . Đó là hành vi của
  // BẢN CHÉP nằm trong file test, không phải của component — component từ lâu dùng
  // formatSimpleMeterName(meter_code) và bỏ hẳn meter_name. Khi trỏ test sang hàm
  // thật, cả bốn ca ĐỎ ngay: bằng chứng bản chép đã trôi khỏi thực tế.
  // Viết lại theo hành vi THẬT.

  it('bỏ tiền tố loại công tơ trong mã', () => {
    expect(getMeterName_editingMode({ meter_code: 'CTD-111PVC-101' })).toBe('111PVC-101');
    expect(getMeterName_editingMode({ meter_code: 'CTN-A-12' })).toBe('A-12');
  });

  it('mã không có dấu gạch thì giữ nguyên', () => {
    expect(getMeterName_editingMode({ meter_code: 'ABC123' })).toBe('ABC123');
  });

  it('không có mã thì trả chuỗi rỗng', () => {
    expect(getMeterName_editingMode({ meter_code: null })).toBe('');
    expect(getMeterName_editingMode({ meter_code: '' })).toBe('');
    expect(getMeterName_editingMode(null)).toBe('');
  });

  it('KHÔNG đọc meter_name — trường đó đã bị bỏ khỏi đường sửa', () => {
    // Khoá lại đúng điểm mà bản chép nói sai: dù meter_name có giá trị, kết quả
    // vẫn suy từ meter_code.
    const r = { meter_code: 'CTD-X-9', meter_name: 'TEN-KHAC' } as { meter_code: string };
    expect(getMeterName_editingMode(r)).toBe('X-9');
  });

  it('luôn khớp formatSimpleMeterName(meter_code) với mọi đầu vào', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 30 }), fc.constant(null)), (code) => {
        expect(getMeterName_editingMode({ meter_code: code })).toBe(
          code ? (code.includes('-') ? code.split('-').slice(1).join('-') : code) : '',
        );
      }),
      { numRuns: 200 },
    );
  });
});

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
