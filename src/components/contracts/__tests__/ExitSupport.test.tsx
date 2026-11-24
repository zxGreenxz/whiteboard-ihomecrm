// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitSupportField } from '../contract-form/ExitSupportField';
import { ExitSupportSummary } from '../ExitSupportPanel';
import { exitSupportCaps, exitSupportError } from '@/lib/contractExitSupport';
import type { ContractFormState } from '../contract-form/useContractFormState';
import { exitTermsRow, linkedExitTermsRow, EXIT_FIXTURE_IDS as ID } from './exitEarlyTermsFixture';

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), permissions: { __superadmin: true } as Record<string, unknown> }));
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', () => ({
  useReverseContractExitSupport: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: mocks.permissions }) }));
beforeEach(() => { vi.clearAllMocks(); mocks.permissions = { __superadmin: true }; });
afterEach(() => { cleanup(); });

type ExitSupportState = ContractFormState['exitSupport'];
const amountInput = () => document.querySelector<HTMLInputElement>('input[name="transfer_support_amount"]')!;
function supportState(overrides: Partial<ExitSupportState> = {}): ExitSupportState {
  const hold = exitTermsRow();
  const caps = exitSupportCaps(hold, 4_000_000, 1_000_000);
  const amount = overrides.amount ?? 0;
  return { hold, readError: false, retry: vi.fn(), permitted: true, links: true, amount, setAmount: vi.fn(), applied: amount,
    caps, issue: amount ? exitSupportError(amount, caps) : null, ...overrides };
}

describe('ô "Khách cũ hỗ trợ khách mới" ở form tạo hợp đồng', () => {
  it('không có hồ sơ sang nhượng chờ nối thì không vẽ gì', () => {
    const { container } = render(<ExitSupportField exitSupport={supportState({ hold: null, caps: null })} />);
    expect(container.innerHTML).toBe('');
  });

  it('hiện hồ sơ cũ, trần theo cọc cũ trừ phí môi giới và cọc còn thiếu; nhập số thì báo lên form', () => {
    const state = supportState();
    const onAmountChange = vi.fn();
    render(<ExitSupportField exitSupport={state} onAmountChange={onAmountChange} />);
    expect(screen.getByRole('group', { name: 'Khách cũ hỗ trợ khách mới' }).textContent).toContain('HD-0101');
    expect(screen.getByTestId('exit-support-cap').textContent).toContain('Tối đa 2.000.000');
    expect(screen.getByTestId('exit-support-cap').textContent).toContain('phí môi giới 2.000.000');
    const input = amountInput();
    expect(input.getAttribute('name')).toBe('transfer_support_amount');
    fireEvent.change(input, { target: { value: '1500000' } });
    expect(state.setAmount).toHaveBeenLastCalledWith(1_500_000);
    expect(onAmountChange).toHaveBeenCalled();
  });

  it('vượt trần: báo lý do bị từ chối ngay tại ô', () => {
    render(<ExitSupportField exitSupport={supportState({ amount: 2_500_000 })} />);
    expect(screen.getByRole('alert').textContent).toContain('Vượt cọc cũ đã thu sau khi trừ phí môi giới (tối đa 2.000.000 đ).');
    expect(amountInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('ngày bắt đầu trước ngày trả phòng hoặc thiếu quyền thanh lý: khoá ô, nói rõ vì sao', () => {
    const { rerender } = render(<ExitSupportField exitSupport={supportState({ links: false })} />);
    expect(amountInput().disabled).toBe(true);
    expect(screen.getByText(/Ngày bắt đầu hợp đồng phải từ 01\/12\/2026/)).toBeTruthy();
    rerender(<ExitSupportField exitSupport={supportState({ permitted: false })} />);
    expect(amountInput().disabled).toBe(true);
    expect(screen.getByText(/Cần quyền thanh lý hợp đồng/)).toBeTruthy();
  });

  it('lỗi đọc hồ sơ trả phòng: một dòng kèm Thử lại', () => {
    const state = supportState({ readError: true });
    render(<ExitSupportField exitSupport={state} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(state.retry).toHaveBeenCalled();
  });
});

describe('dòng số hỗ trợ ở hồ sơ trả phòng và nút đảo', () => {
  const withSupport = linkedExitTermsRow({ support_amount: 1_200_000, support_out_code: 'PC2611012', support_in_code: 'PT2611003', version: 3 });

  it('không có số hỗ trợ thì không vẽ', () => {
    const { container } = render(<ExitSupportSummary terms={linkedExitTermsRow()} />);
    expect(container.innerHTML).toBe('');
  });

  it('hiện số, hợp đồng nhận và mã hai phiếu; đảo cần lý do và gửi đúng phiên bản hồ sơ', async () => {
    mocks.mutateAsync.mockResolvedValue(withSupport);
    render(<ExitSupportSummary terms={withSupport} />);
    const summary = screen.getByTestId('exit-support-summary').textContent ?? '';
    expect(summary).toContain('1.200.000 đ');
    expect(summary).toContain('HD-0202');
    expect(summary).toContain('PC2611012 / PT2611003');
    fireEvent.click(screen.getByRole('button', { name: 'Đảo số hỗ trợ' }));
    const confirm = screen.getAllByRole('button', { name: 'Đảo số hỗ trợ' }).at(-1)!;
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Lý do đảo/), { target: { value: ' Khách nhận huỷ ' } });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ caseId: ID.exitCase, expectedVersion: 3, reason: 'Khách nhận huỷ',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }));
  });

  it('đã quyết toán hoặc không có quyền thanh lý ở toà: chỉ hiện, không có nút đảo', () => {
    const { rerender } = render(<ExitSupportSummary terms={{ ...withSupport, exit_state: 'FINALIZED' }} />);
    expect(screen.queryByRole('button', { name: 'Đảo số hỗ trợ' })).toBeNull();
    mocks.permissions = {};
    rerender(<ExitSupportSummary terms={withSupport} />);
    expect(screen.queryByRole('button', { name: 'Đảo số hỗ trợ' })).toBeNull();
    expect(screen.getByTestId('exit-support-summary').textContent).toContain('1.200.000 đ');
  });
});
