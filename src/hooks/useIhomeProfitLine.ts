// Dòng "Lợi nhuận của iHome" trên Báo cáo LN (chủ chốt 22/10/2026): giữ TỔNG lợi nhuận, thêm một dòng
// = tổng − phần chủ nhà của các toà vận hành cho chủ nhà trong phạm vi đang xem (toà đang lọc × tháng
// đang xem). Phần chủ nhà vẫn tính nhưng không hiện thành dòng riêng. Desktop và mobile dùng chung;
// phần quyết định nằm ở `ihomeLineOf` (lib, có test).
import { useMemo } from 'react';
import { useLandlordIhomeProfit } from '@/hooks/useLandlordSettlement';
import { ihomeLineOf, type IhomeLineDecision } from '@/lib/landlordSettlement';

export { ihomeLineTitle, pendingBuildingIdsOf } from '@/lib/landlordSettlement';

export type IhomeProfitLine = IhomeLineDecision | { kind: 'loading' } | { kind: 'error'; retry: () => void };

export interface IhomeProfitLineOptions {
  /** Tắt hẳn (vd đang ẩn dải thống kê, hoặc đang lọc chỉ thu / chỉ chi — tổng không phải lợi nhuận). */
  enabled: boolean;
  /** Trang đang xem đúng cơ sở của phần chủ nhà: phân bổ theo kỳ + chỉ khoản tính KQKD. */
  sameBasis: boolean;
  /** Toà có phiếu CHỜ DUYỆT nằm trong tổng đang xem. */
  pendingBuildingIds: ReadonlySet<string>;
}

/**
 * @param ym 'YYYY-MM' tháng đang xem.
 * @param buildingIds toà đang lọc; rỗng = mọi toà.
 * @param totalProfit tổng lợi nhuận đang hiện (cùng cơ sở với thẻ Lợi nhuận).
 */
export function useIhomeProfitLine(
  ym: string,
  buildingIds: readonly string[],
  totalProfit: number,
  opts: IhomeProfitLineOptions,
): IhomeProfitLine {
  const { enabled, sameBasis, pendingBuildingIds } = opts;
  const firstOfMonth = /^\d{4}-\d{2}$/.test(ym) ? `${ym}-01` : null;
  const query = useLandlordIhomeProfit(enabled ? firstOfMonth : null, enabled ? firstOfMonth : null);
  const { data, isError, refetch } = query;
  return useMemo((): IhomeProfitLine => {
    if (!enabled || !firstOfMonth) return { kind: 'hidden' };
    if (isError) return { kind: 'error', retry: () => { void refetch(); } };
    if (!data) return { kind: 'loading' };
    return ihomeLineOf(data, { ym, buildingIds, totalProfit, sameBasis, pendingBuildingIds });
  }, [enabled, firstOfMonth, isError, refetch, data, totalProfit, ym, buildingIds, sameBasis, pendingBuildingIds]);
}
