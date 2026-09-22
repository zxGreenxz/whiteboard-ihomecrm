// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SettlementRow } from '@/lib/contractSettlement';

const H = vi.hoisted(() => ({
  lifecycle: { data: null as unknown, isLoading: true, isError: false, refetch: vi.fn() },
  refund: { data: null as unknown, isLoading: true, isError: false, refetch: vi.fn() },
  commission: { data: null as unknown, isLoading: false, isError: false, refetch: vi.fn() },
}));
vi.mock('@/hooks/useContractLifecycle', () => ({ useContractLifecycle: () => H.lifecycle }));
vi.mock('@/hooks/useTerminationRefundFacts', () => ({ useTerminationRefundFacts: () => H.refund }));
vi.mock('@/hooks/useCommissionVoucher', () => ({ useCommissionVoucherFacts: () => H.commission }));
import { ContractLifecycleBand } from '../ContractLifecycleBand';
import { SettlementVoucherDetails } from '../SettlementVoucherDetails';

const bandProps = {
  organizationId: 'org-a', contractId: 'contract-a', roomId: 'room-a', businessDate: '2026-09-01',
  subject: { kind: 'voucher', voucherKind: 'refund' } as const,
  sourceLabel: 'Phiếu', sourceText: 'PC-A',
};
const row = {
  voucherId: 'voucher-a', contractId: 'contract-a', kind: 'refund', systemSource: 'termination.refund',
  commissionKind: null, basis: { kind: 'not-applicable' },
} as SettlementRow;
beforeEach(() => {
  H.lifecycle = { data: null, isLoading: true, isError: false, refetch: vi.fn() };
  H.refund = { data: null, isLoading: true, isError: false, refetch: vi.fn() };
  H.commission = { data: null, isLoading: false, isError: false, refetch: vi.fn() };
});
afterEach(cleanup);

it('dải vòng đời báo loading/error và retry; báo cáo thiếu một phần vẫn là insufficient', () => {
  const changed = vi.fn();
  const { rerender } = render(<ContractLifecycleBand {...bandProps} onReadStateChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith('loading');
  H.lifecycle.isLoading = false;
  H.lifecycle.isError = true;
  rerender(<ContractLifecycleBand {...bandProps} onReadStateChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith('error');
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại lịch sử hợp đồng' }));
  expect(H.lifecycle.refetch).toHaveBeenCalledOnce();
  H.lifecycle.isError = false;
  H.lifecycle.data = {
    lanes: [], roomState: { label: 'Chưa xác minh' }, status: {
      lanes: { kind: 'sufficient' }, deposit: { kind: 'sufficient' }, rent: { kind: 'sufficient' },
      postings: { kind: 'insufficient', reason: 'Chưa đối chiếu được bút toán' },
    },
  };
  rerender(<ContractLifecycleBand {...bandProps} onReadStateChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith('insufficient');
  expect(document.body.textContent).toContain('Chưa đối chiếu được bút toán');
});

it.each(['refund', 'commission'] as const)('bảng căn cứ %s báo lỗi thật và retry đúng nguồn, trả rỗng báo insufficient', (source) => {
  const currentRow = source === 'refund' ? row : { ...row, kind: 'commission' as const, commissionKind: 'broker' };
  H[source].isLoading = true;
  const changed = vi.fn();
  const { rerender } = render(<SettlementVoucherDetails row={currentRow} onReadStateChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith('loading');
  H[source].isLoading = false;
  H[source].isError = true;
  rerender(<SettlementVoucherDetails row={currentRow} onReadStateChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith('error');
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại căn cứ' }));
  expect(H[source].refetch).toHaveBeenCalledOnce();
  expect(H[source === 'refund' ? 'commission' : 'refund'].refetch).not.toHaveBeenCalled();
  H[source].isError = false;
  rerender(<SettlementVoucherDetails row={currentRow} onReadStateChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith('insufficient');
  expect(document.body.textContent).toContain('Chưa kết luận được');
});
