// @vitest-environment jsdom
// Tên hiển thị danh sách Thu chi (chủ nhắn 23/10/2026): chỉ đọc hoá đơn của phiếu mang tên tự sinh,
// chưa có dữ liệu ⇒ tên gốc. Id / mã giả.
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoiceTitlePartsOf } from '@/lib/invoiceUtils';

const state = vi.hoisted(() => ({ ids: [] as string[][], data: undefined as unknown }));
vi.mock('@/hooks/useInvoiceTotalsByIds', () => ({
  useInvoiceTotalsByIds: (ids: string[]) => { state.ids.push(ids); return { data: state.data }; },
}));

import { useVoucherDisplayNames } from '@/hooks/useVoucherDisplayNames';

afterEach(() => { cleanup(); state.ids = []; state.data = undefined; });

const ds = [
  { name: 'Thu tiền theo HĐ INV-2026-00001', invoice_id: 'hd-1', room_name: '203' },
  { name: 'Doanh thu bỏ cọc — HĐ HD-2026-0012', invoice_id: 'hd-2', room_name: '203' },
  { name: 'Mua bóng đèn', invoice_id: null, room_name: null },
];

it('đọc đúng hoá đơn cần dựng tên; có dữ liệu ⇒ tên hoá đơn (không chèn phòng — bảng có cột phòng)', () => {
  state.data = new Map([['hd-1', {
    titleParts: invoiceTitlePartsOf({ kind: 'MONTHLY', billing_month: '2026-10', invoice_items: [{ type: 'RENT' }, { type: 'SERVICE' }] }),
  }]]);
  const { result } = renderHook(() => useVoucherDisplayNames(ds, { includeRoom: false }));
  expect(state.ids.at(-1)).toEqual(['hd-1']);
  expect(ds.map(result.current)).toEqual(['TIỀN PHÒNG - 10/2026', 'Doanh thu bỏ cọc', 'Mua bóng đèn']);
});

it('chưa tải xong hoá đơn ⇒ tên gốc của phiếu tự sinh', () => {
  const { result } = renderHook(() => useVoucherDisplayNames(ds, { includeRoom: true }));
  expect(ds.map(result.current)).toEqual(['Thu tiền theo HĐ INV-2026-00001', 'Doanh thu bỏ cọc — phòng 203', 'Mua bóng đèn']);
});
