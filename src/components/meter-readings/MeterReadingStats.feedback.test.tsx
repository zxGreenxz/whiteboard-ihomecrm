// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ error: true, refetch: vi.fn() }));
vi.mock('@/hooks/useMeterReadings', () => ({ useMeterReadingStats: () => ({ data: undefined, isLoading: false, isError: state.error, refetch: state.refetch }) }));
import { MeterReadingStats } from './MeterReadingStats';
afterEach(cleanup);
it('không hiển thị năm số 0 khi thống kê công tơ lỗi; có tải lại', () => {
  render(<MeterReadingStats />);
  expect(screen.getByRole('alert').textContent).toContain('Không tải được thống kê chỉ số');
  expect(screen.queryByText('0 kWh')).toBeNull();
  screen.getByRole('button', { name: /Tải lại/ }).click();
  expect(state.refetch).toHaveBeenCalledOnce();
});
