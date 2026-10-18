import {financialReadNumber,financialReadRows} from '@/lib/financialReadValidation';
import { useQuery } from '@tanstack/react-query';
import { invoiceBreakdownClient } from '@/lib/invoiceBreakdownRpc';
import { invoiceStatisticsRpcArgs } from '@/lib/invoiceReadArgs';
import { getSessionUser } from '@/lib/authSession';
import type { InvoiceStatisticsFilters } from '@/hooks/useInvoices';

// =============================================
// Chi tiết cho 2 thẻ thống kê (mở modal khi bấm):
//  - Tiền thối: invoice_change_breakdown_v1 (theo sổ quỹ × kỳ)
//  - Cọc đã thu: invoice_deposit_breakdown_v1 (theo toà → phòng, đủ/thiếu)
// Cùng scope (building/billing_month) như invoice_statistics_v3.
// =============================================

export interface ChangeBreakdownRow {
  account_id: string | null;
  account_name: string;
  billing_month: string;
  building_name: string | null;
  room_name: string | null;
  payer_name: string;
  voucher_date: string;
  change_amount: number;
  code: string | null;
}

export const useChangeBreakdown = (
  filters?: InvoiceStatisticsFilters,
  enabled = true,
) => {
  return useQuery({
    meta:{feedback:"inline"},
    queryKey: ['change-breakdown', filters],
    enabled,
    // Mở lại dialog cùng bộ lọc trong 60s → dùng cache, không chạy lại RPC.
    staleTime: 60_000,
    queryFn: async (): Promise<ChangeBreakdownRow[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await invoiceBreakdownClient.rpc(
        'invoice_change_breakdown_v1', invoiceStatisticsRpcArgs(filters),
      );
      if (error) throw error;
      return financialReadRows(data as unknown as ChangeBreakdownRow[] | null).map((r) => ({
        account_id: r.account_id ?? null,
        account_name: r.account_name ?? '(chưa gán sổ thối)',
        billing_month: r.billing_month ?? '',
        building_name: r.building_name ?? null,
        room_name: r.room_name ?? null,
        payer_name: r.payer_name ?? '',
        voucher_date: r.voucher_date,
        change_amount: financialReadNumber(r.change_amount),
        code: r.code ?? null,
      }));
    },
  });
};

export interface DepositBreakdownRow {
  building_id: string | null;
  building_name: string | null;
  room_id: string | null;
  room_name: string | null;
  contract_id: string | null;
  contract_number: string | null;
  total_deposit: number | null;
  deposit_paid: number | null;
  deposit_remaining: number | null;
  deposit_debt_mode: string | null;
  voucher_id: string;
  code: string | null;
  voucher_date: string;
  amount: number;
  account_name: string;
  notes: string | null;
  // Hoá đơn mà khoản cọc được thu kèm (chỉ có khi phiếu cọc tách ra từ HĐ gộp cọc).
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_total: number | null;
}

export const useDepositBreakdown = (
  filters?: InvoiceStatisticsFilters,
  enabled = true,
) => {
  return useQuery({
    meta:{feedback:"inline"},
    queryKey: ['deposit-breakdown', filters],
    enabled,
    // Mở lại dialog cùng bộ lọc trong 60s → dùng cache, không chạy lại RPC.
    staleTime: 60_000,
    queryFn: async (): Promise<DepositBreakdownRow[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await invoiceBreakdownClient.rpc(
        'invoice_deposit_breakdown_v1', invoiceStatisticsRpcArgs(filters),
      );
      if (error) throw error;
      return financialReadRows(data as unknown as DepositBreakdownRow[] | null).map((r) => ({
        building_id: r.building_id ?? null,
        building_name: r.building_name ?? '—',
        room_id: r.room_id ?? null,
        room_name: r.room_name ?? '—',
        contract_id: r.contract_id ?? null,
        contract_number: r.contract_number ?? null,
        total_deposit: r.total_deposit != null ? financialReadNumber(r.total_deposit) : null,
        deposit_paid: r.deposit_paid != null ? financialReadNumber(r.deposit_paid) : null,
        deposit_remaining: r.deposit_remaining != null ? financialReadNumber(r.deposit_remaining) : null,
        deposit_debt_mode: r.deposit_debt_mode ?? null,
        voucher_id: r.voucher_id,
        code: r.code ?? null,
        voucher_date: r.voucher_date,
        amount: financialReadNumber(r.amount),
        account_name: r.account_name ?? '',
        notes: r.notes ?? null,
        invoice_id: r.invoice_id ?? null,
        invoice_number: r.invoice_number ?? null,
        invoice_total: r.invoice_total != null ? financialReadNumber(r.invoice_total) : null,
      }));
    },
  });
};
