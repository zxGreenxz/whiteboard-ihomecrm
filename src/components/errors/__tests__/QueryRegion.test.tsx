// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryRegion } from '../QueryRegion';
afterEach(cleanup);
const query = (overrides: Record<string, unknown> = {}) => ({ data: undefined, status: 'error' as const, fetchStatus: 'idle' as const, isLoading: false, isError: true, error: new Error('Failed to fetch'), refetch: vi.fn(), dataUpdatedAt: 1, ...overrides });
it.each(['pending','success'] as const)('does not render an absent required %s source as zero', status => {
  render(<QueryRegion label="bảng lương" queries={[query({data:undefined,status,isError:false,error:null})]}><p>Tổng 0 đồng</p></QueryRegion>);
  expect(screen.queryByText('Tổng 0 đồng')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải được bảng lương');
});
// Đo 02/10/2026 trên production: /finance/salary chớp "Chưa tải được bảng lương…" 2,4 s
// mỗi lần mở, vì nguồn đang tắt chờ nguồn khác (pending/idle) bị tính là lỗi trước cả
// nguồn đang tải.
it.each([
  ['đang tải lần đầu', { status: 'pending', fetchStatus: 'fetching', isLoading: true }],
  ['đang nạp lại', { data: 3, status: 'success', fetchStatus: 'fetching', isLoading: false }],
] as const)('source waiting on another that is %s shows loading, not an error', (_ten, dangChay) => {
  const cho = query({ status: 'pending', isError: false, error: null });
  render(<QueryRegion label="bảng lương" queries={[query({ isError: false, error: null, ...dangChay }), cho]}><p>Tổng 0 đồng</p></QueryRegion>);
  expect(screen.queryByText('Tổng 0 đồng')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Đang tải bảng lương');
});
it('source that never starts after the others settle is still reported', () => {
  const xong = query({ data: 1, status: 'success', isError: false, error: null });
  render(<QueryRegion label="bảng lương" queries={[xong, query({ status: 'pending', isError: false, error: null })]}><p>Tổng 0 đồng</p></QueryRegion>);
  expect(screen.queryByText('Tổng 0 đồng')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải được bảng lương');
});
it('initial failure hides empty/success data and retries only its source', async () => {
  const source = query();
  render(<QueryRegion label="danh sách phòng" queries={[source]}><p>Không có phòng</p></QueryRegion>);
  expect(screen.queryByText('Không có phòng')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải được danh sách phòng');
  fireEvent.click(screen.getByRole('button', {name:'Tải lại'}));
  await waitFor(() => expect(source.refetch).toHaveBeenCalledOnce());
});
it('transient refetch failure preserves cached data with a timestamp warning', () => {
  render(<QueryRegion label="doanh thu" queries={[query({data: 15})]}><p>15 đồng</p></QueryRegion>);
  expect(screen.getByText('15 đồng')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Đang hiển thị kết quả tải lúc');
});
it('permission failure never reveals cached data', () => {
  render(<QueryRegion label="doanh thu" queries={[query({data: 15, error:{code:'42501'}})]}><p>15 đồng</p></QueryRegion>);
  expect(screen.queryByText('15 đồng')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('quyền');
});
it('one missing mandatory source blocks calculations', () => {
  render(<QueryRegion label="số liệu thanh lý" queries={[query({ data: 2, isError: false, status:'success' }), query()]}><p>Đã tính thanh lý</p></QueryRegion>);
  expect(screen.queryByText('Đã tính thanh lý')).toBeNull();
});
it('true empty data is allowed only after a successful load', () => {
  render(<QueryRegion label="danh sách phòng" queries={[query({data:[],isError:false,status:'success'})]}><p>Không có phòng</p></QueryRegion>);
  expect(screen.getByText('Không có phòng')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
