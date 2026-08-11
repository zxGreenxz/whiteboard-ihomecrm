import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Ma trận cấu hình phí cố định (toà × 9 hạng mục) cho trang Cài đặt.
 *
 * Vì sao KHÔNG dùng `useFeeAccounts` có sẵn: hook đó chỉ trả những dòng ĐÃ khai
 * trong `building_fee_accounts`, nên ô chưa khai là VÔ HÌNH — mà đó chính là
 * phần cần thấy nhất (đo prod 30/07/2026: org thật 53/162 ô chưa khai, DEMO
 * 0/27). `get_fee_config_matrix_v1` trả đủ cả ô trống.
 */
export const FEE_KINDS = [
  { key: 'tien_nha',  label: 'Tiền nhà' },
  { key: 'dien',      label: 'Tiền điện' },
  { key: 'nuoc',      label: 'Tiền nước' },
  { key: 'internet',  label: 'Internet' },
  { key: 'quan_ly',   label: 'Quản lý' },
  { key: 've_sinh',   label: 'Vệ sinh' },
  { key: 'cong_an',   label: 'Công an' },
  { key: 'rac',       label: 'Rác' },
  { key: 'thang_may', label: 'Thang máy' },
] as const;

export type FeeKind = typeof FEE_KINDS[number]['key'];

export interface FeeConfigCell {
  buildingId: string;
  buildingName: string;
  feeCategory: FeeKind;
  providerCode: string;
  accountHolder: string;
  defaultAmount: number | null;
  defaultAccountId: string | null;
  defaultAccountName: string | null;
  /** Nguồn duy nhất là `buildings.hidden_fixed_expenses`, KHÔNG phải cột cùng tên. */
  notApplicable: boolean;
  /** false = chưa từng khai dòng cấu hình nào cho ô này. */
  isDeclared: boolean;
  lastVoucherDate: string | null;
  voucherCount: number;
}

export const useFeeConfigMatrix = (buildingIds?: string[]) => {
  const key = buildingIds && buildingIds.length ? [...buildingIds].sort() : null;
  const query = useQuery({
    queryKey: ['fee-config-matrix', key],
    queryFn: async (): Promise<FeeConfigCell[]> => {
      const { data, error } = await supabase.rpc('get_fee_config_matrix_v1', {
        p_building_ids: key,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        buildingId: r.building_id,
        buildingName: r.building_name,
        feeCategory: r.fee_category,
        providerCode: r.provider_code ?? '',
        accountHolder: r.account_holder ?? '',
        defaultAmount: r.default_amount == null ? null : Number(r.default_amount),
        defaultAccountId: r.default_account_id ?? null,
        defaultAccountName: r.default_account_name ?? null,
        notApplicable: !!r.not_applicable,
        isDeclared: !!r.is_declared,
        lastVoucherDate: r.last_voucher_date ?? null,
        voucherCount: Number(r.voucher_count ?? 0),
      }));
    },
  });

  const byBuilding = useMemo(() => {
    const m = new Map<string, { name: string; cells: Map<string, FeeConfigCell> }>();
    for (const c of query.data ?? []) {
      if (!m.has(c.buildingId)) m.set(c.buildingId, { name: c.buildingName, cells: new Map() });
      m.get(c.buildingId)!.cells.set(c.feeCategory, c);
    }
    return m;
  }, [query.data]);

  const summary = useMemo(() => {
    const rows = query.data ?? [];
    const applicable = rows.filter((r) => !r.notApplicable);
    return {
      total: rows.length,
      notApplicable: rows.length - applicable.length,
      declared: applicable.filter((r) => r.isDeclared).length,
      priced: applicable.filter((r) => r.defaultAmount != null && r.defaultAmount > 0).length,
      missing: applicable.filter((r) => r.defaultAmount == null || r.defaultAmount <= 0).length,
      running: rows.filter((r) => r.voucherCount > 0).length,
    };
  }, [query.data]);

  return { ...query, byBuilding, summary };
};

export interface SaveFeeConfigArgs {
  buildingId: string;
  feeCategory: FeeKind;
  /** undefined = không đụng tới. null = XOÁ (dùng cờ p_clear_*). */
  defaultAmount?: number | null;
  providerCode?: string | null;
  accountHolder?: string | null;
  notApplicable?: boolean;
}

/**
 * GOTCHA quan trọng: RPC coi `NULL = giữ nguyên` cho các cột giá trị (để
 * `pay_period_fee` học cấu hình mà không xoá cột nó không truyền). Muốn XOÁ thật
 * thì phải bật `p_clear_*`. Vì vậy ở đây `null` được DỊCH sang cờ xoá, còn
 * `undefined` mới là "không đụng".
 */
export const useSaveFeeConfig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: SaveFeeConfigArgs) => {
      const clearAmount = a.defaultAmount === null;
      const clearProvider = a.providerCode === null;
      const { data, error } = await supabase.rpc('upsert_building_fee_account', {
        p_building_id: a.buildingId,
        p_fee_category: a.feeCategory,
        p_provider_code: clearProvider ? null : (a.providerCode ?? null),
        p_account_holder: clearProvider ? null : (a.accountHolder ?? null),
        p_default_amount: clearAmount ? null : (a.defaultAmount ?? null),
        p_default_account_id: undefined,
        p_not_applicable: a.notApplicable ?? undefined,
        p_clear_amount: clearAmount,
        p_clear_provider: clearProvider,
        p_clear_account: false,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fee-config-matrix'] });
      // Lưới phí của /thanh-toan đọc cùng cấu hình này.
      qc.invalidateQueries({ queryKey: ['fee-accounts'] });
      qc.invalidateQueries({ queryKey: ['period-fee-status'] });
    },
  });
};
