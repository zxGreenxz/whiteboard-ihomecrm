import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { FeeKind } from '@/hooks/useFeeConfigMatrix';

/**
 * GIÁ CÔNG BỐ của phí cố định — khác hẳn "giá gợi ý" trong `useFeeConfigMatrix`.
 *
 * Vì sao phải có hai khái niệm, đây là chỗ dễ nhầm nhất:
 *
 *   • `building_fee_accounts.default_amount` (giá GỢI Ý) bị đường chi ghi đè sau
 *     mỗi lần đóng tiền, nên nó là *ký ức lần đóng gần nhất*, không phải mức phí.
 *     Đo được trên prod 31/07/2026: toà 405PVB hạng mục công an đang lưu 7.000đ
 *     (sót lại từ một phiếu "làm tạm trú" tính theo đầu người) trong khi phí thật
 *     là 500.000đ/tháng. Nó chỉ dùng để điền sẵn ô số tiền cho nhanh.
 *
 *   • Giá CÔNG BỐ (hook này) do CHỦ TỔ CHỨC đặt, có tháng hiệu lực, và đường chi
 *     không với tới được. Đây mới là thứ quyết định phiếu nào được tự duyệt:
 *     đóng đúng giá công bố ⇒ máy duyệt và ghi sổ luôn; lệch ⇒ phiếu chờ người duyệt.
 *
 * Ô chưa công bố giá ⇒ giữ nguyên hành vi cũ (vẫn tự duyệt như trước khi có tính
 * năng này). Luật chỉ bật lên cho từng ô, đúng lúc chủ công bố giá ô đó.
 */
export interface SpecialFeePrice {
  buildingId: string;
  buildingName: string;
  feeCategory: FeeKind;
  /** null = chủ chưa công bố giá cho ô này. */
  amount: number | null;
  /** 'YYYY-MM' — giá này áp dụng từ tháng nào. */
  effectiveFrom: string | null;
  source: string | null;
  /** Người đang đăng nhập có được công bố giá không (chỉ chủ tổ chức / super admin). */
  canEdit: boolean;
}

export const useSpecialFeePrices = (buildingIds?: string[], month?: string) => {
  const key = buildingIds && buildingIds.length ? [...buildingIds].sort() : null;
  const query = useQuery({
    queryKey: ['special-fee-prices', key, month ?? null],
    queryFn: async (): Promise<SpecialFeePrice[]> => {
      const { data, error } = await supabase.rpc('get_special_fee_prices_v1', {
        p_building_ids: key,
        p_month: month ?? undefined,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        buildingId: r.building_id,
        buildingName: r.building_name,
        feeCategory: r.fee_category,
        amount: r.amount == null ? null : Number(r.amount),
        effectiveFrom: r.effective_from ?? null,
        source: r.source ?? null,
        canEdit: !!r.can_edit,
      }));
    },
  });

  /** Tra nhanh theo `${buildingId}:${feeCategory}`. */
  const byCell = useMemo(() => {
    const m = new Map<string, SpecialFeePrice>();
    for (const p of query.data ?? []) m.set(`${p.buildingId}:${p.feeCategory}`, p);
    return m;
  }, [query.data]);

  const canEditAny = useMemo(
    () => (query.data ?? []).some((p) => p.canEdit),
    [query.data],
  );

  const publishedCount = useMemo(
    () => (query.data ?? []).filter((p) => p.amount != null).length,
    [query.data],
  );

  return { ...query, byCell, canEditAny, publishedCount };
};

export interface SetSpecialFeePriceArgs {
  buildingId: string;
  feeCategory: FeeKind;
  amount: number;
  /** 'YYYY-MM'. Bỏ trống = áp dụng từ tháng này. */
  effectiveFromMonth?: string;
  note?: string;
}

export const useSetSpecialFeePrice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: SetSpecialFeePriceArgs) => {
      const { data, error } = await supabase.rpc('set_special_fee_price_v1', {
        p_building_id: a.buildingId,
        p_fee_category: a.feeCategory,
        p_amount: a.amount,
        p_effective_from_month: a.effectiveFromMonth ?? undefined,
        p_note: a.note ?? undefined,
      });
      if (error) throw new Error(error.message);
      return data as { effectiveFrom: string; note: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['special-fee-prices'] });
      qc.invalidateQueries({ queryKey: ['fee-config-matrix'] });
      qc.invalidateQueries({ queryKey: ['period-fee-status'] });
    },
  });
};
