// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { InvoiceWithRelations } from '@/types/invoice';

const mock = vi.hoisted(() => ({ mutateAsync: vi.fn().mockResolvedValue({ failures: [], voucherIds: [] }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [
  { id: 'cash', name: 'Chung', is_virtual: false },
] }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'collector' } }) }));
vi.mock('@/hooks/useBulkRecordPayment', () => ({ useBulkRecordPayment: () => ({ mutateAsync: mock.mutateAsync }) }));
vi.mock('@/lib/v5PaymentGps', () => ({ captureGpsAndRecord: vi.fn() }));
import { useQuickCollect } from '../useQuickCollect';
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('records deposit shortage as debt without requiring a rounding book', async () => {
  const { result } = renderHook(() => useQuickCollect());
  const invoice = { id: 'invoice', total_amount: 1_000_000, paid_amount: 0 } as InvoiceWithRelations;
  await result.current.collect({ invoice, amount: 995_000, allowRounding: false });
  expect(mock.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({
    amount_tm: 995_000, rounding_amount: 0, rounding_account_id: null,
  })] }));
});
