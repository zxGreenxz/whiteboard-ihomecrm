// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InvoiceRoundingReportDialog from '../InvoiceRoundingReportDialog';
import { RoundingReportError } from '@/lib/invoiceRoundingReport';

const fixture = vi.hoisted(() => ({ allowed: true, fail: false, empty: false, filters: [] as unknown[] }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { thu_tien: { report: fixture.allowed } } }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'dddd0000-0000-4000-8000-000000000003', name: 'DEMO' }] }) }));
vi.mock('@/lib/invoiceRoundingReportRepository', () => ({
  getInvoiceRoundingReport: async (filters: { offset?: number; collectorId?: string | null }) => {
    fixture.filters.push(filters);
    if (fixture.fail) throw new RoundingReportError('permission');
    if (fixture.empty) return { rows: [], total_count: 0, invoice_count: 0, total_amount: 0, by_collector: [] };
    return {
      total_count: 51, invoice_count: 49, total_amount: 120000,
      by_collector: [{ collector_id: 'dddd0000-0000-4000-8000-000000000002', collector_name: 'Lan', total_count: 51, invoice_count: 49, total_amount: 120000 }],
      rows: [{ payment_id: null, collection_id: null, invoice_id: 'dddd0000-0000-4000-8000-000000000002',
        invoice_number: filters.offset ? 'HD-TRANG-2' : 'HD-TRANG-1', building_id: 'dddd0000-0000-4000-8000-000000000003', building_name: 'DEMO', room_name: '305',
        billing_month: '2026-09', collection_date: '2026-09-08', collector_id: null, collector_name: null,
        gross_amount: null, change_amount: null, applied_amount: 4800000, rounding_amount: 5000, reason: 'LEGACY' }],
    };
  },
}));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (!fixture.allowed) client.setQueryData(['invoice-rounding-report', { billingMonth: '2026-09', collectorId: '', buildingId: '', offset: 0, limit: 50 }], { rows: [], total_amount: 999999, total_count: 1, invoice_count: 1, by_collector: [] });
  return render(<QueryClientProvider client={client}><InvoiceRoundingReportDialog open onOpenChange={() => {}} billingMonth="2026-09" /></QueryClientProvider>);
}

describe('InvoiceRoundingReportDialog', () => {
  beforeEach(() => { fixture.allowed = true; fixture.fail = false; fixture.empty = false; fixture.filters = []; });
  afterEach(cleanup);

  it('shows server totals, unknown historical amounts, then pages without recomputing totals', async () => {
    mount();
    await screen.findByText('HD-TRANG-1');
    expect(within(screen.getByLabelText('Tổng khoản bỏ qua')).getByText(/120.000/)).toBeTruthy();
    expect(within(screen.getByLabelText('Số hóa đơn có khoản bỏ qua')).getByText('49')).toBeTruthy();
    expect(screen.getByText('Dữ liệu cũ')).toBeTruthy();
    expect(screen.getAllByText('Không rõ').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    await screen.findByText('HD-TRANG-2');
    expect(screen.queryByText('HD-TRANG-1')).toBeNull();
    expect(within(screen.getByLabelText('Tổng khoản bỏ qua')).getByText(/120.000/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Người thu'), { target: { value: 'dddd0000-0000-4000-8000-000000000002' } });
    await screen.findByText('HD-TRANG-1');
    expect(fixture.filters[fixture.filters.length - 1]).toMatchObject({ offset: 0, collectorId: 'dddd0000-0000-4000-8000-000000000002' });
  });

  it('resets pagination on period and building changes', async () => {
    mount();
    await screen.findByText('HD-TRANG-1');
    fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    await screen.findByText('HD-TRANG-2');
    fireEvent.change(screen.getByLabelText('Kỳ hóa đơn'), { target: { value: '2026-10' } });
    await waitFor(() => expect(fixture.filters[fixture.filters.length - 1]).toMatchObject({ offset: 0, billingMonth: '2026-10' }));
    fireEvent.change(screen.getByLabelText('Tòa'), { target: { value: 'dddd0000-0000-4000-8000-000000000003' } });
    await waitFor(() => expect(fixture.filters[fixture.filters.length - 1]).toMatchObject({ offset: 0, buildingId: 'dddd0000-0000-4000-8000-000000000003' }));
  });

  it('does not fetch or reveal cached report data without report permission', async () => {
    fixture.allowed = false;
    mount();
    expect(screen.queryByLabelText('Tổng khoản bỏ qua')).toBeNull();
    expect(fixture.filters).toHaveLength(0);
  });

  it('shows permission failure distinctly from an empty report', async () => {
    fixture.fail = true;
    mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('không có quyền');
    expect(screen.queryByText('Không có khoản bỏ qua trong phạm vi đã chọn.')).toBeNull();
  });

  it('shows zero totals only for a successful empty report', async () => {
    fixture.empty = true;
    mount();
    await screen.findByText('Không có khoản bỏ qua trong phạm vi đã chọn.');
    expect(within(screen.getByLabelText('Tổng khoản bỏ qua')).getByText('0 đ')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trang sau' }).hasAttribute('disabled')).toBe(true);
  });
});
