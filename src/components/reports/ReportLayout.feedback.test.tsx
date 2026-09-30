// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ReportLayout } from './ReportLayout';
afterEach(cleanup);
const query = { data: undefined, isError: true, error: new Error('Failed to fetch'), isLoading: false, status: 'error' as const, fetchStatus: 'idle' as const, refetch: vi.fn() };
it('keeps filters but hides totals and rows and disables export when the source failed', () => {
  render(<MemoryRouter><ReportLayout title="Báo cáo phòng trống" queries={[query]} stats={<p>Tổng: 0</p>} filters={<input aria-label="Ngày lọc" defaultValue="2026-09-01" />} actions={<button>Xuất báo cáo</button>}><p>Không có dữ liệu</p></ReportLayout></MemoryRouter>);
  expect(screen.queryByText('Tổng: 0')).toBeNull();
  expect(screen.queryByText('Không có dữ liệu')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Báo cáo phòng trống');
  expect(screen.getByLabelText('Ngày lọc')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Xuất báo cáo' }).closest('fieldset')?.disabled).toBe(true);
});
