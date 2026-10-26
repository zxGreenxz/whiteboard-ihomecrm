// =============================================
// useInvoiceAmountParts — Báo cáo LN: tách số tiền thu theo hoá đơn thành Tiền phòng / Điện / Nước / PDV
// (chủ chốt 25/10/2026). Server chia VÀ quyết phiếu nào được tách (public.invoice_amount_parts_v1 — INVOKER +
// RLS, cùng hàm với gói quyết toán vận hành); web chỉ hiển thị. Dòng không có phần tách (phiếu hạn chế / thanh
// lý / nhiều hạng mục, hoá đơn không đọc được…) không nằm trong Map ⇒ nơi dùng hiện kiểu cũ. Lỗi thì THROW để
// màn báo, không nuốt thành rỗng.
// =============================================
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invoiceAmountPartsRowsSchema, type InvoiceAmountParts } from '@/lib/invoiceAmountParts';

/** Một dòng báo cáo: số tiền (có thể gộp nhiều phiếu cùng hoá đơn) + id các phiếu đó. */
export type InvoicePartsRequest = { key: string; invoiceId: string; amount: number; voucherIds: readonly string[] };

/** RPC nhận tối đa 3000 dòng mỗi lần. */
const CHUNK = 3000;

export function useInvoiceAmountParts(rows: readonly InvoicePartsRequest[], enabled = true) {
  // xếp theo key để queryKey ổn định (không gọi lại oan khi thứ tự dòng đổi); số tiền làm tròn tới đồng — cộng
  // phân bổ kỳ ở web có thể ra số lẻ kiểu 7625000.000000001
  const payload = useMemo(
    () => rows
      .map((r) => ({ key: r.key, invoice_id: r.invoiceId, amount: Math.round(r.amount), voucher_ids: [...r.voucherIds].sort() }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    [rows],
  );
  return useQuery({
    queryKey: ['invoice-amount-parts', payload],
    enabled: enabled && payload.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, InvoiceAmountParts>> => {
      const out = new Map<string, InvoiceAmountParts>();
      for (let i = 0; i < payload.length; i += CHUNK) {
        const { data, error } = await supabase.rpc('invoice_amount_parts_v1', { p_rows: payload.slice(i, i + CHUNK) });
        if (error) throw error;
        for (const { key, ...parts } of invoiceAmountPartsRowsSchema.parse(data)) out.set(key, parts);
      }
      return out;
    },
  });
}
