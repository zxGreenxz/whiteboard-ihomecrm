// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';
import { ContractDetailMobile } from '../ContractDetailMobile';
import type { ContractWithRelations } from '@/types/contract';
import type { InvoiceWithRelations } from '@/types/invoice';
import type { ContractTerminationInfo } from '@/hooks/contracts/useContractDetailData';

vi.mock('../ContractMobileActions', () => ({ ContractMobileActions: () => null }));
vi.mock('../ContractInfoTab', () => ({ ContractInfoTab: () => null }));
vi.mock('../ContractInvoicesTab', () => ({ ContractInvoicesTab: () => null }));
vi.mock('../ContractPaymentsTab', () => ({ ContractPaymentsTab: () => null }));
vi.mock('../ContractHistoryTab', () => ({ ContractHistoryTab: () => null }));
afterEach(cleanup);

const contract = { id: 'contract', contract_number: 'DEMO', status: 'TERMINATED',
  total_deposit: 2_000, deposit_paid: 2_000, deposit_remaining: 0 } as unknown as ContractWithRelations;
const termination: ContractTerminationInfo = { termination_type: 'MOVE_OUT', actual_move_out_date: '2026-09-28',
  outstanding_debt: 0, early_termination_fee: 0, total_deposit: 2_000, total_deductions: 0,
  refund_amount: 2_000, posted_refund: 2_000, posted_refund_count: 1, posted_refund_codes: ['REFUND'] };
const invoice = { id: 'invoice', total_amount: 1_000, paid_amount: 0, status: 'APPROVED' } as unknown as InvoiceWithRelations;
const noop = () => {};
function show(overrides: Partial<ComponentProps<typeof ContractDetailMobile>> = {}) {
  render(<MemoryRouter><ContractDetailMobile contract={contract} services={[]} invoices={[]} history={[]}
    depositVouchers={[]} perms={{}} customers={[]} onBack={noop} onEdit={noop} onPrint={noop} onShowQR={noop}
    onRenew={noop} onTransferRoom={noop} onTransferContract={noop} onMoveOut={noop} onTerminate={noop} onDelete={noop}
    terminationInfo={termination} pendingForfeitCount={0} pendingRefundCount={0} statusLoading={false}
    sideLoadErrors={[]} {...overrides} /></MemoryRouter>);
  return within(screen.getByRole('region', { name: 'Trạng thái sau trả phòng' }));
}

it('shows an outstanding refund and the existing pending voucher count', () => {
  const status = show({ terminationInfo: { ...termination, posted_refund: 0 }, pendingRefundCount: 1 });
  expect(status.getByText('Khách đã trả phòng')).toBeTruthy();
  expect(status.getByText(/Chưa hoàn khách.*2\.000/)).toBeTruthy();
  expect(status.getByText('Phiếu hoàn chờ xử lý (1)')).toBeTruthy();
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it('keeps invoice debt and money to refund in separate visible rows', () => {
  const status = show({ invoices: [invoice], terminationInfo: { ...termination, posted_refund: 0 } });
  expect(status.getByText(/Nợ hoá đơn.*1\.000/)).toBeTruthy();
  expect(status.getByText(/Chưa hoàn khách.*2\.000/)).toBeTruthy();
  expect(status.queryByText(/3\.000/)).toBeNull();
});
it('shows no hanging item only when loaded settlement and readers agree', () => {
  expect(show().getByText('Không còn khoản nào treo')).toBeTruthy();
});
it('never claims completion while settlement sources are loading, even with cached data', () => {
  const status = show({ statusLoading: true });
  expect(status.getByRole('status').textContent).toContain('Đang tải trạng thái thanh lý');
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it('reports side-load errors instead of treating failed readers as settled', () => {
  const status = show({ sideLoadErrors: ['quyết toán thanh lý'] });
  expect(status.getByRole('alert').textContent).toContain('quyết toán thanh lý');
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it.each([null, undefined])('does not claim completion without a finalized termination: %s', terminationInfo => {
  const status = show({ terminationInfo });
  expect(status.getByText('Chưa chốt quyết toán')).toBeTruthy();
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it('preserves pending forfeit status and prevents a false completed label', () => {
  const status = show({ terminationInfo: { ...termination, termination_type: 'FORFEIT' }, pendingForfeitCount: 2 });
  expect(status.getByText('Phiếu bỏ cọc chờ xử lý (2)')).toBeTruthy();
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it('does not render a returned-contract status for an active contract', () => {
  render(<MemoryRouter><ContractDetailMobile contract={{ ...contract, status: 'ACTIVE' }} services={[]} invoices={[]}
    history={[]} depositVouchers={[]} perms={{}} customers={[]} onBack={noop} onEdit={noop} onPrint={noop} onShowQR={noop}
    onRenew={noop} onTransferRoom={noop} onTransferContract={noop} onMoveOut={noop} onTerminate={noop} onDelete={noop}
    terminationInfo={termination} pendingForfeitCount={0} pendingRefundCount={0} statusLoading={false} sideLoadErrors={[]} /></MemoryRouter>);
  expect(screen.queryByRole('region', { name: 'Trạng thái sau trả phòng' })).toBeNull();
});
