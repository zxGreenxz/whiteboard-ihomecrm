// =============================================================================
// useSpendEngine — màn "Cam kết chi" của chủ (plan cỗ máy chi theo cam kết, 26/09/2026).
//
// MỘT bộ máy quyết định phiếu chi sinh ra đã duyệt hay chờ, đọc luật khai TRÊN HẠNG MỤC:
//   CAM_KET    — chủ ký trước số tiền cho (toà, hạng mục, tháng); chi trong phần còn lại
//                thì máy duyệt, vượt thì chờ (cam kết không tự nới).
//   TRAN       — điện/nước: dưới trần đã công bố thì máy duyệt, vượt thì chờ.
//   TUNG_PHIEU — như cũ: người có quyền duyệt tự duyệt, còn lại theo ngưỡng.
//
// Mọi RPC ở đây chỉ chủ công ty / super admin gọi được — server là hàng rào thật (42501);
// giao diện chỉ hiển thị. Lỗi thì THROW để màn hình báo, không nuốt thành danh sách rỗng.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const SPEND_FEE_KEYS = [
  'tien_nha', 'dien', 'nuoc', 'internet', 'quan_ly', 've_sinh', 'cong_an', 'rac', 'thang_may',
] as const;
export type SpendFeeKey = typeof SPEND_FEE_KEYS[number];

export const SPEND_FEE_LABEL: Record<SpendFeeKey, string> = {
  tien_nha: 'Tiền nhà',
  dien: 'Điện',
  nuoc: 'Nước',
  internet: 'Internet',
  quan_ly: 'Quản lý',
  ve_sinh: 'Vệ sinh',
  cong_an: 'Công an',
  rac: 'Rác',
  thang_may: 'Thang máy',
};

export type SpendMode = 'CAM_KET' | 'TRAN' | 'TUNG_PHIEU';

export const SPEND_MODE_LABEL: Record<SpendMode, string> = {
  CAM_KET: 'Theo cam kết',
  TRAN: 'Theo trần',
  TUNG_PHIEU: 'Từng phiếu',
};

/** Lý do của bộ máy → câu bình dân (khớp app_private.spend_reason_vi_v1). */
export const SPEND_REASON_LABEL: Record<string, string> = {
  WITHIN_COMMITMENT: 'Trong cam kết',
  OVER_COMMITMENT: 'Vượt cam kết',
  NO_COMMITMENT: 'Tháng chưa ký cam kết',
  UNDER_CEILING: 'Dưới trần',
  OVER_CEILING: 'Vượt trần',
  NO_CEILING: 'Chưa khai trần',
  NO_CASHBOOK: 'Chưa gắn sổ quỹ thật',
  NO_CASHBOOK_RIGHT: 'Người lập không giữ sổ',
  SELF_APPROVER: 'Tự duyệt — có quyền duyệt',
  FORCE_APPROVAL: 'Hạng mục bắt buộc duyệt',
  OVER_THRESHOLD: 'Từ ngưỡng tự duyệt',
  UNDER_THRESHOLD: 'Dưới ngưỡng',
  RECURRING_PREAPPROVED: 'Định kỳ đã cho tự duyệt',
  SYSTEM_BALANCED: 'Nguồn hệ thống',
  INCOME_POLICY: 'Phiếu thu',
  ENGINE_ERROR: 'Bộ máy lỗi — chờ cho an toàn',
  NO_LINES: 'Phiếu không có dòng',
};

export const SPEND_WRITER_LABEL: Record<string, string> = {
  create_income_expense_v1: 'Thu chi (lập tay)',
  pay_period_fee: 'Thanh toán — phí cố định',
  pay_utility_bill: 'Thanh toán — điện nước',
  generate_special_fees_v1: 'Sinh phí hàng loạt',
  generate_recurring_vouchers: 'Phiếu định kỳ',
  manual: 'Lập tay (đường khác)',
};

/** 'YYYY-MM' → 'YYYY-MM-01' (RPC nhận date). */
export const monthToDate = (m: string) => `${m}-01`;

export interface OrgOption { id: string; name: string }

/** Tổ chức người đang đăng nhập thuộc về (chọn org cho màn chủ). */
export const useMySpendOrganizations = () =>
  useQuery({
    queryKey: ['spend-engine', 'orgs'],
    queryFn: async (): Promise<OrgOption[]> => {
      const { data: ids, error } = await supabase.rpc('my_org_ids');
      if (error) throw new Error(error.message);
      const list = Array.isArray(ids) ? (ids as string[]).filter(Boolean) : [];
      if (!list.length) return [];
      // Tên chỉ để HIỂN THỊ. RLS bảng organizations ẩn dòng với vai "Chủ công ty" (đo bằng
      // trình duyệt 26/09/2026: select trả []), nên id lấy từ my_org_ids là nguồn đúng; đọc
      // được tên thì dùng, không thì ghi chung chung — tuyệt đối không đánh rơi công ty.
      const { data } = await supabase.from('organizations').select('id, name').in('id', list);
      const names = new Map((data ?? []).map((o) => [o.id as string, o.name as string]));
      return list.map((id, i) => ({
        id,
        name: names.get(id) ?? (list.length > 1 ? `Công ty ${i + 1}` : 'Công ty của bạn'),
      }));
    },
    staleTime: 10 * 60_000,
  });

export interface SpendEngineStatus {
  route: string;
  cashbook_route: string;
  shadow_since: string | null;
  decisions_30d: number;
  mismatches_30d: number;
  enforced_30d: number;
  cashbook_warn_30d: number;
  errors_7d: number;
  switches_on: number;
  ledger: Record<string, { n: number; amount: number }>;
}

export const useSpendEngineStatus = (orgId: string | null) =>
  useQuery({
    enabled: !!orgId,
    queryKey: ['spend-engine', 'status', orgId],
    queryFn: async (): Promise<SpendEngineStatus> => {
      const { data, error } = await supabase.rpc('get_spend_engine_status_v1', {
        p_organization_id: orgId as string,
      });
      if (error) throw new Error(error.message);
      return data as unknown as SpendEngineStatus;
    },
  });

export interface SpendCommitmentRow {
  commitment_id: string;
  building_id: string;
  building_name: string;
  fee_category: SpendFeeKey;
  period_month: string;
  amount: number;
  remaining: number;
  source: string;
  note: string | null;
}

export const useSpendCommitments = (orgId: string | null, fromMonth: string, toMonth: string) =>
  useQuery({
    enabled: !!orgId,
    queryKey: ['spend-engine', 'commitments', orgId, fromMonth, toMonth],
    queryFn: async (): Promise<SpendCommitmentRow[]> => {
      const { data, error } = await supabase.rpc('list_spend_commitments_v1', {
        p_organization_id: orgId as string,
        p_from_month: monthToDate(fromMonth),
        p_to_month: monthToDate(toMonth),
      });
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({
        ...r,
        amount: Number(r.amount),
        remaining: Number(r.remaining),
      })) as SpendCommitmentRow[];
    },
  });

export const useSetSpendCommitment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      buildingId: string; feeCategory: SpendFeeKey; month: string; amount: number | null; note?: string;
    }) => {
      const { data, error } = await supabase.rpc('set_spend_commitment_v1', {
        p_building_id: args.buildingId,
        p_fee_category: args.feeCategory,
        p_period_month: monthToDate(args.month),
        // Bỏ trống = thu hồi cam kết tháng đó (RPC nhận NULL/0).
        p_amount: (args.amount ?? 0) as number,
        p_note: args.note ?? undefined,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spend-engine'] }),
  });
};

export interface SpendSwitchRow {
  switch_id: string;
  fee_category: SpendFeeKey;
  building_id: string | null;
  building_name: string | null;
  period_from: string;
  period_to: string | null;
  note: string | null;
  enabled_at: string;
}

export const useSpendSwitches = (orgId: string | null) =>
  useQuery({
    enabled: !!orgId,
    queryKey: ['spend-engine', 'switches', orgId],
    queryFn: async (): Promise<SpendSwitchRow[]> => {
      const { data, error } = await supabase.rpc('list_spend_policy_switches_v1', {
        p_organization_id: orgId as string,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as SpendSwitchRow[];
    },
  });

export const useSetSpendSwitch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      orgId: string; feeCategory: SpendFeeKey; fromMonth: string; toMonth?: string | null;
      buildingId?: string | null; on: boolean; note?: string;
    }) => {
      const { data, error } = await supabase.rpc('set_spend_policy_switch_v1', {
        p_organization_id: args.orgId,
        p_fee_category: args.feeCategory,
        p_from_month: monthToDate(args.fromMonth),
        p_to_month: args.toMonth ? monthToDate(args.toMonth) : undefined,
        p_building_id: args.buildingId ?? undefined,
        p_on: args.on,
        p_note: args.note ?? undefined,
      });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spend-engine'] }),
  });
};

export interface SpendShadowRow {
  voucher_id: string;
  code: string | null;
  voucher_date: string | null;
  building_name: string | null;
  writer: string;
  amount: number | null;
  birth_status: string;
  engine_status: string;
  engine_reason: string;
  match: boolean;
  enforced: boolean;
  route: string;
  decided_at: string;
  cashbook_ok: boolean | null;
  fee_categories: string | null;
}

export const useSpendShadowReport = (orgId: string | null, from: string, to: string) =>
  useQuery({
    enabled: !!orgId,
    queryKey: ['spend-engine', 'shadow', orgId, from, to],
    queryFn: async (): Promise<SpendShadowRow[]> => {
      const { data, error } = await supabase.rpc('spend_shadow_report_v2', {
        p_organization_id: orgId as string,
        p_from: from,
        p_to: to,
      });
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({ ...r, amount: r.amount == null ? null : Number(r.amount) })) as SpendShadowRow[];
    },
  });

export interface SelfApprovedRow {
  voucher_id: string;
  code: string | null;
  voucher_date: string;
  building_name: string | null;
  type: string;
  amount: number;
  maker_id: string;
  maker_name: string | null;
  kind: string;
  approved_at: string | null;
}

export const useSelfApprovedVouchers = (orgId: string | null, from: string, to: string) =>
  useQuery({
    enabled: !!orgId,
    queryKey: ['spend-engine', 'self-approved', orgId, from, to],
    queryFn: async (): Promise<SelfApprovedRow[]> => {
      const { data, error } = await supabase.rpc('list_self_approved_vouchers_v1', {
        p_organization_id: orgId as string,
        p_from: from,
        p_to: to,
      });
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({ ...r, amount: Number(r.amount) })) as SelfApprovedRow[];
    },
  });

export const useSetTypeSpendRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { typeId: string; mode: SpendMode; feeCategory?: SpendFeeKey | null }) => {
      const { data, error } = await supabase.rpc('set_income_expense_type_spend_rule_v1', {
        p_type_id: args.typeId,
        p_spend_mode: args.mode,
        p_fee_category: args.feeCategory ?? undefined,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spend-engine'] });
      qc.invalidateQueries({ queryKey: ['income-expense-types'] });
    },
  });
};
