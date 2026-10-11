// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MonthInput, monthInputLabel } from '../month-input';
afterEach(cleanup);

// K11-60 (C-10): ô "Từ tháng/Đến tháng" hiện "October 2026" theo ngôn ngữ trình duyệt.
it('hiện tháng bằng chữ của app (10/2026), không phụ thuộc ngôn ngữ trình duyệt', () => {
  render(<MonthInput aria-label="Từ tháng" value="2026-10" onChange={() => {}} />);
  expect(screen.getByText('10/2026')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/October/i);
});

it('chưa chọn thì hiện gợi ý; đổi giá trị qua input gốc vẫn trả YYYY-MM', () => {
  const onChange = vi.fn();
  render(<MonthInput aria-label="Từ tháng" value="" onChange={onChange} />);
  expect(screen.getByText('Chọn tháng')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Từ tháng'), { target: { value: '2026-11' } });
  expect(onChange).toHaveBeenCalledWith('2026-11');
});

it('nhãn chỉ nhận YYYY-MM hợp lệ', () => {
  expect(monthInputLabel('2026-01')).toBe('1/2026');
  expect(monthInputLabel('2026-13')).toBeNull();
  expect(monthInputLabel(undefined)).toBeNull();
});
