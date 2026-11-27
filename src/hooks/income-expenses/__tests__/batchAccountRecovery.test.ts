// @vitest-environment jsdom
// Đợt 6: đổi sổ quỹ cho cả đợt phiếu (cách A: chạy lại). revise_pending_income_expense_v1 (production 25/11/2026) khoá
// công ty + phiếu FOR UPDATE rồi tra mã (trả kết quả cũ KHÔNG so nội dung), rồi so phiên bản. Vòng của trình duyệt đọc lại
// phiếu và bỏ qua phiếu đã ở đúng sổ.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from '../../__tests__/fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { useUpdateBatchAccount } from '../batch';

type Row = Record<string, unknown>;
const move = (accountId: string) => (renderHook(() => useUpdateBatchAccount()).result.current as unknown as { mutationFn: (v: unknown) => Promise<{ count: number }> }).mutationFn({ batchId: 'b1', accountId, reason: 'Đổi sổ ghi phiếu' });
const revisions = () => io.server.rpcCalls.filter(call => call.name === 'revise_pending_income_expense_v1');
let changes = 0;
function install() {
  changes = 0;
  io.server.rows.income_expense_batch_items = [{ batch_id: 'b1', income_expense_id: 'v1' }, { batch_id: 'b1', income_expense_id: 'v2' }];
  io.server.rows.income_expenses = [
    { id: 'v1', code: 'PC1', approval_status: 'UNAPPROVED', approval_version: 1, account_id: 'old' },
    { id: 'v2', code: 'PC2', approval_status: 'UNAPPROVED', approval_version: 1, account_id: 'old' },
  ];
  const seen = new Map<string, Row>();
  io.server.rpcHandlers.revise_pending_income_expense_v1 = args => {
    const voucher = io.server.rows.income_expenses.find(row => row.id === args.p_voucher)!;
    const prior = seen.get(String(args.p_idempotency_key));
    // Trả kết quả cũ theo mã mà không so nội dung (đúng thân hàm production).
    if (prior) return { data: { ...prior, replayed: true }, error: null };
    if (voucher.approval_version !== args.p_expected_approval_version) return { data: null, error: { code: 'PT409', message: 'Phiếu vừa được người khác sửa — tải lại để xem thay đổi.' } };
    changes += 1;
    voucher.account_id = (args.p_patch as Row).account_id;
    voucher.approval_version = Number(voucher.approval_version) + 1;
    const result = { id: voucher.id, changed: true, approval_version: voucher.approval_version, changed_fields: ['account_id'] };
    seen.set(String(args.p_idempotency_key), result);
    return { data: result, error: null };
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-1');
  io.server = fakeRecordServer();
  install();
});

describe('đổi sổ đợt phiếu (cách A)', () => {
  it('lệnh không tới máy chủ ở phiếu đầu: chạy lại ngay, đổi đủ hai phiếu', async () => {
    io.server.failNext('revise_pending_income_expense_v1', 'rpc', 'drop-before');
    await expect(move('new')).rejects.toBeTruthy();
    await expect(move('new')).resolves.toEqual({ count: 2 });
    expect(io.server.rows.income_expenses.map(row => row.account_id)).toEqual(['new', 'new']);
    expect(changes).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi ở phiếu đầu: chạy lại bỏ qua phiếu đã đúng sổ, mỗi phiếu đổi một lần', async () => {
    io.server.failNext('revise_pending_income_expense_v1', 'rpc', 'drop-after');
    await expect(move('new')).rejects.toBeTruthy();
    await expect(move('new')).resolves.toEqual({ count: 1 });
    expect(io.server.rows.income_expenses.map(row => row.account_id)).toEqual(['new', 'new']);
    expect(changes).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi ở phiếu cuối: chạy lại không đổi gì thêm', async () => {
    const inner = io.server.rpcHandlers.revise_pending_income_expense_v1!;
    let call = 0;
    io.server.rpcHandlers.revise_pending_income_expense_v1 = args => { call += 1; const result = inner(args); return call === 2 ? { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } } : result; };
    await expect(move('new')).rejects.toBeTruthy();
    await expect(move('new')).resolves.toEqual({ count: 0 });
    expect(changes).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });

  it('chạy lại sang sổ khác với lần kẹt: mã gồm sổ đích, không nhận "đã đổi" của lần trước khi phiếu còn ở sổ cũ', async () => {
    io.server.failNext('revise_pending_income_expense_v1', 'rpc', 'drop-after');
    await expect(move('new')).rejects.toBeTruthy();
    await expect(move('other')).resolves.toEqual({ count: 2 });
    expect(io.server.rows.income_expenses.map(row => row.account_id)).toEqual(['other', 'other']);
  });

  it('dấu cũ gieo sẵn: chạy lại ngay, không khoá đợt', async () => {
    seedLegacyPending({ namespace: 'voucher-batch-account', userId: 'actor', organizationId: 'org-1', businessKey: 'b1' }, new Date(Date.now() - 30_000));
    await expect(move('new')).resolves.toEqual({ count: 2 });
    expect(revisions()).toHaveLength(2);
    expect(pendingKeys()).toEqual([]);
  });
});
