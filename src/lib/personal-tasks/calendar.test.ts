import { expect, it } from 'vitest';
import { lunarLabel, monthCells, shiftMonth, holiday } from './calendar';

it('lịch VN khớp ảnh mẫu và Tết; tuần T2, điều hướng năm', () => {
  expect(lunarLabel('2026-10-04')).toBe('24/8 âm');
  expect(lunarLabel('2026-02-17')).toBe('1/1 âm');
  expect(holiday('2026-02-17')).toBe('Tết Nguyên Đán');
  expect(monthCells('2026-10')[0]).toBe('2026-09-28');
  expect(monthCells('2026-10').length % 7).toBe(0);
  expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  expect(shiftMonth('1900-01', -12)).toBe('1900-01');
});
