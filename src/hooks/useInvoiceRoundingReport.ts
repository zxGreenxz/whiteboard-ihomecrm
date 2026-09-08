import { useQuery } from '@tanstack/react-query';
import { useMyPermissions } from './useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { RoundingReportError, type InvoiceRoundingFilters } from '@/lib/invoiceRoundingReport';
import { getInvoiceRoundingReport } from '@/lib/invoiceRoundingReportRepository';

export function useInvoiceRoundingReport(filters: InvoiceRoundingFilters, enabled = true) {
  const { data: permissions } = useMyPermissions();
  const allowed = canUse(permissions, 'thu_tien', 'report');
  return useQuery({
    queryKey: ['invoice-rounding-report', filters],
    queryFn: () => getInvoiceRoundingReport(filters),
    enabled: enabled && allowed && /^\d{4}-(0[1-9]|1[0-2])$/.test(filters.billingMonth),
    retry: (failureCount, error) => failureCount < 1 && !(error instanceof RoundingReportError && error.kind !== 'unavailable'),
  });
}
