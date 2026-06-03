import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  dateToMonth,
  monthToStartDate,
  monthToEndDate,
  currentMonth,
  formatPeriod,
} from '../monthPeriod';

describe('dateToMonth', () => {
  it('cắt YYYY-MM từ YYYY-MM-DD và giữ nguyên YYYY-MM', () => {
    expect(dateToMonth('2024-03-17')).toBe('2024-03');
    expect(dateToMonth('2024-03')).toBe('2024-03');
  });
  it('null/rỗng → ""', () => {
    expect(dateToMonth(null)).toBe('');
    expect(dateToMonth(undefined)).toBe('');
    expect(dateToMonth('')).toBe('');
  });
});

describe('monthToStartDate', () => {
  it('YYYY-MM → ngày đầu tháng', () => {
    expect(monthToStartDate('2024-03')).toBe('2024-03-01');
  });
  it('rỗng → ""', () => {
    expect(monthToStartDate('')).toBe('');
    expect(monthToStartDate(null)).toBe('');
  });
});

describe('monthToEndDate', () => {
  it('đúng ngày cuối tháng, kể cả năm nhuận', () => {
    expect(monthToEndDate('2024-02')).toBe('2024-02-29'); // nhuận
    expect(monthToEndDate('2023-02')).toBe('2023-02-28');
    expect(monthToEndDate('2024-04')).toBe('2024-04-30');
    expect(monthToEndDate('2024-12')).toBe('2024-12-31');
    expect(monthToEndDate('2024-01')).toBe('2024-01-31');
  });
  it('rỗng → ""', () => {
    expect(monthToEndDate('')).toBe('');
  });
});

describe('currentMonth', () => {
  it('đúng định dạng YYYY-MM', () => {
    expect(currentMonth()).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('formatPeriod', () => {
  it('cùng tháng → 1 nhãn MM/yyyy', () => {
    expect(formatPeriod('2024-06-01', '2024-06-30')).toBe('06/2024');
  });
  it('khác tháng → khoảng MM/yyyy – MM/yyyy', () => {
    expect(formatPeriod('2024-01-01', '2024-03-31')).toBe('01/2024 – 03/2024');
  });
  it('thiếu start hoặc end → "" (không hiển thị)', () => {
    expect(formatPeriod(null, '2024-03-31')).toBe('');
    expect(formatPeriod('2024-01-01', null)).toBe('');
    expect(formatPeriod(null, null)).toBe('');
  });
});

describe('round-trip month ↔ date', () => {
  it('dateToMonth(monthToStartDate(m)) === m và với monthToEndDate', () => {
    const monthArb = fc
      .record({
        y: fc.integer({ min: 2000, max: 2099 }),
        m: fc.integer({ min: 1, max: 12 }),
      })
      .map(({ y, m }) => `${y}-${String(m).padStart(2, '0')}`);
    fc.assert(
      fc.property(monthArb, (m) => {
        expect(dateToMonth(monthToStartDate(m))).toBe(m);
        expect(dateToMonth(monthToEndDate(m))).toBe(m);
      }),
    );
  });
});
