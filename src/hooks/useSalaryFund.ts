// Dữ liệu phụ cho tab "Tổng quan kỳ" của màn Lương & thu nhập.
// Chỉ ĐỌC — không ghi, không đổi công thức lương.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSpecialFeePrices } from "@/hooks/useSpecialFeePrices";
import { financialReadNumber, financialReadRows } from '@/lib/financialReadValidation';

export interface FeeFundRow {
  buildingId: string;
  buildingName: string;
  amount: number;
  effectiveFrom: string | null;
}

/**
 * Nguồn A — phí Quản lý từ các tòa (brief §2.2). Ở sổ tòa đây là hạng mục chi
 * "Quản lý" (`quan_ly`); lấy GIÁ CÔNG BỐ áp cho tháng, không lấy
 * `building_fee_accounts.default_amount` (bị đường chi ghi đè sau mỗi lần đóng).
 * Tòa chưa công bố giá thì không cộng — đếm riêng ở `unpublished`.
 */
export const useSalaryFeeFund = (periodMonth: string, enabled = true) => {
  const month = periodMonth.slice(0, 7);
  const q = useSpecialFeePrices(undefined, month, { enabled });
  const value = useMemo(() => {
    const cells = (q.data ?? []).filter((p) => p.feeCategory === "quan_ly");
    const rows: FeeFundRow[] = cells
      .filter((p) => p.amount != null && p.amount > 0)
      .map((p) => ({ buildingId: p.buildingId, buildingName: p.buildingName, amount: p.amount as number, effectiveFrom: p.effectiveFrom }))
      .sort((a, b) => a.buildingName.localeCompare(b.buildingName, "vi"));
    return {
      rows,
      total: rows.reduce((s, r) => s + r.amount, 0),
      unpublished: cells.filter((p) => p.amount == null).length,
    };
  }, [q.data]);
  return { ...q, ...value };
};

export interface PendingPayout {
  staffId: string;
  voucherId: string;
  amount: number;
  voucherDate: string | null;
}

/**
 * Phiếu chi lương đã lập nhưng CHƯA DUYỆT của kỳ. salary_payout_v1 tạo phiếu
 * UNAPPROVED và gắn vào salary_monthly.payout_voucher_id; `paid` chỉ tăng khi
 * duyệt. `amount` là phần thực nhận của phiếu (không gồm dòng cấn trừ tiền phòng).
 */
export const useSalaryPendingPayouts = (periodMonth: string, staffIds: string[]) => {
  const key = [...staffIds].sort();
  return useQuery<PendingPayout[]>({
    meta: {feedback:'inline'},
    queryKey: ["salary-pending-payouts", periodMonth, key],
    enabled: !!periodMonth && key.length > 0,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("salary_monthly")
        .select("staff_id, payout_voucher_id")
        .eq("period_month", periodMonth)
        .in("staff_id", key)
        .not("payout_voucher_id", "is", null);
      if (error) throw error;
      const byVoucher = new Map<string, string>();
      for (const r of financialReadRows(rows)) {
        if (!r.payout_voucher_id || !r.staff_id) throw new TypeError('Invalid salary payout link');
        byVoucher.set(r.payout_voucher_id, r.staff_id);
      }
      if (!byVoucher.size) return [];
      const { data: vouchers, error: vErr } = await supabase
        .from("income_expenses")
        .select("id, total_amount, approval_status, voucher_date, deleted_at")
        .in("id", [...byVoucher.keys()]);
      if (vErr) throw vErr;
      const verifiedVouchers = financialReadRows(vouchers);
      if (verifiedVouchers.length !== byVoucher.size || verifiedVouchers.some(v => !byVoucher.has(v.id) || !v.approval_status)) throw new TypeError('Incomplete salary voucher source');
      const pending = verifiedVouchers.filter((v) => v.approval_status === "UNAPPROVED" && !v.deleted_at);
      if (!pending.length) return [];
      // Cả hai đường chi (canonical + legacy) ghi dòng cấn trừ là "Tiền phòng (khấu trừ)…".
      // Trừ dòng đó ra để so được với thực nhận (take_home đã trừ tiền phòng).
      const { data: items, error: iErr } = await supabase
        .from("income_expense_items")
        .select("income_expense_id, description, quantity, unit_price")
        .in("income_expense_id", pending.map((v) => v.id));
      if (iErr) throw iErr;
      const rentBy = new Map<string, number>();
      for (const it of financialReadRows(items)) {
        if (!/^Tiền phòng/i.test(it.description || "")) continue;
        rentBy.set(it.income_expense_id, (rentBy.get(it.income_expense_id) || 0) + financialReadNumber(it.quantity) * financialReadNumber(it.unit_price));
      }
      return pending.map((v) => ({
        staffId: byVoucher.get(v.id) as string,
        voucherId: v.id,
        amount: Math.max(0, financialReadNumber(v.total_amount) - (rentBy.get(v.id) || 0)),
        voucherDate: v.voucher_date ?? null,
      }));
    },
  });
};
