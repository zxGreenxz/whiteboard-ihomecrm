// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';

const h = vi.hoisted(() => ({
  save: vi.fn(), refetch: vi.fn(), ownerRefetch: vi.fn(), stateRead: vi.fn(),
  stateError: false, stateLoading: false, owner: true, ownerError: false, canReopen: true, locked: true, pendingClosure: false,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/hooks/useCashbookReopening', () => ({
  useCashbookReopeningState: (id: string | null) => {
    h.stateRead(id);
    return {
      data: h.stateError || h.stateLoading ? undefined : {
        cashbook_id: 'book-a', can_reopen: h.canReopen, lock_date: h.locked ? '2026-10-20' : null, revision: 'closing:17',
        blocked_reason: h.pendingClosure ? 'PENDING_CLOSURE' : null,
        history: [{ id: 'reopen-1', reopened_at: '2026-10-19T08:15:00Z', reopened_by_name: 'Chủ demo', reason: 'Kiểm tra phiếu bị ghi nhầm', previous_lock_date: '2026-10-18' }],
      },
      error: h.stateError ? new Error('private SQL diagnostics') : null,
      isError: h.stateError, isLoading: h.stateLoading, status: h.stateError ? 'error' : h.stateLoading ? 'pending' : 'success',
      fetchStatus: h.stateLoading ? 'fetching' : 'idle', refetch: h.refetch,
    };
  },
  useReopenCashbook: () => ({ mutateAsync: h.save, isPending: false }),
}));
vi.mock('@/hooks/useIsCompanyOwner', () => ({
  useIsCompanyOwner: () => ({ data: h.owner, isError: h.ownerError, isLoading: false, refetch: h.ownerRefetch }),
}));

import ReopenCashbookDialog from './ReopenCashbookDialog';
import CashbookReopenAction from './CashbookReopenAction';

afterEach(cleanup);
beforeEach(() => {
  h.save.mockReset(); h.refetch.mockReset(); h.ownerRefetch.mockReset(); h.stateRead.mockReset();
  h.stateError = false; h.stateLoading = false; h.owner = true; h.ownerError = false; h.canReopen = true; h.locked = true;
  h.pendingClosure = false;
});

const show = (onOpenChange = vi.fn()) => render(<ReopenCashbookDialog open cashbookId="book-a" cashbookName="Sổ demo" onOpenChange={onOpenChange} />);

describe('cashbook reopening form', () => {
  it('requires a meaningful reason and focuses it without writing', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận mở khóa' }));
    expect(await screen.findByText('Nhập lý do mở khóa ít nhất 10 ký tự.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('cashbook-reopen-reason'));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('submits the displayed lock revision and trimmed reason, closing only after confirmed success', async () => {
    const close = vi.fn();
    let resolveSave: () => void = () => {};
    h.save.mockImplementation(() => new Promise<void>(resolve => { resolveSave = resolve; }));
    show(close);
    fireEvent.change(screen.getByLabelText(/Lý do mở khóa/), { target: { value: '  Kiểm tra phiếu bị ghi nhầm  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận mở khóa' }));
    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ cashbookId: 'book-a', cashbookName: 'Sổ demo', reason: 'Kiểm tra phiếu bị ghi nhầm', expectedLockDate: '2026-10-20', expectedRevision: 'closing:17' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Đóng' }).hasAttribute('disabled')).toBe(true);
    resolveSave();
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });

  it('keeps the reason and shows permission loss without claiming success', async () => {
    const close = vi.fn();
    h.save.mockRejectedValue({ code: '42501', message: '[REOPEN_FORBIDDEN] private SQL diagnostics' });
    show(close);
    fireEvent.change(screen.getByLabelText(/Lý do mở khóa/), { target: { value: 'Kiểm tra phiếu bị ghi nhầm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận mở khóa' }));
    expect(await screen.findByText(/Chỉ chủ tổ chức sở hữu sổ này được mở khóa/)).toBeTruthy();
    expect((screen.getByLabelText(/Lý do mở khóa/) as HTMLTextAreaElement).value).toBe('Kiểm tra phiếu bị ghi nhầm');
    expect(close).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('private SQL diagnostics');
  });

  it('blocks resubmission after an unknown result while retaining the draft', async () => {
    h.save.mockRejectedValue(new FinancialWorkflowError('Cần đối chiếu lịch sử mở khóa.', 'unknown', []));
    show();
    fireEvent.change(screen.getByLabelText(/Lý do mở khóa/), { target: { value: 'Kiểm tra phiếu bị ghi nhầm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận mở khóa' }));
    await screen.findByText(/Cần đối chiếu lịch sử mở khóa/);
    expect(screen.getByRole('button', { name: 'Xác nhận mở khóa' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận mở khóa' }));
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('separates unreadable state from denied permission and hides stale history', () => {
    h.stateError = true;
    show();
    expect(screen.getByText('Chưa tải được trạng thái mở khóa sổ.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xác nhận mở khóa' })).toBeNull();
    expect(screen.queryByText(/Bạn không có quyền mở khóa/)).toBeNull();
    expect(document.body.textContent).not.toContain('private SQL diagnostics');
    expect(document.body.textContent).not.toContain('Kiểm tra phiếu bị ghi nhầm');
  });

  it('shows historical actor, reason and prior lock date even after the book is open', () => {
    h.locked = false; h.canReopen = false;
    show();
    expect(screen.getByText('Sổ hiện không bị khóa.')).toBeTruthy();
    expect(screen.getByText(/Chủ demo ·/)).toBeTruthy();
    expect(screen.getByText('Mở kỳ đã khóa đến 18/10/2026')).toBeTruthy();
    expect(screen.getByText('Kiểm tra phiếu bị ghi nhầm')).toBeTruthy();
    expect(screen.queryByLabelText(/Lý do mở khóa/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xác nhận mở khóa' })).toBeNull();
  });

  it('offers no write action to a reader who is not this organization owner', () => {
    h.canReopen = false;
    show();
    expect(screen.getByText(/Bạn không có quyền mở khóa sổ này/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xác nhận mở khóa' })).toBeNull();
  });

  it('explains a pending closing to the owner and blocks submission without denying ownership', () => {
    h.pendingClosure = true;
    show();
    expect(screen.getByRole('status').textContent).toContain('Sổ có đề nghị chốt đang chờ. Xử lý đề nghị đó trước khi mở khóa.');
    expect(screen.queryByText(/Bạn không có quyền mở khóa/)).toBeNull();
    const submit = screen.getByRole('button', { name: 'Xác nhận mở khóa' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('reopening action permission', () => {
  it('does not treat being owner of another organization as access to this book', () => {
    h.canReopen = false;
    render(<CashbookReopenAction cashbookId="book-a" locked onClick={vi.fn()} compact />);
    expect(h.stateRead).toHaveBeenCalledWith('book-a');
    expect(screen.queryByRole('button', { name: 'Mở khóa sổ' })).toBeNull();
  });

  it('does not request per-book privileges for an ordinary member or an unlocked book', () => {
    h.owner = false;
    const view = render(<CashbookReopenAction cashbookId="book-a" locked onClick={vi.fn()} />);
    expect(h.stateRead).toHaveBeenLastCalledWith(null);
    h.owner = true;
    view.rerender(<CashbookReopenAction cashbookId="book-a" locked={false} onClick={vi.fn()} />);
    expect(h.stateRead).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens for an authorized owner and keeps the containing row from opening', () => {
    const click = vi.fn(); const parentClick = vi.fn();
    render(<div onClick={parentClick}><CashbookReopenAction cashbookId="book-a" locked onClick={click} compact /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Mở khóa sổ' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('still opens the explanation when a closing request temporarily blocks reopening', () => {
    h.pendingClosure = true;
    const click = vi.fn();
    render(<CashbookReopenAction cashbookId="book-a" locked onClick={click} compact />);
    fireEvent.click(screen.getByRole('button', { name: 'Mở khóa sổ' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('offers retry instead of a false permission decision when the source fails', () => {
    h.stateError = true;
    render(<CashbookReopenAction cashbookId="book-a" locked onClick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại kiểm tra quyền mở khóa' }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Mở khóa sổ' })).toBeNull();
  });
});
