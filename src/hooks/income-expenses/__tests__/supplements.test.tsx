// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateIncomeExpenseSupplements, useAppendIncomeExpenseSupplement } from '../supplements';

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], error: null as {message:string} | null, rpc: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: state.rpc,
  from: () => {
    let ids: string[] = [];
    const query = { select: () => query, in: (_: string, values: string[]) => { ids = values; return query; },
      order: () => query, range: async (from: number, to: number) => ({
        data: state.rows.filter(row => ids.includes(String(row.income_expense_id))).slice(from, to + 1), error: state.error,
      }) };
    return query;
  },
} }));
const voucherId = '00000000-0000-4000-8000-000000000001';
const row = { id: '00000000-0000-4000-8000-000000000002', organization_id: 'dddd0000-0000-4000-8000-000000000001',
  income_expense_id: voucherId, note: 'Bổ sung', attachments: ['https://proof.test/new.png'],
  actor_id: '00000000-0000-4000-8000-000000000003', actor_name: 'Kế toán DEMO', created_at: '2026-09-10T04:00:00Z' };
afterEach(() => { cleanup(); state.rows=[]; state.error=null; state.rpc.mockReset(); });

describe('supplement read and mutation boundary', () => {
  it('reads beyond the REST page cap without altering original writer fields', async () => {
    state.rows = Array.from({ length: 1501 }, (_, index) => ({ ...row,
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12,'0')}` }));
    const original = { id: voucherId, notes: '[THU TACH COC test]', attachments: ['original'] };
    const [result] = await hydrateIncomeExpenseSupplements([original]);
    expect(result.supplements).toHaveLength(1501);
    expect(result.supplements[1500].id).toBe(state.rows[1500].id);
    expect(result.notes).toBe(original.notes); expect(result.attachments).toBe(original.attachments);
    expect(original).not.toHaveProperty('supplements');
  });
  it('keeps read failures as errors instead of reporting an empty successful history', async () => {
    state.error = { message: 'fixture error' };
    await expect(hydrateIncomeExpenseSupplements([{ id: voucherId }])).rejects.toThrow('Không tải được');
  });
  it('sends only additions and a retry identity, parses the saved response', async () => {
    state.rpc.mockResolvedValue({ data: { id: row.id, income_expense_id: voucherId, changed: true }, error: null });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const hook = renderHook(useAppendIncomeExpenseSupplement, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    const input = { voucherId, note: '  Mô tả mới\nDòng mới  ', attachments: row.attachments, idempotencyKey: 'retry-owned', total_amount: 9, approval_status: 'CANCELLED' };
    await act(async () => { await hook.result.current.mutateAsync(input); });
    expect(state.rpc).toHaveBeenCalledWith('append_income_expense_supplement_v1', {
      p_voucher: voucherId, p_note: 'Mô tả mới\nDòng mới', p_attachments: row.attachments, p_idempotency_key: 'retry-owned',
    });
    await waitFor(() => expect(hook.result.current.data).toMatchObject({ id: row.id, changed: true }));
  });
});
