import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { hydrateIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import { getVoucherDisplayAttachments } from '@/lib/incomeExpenseSupplement';

const refundEvidenceSchema = z.object({
  voucher: z.object({ id: z.string().uuid(), code: z.string().nullable(), voucher_date: z.string(),
    approval_status: z.string(), posting_status: z.string().nullable(), attachments: z.array(z.string()).nullable() }),
});
interface RefundEvidenceVoucher {
  id: string; code: string | null; voucher_date: string; approval_status: string;
  posting_status: string | null; attachments: string[] | null;
}

export function useReservationRefundEvidence(settlementId: string) {
  return useQuery({
    queryKey: ["reservation-refund-evidence", settlementId],
    queryFn: async () => {
      const rows = await fetchAllRows((from, to) => supabase.from("reservation_settlement_vouchers")
        .select("voucher:income_expenses!reservation_settlement_vouchers_voucher_id_fkey!inner(id,code,voucher_date,approval_status,posting_status,attachments)")
        .eq("settlement_id", settlementId).eq("kind", "REFUND")
        .order("voucher_id", { ascending: true }).range(from, to), { label: "reservation-refund-evidence" });
      if (rows === null) throw new Error("Không tải được chứng từ hoàn tiền. Hãy thử lại.");
      const parsed = z.array(refundEvidenceSchema).parse(rows) as { voucher: RefundEvidenceVoucher }[];
      const vouchers = await hydrateIncomeExpenseSupplements(parsed.map((row) => row.voucher));
      // This hook is a read-only proof projection, never a financial writer input.
      return vouchers.map(voucher => ({ ...voucher, attachments: getVoucherDisplayAttachments(voucher) }));
    },
  });
}
