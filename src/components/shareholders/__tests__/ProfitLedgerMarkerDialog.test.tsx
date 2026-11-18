// @vitest-environment jsdom
// Hộp mốc "đã trả đủ" (E8 → E9) — D2.4: gửi đúng id mốc đang thấy (CAS), gỡ mốc gửi tháng null,
// tháng chưa qua bị chặn, mốc xoá dấu tạm ứng phải tick riêng, mốc vừa đổi ⇒ tải lại xem trước
// (không tự gửi lại). Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PreviewInput = { organizationId: string | null; subjectKind: string; subjectId: string | null; settledThroughMonth: string | null; enabled?: boolean };
const m = vi.hoisted(() => ({
  route: 'SHADOW' as string,
  erased: 0,
  currentMarker: null as null | { id: string; settled_through_month: string | null; ledger_seq: number; created_at: string | null },
  previewCalls: [] as PreviewInput[],
  refetch: vi.fn(),
  mutate: vi.fn(),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useProfitLedgerMarkerPreview: (input: PreviewInput) => {
    m.previewCalls.push(input);
    if (!input.enabled) return { data: undefined, isFetching: false, isError: false, error: null, refetch: m.refetch };
    return {
      data: {
        route: m.route, subject_kind: input.subjectKind, subject_id: input.subjectId, settled_through_month: input.settledThroughMonth,
        current_marker: m.currentMarker, balance_now: 10_000, balance_after: 4_000,
        excluded: { allocated: 6_000, payouts: 0, salary: 0 }, advance_erased: m.erased, requires_acknowledge: m.erased > 0,
      },
      isFetching: false, isError: false, error: null, refetch: m.refetch,
    };
  },
}));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({
  useSetProfitLedgerMarker: () => ({ mutateAsync: m.mutate, isPending: false }),
}));

import { ProfitLedgerMarkerDialog } from '../ProfitLedgerMarkerDialog';

const LY_DO = 'Đã trả đủ ngoài app tới tháng này';
const subject = { id: 's1', name: 'An', marker: null };
const monthInput = () => document.querySelector('[name="settledThroughMonth"]') as HTMLInputElement;
const reasonInput = () => document.querySelector('[name="reason"]') as HTMLTextAreaElement;

beforeEach(() => {
  m.route = 'SHADOW';
  m.erased = 0;
  m.currentMarker = { id: 'mk-old', settled_through_month: null, ledger_seq: 4, created_at: '2026-10-01T00:00:00Z' };
  m.previewCalls = [];
  m.mutate.mockResolvedValue({ marker_id: 'mk-new', settled_through_month: '2020-05-01', supersedes_id: 'mk-old', balance_before: 10_000, balance_after: 4_000, advance_erased: 0 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('hộp mốc đã trả đủ', () => {
  it('đặt mốc: gửi tháng YYYY-MM-01 + id mốc của lần xem trước (CAS), không tự xác nhận tạm ứng', async () => {
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    await waitFor(() => expect(m.previewCalls.at(-1)).toMatchObject({ settledThroughMonth: '2020-05-01', enabled: true, subjectId: 's1' }));
    expect(screen.getByTestId('marker-preview').textContent).toMatch(/10\.000 đ → sau khi đặt mốc 4\.000 đ/);
    fireEvent.change(reasonInput(), { target: { value: LY_DO } });
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc' }));
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1));
    expect(m.mutate).toHaveBeenCalledWith({
      organizationId: 'org-a', subjectKind: 'SHAREHOLDER', subjectId: 's1', settledThroughMonth: '2020-05-01',
      reason: LY_DO, expectedMarkerId: 'mk-old', acknowledgeAdvanceErase: false,
    });
  });

  it('gỡ mốc: gửi tháng null', async () => {
    m.currentMarker = { id: 'mk1', settled_through_month: '2026-08-01', ledger_seq: 5, created_at: null };
    render(
      <ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="MANAGER"
        subject={{ id: 'm1', name: 'Quản lý', marker: { id: 'mk1', settled_through_month: '2026-08-01', ledger_seq: 5 } }} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Gỡ mốc' }));
    await waitFor(() => expect(m.previewCalls.at(-1)).toMatchObject({ settledThroughMonth: null, enabled: true, subjectKind: 'MANAGER' }));
    fireEvent.change(reasonInput(), { target: { value: 'Đặt nhầm mốc, gỡ để tính lại' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gỡ mốc' }));
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1));
    expect(m.mutate).toHaveBeenCalledWith(expect.objectContaining({ subjectKind: 'MANAGER', subjectId: 'm1', settledThroughMonth: null, expectedMarkerId: 'mk1' }));
  });

  it('tháng chưa qua bị chặn ở máy khách, không gọi ghi', async () => {
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    fireEvent.change(monthInput(), { target: { value: '2999-01' } });
    fireEvent.change(reasonInput(), { target: { value: LY_DO } });
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc' }));
    expect(await screen.findByText('Chọn tháng đã qua (trước tháng hiện tại).')).toBeTruthy();
    expect(m.mutate).not.toHaveBeenCalled();
    expect(m.previewCalls.at(-1)?.enabled).toBe(false);
  });

  it('mốc xoá dấu tạm ứng ⇒ chữ đỏ + phải tick mới gửi, gửi kèm xác nhận', async () => {
    m.erased = 5_000;
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    expect((await screen.findByTestId('marker-advance-erased')).textContent).toMatch(/5\.000 đ/);
    fireEvent.change(reasonInput(), { target: { value: LY_DO } });
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc' }));
    await waitFor(() => expect(screen.getByRole('checkbox').getAttribute('aria-invalid')).toBe('true'));
    expect(m.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc' }));
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1));
    expect(m.mutate).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeAdvanceErase: true }));
  });

  it('mốc vừa bị người khác đổi (PT409) ⇒ tải lại xem trước, báo, KHÔNG tự gửi lại', async () => {
    m.mutate.mockRejectedValueOnce({ code: 'PT409', message: 'PROFIT_LEDGER_MARKER_CHANGED: mốc vừa được người khác đổi', details: '{"current_marker_id":"mk-x","expected_marker_id":"mk-old"}' });
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    fireEvent.change(reasonInput(), { target: { value: LY_DO } });
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Mốc vừa được người khác đổi/);
    expect(m.refetch).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(m.mutate).toHaveBeenCalledTimes(1);
  });

  // 18/11/2026 — tạm ứng + chốt chi lợi nhuận: "tạm ứng bị xoá" của mốc cộng cả phiếu tạm ứng đã được khấu trừ.
  it('mốc xoá dấu tạm ứng: cổ đông có thêm chú thích "gồm cả phần đã khấu trừ ở các lần chốt"; lương điều hành thì không', async () => {
    m.erased = 5_000;
    const view = render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    const note = await screen.findByTestId('marker-advance-erased-note');
    expect(note.textContent).toMatch(/kể cả phần đã được khấu trừ ở các lần chốt chi\s+lợi nhuận/);
    expect(note.textContent).toMatch(/có thể lớn hơn "Tạm ứng đang có"/);
    view.unmount();

    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="MANAGER" subject={{ id: 'm1', name: 'Quản lý', marker: null }} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    expect((await screen.findByTestId('marker-advance-erased')).textContent).toMatch(/5\.000 đ/);
    expect(screen.queryByTestId('marker-advance-erased-note')).toBeNull();
  });

  it('mốc sớm hơn tháng đã chốt chi lợi nhuận ⇒ nhắc trước (không khoá nút); đúng tháng chốt trở đi thì không nhắc', async () => {
    const daChot = { ...subject, lastSettledThroughMonth: '2020-06-01' };
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={daChot} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    const hint = await screen.findByTestId('marker-before-settlement');
    // Tháng của lần chốt viết "MM/YYYY" như câu máy chủ và hộp chốt.
    expect(hint.textContent).toMatch(/Đã chốt chi lợi nhuận đến hết 06\/2020/);
    expect(hint.textContent).toMatch(/huỷ lần chốt đó trước/);
    // Chỉ là lời nhắc theo số trang đang có: máy chủ mới là chốt cuối ⇒ nút vẫn bấm được.
    expect((screen.getByRole('button', { name: 'Đặt mốc' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(monthInput(), { target: { value: '2020-06' } });
    await waitFor(() => expect(screen.queryByTestId('marker-before-settlement')).toBeNull());
    fireEvent.change(monthInput(), { target: { value: '2020-07' } });
    await waitFor(() => expect(m.previewCalls.at(-1)).toMatchObject({ settledThroughMonth: '2020-07-01' }));
    expect(screen.queryByTestId('marker-before-settlement')).toBeNull();
  });

  it('lương điều hành không có lần chốt chi ⇒ không bao giờ nhắc, kể cả khi trang truyền nhầm tháng chốt', async () => {
    render(
      <ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="MANAGER"
        subject={{ id: 'm1', name: 'Quản lý', marker: null, lastSettledThroughMonth: '2020-06-01' }} />,
    );
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    await waitFor(() => expect(m.previewCalls.at(-1)).toMatchObject({ settledThroughMonth: '2020-05-01', enabled: true }));
    expect(screen.queryByTestId('marker-before-settlement')).toBeNull();
  });

  it('máy chủ từ chối mốc sớm hơn tháng đã chốt chi (55000) ⇒ câu riêng có tháng đã chốt, hộp không đóng, không tự gửi lại', async () => {
    m.mutate.mockRejectedValueOnce({
      code: '55000',
      message: 'PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT: đã chốt chi lợi nhuận đến hết tháng 06/2020',
      details: '{"settled_through_month":"2020-05-01","last_settled_through_month":"2020-06-01"}',
    });
    const onOpenChange = vi.fn();
    render(<ProfitLedgerMarkerDialog open onOpenChange={onOpenChange} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    fireEvent.change(reasonInput(), { target: { value: LY_DO } });
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Đã chốt chi lợi nhuận đến hết 06\/2020 — mốc "đã trả đủ" phải từ tháng đó trở đi/);
    expect(alert.textContent).toMatch(/huỷ lần chốt đó trước/);
    expect(alert.textContent).not.toMatch(/PROFIT_LEDGER/);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(m.mutate).toHaveBeenCalledTimes(1);
  });

  // U8 (18/11): trang đã biết tháng chốt ⇒ có lời nhắc vàng; máy chủ từ chối đúng lý do đó ⇒ chỉ còn câu đỏ (không hai câu
  // gần trùng), cùng cách viết tháng "MM/YYYY".
  it('đã có lời nhắc vàng mà máy chủ vẫn từ chối cùng lý do ⇒ chỉ còn MỘT câu (đỏ), tháng viết "06/2020"', async () => {
    m.mutate.mockRejectedValueOnce({
      code: '55000',
      message: 'PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT: đã chốt chi lợi nhuận đến hết tháng 06/2020',
      details: '{"settled_through_month":"2020-05-01","last_settled_through_month":"2020-06-01"}',
    });
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={{ ...subject, lastSettledThroughMonth: '2020-06-01' }} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    expect((await screen.findByTestId('marker-before-settlement')).textContent).toMatch(/đến hết 06\/2020/);
    fireEvent.change(reasonInput(), { target: { value: LY_DO } });
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Đã chốt chi lợi nhuận đến hết 06\/2020/);
    expect(screen.queryByTestId('marker-before-settlement')).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/T06\/2020/);
    expect(screen.getByRole('dialog').textContent?.match(/Đã chốt chi lợi nhuận đến hết/g)).toHaveLength(1);
  });

  it('hộp dài: giới hạn theo khung nhìn + cuộn, hàng nút dính đáy (dùng được ở điện thoại)', () => {
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toMatch(/max-h-\[90dvh\]/);
    expect(dialog.className).toMatch(/overflow-y-auto/);
    expect(screen.getByRole('button', { name: 'Đặt mốc' }).parentElement!.className).toMatch(/\bsticky bottom-0\b/);
  });

  it('sổ tổng chưa mở phần đặt mốc ⇒ khoá nút + câu báo', async () => {
    m.route = 'LEGACY';
    render(<ProfitLedgerMarkerDialog open onOpenChange={vi.fn()} organizationId="org-a" subjectKind="SHAREHOLDER" subject={subject} />);
    fireEvent.change(monthInput(), { target: { value: '2020-05' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Đặt mốc' }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toMatch(/xem thử/);
  });
});
