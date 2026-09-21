// =============================================================================
// useContractLifecycle — dòng thời gian hợp đồng cho hộp thoại khoản chi.
//
// Bốn mốc, đúng bản thiết kế 03:
//   1. Ký hợp đồng          contracts.signed_date / start_date / end_date
//   2. Cọc đã đóng · thực thu   contracts.deposit_paid (KHÔNG phải total_deposit)
//   3. Tiền thuê / phí đã đóng  SUM(invoices.paid_amount) — không gồm cọc
//   4. Thanh lý … / Đến hôm nay contract_terminations
//
// ⚠ Mốc 2 phải dùng `deposit_paid` chứ không phải `total_deposit`: đo thật
// 21/09/2026 có hợp đồng `total_deposit` 4.000.000 nhưng `deposit_paid` = 0 —
// tức đã ký mà khách chưa nộp cọc. Hiện số cam kết thay số thực thu là nói dối.
//
// Chỉ ĐỌC. Không hàm ghi nào.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LifecycleData {
  contractNumber: string | null;
  customer: string;
  signedDate: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Cọc THỰC THU. Có thể nhỏ hơn số cam kết. */
  depositPaid: number;
  depositTotal: number;
  rentPrice: number;
  /** Tổng đã thu qua hoá đơn — tiền thuê và phí, KHÔNG gồm cọc. */
  invoicePaid: number;
  /** Có bản ghi thanh lý không, và số liệu của nó. */
  terminatedAt: string | null;
  terminationType: string | null;
  refundAmount: number | null;
  outstandingDebt: number | null;
}

export function useContractLifecycle(contractId: string | null | undefined) {
  return useQuery({
    queryKey: ['contract-settlement', 'lifecycle', contractId],
    enabled: !!contractId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LifecycleData | null> => {
      const id = contractId!;

      const [hd, hoaDon, thanhLy] = await Promise.all([
        supabase.from('contracts')
          .select('contract_number, signed_date, start_date, end_date, total_deposit, deposit_paid, rent_price, contract_customers ( customers ( full_name ) )')
          .eq('id', id).maybeSingle(),
        supabase.from('invoices')
          .select('paid_amount').eq('contract_id', id).is('deleted_at', null),
        supabase.from('contract_terminations')
          .select('termination_date, termination_type, refund_amount, outstanding_debt')
          .eq('contract_id', id)
          .order('termination_date', { ascending: false }).limit(1).maybeSingle(),
      ]);

      // Fail-closed từng nhánh: trả số 0 vì đọc hỏng sẽ bị đọc thành "chưa thu
      // đồng nào", đúng loại nhầm lẫn nguy hiểm nhất ở màn tiền.
      if (hd.error) throw new Error(hd.error.message);
      if (hoaDon.error) throw new Error(hoaDon.error.message);
      if (thanhLy.error) throw new Error(thanhLy.error.message);
      if (!hd.data) return null;

      const c = hd.data as unknown as {
        contract_number: string | null; signed_date: string | null;
        start_date: string | null; end_date: string | null;
        total_deposit: number | null; deposit_paid: number | null; rent_price: number | null;
        contract_customers: { customers: { full_name: string | null } | null }[] | null;
      };
      const t = thanhLy.data as unknown as {
        termination_date: string | null; termination_type: string | null;
        refund_amount: number | null; outstanding_debt: number | null;
      } | null;

      const ten = c.contract_customers?.find((x) => x.customers?.full_name)?.customers?.full_name;

      return {
        contractNumber: c.contract_number,
        customer: (ten ?? '').trim() || 'Chưa có tên khách',
        signedDate: c.signed_date,
        startDate: c.start_date,
        endDate: c.end_date,
        depositPaid: Number(c.deposit_paid) || 0,
        depositTotal: Number(c.total_deposit) || 0,
        rentPrice: Number(c.rent_price) || 0,
        invoicePaid: ((hoaDon.data ?? []) as { paid_amount: number | null }[])
          .reduce((s, i) => s + (Number(i.paid_amount) || 0), 0),
        terminatedAt: t?.termination_date ?? null,
        terminationType: t?.termination_type ?? null,
        refundAmount: t?.refund_amount ?? null,
        outstandingDebt: t?.outstanding_debt ?? null,
      };
    },
  });
}
