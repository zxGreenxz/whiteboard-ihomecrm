// @vitest-environment jsdom
// Đợt 6: lương điều hành (manager_salary_payout_v1, cách B). Thân hàm production 25/11/2026: khoá công ty TRƯỚC khi tra mã
// trong canonical_write_operations; băm quản lý, số tiền, sổ quỹ, ngày chi, công ty (không băm ghi chú); cùng mã cùng phần
// băm ⇒ trả phiếu cũ; khác ⇒ 23505.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({ invalidateProfitLedgerQueries: vi.fn() }));

import { useCreateManagerSalaryPayout } from '../income-expenses/specialized';
import type { CreateManagerSalaryPayoutInput } from '../income-expenses/types';

type Row = Record<string, unknown>;
const MANAGER = 'm-1';
const input = (over: Partial<CreateManagerSalaryPayoutInput> = {}): CreateManagerSalaryPayoutInput => ({
  organizationId: 'org-1', manager_id: MANAGER, manager_name: 'Quản lý mẫu', amount: 2_000_000, account_id: 'account-a', voucher_date: '2026-11-05', note: null, ...over,
});
const pay = (value: CreateManagerSalaryPayoutInput) => (renderHook(() => useCreateManagerSalaryPayout({ deferFeedback: true })).result.current as unknown as { mutationFn: (v: unknown) => Promise<Row> }).mutationFn(value);
const keys = () => io.server.rpcCalls.filter(call => call.name === 'manager_salary_payout_v1').map(call => call.args.p_idempotency_key);
const vouchers = () => io.server.rows.income_expenses;
let seq = 0;
function install() {
  const claims = new Map<string, { hash: string; response: unknown }>();
  io.server.rpcHandlers.manager_salary_payout_v1 = args => {
    const hash = JSON.stringify([args.p_manager_id, args.p_amount, args.p_account_id, args.p_voucher_date]);
    const claim = claims.get(String(args.p_idempotency_key));
    if (claim) return claim.hash === hash ? { data: claim.response, error: null } : { data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } };
    const id = `mv-${++seq}`;
    vouchers().push({ id, code: `PC${seq}`, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', notes: args.p_note });
    const response = { manager_salary_voucher_id: id, voucher_id: id, manager_id: args.p_manager_id, state: 'PENDING_APPROVAL', approval_request_id: null };
    claims.set(String(args.p_idempotency_key), { hash, response });
    return { data: response, error: null };
  };
  return claims;
}
const scope = { namespace: 'profit-payout', userId: 'actor', organizationId: 'org-1', businessKey: `manager:${MANAGER}` };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-1');
  seq = 0;
  io.server = fakeRecordServer();
  io.server.rows.income_expenses = [];
});

describe('lương điều hành (cách B)', () => {
  it('lệnh không tới máy chủ: gửi lại ngay đúng mã cũ, một phiếu', async () => {
    install();
    io.server.failNext('manager_salary_payout_v1', 'rpc', 'drop-before');
    await expect(pay(input())).rejects.toBeTruthy();
    await expect(pay(input())).resolves.toMatchObject({ id: 'mv-1' });
    expect(keys()).toHaveLength(2);
    expect(new Set(keys()).size).toBe(1);
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: gửi lại cùng mã nhận phiếu cũ', async () => {
    install();
    io.server.failNext('manager_salary_payout_v1', 'rpc', 'drop-after');
    await expect(pay(input())).rejects.toBeTruthy();
    await expect(pay(input())).resolves.toMatchObject({ id: 'mv-1' });
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn: gửi lại đúng mã của dấu', async () => {
    const claims = install();
    vouchers().push({ id: 'mv-old', code: 'PC-OLD', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED' });
    claims.set('legacy-attempt', { hash: JSON.stringify([MANAGER, 2_000_000, 'account-a', '2026-11-05']), response: { manager_salary_voucher_id: 'mv-old', voucher_id: 'mv-old', manager_id: MANAGER, state: 'PENDING_APPROVAL' } });
    seedLegacyPending(scope, new Date(Date.now() - 10 * 60_000));
    await expect(pay(input())).resolves.toMatchObject({ id: 'mv-old' });
    expect(keys()).toEqual(['legacy-attempt']);
    expect(vouchers()).toHaveLength(1);
  });

  it('dấu cũ đã mang mã phiếu (bản trước ghi mã rồi mới kết thúc dở): giữ dấu, không gửi, không lập phiếu khác', async () => {
    install();
    seedLegacyPending(scope, new Date(Date.now() - 10 * 60_000), ['mv-old']);
    await expect(pay(input())).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(keys()).toEqual([]);
    expect(pendingKeys()).toHaveLength(1);
  });

  it('gửi lại với sổ quỹ khác ⇒ máy chủ báo trùng mã: báo đã lập ở lần trước, không lập thêm', async () => {
    install();
    io.server.failNext('manager_salary_payout_v1', 'rpc', 'drop-after');
    await expect(pay(input())).rejects.toBeTruthy();
    await expect(pay(input({ account_id: 'account-b' }))).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('lần gửi trước') });
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('khi đối chiếu không cho đổi ghi chú (máy chủ không băm): chặn kèm câu hướng dẫn, không gửi', async () => {
    install();
    io.server.failNext('manager_salary_payout_v1', 'rpc', 'drop-after');
    await expect(pay(input())).rejects.toBeTruthy();
    await expect(pay(input({ note: 'Ghi chú khác' }))).rejects.toMatchObject({ message: expect.stringContaining('ghi chú') });
    expect(keys()).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(1);
  });
});
