import { type KeyboardEvent, useMemo } from "react";
import { AlertTriangle, Building2, Calculator, Info, RefreshCw } from "lucide-react";

import { DeltaBadge } from "@/components/finance-analysis/DeltaBadge";
import {
  FinanceEmptyState,
  FinanceLoadingGrid,
  FinanceQueryError,
} from "@/components/finance-performance/FinanceDataState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBusinessPerformancePnl } from "@/hooks/reports/useBusinessPerformance";
import { deriveFinanceQueryState } from "@/lib/financeQueryState";
import {
  type BusinessPerformanceFilters,
  type BusinessPerformancePnlRow,
} from "@/lib/businessPerformance";
import { formatCurrency } from "@/lib/utils";

interface BuildingPerformanceTabProps {
  filters: BusinessPerformanceFilters;
  buildings: readonly BuildingPerformanceBuilding[];
}

export interface BuildingPerformanceBuilding {
  id: string;
  name: string;
}

interface PeriodValue {
  revenue: number;
  expense: number;
  net: number;
  marginPct: number | null;
}

interface BuildingPerformanceRow {
  buildingId: string;
  buildingName: string;
  current: PeriodValue | null;
  previous: PeriodValue | null;
  yearAgo: PeriodValue | null;
}

function monthLabel(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[2]}/${match[1]}` : month;
}

function formatPercent(value: number | null | undefined) {
  return value == null
    ? "—"
    : `${value.toLocaleString("vi-VN", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}%`;
}

function formatMoney(value: number | null | undefined) {
  return value == null ? "—" : formatCurrency(value);
}

function formatSignedMoney(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(value))}`;
}

function StaleDataWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert role="status">
      <Info aria-hidden="true" />
      <AlertTitle>Dữ liệu đang hiển thị có thể đã cũ</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>Lần làm mới gần nhất thất bại. Số liệu đã tải trước đó vẫn được giữ để tham khảo.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          Thử tải lại
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function scrollBuildingTableOnKeyDown(
  event: Pick<
    KeyboardEvent<HTMLDivElement>,
    "currentTarget" | "key" | "preventDefault"
  >,
) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

  event.preventDefault();
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const distance = Math.max(event.currentTarget.clientWidth * 0.8, 160);
  event.currentTarget.scrollLeft += direction * distance;
}

// Exported for the zero-base regression test without rendering the component.
// eslint-disable-next-line react-refresh/only-export-components
export function calculateNetAbsoluteDelta(
  currentNet: number | null,
  baseNet: number | null,
): number | null {
  return currentNet == null || baseNet == null ? null : currentNet - baseNet;
}

function buildBuildingRows(
  rows: readonly BusinessPerformancePnlRow[],
  filters: BusinessPerformanceFilters,
  buildings: readonly BuildingPerformanceBuilding[],
): BuildingPerformanceRow[] {
  const targetMonths = new Set([filters.month, filters.prevMonth, filters.yoyMonth]);
  const aggregates = new Map<
    string,
    {
      name: string;
      periods: Map<string, { revenue: number; expense: number }>;
    }
  >();

  for (const building of buildings) {
    aggregates.set(building.id, {
      name: building.name,
      periods: new Map(
        [...targetMonths].map((month) => [month, { revenue: 0, expense: 0 }]),
      ),
    });
  }

  for (const row of rows) {
    const month = row.month.slice(0, 7);
    if (row.is_virtual || !targetMonths.has(month)) {
      continue;
    }

    const building = aggregates.get(row.building_id);
    if (!building) continue;
    const period = building.periods.get(month);
    if (!period) continue;
    period.revenue += row.revenue;
    period.expense += row.expense;
    building.periods.set(month, period);
  }

  const readPeriod = (
    building: { periods: Map<string, { revenue: number; expense: number }> },
    month: string,
  ): PeriodValue | null => {
    const period = building.periods.get(month);
    if (!period) return null;
    const net = period.revenue - period.expense;
    return {
      ...period,
      net,
      marginPct: period.revenue > 0 ? (net / period.revenue) * 100 : null,
    };
  };

  return [...aggregates.entries()]
    .map(([buildingId, building]) => ({
      buildingId,
      buildingName: building.name,
      current: readPeriod(building, filters.month),
      previous: readPeriod(building, filters.prevMonth),
      yearAgo: readPeriod(building, filters.yoyMonth),
    }))
    .sort((a, b) => a.buildingName.localeCompare(b.buildingName, "vi"));
}

function NetComparison({
  current,
  base,
  baseLabel,
}: {
  current: PeriodValue | null;
  base: PeriodValue | null;
  baseLabel: string;
}) {
  if (!current || !base) {
    return <span className="text-xs text-muted-foreground">Không có đủ hai kỳ</span>;
  }

  const absoluteDelta = calculateNetAbsoluteDelta(current.net, base.net);
  if (absoluteDelta == null) {
    return <span className="text-xs text-muted-foreground">Không có đủ hai kỳ</span>;
  }

  return (
    <div className="flex flex-col gap-1 text-right">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="font-medium tabular-nums">
          {formatSignedMoney(absoluteDelta)}
        </span>
        {base.net !== 0 ? (
          <DeltaBadge current={current.net} previous={base.net} />
        ) : (
          <span className="text-xs text-muted-foreground">% không khả dụng</span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        Nền {baseLabel}: {formatCurrency(base.net)}
      </div>
    </div>
  );
}

function BuildingMobileCard({
  row,
  filters,
}: {
  row: BuildingPerformanceRow;
  filters: BusinessPerformanceFilters;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="size-4 text-primary" aria-hidden="true" />
          {row.buildingName}
        </CardTitle>
        <CardDescription>Kỳ {monthLabel(filters.month)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Doanh thu</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatMoney(row.current?.revenue)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Chi phí</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatMoney(row.current?.expense)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lợi nhuận</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatMoney(row.current?.net)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Biên lợi nhuận</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatPercent(row.current?.marginPct)}</dd>
          </div>
        </dl>
        <div className="grid gap-3 border-t pt-3 text-sm sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              MoM lợi nhuận
            </div>
            <NetComparison current={row.current} base={row.previous} baseLabel={monthLabel(filters.prevMonth)} />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              YoY lợi nhuận
            </div>
            <NetComparison current={row.current} base={row.yearAgo} baseLabel={monthLabel(filters.yoyMonth)} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function BuildingPerformanceTab({
  filters,
  buildings,
}: BuildingPerformanceTabProps) {
  const pnlQuery = useBusinessPerformancePnl(filters);
  const requestedBuildings = useMemo(() => {
    const requestedIds = new Set(filters.buildingIds);
    return buildings.filter((building) => requestedIds.has(building.id));
  }, [buildings, filters.buildingIds]);
  const hasPhysicalScope = requestedBuildings.length > 0;
  const hasPnlSource = pnlQuery.data !== undefined;
  const pnlState = deriveFinanceQueryState(pnlQuery);
  const rows = useMemo(
    () => buildBuildingRows(pnlQuery.data ?? [], filters, requestedBuildings),
    [filters, pnlQuery.data, requestedBuildings],
  );

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Calculator className="size-5 text-primary" aria-hidden="true" />
            Doanh thu - Chi phí = Lợi nhuận
          </CardTitle>
          <CardDescription>
            Mỗi dòng cộng các dòng P&L của đúng tòa vật lý trong kỳ; biên lợi nhuận =
            Lợi nhuận / Doanh thu khi doanh thu lớn hơn 0.
          </CardDescription>
        </CardHeader>
      </Card>

      <Alert role="note">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Hòa vốn và tiền thuê chủ nhà chưa khả dụng</AlertTitle>
        <AlertDescription>
          Báo cáo chủ động không trả về số 0 hoặc tỷ lệ ước đoán cho các chỉ số này.
          Chúng chỉ được mở khi mapping vai trò tài chính theo hiệu lực ngày đã hoàn tất
          và backend tổng hợp đã được kiểm chứng, đối soát.
        </AlertDescription>
      </Alert>

      {pnlState.showLoading ? <FinanceLoadingGrid count={6} /> : null}
      {pnlState.showStaleWarning ? (
        <StaleDataWarning onRetry={() => void pnlQuery.refetch()} />
      ) : null}
      {pnlState.hasBlockingError ? (
        <FinanceQueryError
          title="Không thể tải hiệu quả theo tòa nhà"
          error={pnlState.blockingError}
          onRetry={() => void pnlQuery.refetch()}
        />
      ) : null}
      {pnlState.canRenderData && !hasPhysicalScope ? (
        <FinanceEmptyState
          title="Chưa có tòa vật lý trong phạm vi"
          description="Hãy chọn ít nhất một tòa vật lý để tải hiệu quả theo tòa. Báo cáo không tự mở rộng sang tòa ảo."
        />
      ) : null}
      {pnlState.canRenderData && hasPhysicalScope && !hasPnlSource ? (
        <FinanceEmptyState
          title="Nguồn dữ liệu P&L chưa khả dụng"
          description="Yêu cầu P&L chưa trả về một tập dữ liệu xác nhận; báo cáo không thay bằng số 0."
        />
      ) : null}

      {pnlState.canRenderData &&
      hasPhysicalScope &&
      hasPnlSource &&
      rows.length > 0 ? (
        <>
          <div
            className="hidden overflow-x-auto rounded-lg border bg-card md:block"
            role="region"
            aria-label="Cuộn ngang bảng hiệu quả theo tòa nhà"
            tabIndex={0}
            onKeyDown={scrollBuildingTableOnKeyDown}
          >
            <table className="w-full caption-bottom text-sm">
              <TableCaption>
                Hiệu quả tòa vật lý kỳ {monthLabel(filters.month)}; MoM so với {monthLabel(filters.prevMonth)},
                YoY so với {monthLabel(filters.yoyMonth)}.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="min-w-48">Tòa nhà</TableHead>
                  <TableHead scope="col" className="min-w-36 text-right">Doanh thu</TableHead>
                  <TableHead scope="col" className="min-w-36 text-right">Chi phí</TableHead>
                  <TableHead scope="col" className="min-w-36 text-right">LN</TableHead>
                  <TableHead scope="col" className="min-w-28 text-right">Margin</TableHead>
                  <TableHead scope="col" className="min-w-52 text-right">MoM net</TableHead>
                  <TableHead scope="col" className="min-w-52 text-right">YoY net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.buildingId}>
                    <TableHead scope="row" className="h-auto p-4 text-foreground">
                      {row.buildingName}
                    </TableHead>
                    <TableCell className="text-right tabular-nums">{formatMoney(row.current?.revenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(row.current?.expense)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(row.current?.net)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPercent(row.current?.marginPct)}</TableCell>
                    <TableCell className="text-right">
                      <NetComparison current={row.current} base={row.previous} baseLabel={monthLabel(filters.prevMonth)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <NetComparison current={row.current} base={row.yearAgo} baseLabel={monthLabel(filters.yoyMonth)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>

          <div className="flex flex-col gap-4 md:hidden">
            {rows.map((row) => (
              <BuildingMobileCard key={row.buildingId} row={row} filters={filters} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
