// =============================================================================
// useProfitLockChecks — dữ liệu cho lưới mềm của màn Chốt lợi nhuận (rà 21/10, F20 + F07).
//
//  - Bộ dò chi cố định dùng chung (computeProfitReportChecks, cùng hàm Báo cáo LN gọi)
//    cho tháng đang chốt và ĐÚNG các toà đang chọn. Cơ sở dò = cơ sở chip trên Báo cáo
//    LN: theo KỲ PHÂN BỔ, gồm phiếu CHỜ DUYỆT, chỉ KQKD, so với mức khai ở "Phí cố định
//    theo toà". Chỉ tải khi người xem chốt được (`enabled`).
//  - Toà vận hành cho chủ nhà trong kỳ (landlord_operations_list_v1): lỗi / không có quyền
//    / RPC chưa lên production ⇒ IM LẶNG, tập rỗng — chỉ mất nhãn, không làm màn đỏ
//    (query khai errorDisplay 'inline' và không nằm trong QueryRegion nào).
//
// Tách thành hook riêng để test màn chốt mock gọn một chỗ.
// =============================================================================

import { useMemo } from 'react';
import { useBuildings } from '@/hooks/useBuildings';
import { useAccrualMonthReport } from '@/hooks/useAccrualReport';
import { useFeeConfigMatrix } from '@/hooks/useFeeConfigMatrix';
import { useIncomeExpenseTypes } from '@/hooks/useIncomeExpenseTypes';
import { useLandlordOperations } from '@/hooks/useLandlordSettlement';
import { orgBuildingsOf } from '@/lib/profitReportScope';
import { landlordOperatedBuildingIds } from '@/lib/profitLockPrecheck';
import {
  computeProfitReportChecks,
  type ProfitCheckBuilding,
  type ProfitReportChecksResult,
} from '@/lib/profitReportChecks';

export interface ProfitLockChecksData {
  /** Kết quả dò cho `targetBuildingIds`; null khi chưa đủ dữ liệu, đang tải hoặc lỗi. */
  checks: ProfitReportChecksResult | null;
  isLoading: boolean;
  isError: boolean;
  /** Toà vận hành cho chủ nhà trong kỳ — rỗng khi chưa tải / lỗi / không có quyền. */
  operatedBuildingIds: ReadonlySet<string>;
}

type OrgBuilding = ProfitCheckBuilding & { organization_id?: string | null };

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function useProfitLockChecks(opts: {
  organizationId: string;
  /** 'YYYY-MM-01' */
  period: string;
  targetBuildingIds: readonly string[];
  /** Người xem chốt được (can_lock) — tắt thì không tải dữ liệu dò. */
  enabled: boolean;
}): ProfitLockChecksData {
  const { organizationId, period, targetBuildingIds, enabled } = opts;
  const validPeriod = /^\d{4}-\d{2}-01$/.test(period);
  const active = enabled && !!organizationId && validPeriod;

  const buildingsQuery = useBuildings({ includeVirtual: true, enabled: active });
  const orgBuildings = useMemo(
    () => orgBuildingsOf((buildingsQuery.data ?? []) as OrgBuilding[], organizationId || null),
    [buildingsQuery.data, organizationId],
  );
  const realIds = useMemo(
    () => orgBuildings.filter((b) => !b.is_virtual).map((b) => b.id).sort(),
    [orgBuildings],
  );
  const ready = active && buildingsQuery.isSuccess && realIds.length > 0;

  // Tháng '' ⇒ hook trả rỗng, không truy vấn — nên `ready` phải chốt trước khi tin kết quả.
  const accrualQuery = useAccrualMonthReport(
    ready ? period.slice(0, 7) : '',
    { building_ids: realIds, approval_status: 'ALL_ACTIVE', business_result_only: true },
    { businessResultOnly: true },
  );
  const feeQuery = useFeeConfigMatrix(undefined, { enabled: active });
  const typesQuery = useIncomeExpenseTypes('expense', { enabled: active });
  const operationsQuery = useLandlordOperations();

  const operatedBuildingIds = useMemo(
    () => landlordOperatedBuildingIds(operationsQuery.data?.operations, period, organizationId || null),
    [operationsQuery.data, period, organizationId],
  );

  // Danh sách toà đã về mà công ty không có toà thật nào ⇒ KHÔNG dò được (không phải "đủ"):
  // báo như lỗi để hộp chốt buộc tick xác nhận, không treo ở trạng thái đang dò.
  const noBuildings = active && buildingsQuery.isSuccess && realIds.length === 0;
  const isError =
    active &&
    (noBuildings || buildingsQuery.isError || accrualQuery.isError || feeQuery.isError || typesQuery.isError);
  const isLoading =
    active &&
    !isError &&
    (!buildingsQuery.isSuccess || accrualQuery.isLoading || feeQuery.isLoading || typesQuery.isLoading);

  const targetKey = [...targetBuildingIds].sort().join(',');
  const checks = useMemo(() => {
    if (!ready || isError || !accrualQuery.data || !feeQuery.data || !typesQuery.data) return null;
    const targets = targetKey ? targetKey.split(',') : [];
    if (targets.length === 0) return null;
    return computeProfitReportChecks({
      rows: accrualQuery.data.rows,
      buildings: orgBuildings,
      feeRates: feeQuery.data,
      expenseTypes: typesQuery.data,
      scopeBuildingIds: targets,
      skipRentBuildingIds: operatedBuildingIds,
      today: todayIso(),
    });
  }, [ready, isError, accrualQuery.data, feeQuery.data, typesQuery.data, targetKey, orgBuildings, operatedBuildingIds]);

  return { checks, isLoading, isError, operatedBuildingIds };
}
