// @vitest-environment jsdom
// Thanh toán hàng loạt (đợt 1 sửa phiếu, 25/09/2026): mỗi hình thức vào đúng sổ
// nhận do máy chủ cho phép; hình thức chưa có sổ ⇒ chặn; phòng vừa được thu cùng
// số tiền trong 30 phút ⇒ hỏi lại trước khi ghi.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BulkRecordPaymentDialog from '../BulkRecordPaymentDialog';

const mocks = vi.hoisted(() => ({
  ghi: vi.fn(),
  toast: vi.fn(),
  recent: vi.fn(),
  soNhan: {
    collectorUserId: 'collector',
    personalCashBook: { id: 'hiep-thu', name: 'Hiệp Thu' } as { id: string; name: string } | null,
    TK: [] as Array<{ id: string; name: string; isDefault?: boolean }>,
    TT: [] as Array<{ id: string; name: string; isDefault?: boolean }>,
  },
}));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { invoices: { record_payment: true } } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'building', name: 'DEMO', organization_id: 'org' }] }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'collector' } }) }));
vi.mock('@/hooks/useBulkRecordPayment', () => ({ useBulkRecordPayment: () => ({ mutateAsync: mocks.ghi }) }));
vi.mock('@/hooks/useReceivingCashbooks', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/useReceivingCashbooks')>();
  return { ...actual, useReceivingCashbooks: () => ({ data: mocks.soNhan, isError: false, error: null }) };
});
vi.mock('@/hooks/useCollectionTenders', () => ({ fetchRecentInvoiceCollections: mocks.recent }));
vi.mock('@/hooks/useClipboardImagePaste', () => ({ useClipboardImagePaste: () => ({}) }));
vi.mock('@/hooks/useInvoices', () => ({ useInvoice: () => ({ data: undefined }) }));
vi.mock('../EditInvoiceDialog', () => ({ default: () => null }));
vi.mock('../PaymentsSummaryDialog', () => ({ default: () => null }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const rows = [{ id: 'invoice', invoice_number: 'DEMO-001', room_id: 'room', room: { name: 'P101' }, status: 'APPROVED', total_amount: 1000000, paid_amount: 0, remaining_amount: 1000000 }];
  const builder = { select: () => builder, eq: () => builder, in: () => builder, gt: () => builder, is: async () => ({ data: rows, error: null }) };
  return builder;
} } }));
vi.mock('@/components/ui/select', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/ui/select')>();
  return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position="item-aligned" /> };
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.soNhan.personalCashBook = { id: 'hiep-thu', name: 'Hiệp Thu' };
  mocks.soNhan.TK = [];
  mocks.soNhan.TT = [];
  mocks.ghi.mockResolvedValue({ ok: ['invoice'], failures: [] });
  mocks.recent.mockResolvedValue([]);
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

/** Chọn toà, tải dòng, gõ tiền vào ô TM (hoặc TK) của phòng P101. */
async function nhapTien(cot: 'TM' | 'TK', tien: string) {
  render(<BulkRecordPaymentDialog open onOpenChange={() => {}} />);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'DEMO' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' }));
  const dong = (await screen.findByText('P101')).closest('tr') as HTMLElement;
  // Thứ tự ô số trong dòng: TM, TT, TK, Tiền thối, Ghi chú.
  const o = within(dong).getAllByRole('textbox');
  fireEvent.change(o[cot === 'TM' ? 0 : 2], { target: { value: tien } });
}

it('tiền mặt vào sổ tiền mặt riêng của người thu (bảng sổ theo hình thức)', async () => {
  await nhapTien('TM', '1.000.000');
  fireEvent.click(screen.getByRole('button', { name: /Ghi nhận 1 thanh toán/ }));
  await waitFor(() => expect(mocks.ghi).toHaveBeenCalledTimes(1));
  expect(mocks.ghi.mock.lastCall?.[0].items[0]).toMatchObject({
    invoice_id: 'invoice',
    amount_tm: 1_000_000,
    account_id: 'hiep-thu',
    accounts: { TM: 'hiep-thu' },
  });
});

it('chuyển khoản ở toà chưa cài sổ: chặn, báo câu hướng dẫn, không ghi', async () => {
  await nhapTien('TK', '1.000.000');
  fireEvent.click(screen.getByRole('button', { name: /Ghi nhận 1 thanh toán/ }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Thiếu sổ nhận tiền',
    description:
      'Người thu chưa dùng được sổ nhận Chuyển khoản nào của toà DEMO: toà chưa cài sổ, ' +
      'hoặc người thu chưa được giao giữ/biết sổ đó — nhờ chủ công ty kiểm ở Sổ quỹ → Sổ nhận tiền.',
  })));
  expect(mocks.ghi).not.toHaveBeenCalled();
});

it('chuyển khoản vào sổ mặc định của toà', async () => {
  mocks.soNhan.TK = [{ id: 'mbhiep', name: 'MBHIEP', isDefault: true }, { id: 'tkhiep', name: 'TKHIEP' }];
  await nhapTien('TK', '1.000.000');
  fireEvent.click(screen.getByRole('button', { name: /Ghi nhận 1 thanh toán/ }));
  await waitFor(() => expect(mocks.ghi).toHaveBeenCalledTimes(1));
  expect(mocks.ghi.mock.lastCall?.[0].items[0]).toMatchObject({ amount_tk: 1_000_000, accounts: { TK: 'mbhiep' } });
});

it('phòng vừa được thu cùng số tiền trong 30 phút: hỏi lại rồi mới ghi', async () => {
  mocks.recent.mockResolvedValue([{
    id: 'c1', invoice_id: 'invoice', status: 'ACTIVE', actor_id: 'x', gross_amount: 1_000_000,
    created_at: new Date(Date.now() - 60_000).toISOString(), collector_name: 'Hiển',
  }]);
  await nhapTien('TM', '1.000.000');
  fireEvent.click(screen.getByRole('button', { name: /Ghi nhận 1 thanh toán/ }));
  expect(await screen.findByText(/P101: 1\.000\.000 đ lúc \d\d:\d\d bởi Hiển/)).toBeTruthy();
  expect(mocks.ghi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Vẫn thu tiếp' }));
  await waitFor(() => expect(mocks.ghi).toHaveBeenCalledTimes(1));
  expect(mocks.recent).toHaveBeenCalledTimes(1);
});
