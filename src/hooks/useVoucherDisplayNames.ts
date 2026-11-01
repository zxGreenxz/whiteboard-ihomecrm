// Tên hiển thị của danh sách phiếu thu/chi (Thu chi: bảng desktop, thẻ điện thoại). Luật ở
// src/lib/voucherDisplayName.ts. Chỉ đọc hoá đơn của phiếu mang tên tự sinh "Thu tiền theo HĐ …";
// chưa tải xong / lỗi / không có quyền đọc hoá đơn ⇒ tên gốc (không chặn danh sách).
import { useCallback, useMemo } from 'react';
import { useInvoiceTotalsByIds } from '@/hooks/useInvoiceTotalsByIds';
import { invoiceIdsForDisplay, voucherDisplayName } from '@/lib/voucherDisplayName';

export interface VoucherNameSource {
  name: string | null;
  invoice_id?: string | null;
  room_name?: string | null;
}

/** `includeRoom`: true ở nơi KHÔNG có cột / dòng phòng riêng (tên phòng chèn vào tên). */
export function useVoucherDisplayNames(vouchers: readonly VoucherNameSource[], opts: { includeRoom: boolean }) {
  const ids = useMemo(() => invoiceIdsForDisplay(vouchers), [vouchers]);
  const { data: invoices } = useInvoiceTotalsByIds(ids);
  const { includeRoom } = opts;
  return useCallback(
    (v: VoucherNameSource): string => voucherDisplayName(
      { name: v.name, roomName: v.room_name, invoice: v.invoice_id ? invoices?.get(v.invoice_id)?.titleParts : null },
      { includeRoom },
    ),
    [invoices, includeRoom],
  );
}
