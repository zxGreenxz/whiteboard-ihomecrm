// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { InvoiceDetailMobile } from '../InvoiceDetailMobile';
import type { InvoiceWithRelations } from '@/types/invoice';

vi.mock('@/hooks/useInvoices', () => ({
  useReviewInvoiceAdjustment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useInvoice: () => ({ refetch: vi.fn() }),
}));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/storage', () => ({ createSignedUrlFromStored: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

const savedInvoice: InvoiceWithRelations = {
  id: 'invoice-september', user_id: 'user', contract_id: 'contract', building_id: 'building', room_id: 'room',
  invoice_number: 'INV-2026-09-303', kind: 'MONTHLY', billing_month: '2026-09',
  issue_date: '2026-09-01', due_date: '2026-09-10', paid_date: '2026-09-17', status: 'PAID',
  subtotal: 2_480_000, discount_amount: 300_000, total_amount: 2_180_000, prepaid_amount: 0,
  paid_amount: 2_180_000, remaining_amount: 0, previous_debt: 0, previous_debt_sources: [],
  notes: 'Hoá đơn tiền phòng đầu tiên',
  discount_notes: 'Giảm trừ 300k/tháng cho tháng 9, 10, 11\nGiảm trừ 100k/tháng từ tháng 12',
  electricity_prev_overridden: false, template_id: null, approved_at: null, approved_by: null,
  creator_name: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-17T00:00:00Z', deleted_at: null,
  invoice_items: [{
    id: 'rent', invoice_id: 'invoice-september', service_id: null, type: 'RENT', accounting_class: 'REVENUE',
    description: 'Tiền phòng', unit_price: 2_480_000, quantity: 1, coefficient: 1, amount: 2_480_000,
    previous_reading: null, current_reading: null, from_date: null, to_date: null, sort_order: 0,
    created_at: '2026-09-01T00:00:00Z',
  }],
  payments: [], invoice_adjustments: [],
};
const noop = () => {};
function renderInvoice(invoice = savedInvoice) {
  return render(<InvoiceDetailMobile invoice={invoice} relatedVouchers={[]} onBack={noop}
    showPay={false} payIsRefund={false} onRecordPayment={noop} showEdit={false} onEdit={noop}
    showCancel={false} onCancel={noop} showRestore={false} onRestore={noop} showQR={false} onShowQR={noop} />);
}
afterEach(cleanup);

it('shows the saved discount explanation when reopening a paid invoice on mobile', () => {
  renderInvoice();
  const discountRow = screen.getByText('Giảm trừ').closest('.invitem') as HTMLElement;
  expect(within(discountRow).getByText(/Giảm trừ 300k\/tháng cho tháng 9, 10, 11/).textContent)
    .toBe(savedInvoice.discount_notes);
  expect(within(discountRow).getByText('−300.000')).toBeTruthy();
  expect(screen.getByText('Hoá đơn tiền phòng đầu tiên')).toBeTruthy();
  const totalRow = screen.getByText('Tổng cộng').parentElement as HTMLElement;
  expect(within(totalRow).getByText('2.180.000')).toBeTruthy();
});

it('keeps a discount without notes visible without inventing an explanation', () => {
  renderInvoice({ ...savedInvoice, discount_notes: null });
  const discountRow = screen.getByText('Giảm trừ').closest('.invitem') as HTMLElement;
  expect(within(discountRow).getByText('−300.000')).toBeTruthy();
  expect(screen.queryByText(/Giảm trừ 300k\/tháng/)).toBeNull();
  expect(screen.getByText('Hoá đơn tiền phòng đầu tiên')).toBeTruthy();
});
