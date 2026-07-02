// =============================================
// useCollectionReport / useThuTienInvoices — nguồn dữ liệu DUY NHẤT của /thu-tien
//
// Trước đây khung phone (useInvoices theo toà) và ManagePanel (useInvoices
// tất cả toà) bắn 2 query INVOICE_LIST_SELECT khổng lồ song song, đổi tab toà
// lại refetch nguyên bộ. Giờ: 1 query gọn cho CẢ KỲ (mọi toà, RLS tự giới hạn),
// mọi consumer (phone grid / ManagePanel / CollectionReport) lọc client-side
// → đổi toà / mở báo cáo = 0 request.
//
// THU_TIEN_SELECT chỉ chứa đúng cột trang này dùng (xem lib/collect.ts):
//   - KHÔNG kéo invoice_items (chỉ InvoiceDetailCard cần → useInvoiceItemsLite
//     lazy khi mở drawer đầy đủ)
//   - payments giữ (id, amount, payment_date) cho lọc theo ngày + Hoàn tác
//   - KHÔNG count:'exact'
// =============================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { InvoiceWithRelations } from '@/types/invoice';

// Cột/embeds ĐÚNG những gì /thu-tien dùng. name_sort giữ lại vì sort client
// của trang so theo name; building.default_account_id_* cho lib/cashAccount.
const THU_TIEN_SELECT = `
  id, invoice_number, billing_month, status, total_amount, paid_amount,
  remaining_amount, notes, building_id, room_id, contract_id,
  contract:contracts!invoices_contract_id_fkey (
    id,
    contract_customers!contract_customers_contract_id_fkey (
      id, is_representative,
      customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
    )
  ),
  building:buildings!invoices_building_id_fkey (id, name, name_sort, default_account_id_tt, default_account_id_tk),
  room:rooms!invoices_room_id_fkey (id, name, name_sort),
  payments (id, amount, payment_date)
`;

/** 1 query hoá đơn/kỳ (mọi toà) dùng chung cho cả trang Thu tiền. */
export const useThuTienInvoices = (billing_month: string) =>
  useQuery({
    // Root 'invoices' GIỮ NGUYÊN → mọi invalidateQueries(['invoices']) hiện có
    // (useBulkRecordPayment/useDeletePayment/useUpdateInvoiceNote…) vẫn bắt được.
    queryKey: ['invoices', 'thu-tien', billing_month],
    queryFn: async (): Promise<InvoiceWithRelations[]> => {
      // Filter y hệt useInvoices({billing_month}) mặc định: bỏ đã xoá + đã huỷ.
      const { data, error } = await (supabase
        .from('invoices')
        .select(THU_TIEN_SELECT) as any)
        .is('deleted_at', null)
        .neq('status', 'CANCELLED')
        .eq('billing_month', billing_month)
        .order('created_at', { ascending: false });
      if (error) throw error; // không nuốt lỗi (pattern perf round 06-30)
      return (data || []) as InvoiceWithRelations[];
    },
  });

interface CollectionReportParams {
  /** undefined = tất cả toà */
  building_id?: string;
  billing_month: string; // YYYY-MM
}

/** Wrapper giữ nguyên chữ ký cũ — building_id giờ lọc CLIENT-SIDE trên cache chung. */
export const useCollectionReport = ({
  building_id,
  billing_month,
}: CollectionReportParams) => {
  const query = useThuTienInvoices(billing_month);
  const invoices = useMemo(() => {
    const all = query.data ?? [];
    return building_id ? all.filter((i) => i.building_id === building_id) : all;
  }, [query.data, building_id]);
  return { invoices, isLoading: query.isLoading };
};

/** Chi tiết invoice_items cho drawer đầy đủ — chỉ fetch khi mở (lazy). */
export const useInvoiceItemsLite = (invoiceId?: string) =>
  useQuery({
    // Prefix ['invoice'] đã được các mutation hoá đơn invalidate sẵn.
    queryKey: ['invoice', invoiceId, 'items-lite'],
    enabled: !!invoiceId,
    queryFn: async () => {
      const { data, error } = await (supabase
        .from('invoice_items')
        .select('id, description, amount, sort_order') as any)
        .eq('invoice_id', invoiceId!)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data || []) as { id: string; description: string | null; amount: number }[];
    },
  });
