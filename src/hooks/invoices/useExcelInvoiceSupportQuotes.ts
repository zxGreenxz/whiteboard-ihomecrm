import { useQueries } from '@tanstack/react-query';
import { buildInvoiceFormData, type ExcelRowData, type SubmitContext } from '@/lib/excelInvoiceRows';
import { quoteInvoiceRentSupport } from '@/lib/invoiceRentSupport';

export function useExcelInvoiceSupportQuotes(rows: ExcelRowData[], ctx: SubmitContext) {
  const requests = rows.map(row => row.support_plan_revision && !row.support_error ? buildInvoiceFormData(row, ctx, '00000000-0000-4000-8000-000000000001') : null);
  const quotes = useQueries({ queries: rows.map((row, index) => {
    const request = requests[index];
    return {
      queryKey: ['invoice-support-quote', row.support_organization_id, row.contract_id, row.support_plan_revision, ctx.billingMonth,
        request?.items, request?.rent_support_context?.manual_discount_amount, request?.applied_credit],
      enabled: row.selected && !!request && !!row.support_organization_id,
      queryFn: () => quoteInvoiceRentSupport(row.support_organization_id!, row.contract_id, ctx.billingMonth,
        request!.items.map(item => ({ ...item })), request!.applied_credit ?? 0, request!.rent_support_context!),
      staleTime: 0,
    };
  }) });
  const states = rows.map((row, index) => {
    if (!row.selected || !row.support_plan_revision) return { ready: true, error: null };
    const quote = quotes[index];
    const error = row.support_error || (!row.support_organization_id ? 'Chưa xác nhận được tổ chức của lịch hỗ trợ.' : quote.isError ? 'Không kiểm tra được hỗ trợ; tải dữ liệu lại trước khi tạo.' : quote.data?.state === 'NEEDS_REVIEW' ? 'Hỗ trợ cần đối chiếu trước khi tạo hóa đơn.' : null);
    return { ready: !error && !quote.isFetching && quote.data?.state === 'READY', error };
  });
  return { ready: states.every(state => state.ready), states };
}
