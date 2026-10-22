// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReservationDepositRow } from '@/hooks/useDeposits';
import type { HoldDeadlineTarget } from '@/components/deposits/HoldDeadlineDialog';

const state = vi.hoisted(() => ({
  reservations: [] as ReservationDepositRow[],
  terms: {} as Record<string, { holdUntil: string | null; topupDueDate: string | null; depositTarget: number | null }>,
  editBuildings: ['b1'],
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('@/hooks/use-mobile', () => ({ usePhoneViewport: () => false }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => createElement('a', { href: to }, children),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/hooks/usePersistedState', () => ({ usePersistedState: <T,>(_key: string, initial: T) => useState(initial) }));
vi.mock('@/hooks/useMyPermissions', () => ({
  useMyPermissions: () => ({ data: { deposits: { edit: { org_wide: false, building_ids: state.editBuildings }, convert: true } } }),
}));
vi.mock('@/hooks/income-expenses/statusMutations', () => ({ useApproveVoucher: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/useDepositDashboard', async original => ({
  ...(await original<typeof import('@/hooks/useDepositDashboard')>()),
  useHeldDeposits: () => ({ data: [], isLoading: false }),
  useDepositRefundsForfeits: () => ({ data: [], isLoading: false }),
  useHeldDepositSummary: () => ({ data: [] }),
  useRefundForfeitSummary: () => ({ data: {} }),
  useReservationDepositSettlementSummary: () => ({ data: {} }),
}));
vi.mock('@/hooks/useDeposits', () => ({
  useReservationDeposits: () => ({ data: state.reservations, isLoading: false }),
  useReservationDepositSummary: () => ({ data: {} }),
}));
vi.mock('@/hooks/useReservationHoldDeadlines', () => ({ useReservationHoldDeadlines: () => ({ data: state.terms }) }));
vi.mock('@/components/errors/QueryRegion', () => ({ QueryRegion: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/buildings/BuildingFilterSelect', () => ({ BuildingFilterSelect: () => null }));
vi.mock('@/components/deposits/CreateDepositDialog', () => ({ CreateDepositDialog: () => null }));
vi.mock('@/components/contracts/ContractFormDialog', () => ({ ContractFormDialog: () => null }));
vi.mock('@/components/deposits/RoomReservationPanel', () => ({ RoomReservationPanel: () => null }));
vi.mock('@/components/deposits/RoomSaleLocksPanel', () => ({ RoomSaleLocksPanel: () => null }));
vi.mock('@/components/deposits/ReservationPendingRefundList', () => ({ ReservationPendingRefundList: () => null }));
vi.mock('@/components/deposits/ReservationSettlementDialog', () => ({ ReservationSettlementDialog: () => null }));
vi.mock('@/components/deposits/HoldDeadlineDialog', () => ({
  HoldDeadlineDialog: ({ target }: { target: HoldDeadlineTarget | null }) => target
    ? <output data-testid="deadline-target">{JSON.stringify(target)}</output> : null,
}));
import DepositsPage from '../DepositsPage';
import DepositsMobilePage from '../DepositsMobilePage';

function voucher(facts: Partial<ReservationDepositRow> = {}): ReservationDepositRow {
  return {
    id: 'v1', code: 'PT-1', name: 'Phiếu cọc', payer_name: 'Khách A', total_amount: 2_000_000,
    voucher_date: '2026-01-01', approval_status: 'APPROVED', approval_version: 1,
    building_id: 'b1', building_name: 'Tòa A', room_id: 'r1', room_name: '101',
    settlement_status: 'UNSETTLED', settlement: null, reservation_id: 'reservation-1',
    received_amount: 0, received_fact_status: 'VERIFIED', ...facts,
  };
}
beforeEach(() => {
  state.reservations = [voucher()];
  state.editBuildings = ['b1'];
  state.terms = { v1: { holdUntil: '2026-01-02', topupDueDate: null, depositTarget: 5_000_000 } };
});
afterEach(cleanup);

describe.each([
  ['desktop', DepositsPage],
  ['mobile', DepositsMobilePage],
] as const)('queue thực nhận → kỳ hạn %s', (mode, Component) => {
  function openTask(container: HTMLElement) {
    if (mode === 'mobile') fireEvent.click(container.querySelector('button.dp-card')!);
  }
  it.each([
    { status: 'VERIFIED' as const, received: 0, paid: 0 },
    { status: 'UNKNOWN' as const, received: undefined, paid: null },
  ])('quá hạn giữ chỗ truyền $paid vào dialog, không thay bằng mệnh giá 2 triệu', ({ status, received, paid }) => {
    state.reservations = [voucher({ received_fact_status: status, received_amount: received })];
    const { container } = render(<Component />);
    openTask(container);
    fireEvent.click(screen.getByRole('button', { name: 'Sửa kỳ hạn' }));
    const target = JSON.parse(screen.getByTestId('deadline-target').textContent!);
    expect(target).toMatchObject({ voucherId: 'v1', buildingId: 'b1', paidAmount: paid, receivedFactStatus: status });
    expect(target.paidAmount).not.toBe(2_000_000);
  });
  it('thẻ chờ nhận mở được phiếu và đặt kỳ hạn đúng tòa, không gắn nút ký hợp đồng', () => {
    state.terms = {};
    const { container } = render(<Component />);
    openTask(container);
    expect(screen.getByRole('link', { name: 'Mở phiếu' }).getAttribute('href')).toBe('/income-expense/voucher/v1');
    expect(screen.queryByRole('button', { name: 'Tạo hợp đồng' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Đặt kỳ hạn' }));
    expect(JSON.parse(screen.getByTestId('deadline-target').textContent!).paidAmount).toBe(0);
  });
  it('thẻ chờ thực nhận gọi đúng hạn làm hợp đồng và mục tiêu cọc của hồ sơ giữ chỗ', () => {
    state.terms.v1.holdUntil = '2099-01-02';
    const { container } = render(<Component />);
    openTask(container);
    if (mode === 'mobile') {
      expect(screen.getByText('Cọc cần đủ')).toBeTruthy();
      expect(screen.queryByText('Cọc theo hợp đồng')).toBeNull();
      expect(screen.getByText('Hạn phải làm hợp đồng')).toBeTruthy();
    } else {
      expect(screen.getByText(/hạn làm HĐ 02\/01/)).toBeTruthy();
    }
  });
  it('có edit ở tòa B không được mở kỳ hạn tòa A; mất quyền khi đang mở thì form đóng', () => {
    const { container, rerender } = render(<Component />);
    openTask(container);
    fireEvent.click(screen.getByRole('button', { name: 'Sửa kỳ hạn' }));
    expect(screen.getByTestId('deadline-target')).toBeTruthy();
    state.editBuildings = ['b2'];
    rerender(<Component />);
    expect(screen.queryByTestId('deadline-target')).toBeNull();
    if (mode === 'mobile') openTask(container);
    expect(screen.queryByRole('button', { name: 'Sửa kỳ hạn' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Mở phiếu' })).toBeTruthy();
  });
});
