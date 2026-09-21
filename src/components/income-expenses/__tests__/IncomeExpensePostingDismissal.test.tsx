// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import IncomeExpensePostingDialog from '../IncomeExpensePostingDialog';

vi.mock('@/components/ui/storage-image', () => ({ StorageImage: () => null }));
vi.mock('@/hooks/useClipboardImagePaste', () => ({ useClipboardImagePaste: () => ({}) }));
afterEach(cleanup);

it.each([false, true])('locks dismissal only for an in-flight operation: busy=%s', async busy => {
  const close = vi.fn(), submit = vi.fn();
  render(<IncomeExpensePostingDialog
    open onOpenChange={close} mode="POST_APPROVED"
    voucher={{ subjectKind: 'VOUCHER', subjectId: '11111111-1111-4111-8111-111111111111', type: 'EXPENSE', approvedTotal: 100, name: 'Phiếu chờ đối chiếu', requiresEvidence: false, defaultCashbookId: '22222222-2222-4222-8222-222222222222' }}
    capability={{ isCustodian: true, canApprove: false }}
    cashbookOptions={[{ id: '22222222-2222-4222-8222-222222222222', name: 'Sổ thử' }]}
    expectedExecutionRevision={0} expectedApprovalVersion={1} expectedPostingVersion={0}
    onSubmit={submit} isSubmitting={busy} submitDisabled
  />);
  const button = screen.getByRole('button', { name: busy ? 'Đang xử lý...' : 'Chi' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  const cancel = screen.getByRole('button', { name: 'Huỷ bỏ' }) as HTMLButtonElement;
  expect(cancel.matches(':disabled')).toBe(busy);
  fireEvent.submit(button.closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(busy ? 0 : 1));
  expect(submit).not.toHaveBeenCalled();
});
