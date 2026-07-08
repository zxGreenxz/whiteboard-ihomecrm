// =============================================
// useUtilityBills — data layer cho "Đóng tiền Điện nước" (/thu-tien).
//
// Chủ nhà đóng tiền điện/nước cho NHÀ CUNG CẤP (EVN / cấp nước) theo từng
// toà + kỳ. Mỗi lần đóng = 1 phiếu CHI (RPC pay_utility_bill, SECURITY DEFINER)
// từ sổ do user CHỌN (mặc định "…Thu" của user), có thể đính ảnh phiếu.
// Mã PE/nước + tên chủ hộ lưu ở building_utility_accounts (upsert inline).
// Hủy phiếu = soft-delete qua cancel_utility_bill.
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

/** 1 phiếu chi điện/nước đã ghi nhận (enriched cho Báo cáo + Hủy phiếu). */
export interface UtilityPaymentRow {
  voucher_id: string;
  building_id: string;
  building_name: string;
  type: UtilType;
  amount: number;
  payment_date: string; // 'YYYY-MM-DD' (voucher_date — ngày đóng thực tế)
  time: string;         // 'HH:MM' (giờ ghi phiếu — từ created_at, giờ VN)
  by: string;           // người đóng (creator_name)
  book: string;         // sổ quỹ ghi chi (tên account)
  hasReceipt: boolean;  // có ảnh phiếu chi
  receiptUrl: string | null;
}

/** Trạng thái "đã đóng" của (toà, loại) trong kỳ — dùng cho ô/thẻ. */
export interface PaidInfo {
  amount: number;   // tổng đã đóng trong kỳ (có thể > 1 phiếu)
  date: string;     // ngày phiếu gần nhất
  count: number;    // số phiếu
  // Phiếu gần nhất — làm mục tiêu Hủy phiếu + hiển thị chi tiết.
  voucherId: string;
  time: string;
  by: string;
  book: string;
  hasReceipt: boolean;
  receiptUrl: string | null;
}

export interface DayReportRow {
  voucher_id: string;
  building_id: string;
  buildingName: string;
  type: UtilType;
  time: string;
  by: string;
  book: string;
  amount: number;
  hasReceipt: boolean;
  receiptUrl: string | null;
}

export interface DayGroup {
  date: string;      // 'YYYY-MM-DD'
  sum: number;
  rows: DayReportRow[];
}

export interface ChartMonth {
  label: string;      // 'T7'
  ym: string;         // 'YYYY-MM'
  elec: number;       // đã chi NCC (điện)
  water: number;      // đã chi NCC (nước)
  elecBill: number;   // phải thu — tiền điện tính cho khách
  waterBill: number;  // phải thu — tiền nước tính cho khách
  current?: boolean;
}

/** 'HH:MM' theo giờ VN từ timestamptz. */
const fmtTimeVN = (iso?: string | null): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return '';
  }
};

/** Danh sách N tháng liên tiếp kết thúc tại endMonth (asc), 'YYYY-MM'. */
const lastNMonths = (endMonth: string, n: number): string[] => {
  const [y, m] = endMonth.slice(0, 7).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
};

/** Lấy type-ids của 'Đóng tiền điện' / 'Đóng tiền nước' (mọi chủ toà). */
const fetchUtilityTypeIds = async (): Promise<{ elecIds: Set<string>; waterIds: Set<string> }> => {
  const { data, error } = await (supabase as any)
    .from('income_expense_types')
    .select('id, name')
    .eq('type', 'expense')
    .in('name', [TYPE_NAME.electric, TYPE_NAME.water]);
  if (error) throw error;
  const elecIds = new Set<string>((data ?? []).filter((t: any) => t.name === TYPE_NAME.electric).map((t: any) => t.id));
  const waterIds = new Set<string>((data ?? []).filter((t: any) => t.name === TYPE_NAME.water).map((t: any) => t.id));
  return { elecIds, waterIds };
};

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
      accountId?: string | null;
      attachments?: string[];
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
        p_account_id: args.accountId ?? null,
        p_attachments: args.attachments && args.attachments.length ? args.attachments : null,
      });
      if (error) throw new Error(error.message);
      return data as { voucher_id: string; code: string; total_amount: number; account_id: string };
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['utility-payments', vars.billingMonth] });
      qc.invalidateQueries({ queryKey: ['utility-chart'] });
      qc.invalidateQueries({ queryKey: ['utility-accounts'] });
      qc.invalidateQueries({ queryKey: ['income-expenses'] });
      qc.invalidateQueries({ queryKey: ['accounts-with-balance'] });
    },
  });
};

/** Hủy (soft-delete) 1 phiếu chi điện/nước. */
export const useCancelUtilityBill = (billingMonth: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (voucherId: string) => {
      const { error } = await (supabase as any).rpc('cancel_utility_bill', { p_voucher_id: voucherId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['utility-payments', billingMonth] });
      qc.invalidateQueries({ queryKey: ['utility-chart'] });
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
      const { elecIds, waterIds } = await fetchUtilityTypeIds();
      const allIds = [...elecIds, ...waterIds];
      if (allIds.length === 0) return [];

      const rangeStart = monthToStartDate(billingMonth);
      const rangeEnd = monthToEndDate(billingMonth);

      // Phiếu CHI có hạng mục thuộc type + kỳ chồng lấn billingMonth.
      const { data, error } = await (supabase as any)
        .from('income_expenses')
        .select(`
          id, building_id, total_amount, voucher_date, created_at, creator_name, attachments,
          building:buildings(name),
          book:accounts!income_expenses_account_id_fkey(name),
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
        const atts: string[] = Array.isArray(v.attachments) ? v.attachments : [];
        out.push({
          voucher_id: v.id,
          building_id: v.building_id,
          building_name: v.building?.name ?? '—',
          type: isElec ? 'electric' : 'water',
          amount: Number(v.total_amount) || 0,
          payment_date: (v.voucher_date ?? '').slice(0, 10),
          time: fmtTimeVN(v.created_at),
          by: v.creator_name ?? '',
          book: v.book?.name ?? '',
          hasReceipt: atts.length > 0,
          receiptUrl: atts[0] ?? null,
        });
      }
      return out;
    },
  });

  const rows = query.data ?? [];

  // Đã đóng toà/loại trong kỳ → tổng + phiếu gần nhất (mục tiêu Hủy phiếu).
  const paidMap = useMemo(() => {
    const m: Record<string, PaidInfo> = {};
    for (const r of rows) {
      const k = `${r.building_id}:${r.type}`;
      const cur = m[k];
      if (!cur) {
        m[k] = {
          amount: r.amount, date: r.payment_date, count: 1,
          voucherId: r.voucher_id, time: r.time, by: r.by, book: r.book,
          hasReceipt: r.hasReceipt, receiptUrl: r.receiptUrl,
        };
      } else {
        cur.amount += r.amount;
        cur.count += 1;
        // Giữ phiếu gần nhất làm đại diện (rows đã sort voucher_date desc).
        if (r.payment_date > cur.date) {
          cur.date = r.payment_date;
          cur.voucherId = r.voucher_id;
          cur.time = r.time; cur.by = r.by; cur.book = r.book;
          cur.hasReceipt = r.hasReceipt; cur.receiptUrl = r.receiptUrl;
        }
      }
    }
    return m;
  }, [rows]);
  const paidThisKy = (buildingId: string, type: UtilType): PaidInfo | undefined =>
    paidMap[`${buildingId}:${type}`];

  // Báo cáo theo ngày — chỉ ngày có đóng, desc; trong ngày sort theo giờ asc.
  const byDay = useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();
    for (const r of rows) {
      const d = r.payment_date;
      if (!d) continue;
      let g = map.get(d);
      if (!g) { g = { date: d, sum: 0, rows: [] }; map.set(d, g); }
      g.sum += r.amount;
      g.rows.push({
        voucher_id: r.voucher_id, building_id: r.building_id, buildingName: r.building_name,
        type: r.type, time: r.time, by: r.by, book: r.book, amount: r.amount,
        hasReceipt: r.hasReceipt, receiptUrl: r.receiptUrl,
      });
    }
    const groups = [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const g of groups) g.rows.sort((a, b) => (a.time < b.time ? -1 : 1));
    return groups;
  }, [rows]);

  return { ...query, rows, paidThisKy, byDay };
};

/** Dữ liệu Biểu đồ: chi NCC (điện/nước) vs phải thu (hoá đơn khách) theo tháng. */
export const useUtilityChart = (
  billingMonth: string,
  opts?: { enabled?: boolean; monthsBack?: number },
) => {
  const monthsBack = opts?.monthsBack ?? 7;
  const months = useMemo(() => lastNMonths(billingMonth, monthsBack), [billingMonth, monthsBack]);

  return useQuery({
    queryKey: ['utility-chart', billingMonth, monthsBack],
    enabled: (opts?.enabled ?? true) && !!billingMonth && months.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ChartMonth[]> => {
      const { elecIds, waterIds } = await fetchUtilityTypeIds();
      const allIds = [...elecIds, ...waterIds];

      const rangeStart = monthToStartDate(months[0]);
      const rangeEnd = monthToEndDate(months[months.length - 1]);

      // ── Đã chi NCC: phiếu utility trong span, gộp theo tháng-kỳ (item start_date) ──
      const paidByMonth: Record<string, { elec: number; water: number }> = {};
      for (const ym of months) paidByMonth[ym] = { elec: 0, water: 0 };

      if (allIds.length > 0) {
        const { data, error } = await (supabase as any)
          .from('income_expenses')
          .select(`total_amount, it:income_expense_items!inner ( income_expense_type_id, start_date )`)
          .eq('type', 'EXPENSE')
          .eq('approval_status', 'APPROVED')
          .is('deleted_at', null)
          .in('it.income_expense_type_id', allIds)
          .gte('it.start_date', rangeStart)
          .lte('it.start_date', rangeEnd);
        if (error) throw error;
        for (const v of (data ?? []) as any[]) {
          const items = Array.isArray(v.it) ? v.it : v.it ? [v.it] : [];
          for (const it of items) {
            const ym = (it.start_date ?? '').slice(0, 7);
            if (!paidByMonth[ym]) continue;
            const amt = Number(v.total_amount) || 0;
            if (elecIds.has(it.income_expense_type_id)) paidByMonth[ym].elec += amt;
            else if (waterIds.has(it.income_expense_type_id)) paidByMonth[ym].water += amt;
          }
        }
      }

      // ── Phải thu (hoá đơn khách): electric/water_amount theo từng kỳ (song song) ──
      const stats = await Promise.all(
        months.map(async (ym) => {
          const { data, error } = await (supabase.rpc as any)('get_invoice_statistics_v2', {
            p_building_id: null, p_room_id: null, p_status: null,
            p_start_date: null, p_end_date: null,
            p_billing_month: ym, p_payment_status: null, p_building_ids: null,
          });
          if (error) return { elecBill: 0, waterBill: 0 };
          const r = Array.isArray(data) ? data[0] : data;
          return {
            elecBill: Number(r?.electric_amount ?? 0),
            waterBill: Number(r?.water_amount ?? 0),
          };
        }),
      );

      return months.map((ym, i) => ({
        label: 'T' + Number(ym.slice(5, 7)),
        ym,
        elec: paidByMonth[ym].elec,
        water: paidByMonth[ym].water,
        elecBill: stats[i].elecBill,
        waterBill: stats[i].waterBill,
        current: ym === billingMonth.slice(0, 7),
      }));
    },
  });
};
