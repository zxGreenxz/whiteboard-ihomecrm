import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  Banknote,
  Building2,
  DoorOpen,
  HandCoins,
  Home,
  Landmark,
  Percent,
  RefreshCw,
  ReceiptText,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

import { DeltaBadge } from "@/components/finance-analysis/DeltaBadge";
import { KpiCard } from "@/components/finance-analysis/KpiCard";
import {
  FinanceEmptyState,
  FinanceLoadingGrid,
  FinanceQueryError,
} from "@/components/finance-performance/FinanceDataState";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  useBusinessPerformanceOccupancySnapshot,
  useBusinessPerformancePnl,
  useBusinessPerformanceSnapshot,
  type OccupancySnapshotRow,
} from "@/hooks/reports/useBusinessPerformance";
import { deriveFinanceQueryState } from "@/lib/financeQueryState";
import {
  aggregatePnlByMonth,
  aggregateSnapshot,
  buildPnlComparisons,
  parseFiniteNumber,
  type BusinessPerformanceFilters,
  type BusinessPerformanceMetricComparison,
  type BusinessPerformancePnlRow,
} from "@/lib/businessPerformance";
import { cn, formatCurrency } from "@/lib/utils";

interface BusinessOverviewTabProps {
  filters: BusinessPerformanceFilters;
}

interface OccupancyAggregate {
  total: number;
  occupied: number;
  reserved: number;
  available: number;
  listedRentOpportunity: number;
  occupancyPct: number | null;
  committedPct: number | null;
}

interface MetricComparisonRowProps {
  label: string;
  metric: BusinessPerformanceMetricComparison;
  invert?: boolean;
}

type ValidationResult<T> = {
  data: T | null;
  error: Error | null;
};

const BUSINESS_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const WRAPPED_KPI_ACCENT = {
  amber: {
    border: "border-l-amber-500",
    iconBg: "bg-amber-100",
    iconText: "text-amber-600",
  },
  blue: {
    border: "border-l-blue-500",
    iconBg: "bg-blue-100",
    iconText: "text-blue-600",
  },
  violet: {
    border: "border-l-violet-500",
    iconBg: "bg-violet-100",
    iconText: "text-violet-600",
  },
} as const;

function WrappedKpiCard({
  label,
  value,
  icon: Icon,
  accent,
  className,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  accent: keyof typeof WRAPPED_KPI_ACCENT;
  className?: string;
}) {
  const tone = WRAPPED_KPI_ACCENT[accent];

  return (
    <Card className={cn("border-l-4", tone.border, className)}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-full", tone.iconBg)}>
            <Icon className={cn("size-5", tone.iconText)} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold tabular-nums sm:text-xl">{value}</div>
            <div className="mt-1 text-sm leading-snug text-muted-foreground">{label}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StaleDataWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert role="status">
      <AlertCircle aria-hidden="true" />
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

function monthLabel(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[2]}/${match[1]}` : month;
}

function currentBusinessDate() {
  const parts = BUSINESS_DATE_FORMATTER.formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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

// Exported for the zero-base regression test without rendering the component.
// eslint-disable-next-line react-refresh/only-export-components
export function calculateComparisonAbsoluteDelta(
  current: number | null,
  base: number | null,
): number | null {
  return current == null || base == null ? null : current - base;
}

function aggregateOccupancy(rows: readonly OccupancySnapshotRow[]): OccupancyAggregate | null {
  if (rows.length === 0) return null;

  const total = rows.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      occupied: sum.occupied + row.occupied,
      reserved: sum.reserved + row.reserved,
      available: sum.available + row.available,
      listedRentOpportunity: sum.listedRentOpportunity + row.missed_revenue,
    }),
    { total: 0, occupied: 0, reserved: 0, available: 0, listedRentOpportunity: 0 },
  );

  return {
    ...total,
    occupancyPct: total.total > 0 ? (total.occupied / total.total) * 100 : null,
    committedPct:
      total.total > 0
        ? ((total.occupied + total.reserved) / total.total) * 100
        : null,
  };
}

function toValidationError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function parseNonNegativeNumber(value: unknown, field: string) {
  const parsed = parseFiniteNumber(value, field);
  if (parsed < 0 || !Number.isSafeInteger(parsed)) {
    throw new Error(`${field} phải là số nguyên không âm an toàn`);
  }
  return parsed;
}

function parsePercentage(value: unknown, field: string) {
  const parsed = parseFiniteNumber(value, field);
  if (parsed < 0 || parsed > 100) {
    throw new Error(`${field} phải nằm trong khoảng 0 đến 100`);
  }
  return parsed;
}

function expectedSnapshotRate(numerator: number, total: number) {
  return total > 0 ? Number(((numerator / total) * 100).toFixed(1)) : 0;
}

function validateOccupancyRows(
  rows: readonly OccupancySnapshotRow[],
  buildingIds: readonly string[],
): ValidationResult<OccupancySnapshotRow[]> {
  try {
    const requestedBuildingIds = new Set(buildingIds);
    const data = rows.map((row, index) => {
        if (!requestedBuildingIds.has(row.building_id)) {
          throw new Error(
            `snapshot[${index}].building_id không thuộc phạm vi tòa vật lý đã chọn`,
          );
        }
        const total = parseNonNegativeNumber(row.total, `snapshot[${index}].total`);
        const occupied = parseNonNegativeNumber(
          row.occupied,
          `snapshot[${index}].occupied`,
        );
        const reserved = parseNonNegativeNumber(
          row.reserved,
          `snapshot[${index}].reserved`,
        );
        const maintenance = parseNonNegativeNumber(
          row.maintenance,
          `snapshot[${index}].maintenance`,
        );
        const unavailable = parseNonNegativeNumber(
          row.unavailable,
          `snapshot[${index}].unavailable`,
        );
        const available = parseNonNegativeNumber(
          row.available,
          `snapshot[${index}].available`,
        );
        if (occupied > total) {
          throw new Error(
            `snapshot[${index}].occupied không được lớn hơn tổng phòng`,
          );
        }
        if (occupied + reserved + maintenance + unavailable + available !== total) {
          throw new Error(
            `snapshot[${index}] có tổng trạng thái phòng không khớp tổng phòng`,
          );
        }
        const occupancyPct = parsePercentage(
          row.occupancy_pct,
          `snapshot[${index}].occupancy_pct`,
        );
        const committedPct = parsePercentage(
          row.committed_pct,
          `snapshot[${index}].committed_pct`,
        );
        if (occupancyPct !== expectedSnapshotRate(occupied, total)) {
          throw new Error(
            `snapshot[${index}].occupancy_pct không khớp số phòng đang thuê`,
          );
        }
        if (committedPct !== expectedSnapshotRate(occupied + reserved, total)) {
          throw new Error(
            `snapshot[${index}].committed_pct không khớp số phòng đã cam kết`,
          );
        }
        return {
          ...row,
          total,
          occupied,
          reserved,
          maintenance,
          unavailable,
          available,
          occupancy_pct: occupancyPct,
          committed_pct: committedPct,
          missed_revenue: parseFiniteNumber(
            row.missed_revenue,
            `snapshot[${index}].missed_revenue`,
          ),
        };
      });
    const aggregateCounts = {
      total: 0,
      occupied: 0,
      reserved: 0,
      maintenance: 0,
      unavailable: 0,
      available: 0,
    };
    for (const row of data) {
      aggregateCounts.total = parseNonNegativeNumber(
        aggregateCounts.total + row.total,
        "snapshot.aggregate.total",
      );
      aggregateCounts.occupied = parseNonNegativeNumber(
        aggregateCounts.occupied + row.occupied,
        "snapshot.aggregate.occupied",
      );
      aggregateCounts.reserved = parseNonNegativeNumber(
        aggregateCounts.reserved + row.reserved,
        "snapshot.aggregate.reserved",
      );
      aggregateCounts.maintenance = parseNonNegativeNumber(
        aggregateCounts.maintenance + row.maintenance,
        "snapshot.aggregate.maintenance",
      );
      aggregateCounts.unavailable = parseNonNegativeNumber(
        aggregateCounts.unavailable + row.unavailable,
        "snapshot.aggregate.unavailable",
      );
      aggregateCounts.available = parseNonNegativeNumber(
        aggregateCounts.available + row.available,
        "snapshot.aggregate.available",
      );
    }
    return { data, error: null };
  } catch (error) {
    return { data: null, error: toValidationError(error) };
  }
}

function negativeBuildingNames(rows: readonly BusinessPerformancePnlRow[], month: string) {
  const byBuilding = new Map<string, { name: string; net: number }>();

  for (const row of rows) {
    if (row.is_virtual || row.month.slice(0, 7) !== month) continue;
    const current = byBuilding.get(row.building_id) ?? {
      name: row.building_name,
      net: 0,
    };
    current.net += row.net;
    byBuilding.set(row.building_id, current);
  }

  return [...byBuilding.values()]
    .filter((building) => building.net < 0)
    .sort((a, b) => a.name.localeCompare(b.name, "vi"))
    .map((building) => building.name);
}

function ComparisonDelta({
  current,
  base,
  pct,
  invert,
}: {
  current: number | null;
  base: number | null;
  pct: number | null;
  invert?: boolean;
}) {
  const absoluteDelta = calculateComparisonAbsoluteDelta(current, base);
  // Hai vế `current`/`base` là THỪA về mặt logic — `calculateComparisonAbsoluteDelta`
  // đã trả null đúng trong các trường hợp đó. Nhưng kết luận ấy đi vòng qua giá trị
  // trả về của hàm nên TS không mang thu hẹp về lại `current`, trong khi <DeltaBadge>
  // bên dưới đòi `number`. Kiểm thẳng trên biến là cách giữ đúng bất biến mà không
  // phải khẳng định suông.
  if (absoluteDelta == null || current == null || base == null) {
    return <span className="text-xs text-muted-foreground">Không đủ cơ sở</span>;
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-sm font-medium tabular-nums">
        {formatSignedMoney(absoluteDelta)}
      </span>
      {base !== 0 && pct != null ? (
        <DeltaBadge current={current} previous={base} invert={invert} />
      ) : (
        <span className="text-xs text-muted-foreground">% không khả dụng</span>
      )}
    </div>
  );
}

function MetricComparisonRow({ label, metric, invert }: MetricComparisonRowProps) {
  return (
    <TableRow>
      <TableHead scope="row" className="h-auto font-medium text-foreground">
        {label}
      </TableHead>
      <TableCell className="text-right tabular-nums">{formatMoney(metric.current)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(metric.previous)}</TableCell>
      <TableCell className="text-right">
        <ComparisonDelta
          current={metric.current}
          base={metric.previous}
          pct={metric.momPct}
          invert={invert}
        />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(metric.yearAgo)}</TableCell>
      <TableCell className="text-right">
        <ComparisonDelta
          current={metric.current}
          base={metric.yearAgo}
          pct={metric.yoyPct}
          invert={invert}
        />
      </TableCell>
    </TableRow>
  );
}

export function BusinessOverviewTab({ filters }: BusinessOverviewTabProps) {
  const [, setSearchParams] = useSearchParams();
  const pnlQuery = useBusinessPerformancePnl(filters);
  const snapshotQuery = useBusinessPerformanceSnapshot(
    filters.organizationId,
    filters.buildingIds,
  );
  const businessDate = currentBusinessDate();
  const businessMonth = businessDate.slice(0, 7);
  const occupancyQuery = useBusinessPerformanceOccupancySnapshot(
    filters.organizationId,
    businessDate,
    filters.buildingIds,
  );

  const comparisons = useMemo(
    () => buildPnlComparisons(pnlQuery.data ?? [], filters),
    [filters, pnlQuery.data],
  );
  const pnlByMonth = useMemo(
    () => aggregatePnlByMonth(pnlQuery.data ?? [], [filters.month]),
    [filters.month, pnlQuery.data],
  );
  const snapshot = useMemo(
    () => aggregateSnapshot(snapshotQuery.data ?? []),
    [snapshotQuery.data],
  );
  const occupancyValidation = useMemo(
    () => validateOccupancyRows(occupancyQuery.data ?? [], filters.buildingIds),
    [filters.buildingIds, occupancyQuery.data],
  );
  const occupancy = useMemo(
    () => aggregateOccupancy(occupancyValidation.data ?? []),
    [occupancyValidation.data],
  );
  const pnlState = deriveFinanceQueryState(pnlQuery);
  const snapshotState = deriveFinanceQueryState(snapshotQuery);
  const occupancyState = deriveFinanceQueryState(
    occupancyQuery,
    occupancyValidation.error,
  );
  const lossBuildings = useMemo(
    () => negativeBuildingNames(pnlQuery.data ?? [], filters.month),
    [filters.month, pnlQuery.data],
  );

  const openTab = (tab: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("tab", tab);
      return next;
    });
  };

  const observations = useMemo(() => {
    const items: string[] = [];
    if (lossBuildings.length > 0) {
      items.push(
        `${lossBuildings.length.toLocaleString("vi-VN")} tòa có lợi nhuận nhỏ hơn 0 trong kỳ: ${lossBuildings.join(", ")}.`,
      );
    }
    if (occupancy && occupancy.available > 0) {
      items.push(
        `${occupancy.available.toLocaleString("vi-VN")} phòng đang available, với giá trị cho thuê niêm yết ${formatCurrency(occupancy.listedRentOpportunity)}/tháng.`,
      );
    }
    if (filters.month === businessMonth) {
      items.push(
        `Tháng ${monthLabel(filters.month)} đang mở; số liệu KQKD có thể tiếp tục thay đổi khi nghiệp vụ được ghi nhận.`,
      );
    }
    return items;
  }, [businessMonth, filters.month, lossBuildings, occupancy]);

  const currentPnl = pnlByMonth.get(filters.month) ?? comparisons.current;
  const observationsHaveError = Boolean(
    pnlState.hasBlockingError || occupancyState.hasBlockingError,
  );
  const observationsAreLoading = pnlState.showLoading || occupancyState.showLoading;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="overview-pnl-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="overview-pnl-title" className="text-lg font-semibold">
              Kết quả kinh doanh tháng {monthLabel(filters.month)}
            </h2>
            <p className="text-sm text-muted-foreground">
              So sánh đúng kỳ được chọn với tháng trước và cùng kỳ năm trước.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => openTab("building-performance")}>
              Theo tòa nhà
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
        </div>

        {pnlState.showLoading ? <FinanceLoadingGrid count={4} /> : null}
        {pnlState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void pnlQuery.refetch()} />
        ) : null}
        {pnlState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải kết quả kinh doanh"
            error={pnlState.blockingError}
            onRetry={() => void pnlQuery.refetch()}
          />
        ) : null}
        {pnlState.canRenderData && !currentPnl ? (
          <FinanceEmptyState
            title="Chưa có dữ liệu KQKD cho kỳ đã chọn"
            description="Không có dòng P&L hợp lệ trong phạm vi tòa nhà hiện tại; các KPI không được thay bằng số 0."
          />
        ) : null}

        {pnlState.canRenderData && currentPnl ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="Doanh thu"
                value={formatCurrency(currentPnl.revenue)}
                icon={Banknote}
                accent="blue"
              />
              <KpiCard
                label="Chi phí"
                value={formatCurrency(currentPnl.expense)}
                icon={ReceiptText}
                accent="amber"
              />
              <KpiCard
                label="Lợi nhuận"
                value={formatCurrency(currentPnl.net)}
                icon={Landmark}
                accent="violet"
              />
              <KpiCard
                label="Biên lợi nhuận"
                value={formatPercent(currentPnl.marginPct)}
                icon={Percent}
                accent="slate"
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Đối chiếu theo kỳ</CardTitle>
                <CardDescription>
                  Chênh lệch tuyệt đối hiển thị khi cả hai kỳ tồn tại; phần trăm chỉ
                  hiển thị khi kỳ gốc khác 0.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  role="region"
                  aria-label="Bảng đối chiếu kết quả kinh doanh theo kỳ"
                  tabIndex={0}
                  className="overflow-x-auto rounded-md border"
                >
                  <table className="w-full caption-bottom text-sm">
                    <TableCaption className="sr-only">
                      Đối chiếu doanh thu, chi phí, lợi nhuận và biên lợi nhuận của
                      kỳ đã chọn với tháng trước và cùng kỳ năm trước.
                    </TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Chỉ số</TableHead>
                        <TableHead scope="col" className="min-w-32 text-right">
                          {monthLabel(filters.month)}
                        </TableHead>
                        <TableHead scope="col" className="min-w-32 text-right">
                          {monthLabel(filters.prevMonth)}
                        </TableHead>
                        <TableHead scope="col" className="min-w-44 text-right">MoM</TableHead>
                        <TableHead scope="col" className="min-w-32 text-right">
                          {monthLabel(filters.yoyMonth)}
                        </TableHead>
                        <TableHead scope="col" className="min-w-44 text-right">YoY</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <MetricComparisonRow label="Doanh thu" metric={comparisons.revenue} />
                      <MetricComparisonRow label="Chi phí" metric={comparisons.expense} invert />
                      <MetricComparisonRow label="Lợi nhuận" metric={comparisons.net} />
                      <TableRow>
                        <TableHead scope="row" className="h-auto font-medium text-foreground">
                          Biên lợi nhuận
                        </TableHead>
                        <TableCell className="text-right tabular-nums">
                          {formatPercent(comparisons.current?.marginPct)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPercent(comparisons.previous?.marginPct)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">—</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPercent(comparisons.yearAgo?.marginPct)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">—</TableCell>
                      </TableRow>
                    </TableBody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </section>

      <section aria-labelledby="overview-occupancy-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="overview-occupancy-title" className="text-lg font-semibold">
              Lấp đầy hiện tại
            </h2>
            <p className="text-sm text-muted-foreground">
              Snapshot Occupancy v2 tại ngày {businessDate.split("-").reverse().join("/")}.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => openTab("occupancy-vacancy")}>
            Xem lấp đầy & phòng trống
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>

        {occupancyState.showLoading ? <FinanceLoadingGrid count={7} /> : null}
        {occupancyState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void occupancyQuery.refetch()} />
        ) : null}
        {occupancyState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải snapshot lấp đầy"
            error={occupancyState.blockingError}
            onRetry={() => void occupancyQuery.refetch()}
          />
        ) : null}
        {occupancyState.canRenderData && !occupancy ? (
          <FinanceEmptyState
            title="Chưa có snapshot lấp đầy"
            description="Không có dữ liệu phòng vật lý trong phạm vi đã chọn tại ngày hiện tại."
          />
        ) : null}
        {occupancyState.canRenderData && occupancy ? (
          <div className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Tổng phòng" value={occupancy.total.toLocaleString("vi-VN")} icon={Building2} accent="slate" />
            <KpiCard label="Đang thuê" value={occupancy.occupied.toLocaleString("vi-VN")} icon={Home} accent="blue" />
            <KpiCard label="Đã giữ chỗ" value={occupancy.reserved.toLocaleString("vi-VN")} icon={HandCoins} accent="violet" />
            <KpiCard label="Available" value={occupancy.available.toLocaleString("vi-VN")} icon={DoorOpen} accent="amber" />
            <WrappedKpiCard
              label="Tỷ lệ lấp đầy có trọng số"
              value={formatPercent(occupancy.occupancyPct)}
              icon={Percent}
              accent="blue"
            />
            <WrappedKpiCard
              label="Tỷ lệ cam kết có trọng số"
              value={formatPercent(occupancy.committedPct)}
              icon={Percent}
              accent="violet"
            />
            <WrappedKpiCard
              label="Giá trị cho thuê niêm yết của phòng đang available/tháng"
              value={formatCurrency(occupancy.listedRentOpportunity)}
              icon={WalletCards}
              accent="amber"
              className="min-[400px]:col-span-2"
            />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="overview-snapshot-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="overview-snapshot-title" className="text-lg font-semibold">
              Phải thu và tiền cọc
            </h2>
            <p className="text-sm text-muted-foreground">
              Hiện tại — không phải số dư tại cuối tháng {monthLabel(filters.month)}.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => openTab("collections-debt")}>
            Xem thu tiền & công nợ
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>

        {snapshotState.showLoading ? <FinanceLoadingGrid count={2} /> : null}
        {snapshotState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void snapshotQuery.refetch()} />
        ) : null}
        {snapshotState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải snapshot phải thu và tiền cọc"
            error={snapshotState.blockingError}
            onRetry={() => void snapshotQuery.refetch()}
          />
        ) : null}
        {snapshotState.canRenderData && !snapshot ? (
          <FinanceEmptyState
            title="Chưa có snapshot tài chính hiện tại"
            description="Không có dữ liệu phải thu hoặc tiền cọc trong phạm vi tòa nhà đã chọn."
          />
        ) : null}
        {snapshotState.canRenderData && snapshot ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <KpiCard
              label="Phải thu"
              value={formatCurrency(snapshot.receivable_total)}
              icon={ReceiptText}
              accent="blue"
              sub="Hiện tại"
            />
            <KpiCard
              label="Tiền cọc đang giữ"
              value={formatCurrency(snapshot.deposit_held)}
              icon={WalletCards}
              accent="slate"
              sub="Hiện tại"
            />
          </div>
        ) : null}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quan sát thực tế</CardTitle>
          <CardDescription>
            Các mục dưới đây chỉ phản ánh điều kiện toán học và trạng thái đang có.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {observationsHaveError ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>Chưa thể kết luận các quan sát</AlertTitle>
              <AlertDescription>
                Dữ liệu KQKD hoặc lấp đầy đang lỗi nên chưa thể tổng hợp đáng tin cậy.
              </AlertDescription>
            </Alert>
          ) : observationsAreLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Đang tổng hợp quan sát từ dữ liệu KQKD và lấp đầy.
            </p>
          ) : observations.length > 0 ? (
            <ul className="flex flex-col gap-3 pl-5 text-sm leading-relaxed marker:text-primary">
              {observations.map((observation) => (
                <li key={observation} className="list-disc">
                  {observation}
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Không có điều kiện nào trong ba nhóm quan sát: lợi nhuận tòa nhỏ hơn 0,
              phòng available, hoặc tháng hiện tại đang mở.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => openTab("revenue-cost-structure")}>
          <Banknote data-icon="inline-start" aria-hidden="true" />
          Xem cơ cấu Thu & Chi
        </Button>
      </div>
    </div>
  );
}
