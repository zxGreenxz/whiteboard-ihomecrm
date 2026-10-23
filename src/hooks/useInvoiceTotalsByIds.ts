// =============================================
// useInvoiceTotalsByIds — lấy GỌN tổng/đã trả/còn lại + tên của nhiều hoá đơn theo id.
// Dùng cho báo cáo gộp khoản thu theo hoá đơn (note thiếu/thừa so với HĐ) và tên hiển thị
// của phiếu thu theo hoá đơn (src/lib/voucherDisplayName.ts — Báo cáo LN, Thu chi).
// Chỉ cần vài cột số, không kéo cả quan hệ như useInvoice. Tách khỏi useInvoices.ts (23/10/2026)
// để trang Thu chi dùng được mà không kéo cả module hoá đơn vào chunk của trang.
// =============================================
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { financialReadNumber, financialReadRows } from '@/lib/financialReadValidation';
import { invoiceTitleFromParts, invoiceTitlePartsOf, type InvoiceTitleParts } from '@/lib/invoiceUtils';

export interface InvoiceTotalLite {
  id: string;
  total_amount: number;
  paid_amount: number;
  remaining_amount: number;
  // Tên hoá đơn KHÔNG kèm phòng/toà (getInvoiceTitle trên bản ghi thiếu quan hệ
  // room/building) — cột Thu bên BC Lợi Nhuận hiện đúng tên như trang /invoices
  // nhưng gọn (phòng đã có cột riêng). Vd "TIỀN PHÒNG THÁNG ĐẦU TIÊN - 05/2026".
  displayTitle: string;
  /** Các phần dựng tên — nơi không có cột phòng riêng chèn tên phòng (invoiceTitleFromParts). */
  titleParts: InvoiceTitleParts;
}

/** Hình dòng đọc về (số tiền để unknown: financialReadNumber kiểm lại, sai hình thì ném). */
interface InvoiceLiteRow {
  id: string;
  total_amount: unknown;
  paid_amount: unknown;
  remaining_amount: unknown;
  kind: string | null;
  billing_month: string | null;
  notes: string | null;
  issue_date: string | null;
  contract: { start_billing_date: string | null } | null;
  invoice_items: Array<{ type: string | null; from_date: string | null }> | null;
}

export const useInvoiceTotalsByIds = (ids: string[]) => {
  // Dedupe + sort để queryKey ổn định (không refetch oan khi thứ tự đổi).
  const sortedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['invoice-totals-by-ids', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async (): Promise<Map<string, InvoiceTotalLite>> => {
      const map = new Map<string, InvoiceTotalLite>();
      // Chunk để tránh URL .in() quá dài (PostgREST 400 khi danh sách id lớn).
      const CHUNK = 200;
      for (let i = 0; i < sortedIds.length; i += CHUNK) {
        const slice = sortedIds.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('invoices')
          .select(
            `id, total_amount, paid_amount, remaining_amount,
             kind, billing_month, notes, issue_date,
             contract:contracts!invoices_contract_id_fkey (start_billing_date),
             invoice_items (type, from_date)`,
          )
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const row of financialReadRows(data as unknown as InvoiceLiteRow[] | null)) {
          const titleParts = invoiceTitlePartsOf(row);
          map.set(row.id, {
            id: row.id,
            total_amount: financialReadNumber(row.total_amount),
            paid_amount: financialReadNumber(row.paid_amount),
            remaining_amount: financialReadNumber(row.remaining_amount),
            // Không select room/building → title tự rớt phần "<phòng>/<toà>".
            displayTitle: invoiceTitleFromParts(titleParts, null),
            titleParts,
          });
        }
      }
      return map;
    },
  });
};
