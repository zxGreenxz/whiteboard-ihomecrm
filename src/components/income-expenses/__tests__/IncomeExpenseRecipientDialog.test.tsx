// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IncomeExpenseRecipientDialog } from '../IncomeExpenseRecipientDialog';
const original = { payerName: 'Khách A', bankName: 'ACB', bankAccount: '00123' };
afterEach(cleanup);
it('loads the current recipient, submits edited values only after change, and preserves account leading zeros', async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<IncomeExpenseRecipientDialog code="PC-1" original={original} busy={false} enabled onClose={() => {}} onSubmit={submit} />);
  expect((screen.getByLabelText('Số tài khoản người nhận') as HTMLInputElement).value).toBe('00123');
  expect((screen.getByRole('button', { name: 'Lưu người nhận' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Người nhận'), { target: { value: 'Khách B' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu người nhận' }));
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith({ ...original, payerName: 'Khách B' }));
});
it('blocks writes without capability but allows closing an idle rejected form', () => {
  const close = vi.fn(), submit = vi.fn();
  render(<IncomeExpenseRecipientDialog code="PC-1" original={original} busy={false} enabled={false} reason="Phiếu khóa nội dung" onClose={close} onSubmit={submit} />);
  expect(screen.getByText('Phiếu khóa nội dung')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu người nhận' }));
  fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
  expect(submit).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
it('keeps busy edits and dismissal locked while exposing reconciliation feedback', () => {
  const close = vi.fn();
  render(<IncomeExpenseRecipientDialog code="PC-1" original={original} busy enabled onClose={close} onSubmit={vi.fn()} feedback={<p>Đang đối chiếu kết quả</p>} />);
  expect((screen.getByLabelText('Người nhận') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
  expect(close).not.toHaveBeenCalled(); expect(screen.getByText('Đang đối chiếu kết quả')).toBeTruthy();
});
