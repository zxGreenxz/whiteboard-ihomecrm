// @vitest-environment jsdom
// Hộp huỷ dùng chung (E6): lý do 8..1000, không chép câu hệ thống, LUÔN gửi trạng thái đang thấy;
// phiếu vừa đổi trạng thái (PT409) ⇒ hiện trạng thái mới, lần bấm sau gửi đúng trạng thái mới.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rpc: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-a' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc } }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, info: m.toastInfo, error: vi.fn(), warning: vi.fn() } }));

import { ProfitPayoutCancelDialog } from '../ProfitPayoutCancelDialog';
import { PROFIT_FORM_MESSAGES } from '@/lib/profitLedger/forms';
import type { ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';

const target = (over: Partial<ProfitPayoutCancelTarget> = {}): ProfitPayoutCancelTarget => ({
  voucherId: 'v1', organizationId: 'org-a', kind: 'SHAREHOLDER', code: 'PC2611999', amount: 500_000,
  approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED', subjectName: 'Cổ đông 1', accountName: 'Quỹ tiền mặt', ...over,
});
const renderDialog = (t: ProfitPayoutCancelTarget, extra: { onCancelled?: () => void; onOpenChange?: () => void } = {}) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<ProfitPayoutCancelDialog open target={t} onOpenChange={extra.onOpenChange ?? vi.fn()} onCancelled={extra.onCancelled} />, { wrapper: wrap });
};
const reason = () => document.querySelector('[name="reason"]') as HTMLTextAreaElement;
const huy = () => screen.getByRole('button', { name: 'Huỷ phiếu' }) as HTMLButtonElement;

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);

describe('ProfitPayoutCancelDialog', () => {
  it('câu khác nhau theo trạng thái: đã chi (đảo về sổ) / đã duyệt chưa chi / chờ duyệt', () => {
    const posted = renderDialog(target({ approvalStatus: 'APPROVED', postingStatus: 'POSTED' }));
    expect(screen.getByTestId('profit-cancel-effect').textContent).toMatch(/bút toán đảo, tiền về sổ Quỹ tiền mặt/);
    posted.unmount();
    const approved = renderDialog(target({ approvalStatus: 'APPROVED', postingStatus: 'UNPOSTED' }));
    expect(screen.getByTestId('profit-cancel-effect').textContent).toMatch(/đã duyệt nhưng chưa chi tiền/);
    approved.unmount();
    renderDialog(target());
    expect(screen.getByTestId('profit-cancel-effect').textContent).toMatch(/chờ duyệt: huỷ yêu cầu duyệt/);
  });
  it.each([['ngắn', PROFIT_FORM_MESSAGES.cancelReasonLength], [PROFIT_FORM_MESSAGES.cancelReasonLength, PROFIT_FORM_MESSAGES.cancelReasonSystem]])(
    'lý do "%s" ⇒ chặn, không gọi máy chủ', async (text, message) => {
      renderDialog(target());
      fireEvent.change(reason(), { target: { value: text } });
      fireEvent.click(huy());
      expect(await screen.findByText(message)).toBeTruthy();
      expect(m.rpc).not.toHaveBeenCalled();
    },
  );
  it('gửi đúng p_voucher_id, p_reason, p_idempotency_key, p_expected_state; báo số dư sau huỷ', async () => {
    m.rpc.mockResolvedValue({ data: { voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_AFTER_POSTING', reversal_posting_id: 'p1', balance_after: 300_000 }, error: null });
    const onCancelled = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(target({ approvalStatus: 'APPROVED', postingStatus: 'POSTED' }), { onCancelled, onOpenChange });
    fireEvent.change(reason(), { target: { value: 'Chi nhầm người nhận, lập lại phiếu khác' } });
    fireEvent.click(huy());
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    expect(m.rpc).toHaveBeenCalledWith('profit_ledger_payout_cancel_v1', {
      p_voucher_id: 'v1', p_reason: 'Chi nhầm người nhận, lập lại phiếu khác', p_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/), p_expected_state: 'POSTED',
    });
    expect(m.toastSuccess.mock.calls[0]![0]).toMatch(/đảo bút toán — tiền về sổ Quỹ tiền mặt.*Sau huỷ, lợi nhuận chưa chi sau khi trừ tạm ứng: 300\.000/);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it('máy chủ CHE số dư (người giữ sổ huỷ phiếu tạm ứng mình lập hộ: balance_after null) ⇒ báo đã huỷ, KHÔNG có câu số dư', async () => {
    m.rpc.mockResolvedValue({ data: { voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', reversal_posting_id: null, balance_after: null }, error: null });
    const onCancelled = vi.fn();
    renderDialog(target(), { onCancelled });
    fireEvent.change(reason(), { target: { value: 'Gõ nhầm số tiền, lập lại phiếu khác' } });
    fireEvent.click(huy());
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    const message = m.toastSuccess.mock.calls[0]![0] as string;
    expect(message).toBe('Đã huỷ phiếu PC2611999.');
    expect(message).not.toMatch(/Sau huỷ|lợi nhuận chưa chi|tạm ứng còn|\d{1,3}(\.\d{3})+/);
  });
  it('phiếu đã huỷ từ trước, số dư bị che ⇒ câu "đã được huỷ trước đó" không kèm số', async () => {
    m.rpc.mockResolvedValue({ data: { voucher_id: 'v1', changed: false, cancellation_kind: null, reversal_posting_id: null, balance_after: null }, error: null });
    const onCancelled = vi.fn();
    renderDialog(target(), { onCancelled });
    fireEvent.change(reason(), { target: { value: 'Gõ nhầm số tiền, lập lại phiếu khác' } });
    fireEvent.click(huy());
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    expect(m.toastInfo.mock.calls[0]![0]).toBe('Phiếu PC2611999 đã được huỷ trước đó.');
  });
  it('phiếu đã khoá (55000) ⇒ câu riêng, không đóng hộp', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'PROFIT_LEDGER_IN_HANDOVER: phiếu đang nằm trong phiên bàn giao tiền mặt' } });
    const onOpenChange = vi.fn();
    renderDialog(target({ approvalStatus: 'APPROVED', postingStatus: 'POSTED' }), { onOpenChange });
    fireEvent.change(reason(), { target: { value: 'Chi nhầm người nhận, lập lại phiếu khác' } });
    fireEvent.click(huy());
    expect(await screen.findByText(/phiên bàn giao tiền mặt — huỷ phiên bàn giao trước/)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
  it('phiếu vừa được duyệt (PT409) ⇒ hiện trạng thái mới; bấm lại gửi trạng thái mới', async () => {
    m.rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'PROFIT_LEDGER_CANCEL_STATE_CHANGED: x', details: '{"expected":"PENDING","actual":"APPROVED_UNPOSTED"}' } })
      .mockResolvedValueOnce({ data: { voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', reversal_posting_id: null, balance_after: 10 }, error: null });
    renderDialog(target());
    fireEvent.change(reason(), { target: { value: 'Rút lại khoản chi chưa cần' } });
    fireEvent.click(huy());
    expect(await screen.findByText(/bây giờ: đã duyệt, chưa chi tiền/)).toBeTruthy();
    expect(screen.getByTestId('profit-cancel-effect').textContent).toMatch(/đã duyệt nhưng chưa chi tiền/);
    fireEvent.click(huy());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2));
    expect(m.rpc.mock.calls[0]![1].p_expected_state).toBe('PENDING');
    expect(m.rpc.mock.calls[1]![1].p_expected_state).toBe('APPROVED_UNPOSTED');
  });
  it('chưa rõ kết quả ⇒ chỉ phiếu đó bị khoá; mở lại phiếu đó gửi lại ĐÚNG lý do + khoá cũ', async () => {
    m.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: { voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', reversal_posting_id: null, balance_after: 10 }, error: null });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = render(<ProfitPayoutCancelDialog open target={target()} onOpenChange={vi.fn()} />, { wrapper: wrap });
    fireEvent.change(reason(), { target: { value: 'Rút lại khoản chi chưa cần' } });
    fireEvent.click(huy());
    expect(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeTruthy();
    view.rerender(<ProfitPayoutCancelDialog open target={target({ voucherId: 'v2', code: 'PC2611998' })} onOpenChange={vi.fn()} />);
    expect(huy().disabled).toBe(false);
    expect(reason().value).toBe('');
    view.rerender(<ProfitPayoutCancelDialog open target={target()} onOpenChange={vi.fn()} />);
    expect(reason().value).toBe('Rút lại khoản chi chưa cần');
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại kết quả' }));
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2));
    expect(m.rpc.mock.calls[1]![1]).toEqual(m.rpc.mock.calls[0]![1]);
  });
  it('phiếu đã huỷ / trạng thái lạ ⇒ không cho bấm', () => {
    renderDialog(target({ approvalStatus: 'APPROVED', postingStatus: 'REVERSED' }));
    expect(huy().disabled).toBe(true);
  });
});
