// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProfitCommissionChecks from '../ProfitCommissionChecks';
import type { CommissionCheckVoucher, CommissionVoucherCheck, ProfitCommissionCheck } from '@/lib/profitCommissionChecks';
const state = vi.hoisted(() => ({ query: { isPending: false, isError: false, isFetching: false,
  data: undefined as { rows: ProfitCommissionCheck[]; completeVisibility: boolean; orphans: CommissionCheckVoucher[]; postingReadFailed: boolean } | undefined,
  refetch: vi.fn() } }));
vi.mock('@/hooks/useProfitCommissionChecks', () => ({ useProfitCommissionChecks: () => state.query }));
vi.mock('@/components/income-expenses/IncomeExpenseDetailDialog', () => ({ default: ({ voucherId }: { voucherId: string }) => <div role="dialog">Phiếu {voucherId}</div> }));
const row = (id: string, status: ProfitCommissionCheck['state']): ProfitCommissionCheck => ({
  contract: { id, organization_id: 'org', contract_number: `DEMO-${id}`, start_date: '2026-11-01', signed_date: '2026-10-01',
    status: 'ACTIVE', room_id: `room-${id}`, room: { id: `room-${id}`, name: id, building_id: 'building', building: { name: 'Tòa thử' } } },
  state: status, vouchers: [], reason: null, complete: status !== 'UNVERIFIED',
});
const paidVoucher = (id: string, code: string): CommissionVoucherCheck => ({
  voucher: { id, code, organization_id: 'org', contract_id: '101', room_id: 'room-101',
    building_id: 'building', type: 'EXPENSE', deleted_at: null, total_amount: 500_000, voucher_date: '2026-10-02', commission_kind: 'broker',
    system_source: null, approval_status: 'APPROVED', posting_status: 'POSTED', active_posting_id_v2: 'posting',
    business_result_accounting: null, invoice_id: null, invoice: null, items: [] },
  status: 'paid', postedOn: '2026-12-03', periods: ['11/2026'], conflict: false,
});
const show = () => render(<MemoryRouter><ProfitCommissionChecks organizationId="org" buildingIds={['building']} month="2026-11" /></MemoryRouter>);
const header = () => screen.getByRole('button', { name: /Hoa hồng theo hợp đồng bắt đầu kỳ 11\/2026/ });
beforeEach(() => {
  state.query.isError = false; state.query.isPending = false; state.query.isFetching = false; state.query.refetch.mockClear();
  state.query.data = { rows: [row('101', 'MISSING'), row('102', 'NOT_APPLICABLE')], completeVisibility: true, orphans: [], postingReadFailed: false };
});
afterEach(cleanup);
it('starts collapsed, opens the missing-contract warning and can collapse the full list again', () => {
  show();
  expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(header().textContent).toContain('1 hợp đồng thiếu phiếu');
  expect(screen.queryByRole('button', { name: 'Đối chiếu lại' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'DEMO-101' })).toBeNull();
  fireEvent.click(header());
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('Chưa có phiếu hoa hồng')).toBeTruthy();
  expect(screen.getByText(/Có thể đã chi nhưng chưa nhập/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'DEMO-101' }).getAttribute('href')).toBe('/contracts/101');
  expect(screen.queryByText('DEMO-102')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Xem từng hợp đồng và kỳ phiếu' }));
  expect(screen.getByText('Đã xác nhận không phát sinh hoa hồng')).toBeTruthy();
  fireEvent.click(header());
  expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('link', { name: 'DEMO-102' })).toBeNull();
});
it('shows voucher date, declared profit period and verified payment period separately', async () => {
  const one = row('101', 'ONE');
  one.vouchers = [paidVoucher('voucher', 'DEMO-PC')];
  state.query.data!.rows = [one]; show();
  expect(header().textContent).toContain('0 phiếu cần đối chiếu');
  fireEvent.click(header());
  fireEvent.click(screen.getByRole('button', { name: 'Xem từng hợp đồng và kỳ phiếu' }));
  expect(screen.getByText('Kỳ phiếu: 10/2026 · Kỳ phân bổ khai trên phiếu: 11/2026')).toBeTruthy();
  expect(screen.getByText('Kỳ chi theo ghi sổ: 12/2026')).toBeTruthy();
  expect(screen.getByText('Đã chi · đã ghi sổ')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'DEMO-PC' }));
  expect((await screen.findByRole('dialog')).textContent).toContain('Phiếu voucher');
});
it('counts each duplicate and unlinked voucher in the header', () => {
  const duplicate = row('101', 'DUPLICATE');
  duplicate.vouchers = [paidVoucher('a', 'DEMO-A'), paidVoucher('b', 'DEMO-B')];
  state.query.data!.rows = [duplicate];
  state.query.data!.orphans = [{ ...paidVoucher('c', 'DEMO-C').voucher, contract_id: null }];
  show();
  expect(header().textContent).toContain('3 phiếu cần đối chiếu');
  fireEvent.click(header());
  expect(screen.getByRole('button', { name: 'DEMO-A' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'DEMO-B' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /DEMO-C/ })).toBeTruthy();
});
it('shows loading in the header until a count is available', () => {
  state.query.isPending = true; state.query.data = undefined; show();
  expect(header().textContent).toContain('Đang tải…');
  expect(header().textContent).not.toContain('0 phiếu');
});
it('does not display cached missing conclusions after a refresh failure', () => {
  state.query.isError = true; show();
  expect(header().textContent).toContain('Chưa tải được kết quả');
  expect(header().textContent).not.toContain('1 hợp đồng thiếu phiếu');
  fireEvent.click(header());
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ dữ liệu');
  expect(screen.queryByText('Chưa có phiếu hoa hồng')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Đối chiếu lại' })); expect(state.query.refetch).toHaveBeenCalledOnce();
});
it('keeps a paid voucher with an unreadable payment period visible in the default warning list', () => {
  const one = row('101', 'ONE');
  one.vouchers = [{ ...paidVoucher('voucher', 'DEMO-PC'), postedOn: null }];
  state.query.data!.rows = [one]; state.query.data!.postingReadFailed = true; show();
  expect(header().textContent).toContain('1 phiếu cần đối chiếu');
  fireEvent.click(header());
  expect(screen.getByText('Kỳ chi theo ghi sổ: chưa xác minh')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'DEMO-PC' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải được ngày ghi sổ');
});
it('shows limited visibility explicitly and never calls it all clear', () => {
  state.query.data!.completeVisibility = false; state.query.data!.rows = [row('101', 'UNVERIFIED')]; show();
  expect(header().textContent).toContain('Giới hạn quyền xem');
  expect(header().textContent).not.toContain('0 phiếu');
  fireEvent.click(header());
  expect(screen.getByRole('alert').textContent).toContain('Chưa đủ quyền');
  expect(screen.getByText('Chưa đủ dữ liệu để kết luận số phiếu hoa hồng')).toBeTruthy();
  expect(screen.queryByText(/0 chưa có|khớp|đủ phiếu/i)).toBeNull();
});
it('identifies unverified contracts with no visible voucher as contracts', () => {
  state.query.data!.rows = [row('101', 'UNVERIFIED')]; show();
  expect(header().textContent).toContain('1 hợp đồng chưa xác minh');
  expect(header().textContent).not.toContain('0 phiếu');
});
