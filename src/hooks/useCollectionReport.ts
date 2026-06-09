// =============================================
// useCollectionReport — nguồn dữ liệu cho Báo cáo thu tiền
//
// Tái dùng đúng read-path của lưới (useInvoices) thay vì mở query payments
// riêng → trạng thái/remaining/payments đã sẵn, nhất quán với màn chính.
//   - building_id undefined  → "Tất cả tòa" (mọi HĐ của kỳ, theo RLS)
//   - billing_month          → kỳ đang xem
// Component tự nhóm theo toà + lọc theo payment_date (collectedAt).
// =============================================

import { useInvoices } from '@/hooks/useInvoices';
import type { InvoiceWithRelations } from '@/types/invoice';

interface CollectionReportParams {
  /** undefined = tất cả toà */
  building_id?: string;
  billing_month: string; // YYYY-MM
}

export const useCollectionReport = ({
  building_id,
  billing_month,
}: CollectionReportParams) => {
  const query = useInvoices({ building_id, billing_month });
  return {
    invoices: (query.data?.data ?? []) as InvoiceWithRelations[],
    isLoading: query.isLoading,
  };
};
