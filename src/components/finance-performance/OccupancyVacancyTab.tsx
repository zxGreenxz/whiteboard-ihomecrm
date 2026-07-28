import { useMemo } from "react";
import { format, isValid, parseISO } from "date-fns";
import {
  Ban,
  BookmarkCheck,
  Building2,
  CalendarClock,
  CircleDollarSign,
  DoorOpen,
  Home,
  Info,
  Percent,
  RefreshCw,
  Wrench,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  FinanceEmptyState,
  FinanceLoadingGrid,
  FinanceQueryError,
} from "@/components/finance-performance/FinanceDataState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
  useBusinessPerformanceOccupancySnapshot,
  useBusinessPerformanceOccupancyTrend12m,
  useBusinessPerformanceInventoryHistory,
  useBusinessPerformanceUpcomingVacancy,
  type OccupancySnapshotRow,
  type OccupancyTrendPoint,
  type UpcomingVacancyRow,
} from "@/hooks/reports/useBusinessPerformance";
import { deriveFinanceQueryState } from "@/lib/financeQueryState";
import {
  parseFiniteNumber,
  type BusinessPerformanceFilters,
} from "@/lib/businessPerformance";
import { formatCurrency } from "@/lib/utils";

interface OccupancyVacancyTabProps {
  filters: BusinessPerformanceFilters;
}

const BUSINESS_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function shiftMonth(month: string, delta: number) {
  const [year, monthValue] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthValue - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function displayMonth(value: string) {
  return `${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

type ValidationResult<T> = {
  data: T | null;
  error: Error | null;
};

interface MetricCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: typeof Building2;
  className?: string;
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  className,
}: MetricCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardDescription>{title}</CardDescription>
          <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        </div>
        <span className="rounded-full bg-muted p-2 text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      </CardHeader>
      {description ? (
        <CardContent>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
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

function displayDate(value: string) {
  return format(parseISO(value), "dd/MM/yyyy");
}

function currentBusinessDate() {
  const parts = BUSINESS_DATE_FORMATTER.formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function toValidationError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function parseNonNegativeNumber(value: unknown, field: string) {
  const parsed = parseFiniteNumber(value, field);
  if (parsed < 0) {
    throw new Error(`${field} phải là số không âm`);
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

function parseEffectiveEndDate(value: unknown, field: string) {
  if (typeof value !== "string" || !CANONICAL_DATE_PATTERN.test(value)) {
    throw new Error(`${field} phải là ngày ISO dạng YYYY-MM-DD`);
  }
  const parsed = parseISO(value);
  if (!isValid(parsed) || format(parsed, "yyyy-MM-dd") !== value) {
    throw new Error(`${field} không phải ngày hợp lệ`);
  }
  return value;
}

function validateSnapshotRows(
  rows: readonly OccupancySnapshotRow[],
  buildingIds: readonly string[],
): ValidationResult<OccupancySnapshotRow[]> {
  try {
    const allowedBuildingIds = new Set(buildingIds);
    return {
      data: rows.map((row, index) => {
        if (!allowedBuildingIds.has(row.building_id)) {
          throw new Error(
            `snapshot[${index}].building_id không thuộc phạm vi tòa vật lý đã chọn`,
          );
        }
        const total = parseNonNegativeNumber(
          row.total,
          `snapshot[${index}].total`,
        );
        const occupied = parseNonNegativeNumber(
          row.occupied,
          `snapshot[${index}].occupied`,
        );
        const reserved = parseNonNegativeNumber(
          row.reserved,
          `snapshot[${index}].reserved`,
        );
        const available = parseNonNegativeNumber(
          row.available,
          `snapshot[${index}].available`,
        );
        const maintenance = parseNonNegativeNumber(
          row.maintenance,
          `snapshot[${index}].maintenance`,
        );
        const unavailable = parseNonNegativeNumber(
          row.unavailable,
          `snapshot[${index}].unavailable`,
        );
        if (
          occupied + reserved + available + maintenance + unavailable !== total
        ) {
          throw new Error(
            `snapshot[${index}] có tổng trạng thái phòng không khớp tổng phòng`,
          );
        }
        return {
          ...row,
          total,
          occupied,
          reserved,
          available,
          maintenance,
          unavailable,
          occupancy_pct: parsePercentage(
            row.occupancy_pct,
            `snapshot[${index}].occupancy_pct`,
          ),
          committed_pct: parsePercentage(
            row.committed_pct,
            `snapshot[${index}].committed_pct`,
          ),
          missed_revenue: parseFiniteNumber(
            row.missed_revenue,
            `snapshot[${index}].missed_revenue`,
          ),
        };
      }),
      error: null,
    };
  } catch (error) {
    return { data: null, error: toValidationError(error) };
  }
}

function validateTrendRows(
  rows: readonly OccupancyTrendPoint[],
): ValidationResult<OccupancyTrendPoint[]> {
  try {
    return {
      data: rows.map((row, index) => {
        const occupied = parseNonNegativeNumber(
          row.occupied,
          `trend[${index}].occupied`,
        );
        const total = parseNonNegativeNumber(
          row.total,
          `trend[${index}].total`,
        );
        if (occupied > total) {
          throw new Error(
            `trend[${index}].occupied không được lớn hơn tổng phòng`,
          );
        }
        const rate =
          row.rate == null
            ? null
            : parsePercentage(row.rate, `trend[${index}].rate`);
        if (total > 0 && rate == null) {
          throw new Error(`trend[${index}].rate không được để trống`);
        }
        return {
          ...row,
          occupied,
          total,
          rate: total > 0 ? rate : null,
        };
      }),
      error: null,
    };
  } catch (error) {
    return { data: null, error: toValidationError(error) };
  }
}

function validateUpcomingRows(
  rows: readonly UpcomingVacancyRow[],
  buildingIds: readonly string[],
): ValidationResult<UpcomingVacancyRow[]> {
  try {
    const allowedBuildingIds = new Set(buildingIds);
    return {
      data: rows.map((row, index) => {
        if (!allowedBuildingIds.has(row.building_id)) {
          throw new Error(
            `upcoming[${index}].building_id không thuộc phạm vi tòa vật lý đã chọn`,
          );
        }
        return {
          ...row,
          effective_end_date: parseEffectiveEndDate(
            row.effective_end_date,
            `upcoming[${index}].effective_end_date`,
          ),
          days_remaining: parseFiniteNumber(
            row.days_remaining,
            `upcoming[${index}].days_remaining`,
          ),
          rent_price: parseFiniteNumber(
            row.rent_price,
            `upcoming[${index}].rent_price`,
          ),
        };
      }),
      error: null,
    };
  } catch (error) {
    return { data: null, error: toValidationError(error) };
  }
}

export function OccupancyVacancyTab({ filters }: OccupancyVacancyTabProps) {
  const asOfDate = currentBusinessDate();
  const buildingIds = filters.buildingIds;
  const snapshotQuery = useBusinessPerformanceOccupancySnapshot(
    filters.organizationId,
    asOfDate,
    buildingIds,
  );
  const upcomingQuery = useBusinessPerformanceUpcomingVacancy(
    filters.organizationId,
    asOfDate,
    60,
    buildingIds,
  );
  const trendQuery = useBusinessPerformanceOccupancyTrend12m(
    filters.organizationId,
    buildingIds,
  );
  const historyStart = shiftMonth(filters.month, -11);
  const historyEnd = `${filters.month}-01`;
  const historyQuery = useBusinessPerformanceInventoryHistory(
    filters,
    historyStart,
    historyEnd,
  );
  const snapshotValidation = useMemo(
    () => validateSnapshotRows(snapshotQuery.data ?? [], buildingIds),
    [buildingIds, snapshotQuery.data],
  );
  const trendValidation = useMemo(
    () => validateTrendRows(trendQuery.data ?? []),
    [trendQuery.data],
  );
  const upcomingValidation = useMemo(
    () => validateUpcomingRows(upcomingQuery.data ?? [], buildingIds),
    [buildingIds, upcomingQuery.data],
  );
  const snapshotState = deriveFinanceQueryState(
    snapshotQuery,
    snapshotValidation.error,
  );
  const trendState = deriveFinanceQueryState(trendQuery, trendValidation.error);
  const upcomingState = deriveFinanceQueryState(
    upcomingQuery,
    upcomingValidation.error,
  );
  const historyState = deriveFinanceQueryState(historyQuery);
  const trendRows = trendValidation.data ?? [];
  const upcomingRows = upcomingValidation.data ?? [];
  const historyRows = historyQuery.data ?? [];

  const snapshot = useMemo(() => {
    const rows = snapshotValidation.data ?? [];
    const totals = rows.reduce(
      (result, row) => ({
        total: result.total + row.total,
        occupied: result.occupied + row.occupied,
        reserved: result.reserved + row.reserved,
        available: result.available + row.available,
        maintenance: result.maintenance + row.maintenance,
        unavailable: result.unavailable + row.unavailable,
        listedOpportunity: result.listedOpportunity + row.missed_revenue,
      }),
      {
        total: 0,
        occupied: 0,
        reserved: 0,
        available: 0,
        maintenance: 0,
        unavailable: 0,
        listedOpportunity: 0,
      },
    );

    return {
      rows,
      ...totals,
      occupancyPct:
        totals.total > 0 ? (totals.occupied / totals.total) * 100 : null,
      committedPct:
        totals.total > 0
          ? ((totals.occupied + totals.reserved) / totals.total) * 100
          : null,
    };
  }, [snapshotValidation.data]);

  return (
    <div className="flex flex-col gap-6">
      <Alert role="note">
        <Info aria-hidden="true" />
        <AlertTitle>Ảnh chụp vận hành hiện tại — ngày {displayDate(asOfDate)}</AlertTitle>
        <AlertDescription>
          Phân loại phòng và danh sách sắp trống dùng dữ liệu live tại ngày hiện
          tại. Lịch sử cuối tháng ở phần riêng chỉ dùng snapshot thật đã ghi nhận
          từ ngày rollout; tháng bị thiếu không được dựng lại từ dữ liệu mutable.
        </AlertDescription>
      </Alert>

      <section aria-labelledby="occupancy-live-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="occupancy-live-heading" className="text-lg font-semibold">
            Hiện trạng lấp đầy
          </h2>
          <p className="text-sm text-muted-foreground">
            Phạm vi đúng theo các tòa vật lý đang được chọn; tỷ lệ tổng được tính
            theo số phòng, không lấy trung bình tỷ lệ từng tòa.
          </p>
        </div>

        {snapshotState.showLoading ? <FinanceLoadingGrid count={9} /> : null}
        {snapshotState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void snapshotQuery.refetch()} />
        ) : null}
        {snapshotState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải ảnh chụp lấp đầy hiện tại"
            error={snapshotState.blockingError}
            onRetry={() => void snapshotQuery.refetch()}
          />
        ) : null}
        {snapshotState.canRenderData && snapshot.rows.length === 0 ? (
          <FinanceEmptyState
            title="Chưa có dữ liệu phòng trong phạm vi đã chọn"
            description="Hãy kiểm tra lại tòa đang chọn hoặc quyền truy cập dữ liệu phòng."
          />
        ) : null}

        {snapshotState.canRenderData && snapshot.rows.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2 xl:grid-cols-3">
              <MetricCard title="Tổng phòng" value={snapshot.total} icon={Building2} />
              <MetricCard title="Đang thuê" value={snapshot.occupied} icon={Home} />
              <MetricCard title="Đã giữ chỗ" value={snapshot.reserved} icon={BookmarkCheck} />
              <MetricCard title="Available" value={snapshot.available} icon={DoorOpen} />
              <MetricCard title="Bảo trì" value={snapshot.maintenance} icon={Wrench} />
              <MetricCard
                title="Không khai thác"
                value={snapshot.unavailable}
                icon={Ban}
              />
              <MetricCard
                title="Tỷ lệ lấp đầy có trọng số"
                value={
                  snapshot.occupancyPct == null
                    ? "—"
                    : `${snapshot.occupancyPct.toFixed(1)}%`
                }
                description="Đang thuê / tổng phòng."
                icon={Percent}
              />
              <MetricCard
                title="Tỷ lệ cam kết có trọng số"
                value={
                  snapshot.committedPct == null
                    ? "—"
                    : `${snapshot.committedPct.toFixed(1)}%`
                }
                description="(Đang thuê + đã giữ chỗ) / tổng phòng."
                icon={Percent}
              />
              <MetricCard
                title="Giá trị cho thuê niêm yết của phòng đang available/tháng"
                value={formatCurrency(snapshot.listedOpportunity)}
                description="Tổng giá niêm yết hiện tại; không phải doanh thu đã mất hoặc doanh thu ghi nhận."
                icon={CircleDollarSign}
                className="min-[400px]:col-span-2 xl:col-span-1"
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Hiện trạng theo tòa</CardTitle>
                <CardDescription>
                  Chi tiết cùng mốc live {displayDate(asOfDate)}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  role="region"
                  aria-label="Bảng hiện trạng phòng và tỷ lệ lấp đầy theo tòa"
                  tabIndex={0}
                  className="overflow-x-auto rounded-md border"
                >
                  <table className="w-full caption-bottom text-sm">
                    <TableCaption className="sr-only">
                      Bảng phân loại phòng và tỷ lệ lấp đầy hiện tại theo tòa
                    </TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Tòa nhà</TableHead>
                        <TableHead scope="col" className="text-right">Tổng</TableHead>
                        <TableHead scope="col" className="text-right">Đang thuê</TableHead>
                        <TableHead scope="col" className="text-right">Giữ chỗ</TableHead>
                        <TableHead scope="col" className="text-right">Available</TableHead>
                        <TableHead scope="col" className="text-right">Bảo trì</TableHead>
                        <TableHead scope="col" className="text-right">Không khai thác</TableHead>
                        <TableHead scope="col" className="text-right">Lấp đầy</TableHead>
                        <TableHead scope="col" className="text-right">Cam kết</TableHead>
                        <TableHead scope="col" className="min-w-52 text-right">
                          Giá niêm yết available/tháng
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.rows.map((row) => (
                        <TableRow key={row.building_id}>
                          <TableHead
                            scope="row"
                            className="h-auto whitespace-nowrap p-4 text-foreground"
                          >
                            {row.building_name}
                          </TableHead>
                          <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.occupied}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.reserved}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.available}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.maintenance}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.unavailable}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.total > 0 ? `${row.occupancy_pct.toFixed(1)}%` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.total > 0 ? `${row.committed_pct.toFixed(1)}%` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(row.missed_revenue)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </section>

      <section aria-labelledby="occupancy-history-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="occupancy-history-heading" className="text-lg font-semibold">
            Lịch sử snapshot cuối tháng
          </h2>
          <p className="text-sm text-muted-foreground">
            Chuỗi authoritative theo manifest PROVISIONAL / FINALIZED / MISSED. Chỉ tháng có snapshot
            hợp lệ mới hiển thị số phòng và tỷ lệ.
          </p>
        </div>
        {historyState.showLoading ? <FinanceLoadingGrid count={3} /> : null}
        {historyState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void historyQuery.refetch()} />
        ) : null}
        {historyState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải lịch sử snapshot cuối tháng"
            error={historyState.blockingError}
            onRetry={() => void historyQuery.refetch()}
          />
        ) : null}
        {historyState.canRenderData && historyRows.length === 0 ? (
          <FinanceEmptyState
            title="Chưa có lịch sử snapshot"
            description="Chưa có manifest snapshot trong cửa sổ 12 tháng và phạm vi tòa đã chọn."
          />
        ) : null}
        {historyState.canRenderData && historyRows.length > 0 ? (
          <div
            role="region"
            aria-label="Bảng lịch sử snapshot cuối tháng theo tòa"
            tabIndex={0}
            className="overflow-x-auto rounded-md border"
          >
            <table className="w-full min-w-[56rem] caption-bottom text-sm">
              <TableCaption className="sr-only">
                Lịch sử snapshot phòng cuối tháng; tháng thiếu giữ giá trị trống.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Tháng / tòa</TableHead>
                  <TableHead scope="col">Trạng thái</TableHead>
                  <TableHead scope="col" className="text-right">Tổng phòng</TableHead>
                  <TableHead scope="col" className="text-right">Đang thuê</TableHead>
                  <TableHead scope="col" className="text-right">Available</TableHead>
                  <TableHead scope="col" className="text-right">Lấp đầy</TableHead>
                  <TableHead scope="col" className="text-right">Giá niêm yết available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyRows.map((row) => (
                  <TableRow key={`${row.snapshot_month}:${row.building_id}`}>
                    <TableHead scope="row" className="h-auto text-foreground">
                      <div>{displayMonth(row.snapshot_month)}</div>
                      <div className="text-xs font-normal text-muted-foreground">{row.building_name}</div>
                    </TableHead>
                    <TableCell>
                      {row.snapshot_missing
                        ? row.snapshot_status === "MISSED" ? "Lỡ cutoff" : "Chưa có snapshot"
                        : row.snapshot_status === "FINALIZED" ? "Đã chốt" : "Tạm thời"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.total ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.occupied ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.available ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.occupancy_pct == null
                        ? "—"
                        : `${row.occupancy_pct.toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.listed_rent_opportunity == null
                        ? "—"
                        : formatCurrency(row.listed_rent_opportunity)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="occupancy-trend-heading">
        <Card>
          <CardHeader>
            <CardTitle id="occupancy-trend-heading" className="text-base">
              Ước tính tham chiếu 12 tháng từ hợp đồng và tồn kho hiện tại
            </CardTitle>
            <CardDescription>
              Đây không phải lịch sử snapshot cuối tháng. Mẫu số dùng tồn kho
              phòng hiện tại và dữ liệu hợp đồng hiện có, nên chỉ phù hợp để tham
              khảo xu hướng. Chuỗi luôn kết thúc ở tháng hiện tại và không thay
              đổi theo tháng phân tích đã chọn ({filters.month}).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {trendState.showLoading ? <FinanceLoadingGrid count={2} /> : null}
            {trendState.showStaleWarning ? (
              <StaleDataWarning onRetry={() => void trendQuery.refetch()} />
            ) : null}
            {trendState.hasBlockingError ? (
              <FinanceQueryError
                title="Không thể tải xu hướng lấp đầy ước tính"
                error={trendState.blockingError}
                onRetry={() => void trendQuery.refetch()}
              />
            ) : null}
            {trendState.canRenderData && trendRows.length === 0 ? (
              <FinanceEmptyState
                title="Chưa có dữ liệu xu hướng ước tính"
                description="Nguồn hợp đồng hiện tại chưa tạo được chuỗi tham chiếu cho phạm vi tòa đã chọn."
              />
            ) : null}
            {trendState.canRenderData && trendRows.length > 0 ? (
              <>
                <div
                  role="region"
                  tabIndex={0}
                  aria-label="Cuộn ngang biểu đồ tỷ lệ lấp đầy ước tính 12 tháng"
                  className="overflow-x-auto"
                >
                  <div
                    role="img"
                    aria-label="Biểu đồ đường tỷ lệ lấp đầy ước tính 12 tháng, đơn vị phần trăm"
                    className="h-72 min-w-[640px]"
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trendRows}>
                        <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                        <XAxis dataKey="month" />
                        <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                        <Tooltip
                          formatter={(value: number, _name, item) => [
                            `${value.toFixed(1)}% (${item.payload.occupied}/${item.payload.total} phòng)`,
                            "Lấp đầy ước tính",
                          ]}
                        />
                        <Line
                          type="monotone"
                          dataKey="rate"
                          name="Lấp đầy ước tính"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          dot={{ r: 3 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <details className="mt-4 rounded-md border">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                    Xem bảng dữ liệu biểu đồ
                  </summary>
                  <div
                    role="region"
                    aria-label="Bảng dữ liệu tỷ lệ lấp đầy ước tính 12 tháng"
                    tabIndex={0}
                    className="overflow-x-auto border-t"
                  >
                    <table className="w-full caption-bottom text-sm">
                      <TableCaption className="sr-only">
                        Dữ liệu tỷ lệ lấp đầy ước tính 12 tháng
                      </TableCaption>
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Tháng</TableHead>
                          <TableHead scope="col" className="text-right">Đang thuê</TableHead>
                          <TableHead scope="col" className="text-right">Tổng phòng</TableHead>
                          <TableHead scope="col" className="text-right">Lấp đầy ước tính</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {trendRows.map((point) => (
                          <TableRow key={point.month}>
                            <TableHead scope="row" className="h-auto p-4 text-foreground">
                              {point.month}
                            </TableHead>
                            <TableCell className="text-right tabular-nums">
                              {point.occupied}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {point.total}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {point.rate == null ? "—" : `${point.rate.toFixed(1)}%`}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </table>
                  </div>
                </details>
              </>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="upcoming-vacancy-heading">
        <Card>
          <CardHeader>
            <CardTitle id="upcoming-vacancy-heading" className="flex items-center gap-2 text-base">
              <CalendarClock className="size-5" aria-hidden="true" />
              Phòng có hợp đồng sắp kết thúc hiệu lực trong 60 ngày
            </CardTitle>
            <CardDescription>
              Tính từ {displayDate(asOfDate)} và đã áp dụng gia hạn được duyệt/hoàn tất.
              Giá thuê trong bảng là giá niêm yết hiện tại của phòng.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {upcomingState.showLoading ? <FinanceLoadingGrid count={3} /> : null}
            {upcomingState.showStaleWarning ? (
              <StaleDataWarning onRetry={() => void upcomingQuery.refetch()} />
            ) : null}
            {upcomingState.hasBlockingError ? (
              <FinanceQueryError
                title="Không thể tải danh sách phòng sắp trống"
                error={upcomingState.blockingError}
                onRetry={() => void upcomingQuery.refetch()}
              />
            ) : null}
            {upcomingState.canRenderData && upcomingRows.length === 0 ? (
              <FinanceEmptyState
                title="Không có phòng sắp kết thúc hợp đồng trong 60 ngày"
                description="Không có hợp đồng active nào trong phạm vi tòa đã chọn rơi vào cửa sổ này."
              />
            ) : null}
            {upcomingState.canRenderData && upcomingRows.length > 0 ? (
              <div
                role="region"
                aria-label="Bảng phòng sắp kết thúc hợp đồng trong 60 ngày"
                tabIndex={0}
                className="overflow-x-auto rounded-md border"
              >
                <table className="w-full caption-bottom text-sm">
                  <TableCaption className="sr-only">
                    Danh sách phòng có hợp đồng sắp kết thúc hiệu lực trong 60 ngày
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Phòng</TableHead>
                      <TableHead scope="col">Tòa nhà</TableHead>
                      <TableHead scope="col" className="whitespace-nowrap">Ngày kết thúc hiệu lực</TableHead>
                      <TableHead scope="col" className="text-right">Còn lại</TableHead>
                      <TableHead scope="col" className="text-right">Giá thuê</TableHead>
                      <TableHead scope="col" className="text-center">Gia hạn</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {upcomingRows.map((row) => (
                      <TableRow key={`${row.contract_id}:${row.room_id}`}>
                        <TableHead
                          scope="row"
                          className="h-auto whitespace-nowrap p-4 text-foreground"
                        >
                          {row.room_name}
                        </TableHead>
                        <TableCell className="whitespace-nowrap">{row.building_name}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {displayDate(row.effective_end_date)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {row.days_remaining} ngày
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {formatCurrency(row.rent_price)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant={row.extension_applied ? "secondary" : "outline"}>
                            {row.extension_applied ? "Đã áp dụng" : "Không"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

export default OccupancyVacancyTab;
