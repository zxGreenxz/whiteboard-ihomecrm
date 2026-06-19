// =============================================
// useUtilityBills — data layer cho "Đóng tiền Điện nước" (/thu-tien).
//
// Chủ nhà đóng tiền điện/nước cho NHÀ CUNG CẤP (EVN / cấp nước) theo từng
// toà + kỳ. Mỗi lần đóng = 1 phiếu CHI từ sổ "…Thu" của user (RPC
// pay_utility_bill, SECURITY DEFINER). Mã PE/nước + tên chủ hộ lưu ở bảng
// building_utility_accounts (sửa inline qua upsert_building_utility_account).
//
// Gọi supabase.rpc như METHOD + cast any (types.ts chưa regen) — y hệt
// useCashHandovers.
// =============================================

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { monthToStartDate, monthToEndDate } from '@/lib/monthPeriod';

export type UtilType = 'electric' | 'water';

const TYPE_DB: Record<UtilType, 'ELECTRIC' | 'WATER'> = { electric: 'ELECTRIC', water: 'WATER' };
const TYPE_NAME: Record<UtilType, string> = { electric: 'Đóng tiền điện', water: 'Đóng tiền nước' };

interface UtilityAccountRow {
  building_id: string;
  utility_type: 'ELECTRIC' | 'WATER';
  provider_code: string | null;
  account_holder: string | null;
}

export interface UtilityPaymentRow {
  building_id: string;
  building_name: string;
  type: UtilType;
  amount: number;
  payment_date: string; // 'YYYY-MM-DD'
}

export interface DayGroup {
  date: string;
  sum: number;
  rows: { buildingName: string; type: UtilType; amount: number }[];
}

/** Mã PE/nước + tên chủ hộ theo (toà, loại). */
export const useUtilityAccounts = () => {
  const query = useQuery({
    queryKey: ['utility-accounts'],
    queryFn: async (): Promise<Record<string, { code: string; holder: string }>> => {
      const { data, error } = await (supabase as any)
        .from('building_utility_accounts')
        .select('building_id, utility_type, provider_code, account_holder')
        .is('deleted_at', null);
      if (error) throw error;
      const out: Record<string, { code: string; holder: string }> = {};
      for (const r of (data ?? []) as UtilityAccountRow[]) {
        const t: UtilType = r.utility_type === 'ELECTRIC' ? 'electric' : 'water';
        out[`${r.building_id}:${t}`] = {
          code: r.provider_code ?? '',
          holder: r.account_holder ?? '',
        };
      }
      return out;
    },
  });

  const byKey = (buildingId: string, type: UtilType) => query.data?.[`${buildingId}:${type}`];
  return { ...query, byKey };
};

/** Lưu/sửa mã NCC + tên chủ hộ inline. */
export const useUpsertUtilityAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { buildingId: string; type: UtilType; code: string; holder: string }) => {
      const { error } = await (supabase as any).rpc('upsert_building_utility_account', {
        p_building_id: args.buildingId,
        p_utility_type: TYPE_DB[args.type],
        p_provider_code: args.code || null,
        p_account_holder: args.holder || null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['utility-accounts'] }),
  });
};

/** Tạo phiếu CHI đóng tiền điện/nước cho 1 toà + kỳ. */
export const usePayUtilityBill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      buildingId: string;
      type: UtilType;
      billingMonth: string;
      amount: number;
      code: string;
      holder: string;
      voucherDate?: string;
    }) => {
      const { data, error } = await (supabase as any).rpc('pay_utility_bill', {
        p_building_id: args.buildingId,
        p_utility_type: TYPE_DB[args.type],
        p_amount: args.amount,
        p_period_month: args.billingMonth,
        p_voucher_date: args.voucherDate ?? null,
        p_provider_code: args.code || null,
        p_account_holder: args.holder || null,
      });
      if (error) throw new Error(error.message);
      return data as { voucher_id: string; code: string; total_amount: number };
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['utility-payments', vars.billingMonth] });
      qc.invalidateQueries({ queryKey: ['utility-accounts'] });
      qc.invalidateQueries({ queryKey: ['income-expenses'] });
      qc.invalidateQueries({ queryKey: ['accounts-with-balance'] });
    },
  });
};

/** Phiếu CHI điện/nước trong 1 kỳ → trạng thái đã đóng + báo cáo theo ngày. */
export const useUtilityPayments = (billingMonth: string) => {
  const query = useQuery({
    queryKey: ['utility-payments', billingMonth],
    enabled: !!billingMonth,
    queryFn: async (): Promise<UtilityPaymentRow[]> => {
      // 1) Sibling type-ids cho 'Đóng tiền điện'/'Đóng tiền nước' (mọi chủ).
      const { data: typeRows, error: typeErr } = await (supabase as any)
        .from('income_expense_types')
        .select('id, name')
        .eq('type', 'expense')
        .in('name', [TYPE_NAME.electric, TYPE_NAME.water]);
      if (typeErr) throw typeErr;
      const elecIds = new Set<string>((typeRows ?? []).filter((t: any) => t.name === TYPE_NAME.electric).map((t: any) => t.id));
      const waterIds = new Set<string>((typeRows ?? []).filter((t: any) => t.name === TYPE_NAME.water).map((t: any) => t.id));
      const allIds = [...elecIds, ...waterIds];
      if (allIds.length === 0) return [];

      const rangeStart = monthToStartDate(billingMonth);
      const rangeEnd = monthToEndDate(billingMonth);

      // 2) Phiếu CHI có hạng mục thuộc type + kỳ chồng lấn billingMonth.
      const { data, error } = await (supabase as any)
        .from('income_expenses')
        .select(`
          id, building_id, total_amount, voucher_date,
          building:buildings(name),
          it:income_expense_items!inner ( income_expense_type_id, start_date, end_date )
        `)
        .eq('type', 'EXPENSE')
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null)
        .in('it.income_expense_type_id', allIds)
        .lte('it.start_date', rangeEnd)
        .gte('it.end_date', rangeStart)
        .order('voucher_date', { ascending: false });
      if (error) throw error;

      const out: UtilityPaymentRow[] = [];
      for (const v of (data ?? []) as any[]) {
        const items = Array.isArray(v.it) ? v.it : v.it ? [v.it] : [];
        const isElec = items.some((i: any) => elecIds.has(i.income_expense_type_id));
        out.push({
          building_id: v.building_id,
          building_name: v.building?.name ?? '—',
          type: isElec ? 'electric' : 'water',
          amount: Number(v.total_amount) || 0,
          payment_date: (v.voucher_date ?? '').slice(0, 10),
        });
      }
      return out;
    },
  });

  const rows = query.data ?? [];

  // Đã đóng toà/loại trong kỳ → {amount tổng, ngày gần nhất}.
  const paidMap = useMemo(() => {
    const m: Record<string, { amount: number; date: string }> = {};
    for (const r of rows) {
      const k = `${r.building_id}:${r.type}`;
      const cur = m[k];
      if (!cur) m[k] = { amount: r.amount, date: r.payment_date };
      else {
        cur.amount += r.amount;
        if (r.payment_date > cur.date) cur.date = r.payment_date;
      }
    }
    return m;
  }, [rows]);
  const paidThisKy = (buildingId: string, type: UtilType) => paidMap[`${buildingId}:${type}`];

  // Báo cáo theo ngày — chỉ ngày có đóng, desc.
  const byDay = useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();
    for (const r of rows) {
      const d = r.payment_date;
      if (!d) continue;
      let g = map.get(d);
      if (!g) { g = { date: d, sum: 0, rows: [] }; map.set(d, g); }
      g.sum += r.amount;
      g.rows.push({ buildingName: r.building_name, type: r.type, amount: r.amount });
    }
    return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [rows]);

  return { ...query, paidThisKy, byDay };
};
