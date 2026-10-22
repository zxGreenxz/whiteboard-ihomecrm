// =============================================================================
// useProfitOverviewCoverage — dữ liệu phần đối chiếu của tab Tổng quan (rà 21/10, F18/F20).
//
// LN "hiện tại" lấy từ useFaMonthlyPnl(..., accrual = true) — CÙNG RPC
// fa_monthly_pnl_accrual với useMonthlyBuildingProfit (hook LN theo toà của chốt LN)
// nhưng GIỮ hạt tháng × toà và GIỮ dòng toà ảo, đủ để dựng ma trận và dòng chi phí
// chung trong MỘT lần gọi cho cả năm (useMonthlyBuildingProfit gộp hết về 1 dòng/toà).
// Cơ sở: dồn tích theo kỳ phân bổ, chỉ phiếu đã duyệt, chỉ KQKD, trước lương điều hành.
//
// Phạm vi = công ty đang chọn: RLS cho siêu quản trị thấy toà mọi công ty (gồm DEMO),
// nên KHÔNG gọi RPC với danh sách toà rỗng (rỗng = mọi toà). Chưa chọn công ty / công ty
// không có toà ⇒ không gọi, màn báo rõ.
// =============================================================================

import { useMemo } from 'react';
import type { RegionQuery } from '@/components/errors/QueryRegion';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useBuildings } from '@/hooks/useBuildings';
import { useFaMonthlyPnl } from '@/hooks/useFinancialAnalysis';
import { orgBuildingsOf } from '@/lib/profitReportScope';
import {
  buildProfitCoverage,
  coverageMonths,
  type CoverageSnapshotRow,
  type ProfitCoverage,
} from '@/lib/profitOverviewCoverage';

interface ScopedBuildingRow {
  id: string;
  name?: string | null;
  organization_id?: string | null;
  is_virtual?: boolean | null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const lastDayOf = (year: number, month: number): number => new Date(year, month, 0).getDate();

export interface ProfitOverviewCoverageData {
  coverage: ProfitCoverage | null;
  months: number[];
  today: { year: number; month: number };
  /** Đã chọn công ty (chưa chọn thì không gọi gì). */
  organizationSelected: boolean;
  /** Công ty có ≥1 toà thật. */
  hasBuildings: boolean;
  /** Nguồn cho QueryRegion của khối đối chiếu (chỉ nguồn đang chạy). */
  regionQueries: readonly RegionQuery[];
}

export function useProfitOverviewCoverage(
  year: number,
  monthFilter: number | null,
  snapshots: readonly CoverageSnapshotRow[] | undefined,
): ProfitOverviewCoverageData {
  const { selectedOrganizationId } = useOrganization();
  const buildingsQuery = useBuildings({ includeVirtual: true });
  const orgBuildings = useMemo(
    () => orgBuildingsOf((buildingsQuery.data ?? []) as ScopedBuildingRow[], selectedOrganizationId ?? null),
    [buildingsQuery.data, selectedOrganizationId],
  );
  const orgIds = useMemo(() => orgBuildings.map((b) => b.id).sort(), [orgBuildings]);
  const realBuildings = useMemo(
    () => orgBuildings.filter((b) => !b.is_virtual).map((b) => ({ id: b.id, name: (b.name ?? '').trim() || '—' })),
    [orgBuildings],
  );

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const months = useMemo(
    () => coverageMonths(year, monthFilter, { year: todayYear, month: todayMonth }),
    [year, monthFilter, todayYear, todayMonth],
  );
  const first = months[0];
  const last = months[months.length - 1];
  const range =
    first != null && last != null && realBuildings.length > 0
      ? { start: `${year}-${pad2(first)}-01`, end: `${year}-${pad2(last)}-${pad2(lastDayOf(year, last))}` }
      : null;
  const accrualQuery = useFaMonthlyPnl(range?.start, range?.end, orgIds, true);

  const snapshotsInOrg = useMemo(() => {
    if (!snapshots) return undefined;
    const inOrg = new Set(orgIds);
    // Dòng của toà đã xoá không còn trong danh sách toà ⇒ nhận theo organization_id của dòng
    // (reader trải nguyên dòng profit_monthly nên cột này có lúc chạy dù kiểu không khai).
    return snapshots.filter(
      (s) =>
        inOrg.has(s.building_id) ||
        (!!selectedOrganizationId &&
          (s as CoverageSnapshotRow & { organization_id?: unknown }).organization_id === selectedOrganizationId),
    );
  }, [snapshots, orgIds, selectedOrganizationId]);

  const coverage = useMemo(() => {
    if (!range || !snapshotsInOrg || !accrualQuery.data || accrualQuery.isPlaceholderData) return null;
    return buildProfitCoverage({
      year,
      months,
      buildings: realBuildings,
      snapshots: snapshotsInOrg,
      accrual: accrualQuery.data,
    });
    // range là object mới mỗi lần render — phụ thuộc vào hai mốc của nó.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.start, range?.end, snapshotsInOrg, accrualQuery.data, accrualQuery.isPlaceholderData, year, months, realBuildings]);

  return {
    coverage,
    months,
    today: { year: todayYear, month: todayMonth },
    organizationSelected: !!selectedOrganizationId,
    hasBuildings: realBuildings.length > 0,
    regionQueries: range ? [buildingsQuery, accrualQuery] : [buildingsQuery],
  };
}
