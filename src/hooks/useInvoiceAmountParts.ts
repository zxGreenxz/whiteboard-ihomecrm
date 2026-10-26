// =============================================
// useInvoiceAmountParts — Báo cáo LN: tách số tiền thu theo hoá đơn thành Tiền phòng / Điện / Nước / PDV
// (chủ chốt 25/10/2026). Server chia (public.invoice_amount_parts_v1 — INVOKER + RLS, cùng công thức với gói
// quyết toán vận hành); web chỉ hiển thị. Dòng không có phần tách (hoá đơn không đọc được / không có dòng
// doanh thu) không nằm trong Map ⇒ nơi dùng hiện kiểu cũ. Lỗi thì THROW để màn báo, không nuốt thành rỗng.
// =============================================
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invoiceAmountPartsRowsSchema, type InvoiceAmountParts } from '@/lib/invoiceAmountParts';

export type InvoicePartsRequest = { key: string; invoiceId: string; amount: number };

/** RPC nhận tối đa 3000 dòng mỗi lần. */
const CHUNK = 3000;

export function useInvoiceAmountParts(rows: readonly InvoicePartsRequest[], enabled = true) {
  // xếp theo key để queryKey ổn định (không gọi lại oan khi thứ tự dòng đổi)
  const payload = rows
    .map((r) => ({ key: r.key, invoice_id: r.invoiceId, amount: r.amount }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
