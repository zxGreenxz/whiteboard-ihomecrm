// @vitest-environment jsdom
// Hộp "Đổi hình thức thu" (đợt 1 sửa phiếu, 25/09/2026): sổ theo NGƯỜI ĐÃ THU,
// chặn khoản có tiền thối / làm tròn, bắt lý do ≥ 8 ký tự, gọi đúng tham số.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import ChangeCollectionMethodDialog from '../ChangeCollectionMethodDialog';
import type { ChangeCollectionMethodTender } from '@/hooks/useCollectionTenders';

const mocks = vi.hoisted(() => ({
  doiHinhThuc: vi.fn(),
  docSoNhan: vi.fn(),
  pending: false,
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/useReceivingCashbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useReceivingCashbooks')>();
  return {
    ...actual,
    useReceivingCashbooks: (...args: unknown[]) => mocks.docSoNhan(...args),
    useChangeCollectionTenderMethod: () => ({ mutateAsync: mocks.doiHinhThuc, isPending: mocks.pending }),
  };
});
// Radix Select mở trong jsdom theo kiểu "item-aligned" (cùng mẹo với BulkRecordPaymentDialog test).
vi.mock('@/components/ui/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/select')>();
  return {
    ...actual,
    SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => (
      <actual.SelectContent {...props} position="item-aligned" />
    ),
  };
});

const SO_NHAN = {
  collectorUserId: 'nathan',
  personalCashBook: { id: 'hiep-thu', name: 'Hiệp Thu' },
  TK: [
    { id: 'mbhiep', name: 'MBHIEP', isDefault: true },
    { id: 'tkhiep', name: 'TKHIEP', isDefault: false },
  ],
  TT: [],
};

const TENDER: ChangeCollectionMethodTender = {
  id: 'tender-1',
  paymentMethod: 'TK',
  accountId: 'mbhiep',
  accountName: 'MBHIEP',
  amount: 3_500_000,
  changeAmount: 0,
  roundingAmount: 0,
  collectorUserId: 'nathan',
  buildingId: 'toa-403',
  buildingName: '403PVB',
};

const onOpenChange = vi.fn();
const onChanged = vi.fn();

function renderDialog(tender: ChangeCollectionMethodTender = TENDER) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <ChangeCollectionMethodDialog
      open
      onOpenChange={onOpenChange}
      organizationId="org-1"
      tender={tender}
      onChanged={onChanged}
    />,
    { wrapper: wrap },
  );
}

const nutDoi = () => screen.getByRole('button', { name: 'Đổi hình thức thu' }) as HTMLButtonElement;
const oLyDo = () => screen.getByLabelText('Lý do đổi *') as HTMLTextAreaElement;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
  mocks.docSoNhan.mockReturnValue({ data: SO_NHAN, isError: false, error: null });
  mocks.doiHinhThuc.mockResolvedValue({ tenderId: 'tender-1', voucherId: 'v1', changed: true });
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

describe('ChangeCollectionMethodDialog', () => {
  it('đọc danh sách sổ của NGƯỜI ĐÃ THU và hiện hình thức + sổ hiện tại', () => {
    renderDialog();
    expect(mocks.docSoNhan).toHaveBeenCalledWith('org-1', 'toa-403', 'nathan');
    expect(screen.getByText('Chuyển khoản · MBHIEP')).toBeTruthy();
    expect(screen.getByText('3.500.000 đ')).toBeTruthy();
    // Chưa đổi gì + chưa có lý do ⇒ chưa cho bấm.
    expect(nutDoi().disabled).toBe(true);
  });

  it('khoản có tiền thối: báo không đổi được, khoá mọi ô, không đọc sổ', () => {
    renderDialog({ ...TENDER, paymentMethod: 'TM', changeAmount: 50_000 });
    expect(screen.getByText('Khoản thu có tiền thối nên không đổi hình thức được.')).toBeTruthy();
    expect(mocks.docSoNhan).toHaveBeenCalledWith(null, 'toa-403', 'nathan');
    expect((screen.getByRole('radio', { name: 'Chuyển khoản' }) as HTMLButtonElement).disabled).toBe(true);
    expect(oLyDo().disabled).toBe(true);
    expect(nutDoi().disabled).toBe(true);
  });

  it('khoản có làm tròn cũng không đổi được', () => {
    renderDialog({ ...TENDER, roundingAmount: 3_000 });
    expect(screen.getByText('Khoản thu có làm tròn nên không đổi hình thức được.')).toBeTruthy();
    expect(nutDoi().disabled).toBe(true);
  });

  it('bắt lý do ít nhất 8 ký tự', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'Tiền mặt' }));
    fireEvent.change(oLyDo(), { target: { value: '  ngắn  ' } });
    expect(nutDoi().disabled).toBe(true);
    expect(screen.getByText(/còn thiếu/)).toBeTruthy();
    fireEvent.change(oLyDo(), { target: { value: 'Khách đưa tiền mặt' } });
    expect(nutDoi().disabled).toBe(false);
  });

  it('đổi sang Tiền mặt: gửi đúng dòng thu, hình thức, sổ tiền mặt riêng và lý do', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'Tiền mặt' }));
    expect(screen.getByLabelText('Sổ nhận').textContent).toBe('Hiệp Thu');
    fireEvent.change(oLyDo(), { target: { value: '  Khách đưa tiền mặt tại quầy  ' } });
    fireEvent.click(nutDoi());
    await waitFor(() => expect(mocks.doiHinhThuc).toHaveBeenCalledTimes(1));
    expect(mocks.doiHinhThuc).toHaveBeenCalledWith({
      tenderId: 'tender-1',
      method: 'TM',
      accountId: 'hiep-thu',
      reason: 'Khách đưa tiền mặt tại quầy',
      idempotencyKey: expect.stringMatching(/^tender-method:/),
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('đổi sổ trong cùng hình thức (MBHIEP → TKHIEP)', async () => {
    renderDialog();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sổ nhận' }), { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'TKHIEP' }), { key: 'Enter' });
    fireEvent.change(oLyDo(), { target: { value: 'Khách chuyển vào TKHIEP' } });
    fireEvent.click(nutDoi());
    await waitFor(() => expect(mocks.doiHinhThuc).toHaveBeenCalledTimes(1));
    expect(mocks.doiHinhThuc.mock.lastCall?.[0]).toMatchObject({ method: 'TK', accountId: 'tkhiep' });
  });

  it('hình thức chưa có sổ: báo câu hướng dẫn, không cho đổi', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'Thanh toán' }));
    expect(
      screen.getByText(
        'Người thu chưa dùng được sổ nhận Thanh toán nào của toà 403PVB: toà chưa cài sổ, ' +
          'hoặc người thu chưa được giao giữ/biết sổ đó — nhờ chủ công ty kiểm ở Sổ quỹ → Sổ nhận tiền.',
      ),
    ).toBeTruthy();
    fireEvent.change(oLyDo(), { target: { value: 'Khách thanh toán qua cổng' } });
    expect(nutDoi().disabled).toBe(true);
  });

  it('không biết người đã thu thì không đoán sổ', () => {
    renderDialog({ ...TENDER, collectorUserId: null });
    expect(mocks.docSoNhan).toHaveBeenCalledWith(null, 'toa-403', null);
    expect(screen.getByText(/Chưa xác định được người đã thu/)).toBeTruthy();
    expect(nutDoi().disabled).toBe(true);
  });

  it('máy chủ từ chối: giữ hộp mở để sửa', async () => {
    mocks.doiHinhThuc.mockRejectedValue(new Error('Sổ "X" không nằm trong danh sách'));
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'Tiền mặt' }));
    fireEvent.change(oLyDo(), { target: { value: 'Khách đưa tiền mặt' } });
    fireEvent.click(nutDoi());
    await waitFor(() => expect(mocks.doiHinhThuc).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
