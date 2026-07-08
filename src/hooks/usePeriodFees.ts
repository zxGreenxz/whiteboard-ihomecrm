// =============================================================================
// usePeriodFees — data layer cho "Đóng tiền Tập trung theo Kỳ".
//
// GRID (Tiền nhà/Internet/Quản Lý/Vệ sinh/Công An/Rác/Thang máy):
//   • usePeriodFeeStatus  → RPC get_period_fee_status (trạng thái đã/chưa đóng, gộp mọi tòa)
//   • usePayPeriodFee     → RPC pay_period_fee  (1 phiếu CHI/tòa/kỳ, đa kỳ = accrual)
//   • useCancelPeriodFee  → RPC cancel_period_fee (soft-delete)
//   • useUpdatePeriodFee  → RPC update_period_fee (admin toàn bộ / manager thêm ảnh+gán sổ trống)
//   • useFeeAccounts / useUpsertFeeAccount → mã NCC + số tiền mặc định theo tòa×hạng mục
// COMMISSION: usePeriodCommissions → RPC get_period_commissions
// MAINTENANCE: usePeriodMaintenance → RPC get_period_maintenance (gom batch)
//
// supabase.rpc gọi như METHOD + cast any (types.ts chưa regen) — y hệt useUtilityBills.
// =============================================================================

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ── Types ──────────────────────────────────────────────────────────────────
export interface PeriodFeeStatus {
  buildingId: string;
  categoryKey: string;        // GRID server key
  paidAmount: number;
  coveredStart: string | null;
  coveredEnd: string | null;
  voucherIds: string[];
  hasReceipt: boolean;
  accountName: string | null;
  accountIsEmpty: boolean;    // có phiếu nhưng chưa gán sổ
  expectedAmount: number | null;
}

export interface FeeAccount {
  buildingId: string;
  feeCategory: string;
  providerCode: string;
  accountHolder: string;
  defaultAmount: number | null;
  defaultAccountId: string | null;
}

export interface PeriodCommissionRow {
  contractId: string;
  contractNumber: string | null;
  buildingId: string;
  buildingName: string;
  roomId: string | null;
  roomName: string | null;
  tenantName: string;
  signedDate: string;
  months: number;
  tierPercent: number | null;
  expectedAmount: number;
  voucherId: string | null;
  accountIsEmpty: boolean;
  status: 'paid' | 'unpaid';
}

export interface MaintenanceRow {
  batchId: string | null;
  payerName: string | null;
  voucherId: string;
  buildingId: string;
  buildingName: string;
  subtype: 'ml' | 'mg';
  amount: number;
  accountName: string | null;
  hasReceipt: boolean;
  voucherDate: string | null;
  isStandalone: boolean;
}

// Gộp phiếu bảo trì theo batch (phiếu tổng) — phiếu lẻ đứng riêng (batchId=null).
export interface MaintenanceGroup {
  batchId: string | null;
  payerName: string | null;
  total: number;
  lines: MaintenanceRow[];
  hasReceipt: boolean;
}

// ── Invalidate helper (mọi mutation phí kỳ) ──────────────────────────────────
const invalidateFees = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['period-fee-status'] });
  qc.invalidateQueries({ queryKey: ['period-commissions'] });
  qc.invalidateQueries({ queryKey: ['period-maintenance'] });
  qc.invalidateQueries({ queryKey: ['fee-accounts'] });
  qc.invalidateQueries({ queryKey: ['income-expenses'] });
  qc.invalidateQueries({ queryKey: ['income-expense-batches'] });
  qc.invalidateQueries({ queryKey: ['accounts-with-balance'] });
  qc.invalidateQueries({ queryKey: ['utility-payments'] });
};

// ── GRID: trạng thái đã/chưa đóng ────────────────────────────────────────────
export const usePeriodFeeStatus = (
  period: string,
  categoryKeys: string[],
  buildingIds: string[],
  opts?: { enabled?: boolean },
) => {
  const query = useQuery({
    queryKey: ['period-fee-status', period, [...categoryKeys].sort(), [...buildingIds].sort()],
    enabled: (opts?.enabled ?? true) && !!period && categoryKeys.length > 0 && buildingIds.length > 0,
    queryFn: async (): Promise<PeriodFeeStatus[]> => {
      const { data, error } = await (supabase as any).rpc('get_period_fee_status', {
        p_period_start: period,
        p_period_end: period,
        p_building_ids: buildingIds,
        p_category_keys: categoryKeys,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        buildingId: r.building_id,
        categoryKey: r.category_key,
        paidAmount: Number(r.paid_amount) || 0,
        coveredStart: r.covered_start ?? null,
        coveredEnd: r.covered_end ?? null,
        voucherIds: Array.isArray(r.voucher_ids) ? r.voucher_ids : [],
        hasReceipt: !!r.has_receipt,
        accountName: r.account_name ?? null,
        accountIsEmpty: !!r.account_is_empty,
        expectedAmount: r.expected_amount == null ? null : Number(r.expected_amount),
      }));
    },
  });

  // Tra nhanh theo (buildingId, categoryKey).
  const byKey = useMemo(() => {
    const m: Record<string, PeriodFeeStatus> = {};
    for (const s of query.data ?? []) m[`${s.buildingId}:${s.categoryKey}`] = s;
    return m;
  }, [query.data]);
  const statusOf = (buildingId: string, categoryKey: string): PeriodFeeStatus | undefined =>
    byKey[`${buildingId}:${categoryKey}`];

  return { ...query, byKey, statusOf };
};

// ── GRID: đóng 1 phí ─────────────────────────────────────────────────────────
export const usePayPeriodFee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      buildingId: string;
      categoryKey: string;      // GRID server key
      amount: number;
      periodStart: string;      // 'YYYY-MM'
      periodEnd: string;        // 'YYYY-MM' (= start nếu đơn kỳ)
      voucherDate?: string | null;
      providerCode?: string | null;
      accountHolder?: string | null;
      accountId?: string | null;
      attachments?: string[];
    }) => {
      const { data, error } = await (supabase as any).rpc('pay_period_fee', {
        p_building_id: args.buildingId,
        p_category_key: args.categoryKey,
        p_amount: args.amount,
        p_period_start: args.periodStart,
        p_period_end: args.periodEnd,
        p_voucher_date: args.voucherDate ?? null,
        p_provider_code: args.providerCode || null,
        p_account_holder: args.accountHolder || null,
        p_account_id: args.accountId ?? null,
        p_attachments: args.attachments && args.attachments.length ? args.attachments : null,
      });
      if (error) throw new Error(error.message);
      return data as { voucher_id: string; code: string; total_amount: number; account_id: string };
    },
    onSuccess: () => invalidateFees(qc),
  });
};

// ── Hủy phiếu phí (soft-delete) ──────────────────────────────────────────────
export const useCancelPeriodFee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (voucherId: string) => {
      const { error } = await (supabase as any).rpc('cancel_period_fee', { p_voucher_id: voucherId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => invalidateFees(qc),
  });
};

// ── Sửa phiếu phí (2 tầng quyền, server-authoritative) ───────────────────────
export const useUpdatePeriodFee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      voucherId: string;
      accountId?: string | null;
      attachments?: string[] | null;
      amount?: number | null;
      periodStart?: string | null;
      periodEnd?: string | null;
      notes?: string | null;
    }) => {
      const { error } = await (supabase as any).rpc('update_period_fee', {
        p_voucher_id: args.voucherId,
        p_account_id: args.accountId ?? null,
        p_attachments: args.attachments ?? null,
        p_amount: args.amount ?? null,
        p_period_start: args.periodStart ?? null,
        p_period_end: args.periodEnd ?? null,
        p_notes: args.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => invalidateFees(qc),
  });
};

// ── Cấu hình tòa×hạng mục (mã NCC + số tiền mặc định) ────────────────────────
export const useFeeAccounts = () => {
  const query = useQuery({
    queryKey: ['fee-accounts'],
    queryFn: async (): Promise<FeeAccount[]> => {
      const { data, error } = await (supabase as any)
        .from('building_fee_accounts')
        .select('building_id, fee_category, provider_code, account_holder, default_amount, default_account_id')
        .is('deleted_at', null);
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        buildingId: r.building_id,
        feeCategory: r.fee_category,
        providerCode: r.provider_code ?? '',
        accountHolder: r.account_holder ?? '',
        defaultAmount: r.default_amount == null ? null : Number(r.default_amount),
        defaultAccountId: r.default_account_id ?? null,
      }));
    },
  });
  const byKey = useMemo(() => {
    const m: Record<string, FeeAccount> = {};
    for (const a of query.data ?? []) m[`${a.buildingId}:${a.feeCategory}`] = a;
    return m;
  }, [query.data]);
  const accountOf = (buildingId: string, feeCategory: string): FeeAccount | undefined =>
    byKey[`${buildingId}:${feeCategory}`];
  return { ...query, byKey, accountOf };
};

export const useUpsertFeeAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      buildingId: string;
      feeCategory: string;
      providerCode?: string | null;
      accountHolder?: string | null;
      defaultAmount?: number | null;
      defaultAccountId?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc('upsert_building_fee_account', {
        p_building_id: args.buildingId,
        p_fee_category: args.feeCategory,
        p_provider_code: args.providerCode ?? null,
        p_account_holder: args.accountHolder ?? null,
        p_default_amount: args.defaultAmount ?? null,
        p_default_account_id: args.defaultAccountId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fee-accounts'] }),
  });
};

// ── COMMISSION ───────────────────────────────────────────────────────────────
export const usePeriodCommissions = (
  period: string,
  buildingIds: string[],
  opts?: { enabled?: boolean },
) =>
  useQuery({
    queryKey: ['period-commissions', period, [...buildingIds].sort()],
    enabled: (opts?.enabled ?? true) && !!period && buildingIds.length > 0,
    queryFn: async (): Promise<PeriodCommissionRow[]> => {
      const { data, error } = await (supabase as any).rpc('get_period_commissions', {
        p_period_month: period,
        p_building_ids: buildingIds,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        contractId: r.contract_id,
        contractNumber: r.contract_number ?? null,
        buildingId: r.building_id,
        buildingName: r.building_name ?? '',
        roomId: r.room_id ?? null,
        roomName: r.room_name ?? null,
        tenantName: r.tenant_name ?? '',
        signedDate: r.signed_date,
        months: Number(r.months) || 0,
        tierPercent: r.tier_percent == null ? null : Number(r.tier_percent),
        expectedAmount: Number(r.expected_amount) || 0,
        voucherId: r.voucher_id ?? null,
        accountIsEmpty: !!r.account_is_empty,
        status: (r.status === 'paid' ? 'paid' : 'unpaid') as 'paid' | 'unpaid',
      }));
    },
  });

// ── MAINTENANCE (gom batch) ──────────────────────────────────────────────────
export const usePeriodMaintenance = (
  period: string,
  buildingIds: string[],
  opts?: { enabled?: boolean },
) => {
  const query = useQuery({
    queryKey: ['period-maintenance', period, [...buildingIds].sort()],
    enabled: (opts?.enabled ?? true) && !!period && buildingIds.length > 0,
    queryFn: async (): Promise<MaintenanceRow[]> => {
      const { data, error } = await (supabase as any).rpc('get_period_maintenance', {
        p_period_month: period,
        p_building_ids: buildingIds,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        batchId: r.batch_id ?? null,
        payerName: r.payer_name ?? null,
        voucherId: r.voucher_id,
        buildingId: r.building_id,
        buildingName: r.building_name ?? '',
        subtype: (r.subtype === 'mg' ? 'mg' : 'ml') as 'ml' | 'mg',
        amount: Number(r.amount) || 0,
        accountName: r.account_name ?? null,
        hasReceipt: !!r.has_receipt,
        voucherDate: r.voucher_date ?? null,
        isStandalone: !!r.is_standalone,
      }));
    },
  });

  // Gom theo batch (phiếu tổng) + phiếu lẻ (standalone).
  const { groups, standalone } = useMemo(() => {
    const rows = query.data ?? [];
    const bmap = new Map<string, MaintenanceGroup>();
    const solo: MaintenanceRow[] = [];
    for (const r of rows) {
      if (r.batchId) {
        let g = bmap.get(r.batchId);
        if (!g) { g = { batchId: r.batchId, payerName: r.payerName, total: 0, lines: [], hasReceipt: false }; bmap.set(r.batchId, g); }
        g.lines.push(r);
        g.total += r.amount;
        g.hasReceipt = g.hasReceipt || r.hasReceipt;
      } else {
        solo.push(r);
      }
    }
    return { groups: [...bmap.values()], standalone: solo };
  }, [query.data]);

  return { ...query, groups, standalone };
};
