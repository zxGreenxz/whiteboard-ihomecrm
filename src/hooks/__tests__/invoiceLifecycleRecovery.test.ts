// @vitest-environment jsdom
// Đợt 5: khôi phục, buộc huỷ, huỷ lẻ một hoá đơn (cách C). Ba hàm production (25/11/2026) khoá hợp đồng + hoá đơn rồi mới
// xét trạng thái và trả `noop` khi đã ở đích. Trình duyệt đọc trạng thái hoá đơn TRƯỚC khi ghi dấu; lần bấm sau so lại.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, user: { id: 'actor' } as { id: string } | null }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }), keepPreviousData: undefined }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => io.user }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { useCancelInvoice, useForceCancelInvoice, useRestoreInvoice } from '../useInvoices';

type Row = Record<string, unknown>;
const fn = (hook: () => unknown) => {
  const { result } = renderHook(hook);
  return (result.current as { mutationFn: (id: string) => Promise<unknown> }).mutationFn;
};
const invoice = () => io.server.rows.invoices[0] as Row;
const calls = (name: string) => io.server.rpcCalls.filter(call => call.name === name);
const scope = (namespace: string) => ({ namespace, userId: 'actor', organizationId: 'org-a', businessKey: 'i1' });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.user = { id: 'actor' };
  io.server = fakeRecordServer();
  io.server.rows.invoices = [{ id: 'i1', invoice_number: 'HD2511-07', status: 'APPROVED', paid_amount: 0, deleted_at: null }];
  const locked = (target: string, allowed: (row: Row) => boolean) => (args: Row) => {
    const row = io.server.rows.invoices.find(item => item.id === args.p_invoice_id) as Row;
    if (row.status === target) return { data: { invoice: { ...row }, credit: null, noop: true }, error: null };
    if (!allowed(row)) return { data: null, error: { code: '55000', message: 'trạng thái không hợp lệ' } };
    row.status = target;
    return { data: { invoice: { ...row }, credit: null, noop: false }, error: null };
  };
  io.server.rpcHandlers.cancel_invoice_with_credit_v1 = locked('CANCELLED', row => ['DRAFT', 'APPROVED'].includes(String(row.status)));
  io.server.rpcHandlers.super_admin_force_cancel_invoice_with_credit_v1 = locked('CANCELLED', () => true);
  io.server.rpcHandlers.restore_invoice_with_credit_v1 = locked('APPROVED', row => row.status === 'CANCELLED');
});

describe.each([
  ['huỷ lẻ', 'invoice-cancel', 'cancel_invoice_with_credit_v1', () => useCancelInvoice(), 'APPROVED', 'CANCELLED'],
  ['buộc huỷ', 'invoice-force-cancel', 'super_admin_force_cancel_invoice_with_credit_v1', () => useForceCancelInvoice(), 'PAID', 'CANCELLED'],
  ['khôi phục', 'invoice-restore', 'restore_invoice_with_credit_v1', () => useRestoreInvoice(), 'CANCELLED', 'APPROVED'],
] as const)('%s hoá đơn', (_label, namespace, rpcName, hook, from, to) => {
  beforeEach(() => { invoice().status = from; });
  it('lệnh không tới máy chủ: hoá đơn còn như lúc bấm ⇒ gửi lại ngay đúng mã cũ, làm một lần', async () => {
    io.server.failNext(rpcName, 'rpc', 'drop-before');
    await expect(fn(hook)('i1')).rejects.toBeTruthy();
    await expect(fn(hook)('i1')).resolves.toMatchObject({ invoice: { status: to } });
    const keys = calls(rpcName).map(call => call.args.p_idempotency_key);
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc thấy đã ở đích ⇒ báo «không thay đổi», không gửi lần hai', async () => {
    io.server.failNext(rpcName, 'rpc', 'drop-after');
    await expect(fn(hook)('i1')).rejects.toBeTruthy();
    expect(invoice().status).toBe(to);
    await expect(fn(hook)('i1')).resolves.toMatchObject({ noop: true, invoice: { status: to } });
    expect(calls(rpcName)).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu cũ gieo sẵn (không có trạng thái trước khi bấm): đủ điều kiện ⇒ gửi lại đúng mã cũ', async () => {
    seedLegacyPending(scope(namespace), new Date(Date.now() - 10 * 60_000));
    await expect(fn(hook)('i1')).resolves.toMatchObject({ invoice: { status: to } });
    expect(calls(rpcName)[0].args.p_idempotency_key).toBe('legacy-attempt');
    expect(pendingKeys()).toEqual([]);
  });
});

describe('huỷ lẻ: phép đọc đứng trước khi ghi dấu', () => {
  it('hết phiên đăng nhập: không ghi dấu, không gửi', async () => {
    io.user = null;
    await expect(fn(() => useCancelInvoice())('i1')).rejects.toThrow(/Not authenticated/);
    expect(pendingKeys()).toEqual([]);
    expect(calls('cancel_invoice_with_credit_v1')).toHaveLength(0);
  });
  it('đọc hoá đơn hỏng: không ghi dấu, không gửi', async () => {
    io.server.failNext('invoices', 'read', 'drop-before');
    await expect(fn(() => useCancelInvoice())('i1')).rejects.toBeTruthy();
    expect(pendingKeys()).toEqual([]);
  });
  it('hoá đơn đã thu tiền: từ chối rõ, không để lại dấu', async () => {
    Object.assign(invoice(), { status: 'PARTIAL_PAID', paid_amount: 500 });
    await expect(fn(() => useCancelInvoice())('i1')).rejects.toMatchObject({ outcome: 'failure' });
    expect(pendingKeys()).toEqual([]);
    expect(calls('cancel_invoice_with_credit_v1')).toHaveLength(0);
  });
});
