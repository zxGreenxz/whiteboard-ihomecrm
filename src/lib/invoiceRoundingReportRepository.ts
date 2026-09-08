import { supabase } from '@/integrations/supabase/client';
import { fetchInvoiceRoundingReport, type InvoiceRoundingFilters, type InvoiceRoundingReportArgs, type InvoiceRoundingReportInvoker } from './invoiceRoundingReport';

type ReportRpc = (name: 'get_invoice_rounding_report_v1', args: InvoiceRoundingReportArgs) => ReturnType<InvoiceRoundingReportInvoker>;

/** Single forward RPC not yet in the live-generated catalog. Keep its name/args
 * closed and result unknown until runtime validation, as in Network Center. */
export function getInvoiceRoundingReport(filters: InvoiceRoundingFilters) {
  return fetchInvoiceRoundingReport(filters, (args) =>
    (supabase.rpc as unknown as ReportRpc)('get_invoice_rounding_report_v1', args),
  );
}
