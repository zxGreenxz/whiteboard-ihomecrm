// =============================================================================
// usePeriodFees — data layer cho "Đóng tiền Tập trung theo Kỳ" (V2 — 10/07).
//
// GRID (Tiền nhà/Internet/Quản Lý/Vệ sinh/Công An/Rác/Thang máy):
//   • usePeriodFeeStatus  → RPC get_period_fee_status v2: paid/draft tách riêng,
//     vouchers[] chi tiết TỪNG phiếu (sửa/hủy/thumbnail per-voucher), not_applicable.
//   • usePayPeriodFee     → RPC pay_period_fee v2 (+p_force chống đóng trùng;
//     trả {warning:'duplicate'} → FE confirm rồi gọi lại force).
//   • useCancelPeriodFee  → RPC cancel_period_fee v2 (hủy được cả phiếu auto).
//   • useUpdatePeriodFee  → RPC update_period_fee (admin full / manager ảnh+sổ trống).
//   • usePayDraftFeeVoucher → RPC pay_draft_fee_voucher (thanh toán phiếu NHÁP:
//     sổ + ảnh + duyệt nguyên tử — flow recurring draft-mode).
//   • useFeeAccounts / useUpsertFeeAccount → mã NCC + dự kiến + Không-áp-dụng.
// COMMISSION: usePeriodCommissions v2 → 3 trạng thái unpaid|draft|paid + số phiếu thật.
// MAINTENANCE: usePeriodMaintenance → gom batch.
//
// supabase.rpc gọi như METHOD + cast any (types.ts chưa regen) — y hệt useUtilityBills.
// =============================================================================

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ── Types ──────────────────────────────────────────────────────────────────
/** 1 phiếu trong ô (từ vouchers jsonb của status RPC). */
export interface PeriodFeeVoucher {
  id: string;
  amount: number;
  status: 'APPROVED' | 'UNAPPROVED';
  date: string;                 // voucher_date 'YYYY-MM-DD'
  source: string | null;        // system_source
  isAuto: boolean;              // tên chứa "(tự động lập)"
  inBatch: boolean;
  cancellable: boolean;
  accountId: string | null;
  accountName: string | null;
  attachments: string[];
  notes: string | null;
  itemCount: number;
  start: string | null;         // khoảng phủ của item
  end: string | null;
  creatorName: string | null;
}

export interface PeriodFeeStatus {
  buildingId: string;
  categoryKey: string;
  paidAmount: number;           // Σ phiếu APPROVED
  draftAmount: number;          // Σ phiếu NHÁP (UNAPPROVED)
  coveredStart: string | null;
  coveredEnd: string | null;
  voucherIds: string[];
  vouchers: PeriodFeeVoucher[];
  hasReceipt: boolean;
  accountName: string | null;
  accountIsEmpty: boolean;
  expectedAmount: number | null;
  notApplicable: boolean;
}

export interface FeeAccount {
  buildingId: string;
  feeCategory: string;
  providerCode: string;
  accountHolder: string;
  defaultAmount: number | null;
  defaultAccountId: string | null;
  notApplicable: boolean;
}

export type CommissionStatus = 'unpaid' | 'draft' | 'paid';

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
  voucherAmount: number | null;   // số tiền phiếu THẬT
  voucherAccountName: string | null;
  accountIsEmpty: boolean;
  status: CommissionStatus;
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

export interface MaintenanceGroup {
  batchId: string | null;
  payerName: string | null;
  total: number;
  lines: MaintenanceRow[];
  hasReceipt: boolean;
}

/** Kết quả pay: hoặc phiếu đã tạo, hoặc cảnh báo trùng (chưa ghi gì). */
export type PayPeriodFeeResult =
  | { warning: 'duplicate'; existing_count: number; existing_amount: number }
  | { voucher_id: string; code: string; total_amount: number; account_id: string };

// ── Invalidate helper ──────────────────────────────────────────────────────
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

const mapVoucher = (v: any): PeriodFeeVoucher => ({
  id: v.id,
  amount: Number(v.amount) || 0,
  status: v.status === 'UNAPPROVED' ? 'UNAPPROVED' : 'APPROVED',
  date: (v.date ?? '').slice(0, 10),
  source: v.source ?? null,
  isAuto: !!v.is_auto,
  inBatch: !!v.in_batch,
  cancellable: !!v.cancellable,
  accountId: v.account_id ?? null,
  accountName: v.account_name ?? null,
  attachments: (Array.isArray(v.attachments) ? v.attachments : [])
    .map((x: any) => (typeof x === 'string' ? x : x?.url))
    .filter((x: any): x is string => typeof x === 'string' && x.length > 0),
  notes: v.notes ?? null,
  itemCount: Number(v.item_count) || 1,
  start: v.start ?? null,
  end: v.end ?? null,
  creatorName: v.creator_name ?? null,
});

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
        draftAmount: Number(r.draft_amount) || 0,
        coveredStart: r.covered_start ?? null,
        coveredEnd: r.covered_end ?? null,
        voucherIds: Array.isArray(r.voucher_ids) ? r.voucher_ids : [],
        vouchers: (Array.isArray(r.vouchers) ? r.vouchers : []).map(mapVoucher),
        hasReceipt: !!r.has_receipt,
        accountName: r.account_name ?? null,
        accountIsEmpty: !!r.account_is_empty,
        expectedAmount: r.expected_amount == null ? null : Number(r.expected_amount),
        notApplicable: !!r.not_applicable,
      }));
    },
  });

  const byKey = useMemo(() => {
    const m: Record<string, PeriodFeeStatus> = {};
    for (const s of query.data ?? []) m[`${s.buildingId}:${s.categoryKey}`] = s;
    return m;
  }, [query.data]);
  const statusOf = (buildingId: string, categoryKey: string): PeriodFeeStatus | undefined =>
    byKey[`${buildingId}:${categoryKey}`];

  return { ...query, byKey, statusOf };
};

// ── GRID: đóng 1 phí (p_amount = TỔNG cả khoảng kỳ) ─────────────────────────
export const usePayPeriodFee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      buildingId: string;
      categoryKey: string;
      amount: number;           // TỔNG cả khoảng
      periodStart: string;
      periodEnd: string;
      voucherDate?: string | null;
      providerCode?: string | null;
      accountHolder?: string | null;
      accountId?: string | null;
      attachments?: string[];
      force?: boolean;          // true = bỏ qua cảnh báo trùng
    }): Promise<PayPeriodFeeResult> => {
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
        p_force: args.force ?? false,
      });
      if (error) throw new Error(error.message);
      return data as PayPeriodFeeResult;
    },
    onSuccess: (data) => {
      // Cảnh báo trùng = CHƯA ghi gì → không cần invalidate.
      if (!(data as any)?.warning) invalidateFees(qc);
    },
  });
};

// ── Thanh toán phiếu NHÁP (recurring draft-mode): sổ + ảnh + duyệt ──────────
export const usePayDraftFeeVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { voucherId: string; accountId: string; attachments?: string[] | null }) => {
      const { data, error } = await (supabase as any).rpc('pay_draft_fee_voucher', {
        p_voucher_id: args.voucherId,
        p_account_id: args.accountId,
        p_attachments: args.attachments ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { ok: boolean; voucher_id: string; code: string };
    },
    onSuccess: () => invalidateFees(qc),
  });
};

// ── Hủy phiếu (v2: cả phiếu auto khớp hạng mục) ─────────────────────────────
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

// ── Đính NHANH 1 ảnh (append server-side — 2 người cùng đính không đè nhau) ──
export const useAppendFeeAttachment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { voucherId: string; url: string }) => {
      const { error } = await (supabase as any).rpc('append_fee_attachment', {
        p_voucher_id: args.voucherId,
        p_url: args.url,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['period-fee-status'] });
      qc.invalidateQueries({ queryKey: ['income-expenses'] });
    },
  });
};

// ── Sửa phiếu (2 tầng quyền) ────────────────────────────────────────────────
export const useUpdatePeriodFee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      voucherId: string;
      accountId?: string | null;
      attachments?: string[] | null;  // mảng ĐẦY ĐỦ (cũ + mới); null = giữ nguyên
      amount?: number | null;
      periodStart?: string | null;
      periodEnd?: string | null;
      notes?: string | null;          // null = giữ nguyên
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

// ── Cấu hình tòa×hạng mục ───────────────────────────────────────────────────
export const useFeeAccounts = () => {
  const query = useQuery({
    queryKey: ['fee-accounts'],
    queryFn: async (): Promise<FeeAccount[]> => {
      const { data, error } = await (supabase as any)
        .from('building_fee_accounts')
        .select('building_id, fee_category, provider_code, account_holder, default_amount, default_account_id, not_applicable')
        .is('deleted_at', null);
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        buildingId: r.building_id,
        feeCategory: r.fee_category,
        providerCode: r.provider_code ?? '',
        accountHolder: r.account_holder ?? '',
        defaultAmount: r.default_amount == null ? null : Number(r.default_amount),
        defaultAccountId: r.default_account_id ?? null,
        notApplicable: !!r.not_applicable,
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
      notApplicable?: boolean | null;  // null = giữ nguyên
    }) => {
      const { data, error } = await (supabase as any).rpc('upsert_building_fee_account', {
        p_building_id: args.buildingId,
        p_fee_category: args.feeCategory,
        p_provider_code: args.providerCode ?? null,
        p_account_holder: args.accountHolder ?? null,
        p_default_amount: args.defaultAmount ?? null,
        p_default_account_id: args.defaultAccountId ?? null,
        p_not_applicable: args.notApplicable ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fee-accounts'] });
      qc.invalidateQueries({ queryKey: ['period-fee-status'] });
    },
  });
};

// ── COMMISSION (v2: 3 trạng thái) ────────────────────────────────────────────
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
        voucherAmount: r.voucher_amount == null ? null : Number(r.voucher_amount),
        voucherAccountName: r.voucher_account_name ?? null,
        accountIsEmpty: !!r.account_is_empty,
        status: (r.status === 'paid' ? 'paid' : r.status === 'draft' ? 'draft' : 'unpaid') as CommissionStatus,
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
