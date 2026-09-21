// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IncomeExpenseActionButtons } from '../IncomeExpenseActionButtons';
import type { IncomeExpenseActionsController } from '@/hooks/income-expenses/useIncomeExpenseActions';
afterEach(cleanup);
it.each([true, false])('renders labeled settlement actions from the shared decision, enabled=%s', enabled => {
  const controller = { availability: () => new Proxy({}, { get: (_target, key) => key === 'resubmitReview'
    ? { visible: true, enabled, reason: enabled ? null : 'Chưa đủ quyền' } : { visible: false, enabled: false, reason: null } }),
    dismissalBlocked: false, open: vi.fn(),
  } as unknown as IncomeExpenseActionsController;
  render(<IncomeExpenseActionButtons controller={controller} id="same-voucher" layout="labeled" />);
  expect(screen.getByText('Chuyển chờ duyệt')).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Chuyển chờ duyệt' }) as HTMLButtonElement;
  expect(button.disabled).toBe(!enabled);
  fireEvent.click(button);
  expect(controller.open).toHaveBeenCalledTimes(enabled ? 1 : 0);
  if (enabled) expect(controller.open).toHaveBeenCalledWith('resubmitReview', 'same-voucher');
});
