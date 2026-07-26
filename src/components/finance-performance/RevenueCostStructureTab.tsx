import { useMemo, useState } from "react";
import { Building2, Info, ReceiptText, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FinanceEmptyState,
  FinanceLoadingGrid,
  FinanceQueryError,
} from "@/components/finance-performance/FinanceDataState";
import { useBusinessPerformancePnl } from "@/hooks/reports/useBusinessPerformance";
import type {
  BusinessPerformanceFilters,
  BusinessPerformancePnlRow,
} from "@/lib/businessPerformance";
import { deriveFinanceQueryState } from "@/lib/financeQueryState";
import { formatCurrency } from "@/lib/utils";

interface RevenueCostStructureTabProps {
  filters: BusinessPerformanceFilters;
}

type StructureSide = "INCOME" | "EXPENSE";

interface BuildingStructureRow {
  id: string;
  name: string;
  amount: number;
  sharePct: number | null;
}

const SIDE_CONFIG = {
  INCOME: {
    label: "Thu",
    title: "Cơ cấu doanh thu theo tòa",
    totalLabel: "Tổng doanh thu",
    color: "#0f766e",
  },
  EXPENSE: {
    label: "Chi",
    title: "Cơ cấu chi phí theo tòa",
    totalLabel: "Tổng chi phí",
    color: "#b45309",
  },
} as const;

function monthKey(value: string) {
  return value.slice(0, 7);
}

function formatMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `Tháng ${Number(match[2])}/${match[1]}` : value;
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

function aggregateBuildings(
  rows: readonly BusinessPerformancePnlRow[],
  filters: BusinessPerformanceFilters,
  side: StructureSide,
) {
  const allowedBuildingIds = new Set(filters.buildingIds);
  const amountField = side === "INCOME" ? "revenue" : "expense";
  const byBuilding = new Map<string, Omit<BuildingStructureRow, "sharePct">>();

  for (const row of rows) {
    if (
      row.is_virtual ||
      !allowedBuildingIds.has(row.building_id) ||
      monthKey(row.month) !== filters.month
    ) {
      continue;
    }

    const existing = byBuilding.get(row.building_id);
    byBuilding.set(row.building_id, {
      id: row.building_id,
      name: row.building_name,
      amount: (existing?.amount ?? 0) + row[amountField],
    });
  }

  const total = Array.from(byBuilding.values()).reduce(
    (sum, row) => sum + row.amount,
    0,
  );
  const buildingRows = Array.from(byBuilding.values())
    .map((row) => ({
      ...row,
      sharePct: total === 0 ? null : (row.amount / total) * 100,
    }))
    .sort(
      (left, right) =>
        right.amount - left.amount || left.name.localeCompare(right.name, "vi"),
    );

  return { buildingRows, total };
}

function StructurePanel({
  filters,
  rows,
  side,
}: {
  filters: BusinessPerformanceFilters;
  rows: readonly BusinessPerformancePnlRow[];
  side: StructureSide;
}) {
  const config = SIDE_CONFIG[side];
  const { buildingRows, total } = useMemo(
    () => aggregateBuildings(rows, filters, side),
    [filters, rows, side],
  );
  const visualRows = buildingRows.slice(0, 8);
  const tableTitleId = `${side.toLocaleLowerCase("en-US")}-structure-table-title`;

  if (buildingRows.length === 0) {
    return (
      <FinanceEmptyState
        title={`Chưa có dữ liệu ${config.label.toLocaleLowerCase("vi-VN")}`}
        description={`${formatMonth(filters.month)} không có dòng P&L khả dụng cho các tòa vật lý trong phạm vi đã chọn.`}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>{config.totalLabel}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatCurrency(total)}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
            <ReceiptText className="size-4" aria-hidden="true" />
            {formatMonth(filters.month)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Tòa có dữ liệu</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {buildingRows.length.toLocaleString("vi-VN")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
            <Building2 className="size-4" aria-hidden="true" />
            Trên {filters.buildingIds.length.toLocaleString("vi-VN")} tòa vật lý đã chọn
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{config.title}</CardTitle>
          <CardDescription>
            Tám tòa có giá trị lớn nhất; mọi thanh dùng cùng một màu semantic để
            thứ hạng không làm thay đổi ý nghĩa màu sắc.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            className="flex flex-col gap-4"
            role="img"
            aria-label={`${config.title}, ${formatMonth(filters.month)}`}
          >
            {visualRows.map((row) => (
              <div key={row.id} className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-4 text-sm">
                  <span className="min-w-0 truncate font-medium" title={row.name}>
                    {row.name}
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {formatCurrency(row.amount)} ·{" "}
                    {row.sharePct === null ? "—" : `${row.sharePct.toFixed(1)}%`}
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      backgroundColor: config.color,
                      width: `${Math.max(0, Math.min(100, row.sharePct ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 max-w-full overflow-hidden">
        <CardHeader>
          <CardTitle id={tableTitleId} className="text-lg">
            Chi tiết theo tòa
          </CardTitle>
          <CardDescription>
            Dữ liệu đầy đủ của {formatMonth(filters.month)} trong phạm vi tòa vật lý.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <div
            className="relative w-full overflow-auto rounded-md border"
            role="region"
            aria-label={`Cuộn ngang bảng chi tiết ${config.title.toLocaleLowerCase("vi-VN")}`}
            tabIndex={0}
          >
            <table
              aria-labelledby={tableTitleId}
              className="w-full min-w-[32rem] caption-bottom text-sm"
            >
              <TableCaption className="sr-only">
                {config.title}, chi tiết {formatMonth(filters.month)} theo tòa vật lý.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Tòa nhà</TableHead>
                  <TableHead scope="col" className="text-right">
                    Số tiền
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Tỷ trọng
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buildingRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableHead
                      scope="row"
                      className="h-auto whitespace-nowrap text-foreground"
                    >
                      {row.name}
                    </TableHead>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.amount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.sharePct === null ? "—" : `${row.sharePct.toFixed(1)}%`}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40 font-semibold">
                  <TableHead scope="row" className="h-auto text-foreground">
                    Tổng
                  </TableHead>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(total)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {total === 0 ? "—" : "100,0%"}
                  </TableCell>
                </TableRow>
              </TableBody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function RevenueCostStructureTab({
  filters,
}: RevenueCostStructureTabProps) {
  const [activeSide, setActiveSide] = useState<StructureSide>("INCOME");
  const query = useBusinessPerformancePnl(filters);
  const queryState = deriveFinanceQueryState(query);
  const hasPhysicalScope = filters.buildingIds.length > 0;

  const renderContent = (side: StructureSide) => {
    if (!hasPhysicalScope) {
      return (
        <FinanceEmptyState
          title="Chưa có tòa vật lý trong phạm vi"
          description="Hãy chọn ít nhất một tòa vật lý để tải cơ cấu Thu/Chi. Báo cáo không tự mở rộng sang tòa ảo."
        />
      );
    }
    if (queryState.showLoading) return <FinanceLoadingGrid count={4} />;
    if (queryState.hasBlockingError) {
      return (
        <FinanceQueryError
          title="Không thể tải cơ cấu Thu/Chi"
          error={queryState.blockingError}
          onRetry={() => {
            void query.refetch();
          }}
        />
      );
    }
    return (
      <div className="flex flex-col gap-4">
        {queryState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void query.refetch()} />
        ) : null}
        {queryState.canRenderData ? (
          <StructurePanel
            filters={filters}
            rows={query.data ?? []}
            side={side}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Alert role="note">
        <Info aria-hidden="true" />
        <AlertTitle>Chi tiết hạng mục đang được ẩn</AlertTitle>
        <AlertDescription>
          Báo cáo hiện chỉ trình bày cơ cấu Thu/Chi cấp tòa từ nguồn P&amp;L đã
          giới hạn theo các tòa vật lý được chọn. Tên loại và nhóm hạng mục sẽ chỉ
          được mở lại sau khi chính sách dữ liệu hạn chế và cổng phân quyền phía
          máy chủ hoàn tất.
        </AlertDescription>
      </Alert>

      <Tabs
        value={activeSide}
        onValueChange={(value) => setActiveSide(value as StructureSide)}
      >
        <TabsList
          aria-label="Chọn cơ cấu Thu hoặc Chi"
          className="grid w-full grid-cols-2 sm:w-72"
        >
          <TabsTrigger value="INCOME">Thu</TabsTrigger>
          <TabsTrigger value="EXPENSE">Chi</TabsTrigger>
        </TabsList>
        <TabsContent value="INCOME" className="mt-4">
          {renderContent("INCOME")}
        </TabsContent>
        <TabsContent value="EXPENSE" className="mt-4">
          {renderContent("EXPENSE")}
        </TabsContent>
      </Tabs>
    </div>
  );
}
