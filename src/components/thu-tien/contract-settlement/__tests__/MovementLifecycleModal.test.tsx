// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettlementRow } from '@/lib/contractSettlement';
import type { MovementRow } from '@/hooks/useContractMovements';

const H = vi.hoisted(() => ({ target: null as unknown }));
vi.mock('@/hooks/useContractLifecycle', () => ({
  useContractLifecycle: () => ({ data: { target: H.target }, isLoading: false, isError: false }),
}));
vi.mock('../ContractLifecycleBand', () => ({ ContractLifecycleBand: () => <div /> }));
import { MovementLifecycleModal } from '../MovementLifecycleModal';

const ev: MovementRow = {
  key: 'movement-a', type: 'sign', date: '2026-09-01', buildingId: 'building-a',
  buildingName: 'Toà A', roomId: 'room-a', roomName: '101', organizationId: 'org-a',
  customer: 'Khách A', source: 'HD-A', origin: 'contract', contractId: 'contract-a',
  description: 'Ký mới', staffName: null,
};
const row = (status: SettlementRow['status'], amount: number, issues: SettlementRow['issues'] = []): SettlementRow => ({
  key: `row-${status}-${amount}`, voucherId: `voucher-${status}-${amount}`,
  kind: 'commission', recipientName: 'Người nhận', amount, status, issues,
} as SettlementRow);
const amounts = () => document.querySelector('.cs-payout')!.textContent;
beforeEach(() => { H.target = null; });
afterEach(cleanup);

describe('khoản chi liên quan của hồ sơ biến động', () => {
  it('còn phải chi chỉ cộng rà soát, chờ duyệt và đã duyệt, loại huỷ/hoàn tác/không ghi quỹ', () => {
    render(<MovementLifecycleModal ev={ev} lienQuan={[
      row('pending', 1_000_000, ['MISSING_PAYMENT_INFO']), row('pending', 2_000_000),
      row('approved', 3_000_000), row('paid', 4_000_000), row('cancelled', 5_000_000),
      row('reversed', 6_000_000), row('noncash', 7_000_000),
    ]} onMoPhieu={vi.fn()} onClose={vi.fn()} />);
    const outstanding = screen.getByText('Còn phải chi').parentElement!;
    expect(outstanding.textContent).toContain('6.000.000 đ');
    expect(amounts()).toContain('4.000.000 đ');
    expect(outstanding.textContent).not.toContain('24.000.000 đ');
  });

  it('phiếu không xác định không được suy là khoản chi bằng không hoặc phải trả', () => {
    render(<MovementLifecycleModal ev={ev} lienQuan={[row('unknown', 9_000_000)]} onMoPhieu={vi.fn()} onClose={vi.fn()} />);
    const outstanding = screen.getByText('Còn phải chi').parentElement!;
    expect(outstanding.textContent).toContain('Chưa xác minh');
    expect(outstanding.textContent).not.toContain('9.000.000 đ');
    expect(outstanding.textContent).not.toContain('0 đ');
  });

  it.each(['loading', 'error'] as const)('nguồn liên quan %s không nói không phát sinh chi và không hiện tổng 0', (readState) => {
    const retry = vi.fn();
    render(<MovementLifecycleModal ev={ev} lienQuan={[]} readState={readState} onRetry={retry} onMoPhieu={vi.fn()} onClose={vi.fn()} />);
    expect(document.body.textContent).not.toContain('Không phát sinh chi');
    expect(document.body.textContent).not.toContain('không kéo theo phiếu chi nào');
    expect(document.querySelector('.cs-m-amt')!.textContent).not.toContain('0 đ');
    expect(amounts()).not.toContain('0 đ');
    if (readState === 'error') {
      fireEvent.click(screen.getByRole('button', { name: 'Thử lại khoản chi liên quan' }));
      expect(retry).toHaveBeenCalledOnce();
    }
  });

  it('đã thanh lý nhưng thiếu ngày không bị in đang hiệu lực', () => {
    H.target = { isTerminated: true, terminatedAt: null, deposit: null, settlementDeposit: null };
    render(<MovementLifecycleModal ev={ev} lienQuan={[]} onMoPhieu={vi.fn()} onClose={vi.fn()} />);
    expect(document.body.textContent).not.toContain('Đang hiệu lực');
    expect(document.body.textContent).toContain('Đã thanh lý · chưa xác minh ngày');
  });
});
