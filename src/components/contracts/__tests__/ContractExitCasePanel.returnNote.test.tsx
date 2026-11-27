// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import { ContractExitCasePanel } from '../ContractExitCasePanel';
import { linkedExitTermsRow } from './exitEarlyTermsFixture';

const state = vi.hoisted(() => ({ note: null as string | null, status: 'PENDING', loading: false, error: false }));
vi.mock('@/hooks/useContractExitCases', () => ({ useContractExitCases: () => ({
  data: { items: [{ id: 'exit', state: state.status, actual_move_out_on: '2026-09-29',
    initial_kind: 'EARLY_RETURN', current_kind: 'EARLY_RETURN', kind_history: [], return_note: state.note }] },
  isLoading: state.loading, isError: state.error,
}) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('../ContractReturnStep', () => ({ EXIT_KIND_LABELS: { EARLY_RETURN: 'Trả sớm' } }));
vi.mock('../TerminateDialog', () => ({ TerminateDialog: () => null }));
vi.mock('@/hooks/useContractExitSettlementDrafts', () => ({ useContractExitSettlementDrafts: () => ({ data: [] }) }));
const early = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', () => ({
  useContractExitEarlyTerms: () => ({ data: early.data, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../ExitCommissionForm', () => ({ ExitCommissionDialog: () => null }));
vi.mock('../ContractMeterBoundaryPanel', () => ({ ContractMeterBoundaryPanel: () => null }));

beforeEach(() => { early.data = []; state.note = null; state.status = 'PENDING'; state.loading = false; state.error = false; });
afterEach(cleanup);
const show = () => render(<ContractExitCasePanel contract={{ id: 'contract' } as ContractWithRelations} />);

describe('nội dung thanh lý trong chi tiết hợp đồng', () => {
  it.each(['PENDING', 'FINALIZED'])('hiện nội dung đã lưu với xuống dòng khi hồ sơ %s', status => {
    state.status = status;
    state.note = 'Khách trả phòng sớm vì chuyển công tác.\nĐã bàn giao đủ chìa khóa.';
    show();
    const content = within(screen.getByRole('region', { name: 'Nội dung thanh lý' }));
    const note = content.getByText(/Khách trả phòng sớm/);
    expect(note.textContent).toBe(state.note);
    expect(note.className).toContain('whitespace-pre-wrap');
  });

  it('nói rõ hồ sơ cũ chưa có nội dung thay vì suy diễn từ loại thanh lý', () => {
    show();
    expect(within(screen.getByRole('region', { name: 'Nội dung thanh lý' }))
      .getByText('Chưa có nội dung thanh lý')).toBeTruthy();
  });

  it.each(['loading', 'error'] as const)('không biến %s thành hồ sơ không có nội dung', key => {
    state[key] = true;
    show();
    expect(screen.queryByText('Chưa có nội dung thanh lý')).toBeNull();
  });
});

describe('trường hợp trả phòng trước hạn trong chi tiết hợp đồng', () => {
  it('hồ sơ trước hạn chưa có trường hợp: nhắc chọn khi quyết toán', () => {
    show();
    expect(screen.getByText(/Chưa chọn trường hợp trả phòng trước hạn/)).toBeTruthy();
  });
  it('nhờ sale đã quyết toán mà chưa có phiếu: cảnh báo kèm tên sale và số phí', () => {
    state.status = 'FINALIZED';
    early.data = [linkedExitTermsRow({ exit_state: 'FINALIZED', fee_applied_at: '2026-12-02T00:00:00Z' })];
    show();
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain('chưa có phiếu hoa hồng môi giới cho sale Minh');
    expect(alert).toContain('2.000.000 đ');
    expect(screen.queryByRole('button', { name: 'Lập phiếu hoa hồng' })).toBeNull();
  });
  it('đã có phiếu hoa hồng thì không cảnh báo, hiện mã phiếu', () => {
    state.status = 'FINALIZED';
    early.data = [linkedExitTermsRow({ exit_state: 'FINALIZED', commission_voucher_id: '10000000-0000-4000-8000-000000000099', commission_code: 'PC-0099' })];
    show();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('PC-0099')).toBeTruthy();
  });
});
