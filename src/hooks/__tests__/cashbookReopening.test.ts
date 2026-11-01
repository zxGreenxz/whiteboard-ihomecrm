// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
const h = vi.hoisted(() => ({ rpc: vi.fn(), invalidate: vi.fn(), success: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: h.invalidate }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('sonner', () => ({ toast: { success: h.success } }));
import { useCashbookReopeningState, useReopenCashbook } from '../useCashbookReopening';
import { readCashbookReopeningState, reopenCashbook, type ReopenCashbookInput } from '@/lib/cashbookReopening';
import { financialPending } from '@/lib/financialPending';

const book = 'a0000000-0000-4000-8000-000000000001';
const other = 'a0000000-0000-4000-8000-000000000002';
const key = 'b0000000-0000-4000-8000-000000000001';
const eventId = 'c0000000-0000-4000-8000-000000000001';
const input: ReopenCashbookInput = { cashbookId: book, cashbookName: 'Sổ kiểm thử', reason: 'Đối chiếu lại chứng từ', expectedLockDate: '2026-10-30', expectedRevision: 'revision-before' };
const state = { cashbook_id: book, can_reopen: true, blocked_reason: null, lock_date: input.expectedLockDate, revision: input.expectedRevision, history: [] };
const receipt = (requestKey = key) => ({ cashbook_id: book, reopening_id: eventId, status: 'REOPENED', lock_date: null, idempotency_key: requestKey, previous_revision: input.expectedRevision });
const scope = { namespace: 'cashbook-reopening', userId: 'actor', organizationId: 'actor-scope', businessKey: book };
const mutation = () => renderHook(useReopenCashbook).result.current as unknown as {
  mutationFn: (value: ReopenCashbookInput) => Promise<unknown>;
  onSuccess: (result: unknown, value: ReopenCashbookInput) => void;
};
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); h.rpc.mockReset(); });
afterEach(cleanup);

describe('cashbook reopening boundary', () => {
  it('does not query a missing cashbook', () => {
    expect(renderHook(() => useCashbookReopeningState(null)).result.current).toMatchObject({ enabled: false });
  });
  it.each([null, {}, { ...state, cashbook_id: other }, { ...state, can_reopen: 'true' }, { ...state, lock_date: '2026-02-31' }, { ...state, lock_date: null }])('does not cache an unverified permission/state response: %j', async data => {
    h.rpc.mockResolvedValue({ data, error: null });
    await expect(readCashbookReopeningState(book)).rejects.toThrow('Chưa xác nhận');
  });
  it('allows a verified denied state and retains server permission errors', async () => {
    h.rpc.mockResolvedValueOnce({ data: { ...state, can_reopen: false }, error: null });
    await expect(readCashbookReopeningState(book)).resolves.toMatchObject({ can_reopen: false });
    const error = { code: '42501', message: '[REOPEN_FORBIDDEN]' };
    h.rpc.mockResolvedValueOnce({ data: null, error });
    await expect(readCashbookReopeningState(book)).rejects.toBe(error);
  });
  it.each(['', '    ', 'ngắn', 'x'.repeat(1001)])('rejects an invalid reason before dispatch: %s', async reason => {
    await expect(mutation().mutationFn({ ...input, reason })).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(financialPending.read(scope)).toBeNull();
  });
  it('sends trimmed reason, exact revision and stable request key', async () => {
    h.rpc.mockResolvedValue({ data: receipt(), error: null });
    await expect(reopenCashbook({ ...input, reason: `  ${input.reason}  ` }, key)).resolves.toEqual(receipt());
    expect(h.rpc).toHaveBeenCalledWith('reopen_cashbook_v1', {
      p_cashbook: book, p_reason: input.reason, p_expected_lock_date: input.expectedLockDate,
      p_expected_revision: input.expectedRevision, p_idempotency_key: key,
    });
  });
  it.each([null, {}, { ...receipt(), cashbook_id: other }, { ...receipt(), idempotency_key: other }, { ...receipt(), previous_revision: 'different' }, { ...receipt(), lock_date: input.expectedLockDate }])('cannot announce success from a mismatched receipt: %j', async data => {
    h.rpc.mockResolvedValue({ data, error: null });
    await expect(reopenCashbook(input, key)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(h.success).not.toHaveBeenCalled();
  });
  it('a confirmed denial clears the pending marker so a corrected request can run', async () => {
    const error = { code: 'PT409', message: '[REOPEN_STALE]' };
    h.rpc.mockResolvedValueOnce({ data: null, error });
    const write = mutation().mutationFn;
    await expect(write(input)).rejects.toBe(error);
    expect(financialPending.read(scope)).toBeNull();
    h.rpc.mockImplementation(async (_name, args) => ({ data: receipt(args.p_idempotency_key), error: null }));
    await expect(write(input)).resolves.toMatchObject({ status: 'REOPENED' });
    expect(financialPending.read(scope)).toBeNull();
  });
  it('unknown completion survives remount and organization change without another write', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { status: 504, message: 'timeout' } });
    await expect(mutation().mutationFn(input)).rejects.toMatchObject({ outcome: 'unknown' });
    const pending = financialPending.read(scope);
    expect(pending?.requestKey).toBe(h.rpc.mock.calls[0][1].p_idempotency_key);
    localStorage.setItem('ihomecrm.selectedOrganizationId', 'another-organization');
    h.rpc.mockResolvedValueOnce({ data: state, error: null });
    await expect(mutation().mutationFn(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(h.rpc.mock.calls.map(call => call[0])).toEqual(['reopen_cashbook_v1', 'cashbook_reopening_state_v1']);
    expect(financialPending.read(scope)?.requestKey).toBe(pending?.requestKey);
  });
  it('recovers from the exact recorded request after re-close without reopening the new period', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { status: 504, message: 'timeout' } });
    await expect(mutation().mutationFn(input)).rejects.toMatchObject({ outcome: 'unknown' });
    const pendingKey = financialPending.read(scope)!.requestKey!;
    h.rpc.mockResolvedValueOnce({ data: { ...state, revision: 'reclosed-same-day', history: [{
      id: eventId, reopened_at: '2026-10-31T09:00:00+00:00', reopened_by_name: 'Chủ kiểm thử',
      reason: input.reason, previous_lock_date: input.expectedLockDate, idempotency_key: pendingKey, previous_revision: input.expectedRevision,
    }] }, error: null });
    await expect(mutation().mutationFn({ ...input, expectedRevision: 'reclosed-same-day' })).resolves.toEqual(receipt(pendingKey));
    expect(h.rpc.mock.calls.filter(call => call[0] === 'reopen_cashbook_v1')).toHaveLength(1);
    expect(financialPending.read(scope)).toBeNull();
  });
  it('only success refreshes closing, account, period and history state', () => {
    mutation().onSuccess(receipt(), input);
    for (const prefix of ['accounts', 'accounts-with-balance', 'cashbook-closing-monthly', 'cashbook-reopening', 'cashbook-closings', 'income-expenses']) {
      expect(h.invalidate).toHaveBeenCalledWith({ queryKey: [prefix] });
    }
    expect(h.success).toHaveBeenCalledTimes(1);
  });
});
