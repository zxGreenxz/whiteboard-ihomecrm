// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceWithRelations } from '@/types/invoice';

const mock = vi.hoisted(() => ({
  mutateAsync: vi.fn().mockResolvedValue({ failures: [], voucherIds: [] }),
  docSoNhan: vi.fn(),
  soNhan: {
    collectorUserId: 'collector',
    personalCashBook: { id: 'cash', name: 'Hiệp Thu' } as { id: string; name: string } | null,
    TK: [
      { id: 'mbhiep', name: 'MBHIEP', isDefault: true },
      { id: 'tkhiep', name: 'TKHIEP', isDefault: false },
    ],
    TT: [] as Array<{ id: string; name: string; isDefault: boolean }>,
  },
}));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [
  { id: 'cash', name: 'Chung', is_virtual: false },
] }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'collector' } }) }));
vi.mock('@/hooks/useBulkRecordPayment', () => ({ useBulkRecordPayment: () => ({ mutateAsync: mock.mutateAsync }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-chon' }) }));
vi.mock('@/hooks/useReceivingCashbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useReceivingCashbooks')>();
  return {
    ...actual,
    useReceivingCashbooks: (...args: unknown[]) => {
      mock.docSoNhan(...args);
      return { data: mock.soNhan, isError: false, error: null };
    },
  };
});
vi.mock('@/lib/v5PaymentGps', () => ({ captureGpsAndRecord: vi.fn() }));
import { useQuickCollect } from '../useQuickCollect';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mock.soNhan.personalCashBook = { id: 'cash', name: 'Hiệp Thu' };
  mock.soNhan.TT = [];
});

const invoice = {
  id: 'invoice',
  organization_id: 'org-hd',
  building_id: 'toa',
  building: { id: 'toa', name: '403PVB' },
  total_amount: 1_000_000,
  paid_amount: 0,
} as InvoiceWithRelations;

it('records deposit shortage as debt without requiring a rounding book', async () => {
  const { result } = renderHook(() => useQuickCollect({ invoice }));
  await result.current.collect({ invoice, amount: 995_000, allowRounding: false });
  expect(mock.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({
    amount_tm: 995_000, rounding_amount: 0, rounding_account_id: null,
  })] }));
});

describe('useQuickCollect — sổ nhận theo hình thức (máy chủ quyết)', () => {
  it('đọc sổ theo tổ chức + toà của CHÍNH hoá đơn', () => {
    renderHook(() => useQuickCollect({ invoice }));
    expect(mock.docSoNhan).toHaveBeenCalledWith('org-hd', 'toa');
  });

  it('tiền mặt vào sổ tiền mặt riêng; sổ chọn tay cho TM bị bỏ qua', async () => {
    const { result } = renderHook(() => useQuickCollect({ invoice }));
    await result.current.collect({
      invoice,
      lines: [{ method: 'TM', amount: 1_000_000 }],
      accountOverrides: { TM: 'so-khac' },
    });
    expect(mock.mutateAsync.mock.lastCall?.[0].items[0]).toMatchObject({
      account_id: 'cash',
      accounts: { TM: 'cash' },
    });
  });

  it('chuyển khoản: nhận sổ chọn tay nếu nằm trong danh sách, không thì sổ mặc định', async () => {
    const { result } = renderHook(() => useQuickCollect({ invoice }));
    await result.current.collect({ invoice, lines: [{ method: 'TK', amount: 1_000_000 }], accountOverrides: { TK: 'tkhiep' } });
    expect(mock.mutateAsync.mock.lastCall?.[0].items[0].accounts).toEqual({ TK: 'tkhiep' });
    await result.current.collect({ invoice, lines: [{ method: 'TK', amount: 1_000_000 }], accountOverrides: { TK: 'ngoai-danh-sach' } });
    expect(mock.mutateAsync.mock.lastCall?.[0].items[0].accounts).toEqual({ TK: 'mbhiep' });
  });

  it('thiếu sổ tiền mặt riêng: chặn thu tiền mặt, không rơi về sổ khác', async () => {
    mock.soNhan.personalCashBook = null;
    const { result } = renderHook(() => useQuickCollect({ invoice }));
    expect(result.current.receivingBlockFor('TM')).toBe(
      'Người thu chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền.',
    );
    await expect(result.current.collect({ invoice, amount: 500_000 })).rejects.toThrow(/chưa có sổ tiền mặt riêng/);
    expect(mock.mutateAsync).not.toHaveBeenCalled();
  });

  it('toà chưa cài sổ Thanh toán: chặn đúng hình thức đó', async () => {
    const { result } = renderHook(() => useQuickCollect({ invoice }));
    await expect(
      result.current.collect({ invoice, lines: [{ method: 'TT', amount: 1_000_000 }] }),
    ).rejects.toThrow(
      'Người thu chưa dùng được sổ nhận Thanh toán nào của toà 403PVB: toà chưa cài sổ, ' +
        'hoặc người thu chưa được giao giữ/biết sổ đó — nhờ chủ công ty kiểm ở Sổ quỹ → Sổ nhận tiền.',
    );
    expect(mock.mutateAsync).not.toHaveBeenCalled();
  });

  it('không thu hộ hoá đơn khác hoá đơn đang mở (danh sách sổ theo toà khác)', async () => {
    const { result } = renderHook(() => useQuickCollect({ invoice }));
    await expect(
      result.current.collect({ invoice: { ...invoice, id: 'khac' }, amount: 100_000 }),
    ).rejects.toThrow(/đóng rồi mở lại/);
  });
});
