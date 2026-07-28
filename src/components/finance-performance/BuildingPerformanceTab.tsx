import { type KeyboardEvent, useMemo, useState } from "react";
import { Building2, Calculator, Info, RefreshCw, Save, Settings2 } from "lucide-react";

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
import {
  useBusinessPerformanceBreakEven,
  useBusinessPerformancePnl,
  useBusinessPerformanceReportingRoles,
  useSetBusinessPerformanceReportingRole,
  type BusinessPerformanceBreakEvenRow,
  type BusinessPerformanceReportingRoleRow,
  type FinanceReportingRole,
} from "@/hooks/reports/useBusinessPerformance";
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

const ROLE_LABELS: Record<FinanceReportingRole, string> = {
  ROOM_RENT_REVENUE: "Doanh thu tiền phòng",
  OTHER_OPERATING_REVENUE: "Doanh thu vận hành khác",
  PASS_THROUGH_REVENUE: "Thu hộ / pass-through",
  LANDLORD_RENT_FIXED: "Chi phí thuê chủ nhà cố định",
  OTHER_FIXED_COST: "Chi phí cố định khác",
  ROOM_VARIABLE_COST: "Biến phí gắn với phòng",
  OTHER_VARIABLE_COST: "Biến phí khác",
  PASS_THROUGH_EXPENSE: "Chi hộ / pass-through",
  OUTSIDE_BREAK_EVEN_MODEL: "Ngoài mô hình hòa vốn",
};

const SIDE_ROLES: Record<"INCOME" | "EXPENSE", FinanceReportingRole[]> = {
  INCOME: [
    "ROOM_RENT_REVENUE",
    "OTHER_OPERATING_REVENUE",
    "PASS_THROUGH_REVENUE",
    "OUTSIDE_BREAK_EVEN_MODEL",
  ],
  EXPENSE: [
    "LANDLORD_RENT_FIXED",
    "OTHER_FIXED_COST",
    "ROOM_VARIABLE_COST",
    "OTHER_VARIABLE_COST",
    "PASS_THROUGH_EXPENSE",
    "OUTSIDE_BREAK_EVEN_MODEL",
  ],
};

const BREAK_EVEN_REASON_LABELS: Record<string, string> = {
  UNMAPPED_AMOUNT: "Còn số tiền chưa được mapping",
  OUTSIDE_MODEL_AMOUNT: "Có số tiền được xác nhận ngoài mô hình hòa vốn",
  MISSING_LANDLORD_OR_MONTH: "Thiếu tiền thuê chủ nhà hoặc thiếu kỳ nguồn",
  CMR_CORE_NOT_POSITIVE: "Tỷ lệ đóng góp KQKD không dương",
  CMR_ROOM_NOT_POSITIVE: "Tỷ lệ đóng góp tiền phòng không dương",
  ROOM_BREAK_EVEN_UNAVAILABLE: "Hòa vốn tiền phòng chưa khả dụng",
  SNAPSHOT_UNAVAILABLE: "Chưa có snapshot công suất đã chốt",
  INVALID_LISTED_RENT: "Có phòng thiếu giá niêm yết hợp lệ",
  CAPACITY_NOT_POSITIVE: "Công suất doanh thu không dương",
};

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

function ReportingRoleConfiguration({
  filters,
  query,
}: {
  filters: BusinessPerformanceFilters;
  query: ReturnType<typeof useBusinessPerformanceReportingRoles>;
}) {
  const mutation = useSetBusinessPerformanceReportingRole(filters);
  const queryState = deriveFinanceQueryState(query);
  const [draftRoles, setDraftRoles] = useState<Record<string, FinanceReportingRole>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const roleRows = query.data ?? [];
  const canManage = roleRows.some((row) => row.can_manage);
  const mappedCount = roleRows.filter((row) => row.finance_reporting_role !== null).length;

  const saveRole = async (row: BusinessPerformanceReportingRoleRow) => {
    const role = draftRoles[row.income_expense_type_id]
      ?? row.finance_reporting_role
      ?? row.suggested_role;
    if (!role) return;
    setSaveError(null);
    try {
      await mutation.mutateAsync({
        incomeExpenseTypeId: row.income_expense_type_id,
        role,
        effectiveFrom: `${filters.month}-01`,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Không thể lưu mapping");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Settings2 className="size-5 text-primary" aria-hidden="true" />
          Cấu hình vai trò tài chính
        </CardTitle>
        <CardDescription>
          {mappedCount}/{roleRows.length} loại Thu/Chi đã có mapping hiệu lực cho kỳ {monthLabel(filters.month)}.
          {canManage
            ? " Bạn có thể xác nhận hoặc thay đổi mapping từ đầu tháng này."
            : " Bạn đang xem ở chế độ chỉ đọc."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {queryState.showLoading ? <FinanceLoadingGrid count={2} /> : null}
        {queryState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void query.refetch()} />
        ) : null}
        {queryState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải mapping vai trò tài chính"
            error={queryState.blockingError}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {queryState.canRenderData && roleRows.length === 0 ? (
          <FinanceEmptyState
            title="Chưa có loại Thu/Chi cần mapping"
            description="Tổ chức chưa có loại Thu/Chi KQKD ngoài tiền cọc trong kỳ đã chọn."
          />
        ) : null}
        {queryState.canRenderData && roleRows.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[44rem] caption-bottom text-sm">
              <TableCaption className="sr-only">
                Mapping vai trò tài chính theo loại Thu/Chi cho kỳ {monthLabel(filters.month)}.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Loại Thu/Chi</TableHead>
                  <TableHead scope="col">Bên</TableHead>
                  <TableHead scope="col">Vai trò hòa vốn</TableHead>
                  <TableHead scope="col">Hiệu lực</TableHead>
                  {canManage ? <TableHead scope="col" className="text-right">Thao tác</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {roleRows.map((row) => {
                  const selected = draftRoles[row.income_expense_type_id]
                    ?? row.finance_reporting_role
                    ?? row.suggested_role
                    ?? "";
                  return (
                    <TableRow key={row.income_expense_type_id}>
                      <TableHead scope="row" className="h-auto text-foreground">
                        <div className="font-medium">{row.type_name}</div>
                        <div className="text-xs font-normal text-muted-foreground">
                          {row.category ?? "Chưa phân nhóm"}
                        </div>
                      </TableHead>
                      <TableCell>{row.side === "INCOME" ? "Thu" : "Chi"}</TableCell>
                      <TableCell>
                        {canManage ? (
                          <select
                            aria-label={`Vai trò tài chính cho ${row.type_name}`}
                            className="h-9 w-full min-w-56 rounded-md border bg-background px-3 text-sm"
                            value={selected}
                            onChange={(event) =>
                              setDraftRoles((current) => ({
                                ...current,
                                [row.income_expense_type_id]: event.target.value as FinanceReportingRole,
                              }))
                            }
                          >
                            <option value="" disabled>Chọn vai trò</option>
                            {SIDE_ROLES[row.side].map((role) => (
                              <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                            ))}
                          </select>
                        ) : (
                          <span>{row.finance_reporting_role ? ROLE_LABELS[row.finance_reporting_role] : "Chưa mapping"}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.effective_from ? `Từ ${row.effective_from}` : "Chưa xác nhận"}
                      </TableCell>
                      {canManage ? (
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!selected || mutation.isPending}
                            onClick={() => void saveRole(row)}
                          >
                            <Save data-icon="inline-start" aria-hidden="true" />
                            Lưu
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </table>
          </div>
        ) : null}
        {saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}
      </CardContent>
    </Card>
  );
}

function breakEvenReason(row: BusinessPerformanceBreakEvenRow) {
  const reason = row.break_even_revenue_reason
    ?? row.room_break_even_revenue_reason
    ?? row.break_even_occupancy_reason;
  return reason ? (BREAK_EVEN_REASON_LABELS[reason] ?? reason) : "Chưa khả dụng";
}

function BreakEvenAnalysis({
  filters,
  query,
}: {
  filters: BusinessPerformanceFilters;
  query: ReturnType<typeof useBusinessPerformanceBreakEven>;
}) {
  const queryState = deriveFinanceQueryState(query);
  const rows = query.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Calculator className="size-5 text-primary" aria-hidden="true" />
          Hòa vốn theo tòa
        </CardTitle>
        <CardDescription>
          So sánh tháng đã chọn với bình quân ba tháng. Tỷ lệ lấp đầy có thể vượt 100% khi doanh thu phòng cần thiết lớn hơn công suất giá niêm yết.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert role="note">
          <Info aria-hidden="true" />
          <AlertTitle>Số liệu hòa vốn có kiểm soát</AlertTitle>
          <AlertDescription>
            RPC chỉ trả tỷ lệ khi mapping, tiền thuê chủ nhà, tỷ lệ đóng góp và công suất đều hợp lệ; nếu thiếu, bảng giữ nguyên lý do thay vì điền 0.
          </AlertDescription>
        </Alert>
        {queryState.showLoading ? <FinanceLoadingGrid count={4} /> : null}
        {queryState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void query.refetch()} />
        ) : null}
        {queryState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải phân tích hòa vốn"
            error={queryState.blockingError}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {queryState.canRenderData && rows.length === 0 ? (
          <FinanceEmptyState
            title="Chưa có dữ liệu hòa vốn"
            description={`Không có dòng hòa vốn cho ${monthLabel(filters.month)} trong phạm vi tòa đã chọn.`}
          />
        ) : null}
        {queryState.canRenderData && rows.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[68rem] caption-bottom text-sm">
              <TableCaption className="sr-only">Hòa vốn theo tòa và cửa sổ phân tích.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Tòa / cửa sổ</TableHead>
                  <TableHead scope="col" className="text-right">LN hiện tại</TableHead>
                  <TableHead scope="col" className="text-right">Doanh thu hòa vốn</TableHead>
                  <TableHead scope="col" className="text-right">Tiền phòng hòa vốn</TableHead>
                  <TableHead scope="col" className="text-right">Lấp đầy hiện tại</TableHead>
                  <TableHead scope="col" className="text-right">Lấp đầy lý thuyết</TableHead>
                  <TableHead scope="col">Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.building_id}:${row.analysis_window}`}>
                    <TableHead scope="row" className="h-auto text-foreground">
                      <div>{row.building_name}</div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {row.analysis_window === "SELECTED_MONTH" ? "Tháng đã chọn" : "Bình quân 3 tháng"}
                      </div>
                    </TableHead>
                    <TableCell className="text-right tabular-nums">{formatCurrency(row.net)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.break_even_revenue_available ? formatMoney(row.r_total_be) : "Chưa khả dụng"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.room_break_even_revenue_available ? formatMoney(row.r_room_be) : "Chưa khả dụng"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.break_even_occupancy_available ? formatPercent(row.break_even_occupancy_current) : "Chưa khả dụng"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.break_even_occupancy_available ? formatPercent(row.break_even_occupancy_theory) : "Chưa khả dụng"}
                    </TableCell>
                    <TableCell>
                      {row.break_even_revenue_available && row.break_even_occupancy_available
                        ? `Đủ dữ liệu · mapping ${formatPercent(row.mapping_coverage_pct)}`
                        : breakEvenReason(row)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function BuildingPerformanceTab({
  filters,
  buildings,
}: BuildingPerformanceTabProps) {
  const requestedBuildings = useMemo(() => {
    const requestedIds = new Set(filters.buildingIds);
    return buildings.filter((building) => requestedIds.has(building.id));
  }, [buildings, filters.buildingIds]);
  const hasPhysicalScope = requestedBuildings.length > 0;
  const pnlQuery = useBusinessPerformancePnl(filters, hasPhysicalScope);
  const rolesQuery = useBusinessPerformanceReportingRoles(filters, hasPhysicalScope);
  const breakEvenQuery = useBusinessPerformanceBreakEven(filters, hasPhysicalScope);
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

      {hasPhysicalScope ? (
        <>
          <ReportingRoleConfiguration filters={filters} query={rolesQuery} />
          <BreakEvenAnalysis filters={filters} query={breakEvenQuery} />
        </>
      ) : null}

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
