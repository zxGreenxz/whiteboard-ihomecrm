// @vitest-environment jsdom
// Đợt 5: lưu trữ (xoá) sổ quỹ (cách C). archive_cashbook_v1 (production 25/11/2026) khoá sổ chưa lưu trữ FOR UPDATE rồi
// mới xét; gửi lại khi sổ đã lưu trữ chỉ ra lỗi «không tìm thấy sổ quỹ». Lưu trữ tách khỏi dấu chung của sửa sổ.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/actionFeedback', () => ({ notifyActionError: vi.fn() }));

import { useDeleteAccount, useUpdateAccount } from '../useAccounts';

const archive = () => {
  const { result } = renderHook(() => useDeleteAccount());
  return (result.current as unknown as { mutationFn: (id: string) => Promise<unknown> }).mutationFn;
};
const calls = () => io.server.rpcCalls.filter(call => call.name === 'archive_cashbook_v1').length;

beforeEach(() => {
  localStorage.clear();
  io.server = fakeRecordServer();
  io.server.rows.accounts = [{ id: 'book1', deleted_at: null }, { id: 'book2', deleted_at: null }];
  io.server.rpcHandlers.archive_cashbook_v1 = args => {
    const row = io.server.rows.accounts.find(item => item.id === args.p_cashbook_id && !item.deleted_at);
    if (!row) return { data: null, error: { code: '42501', message: 'Không tìm thấy sổ quỹ' } };
    row.deleted_at = new Date().toISOString();
    return { data: { cashbook_id: row.id, archived: true }, error: null };
  };
  io.server.rpcHandlers.update_cashbook_metadata_v1 = () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } });
});

describe('lưu trữ sổ quỹ', () => {
  it('lệnh không tới máy chủ: sổ còn hoạt động ⇒ gửi lại ngay (máy chủ khoá sổ rồi mới xét)', async () => {
    io.server.failNext('archive_cashbook_v1', 'rpc', 'drop-before');
    await expect(archive()('book1')).rejects.toBeTruthy();
    await expect(archive()('book1')).resolves.toBeUndefined();
    expect(io.server.rows.accounts[0].deleted_at).not.toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc thấy sổ đã lưu trữ ⇒ báo, không gửi lần hai', async () => {
    io.server.failNext('archive_cashbook_v1', 'rpc', 'drop-after');
    await expect(archive()('book1')).rejects.toBeTruthy();
    await expect(archive()('book1')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('lưu trữ') });
    expect(calls()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu chung `cashbook-lifecycle` (sửa sổ hoặc lưu trữ bản trước) của đúng sổ: chặn lưu trữ, không gửi; sổ khác lưu trữ được', async () => {
    seedLegacyPending({ namespace: 'cashbook-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'book1' }, new Date(Date.now() - 10 * 60_000));
    await expect(archive()('book1')).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls()).toBe(0);
    await expect(archive()('book2')).resolves.toBeUndefined();
  });
  it('lưu trữ kẹt không chặn sửa sổ đó', async () => {
    io.server.failNext('archive_cashbook_v1', 'rpc', 'drop-before');
    await expect(archive()('book1')).rejects.toBeTruthy();
    const { result } = renderHook(() => useUpdateAccount());
    const update = (result.current as unknown as { mutationFn: (input: unknown) => Promise<unknown> }).mutationFn;
    await update({ id: 'book1', values: { name: 'Sổ A', initial_amount: 0, initial_date: '2026-09-30' } }).catch(() => undefined);
    expect(io.server.rpcCalls.filter(call => call.name === 'update_cashbook_metadata_v1')).toHaveLength(1);
  });
});
