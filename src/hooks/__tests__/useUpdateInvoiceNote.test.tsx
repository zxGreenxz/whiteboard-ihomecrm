// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useUpdateInvoiceNote } from '../useUpdateInvoiceNote';
const state = vi.hoisted(() => ({ row: { id: 'inv', status: 'APPROVED', paid_amount: 0, adjustment_revision: 0, deleted_at: null as string | null, notes: 'old' } }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: { mutationFn: unknown }) => ({ mutateAsync: options.mutationFn }), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const predicates: Array<(row: typeof state.row) => boolean> = [];
  let notes: string | null = null;
  const builder = {
    update: (values: { notes: string | null }) => { notes = values.notes; return builder; },
    eq: (key: keyof typeof state.row, value: unknown) => { predicates.push(row => row[key] === value); return builder; },
    is: (key: keyof typeof state.row, value: unknown) => { predicates.push(row => row[key] === value); return builder; },
    select: async () => { const matched = predicates.every(predicate => predicate(state.row)); if (matched) state.row.notes = notes ?? ''; return { data: matched ? [{ id: state.row.id }] : [], error: null }; },
  }; return builder;
} } }));
beforeEach(() => { state.row = { id: 'inv', status: 'APPROVED', paid_amount: 0, adjustment_revision: 0, deleted_at: null, notes: 'old' }; });
it.each(['APPROVED', 'PAID', 'PARTIAL_PAID', 'OVERDUE', 'CANCELLED'])('does not directly write notes for %s', async status => {
  state.row.status = status;
  const { result } = renderHook(useUpdateInvoiceNote);
  await expect(result.current.mutateAsync({ invoice_id: 'inv', notes: 'new' })).rejects.toThrow();
  expect(state.row.notes).toBe('old');
});
it('writes only an unrevised unpaid active draft', async () => {
  state.row.status = 'DRAFT'; const { result } = renderHook(useUpdateInvoiceNote);
  await result.current.mutateAsync({ invoice_id: 'inv', notes: ' new ' }); expect(state.row.notes).toBe('new');
  state.row.adjustment_revision = 1;
  await expect(result.current.mutateAsync({ invoice_id: 'inv', notes: 'wrong' })).rejects.toThrow();
  expect(state.row.notes).toBe('new');
});
