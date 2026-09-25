// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { IncomeExpenseDetailDialog } from '../IncomeExpenseDetailDialog';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';

const state = vi.hoisted(() => ({ data: null as unknown, error: null as Error | null, isSuccess: true, isLoading: false }));
vi.mock('@/hooks/useReservationSettlement', async () => {
  const React = await import('react');
  return { useReservationSettlementForVoucher: () => { React.useState(0); return state; } };
});
vi.mock('@/hooks/useIncomeExpenses', () => ({ useIncomeExpenseHistory: () => ({ data: [] }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: true }), useIsSuperAdmin: () => ({ data: true }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { __superadmin: true } }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'owner' } }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/income-expenses/PayViaBankAppSheet', () => ({ PayViaBankAppSheet: () => null }));
vi.mock('@/components/deposits/ReservationSettlementDialog', () => ({ ReservationSettlementDialog: () => null }));

const source = {
  id: '00000000-0000-4000-8000-000000000001', type: 'INCOME', name: 'Cọc thử', code: 'PT-TEST',
  approval_status: 'APPROVED', total_amount: 3000000, user_id: 'owner',
  contract_id: null, invoice_id: null, system_source: null, attachments: [],
  items: [{ id: 'item', is_deposit: true, amount: 3000000, quantity: 1, unit_price: 3000000 }],
} as unknown as IncomeExpenseWithRelations;

function fixture(voucher: IncomeExpenseWithRelations | null, client: QueryClient) {
  return <QueryClientProvider client={client}><MemoryRouter><IncomeExpenseDetailDialog
    open={!!voucher} voucher={voucher} onOpenChange={() => {}}
    onEdit={() => {}} onQuickEdit={() => {}} onCancel={() => {}} onUnapprove={() => {}}
  /></MemoryRouter></QueryClientProvider>;
}
afterEach(() => { cleanup(); state.data = null; state.error = null; state.isSuccess = true; state.isLoading = false; });

describe('reservation voucher detail lifecycle', () => {
  it('admin, phiếu đã duyệt: chỉ còn Bổ sung chứng từ — "Sửa phiếu (Super Admin)" đã bỏ (đợt 1 sửa phiếu)', () => {
    render(fixture(source, new QueryClient()));
    const supplement = screen.getByRole('button', { name: 'Bổ sung chứng từ / ghi chú' });
    expect(supplement.querySelector('svg')?.classList.contains('lucide-file-plus2')).toBe(true);
    expect(screen.queryByTitle('Sửa phiếu (Super Admin)')).toBeNull();
    expect(screen.queryByTitle('Sửa phiếu chờ duyệt')).toBeNull();
  });
  it('phiếu cọc Chờ duyệt: nút sửa riêng, tách khỏi Bổ sung chứng từ', () => {
    render(fixture({ ...source, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED' }, new QueryClient()));
    const edit = screen.getByTitle('Sửa phiếu chờ duyệt');
    expect(edit.querySelector('svg')?.classList.contains('lucide-pencil')).toBe(true);
    expect(screen.getByRole('button', { name: 'Bổ sung chứng từ / ghi chú' })).toBeTruthy();
  });
  it('opens and closes from a null voucher without changing hook order', () => {
    const client = new QueryClient();
    const view = render(fixture(null, client));
    expect(() => view.rerender(fixture(source, client))).not.toThrow();
    expect(screen.getByText('PT-TEST')).toBeTruthy();
    expect(() => view.rerender(fixture(null, client))).not.toThrow();
  });
  it.each(['reservation.forfeit_revenue', 'reservation.forfeit_offset', 'reservation.refund'])('hides generic money actions for %s', system_source => {
    render(fixture({ ...source, system_source, type: system_source.endsWith('revenue') ? 'INCOME' : 'EXPENSE', items: [] }, new QueryClient()));
    expect(screen.queryByTitle('Huỷ phiếu')).toBeNull();
    expect(screen.queryByTitle(/Huỷ duyệt/)).toBeNull();
    expect(screen.queryByTitle('Sửa phiếu chờ duyệt')).toBeNull();
    expect(screen.getByRole('button', { name: 'Bổ sung chứng từ / ghi chú' })).toBeTruthy();
  });
  it('does not offer money actions when settlement lookup failed', () => {
    state.error = new Error('lookup failed'); state.isSuccess = false;
    render(fixture(source, new QueryClient()));
    expect(screen.queryByTitle('Huỷ phiếu')).toBeNull();
    expect(screen.queryByTitle(/Huỷ duyệt/)).toBeNull();
    expect(screen.queryByTitle('Sửa phiếu chờ duyệt')).toBeNull();
  });
  it('tra cứu xử lý cọc lỗi thì phiếu Chờ duyệt cũng không mời sửa', () => {
    state.error = new Error('lookup failed'); state.isSuccess = false;
    render(fixture({ ...source, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED' }, new QueryClient()));
    expect(screen.queryByTitle('Sửa phiếu chờ duyệt')).toBeNull();
  });
});
