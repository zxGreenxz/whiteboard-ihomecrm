import { useMemo } from "react";
import {
  AlertCircle,
  CircleDollarSign,
  Clock3,
  FileSignature,
  Info,
  RefreshCw,
  WalletCards,
} from "lucide-react";

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
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useBusinessPerformanceCashReceived,
  useBusinessPerformanceInvoiceCohort,
  useBusinessPerformanceSnapshot,
} from "@/hooks/reports/useBusinessPerformance";
import {
  aggregateSnapshot,
  type BusinessPerformanceFilters,
} from "@/lib/businessPerformance";
import { deriveFinanceQueryState } from "@/lib/financeQueryState";
import { formatCurrency } from "@/lib/utils";

interface CollectionsDebtTabProps {
  filters: BusinessPerformanceFilters;
}

const EMPTY_SNAPSHOT_ROWS = [] as const;

interface SummaryCardProps {
  title: string;
  value: string | number;
  description: string;
  icon: typeof CircleDollarSign;
  className?: string;
}

function SummaryCard({
  title,
  value,
  description,
  icon: Icon,
  className,
}: SummaryCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardDescription>{title}</CardDescription>
          <CardTitle className="text-xl tabular-nums sm:text-2xl">{value}</CardTitle>
        </div>
        <span className="rounded-full bg-muted p-2 text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      </CardHeader>
      <CardContent>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function shareOfTotal(value: number, total: number) {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "—";
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
          Thử lại
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function CollectionsDebtTab({ filters }: CollectionsDebtTabProps) {
  const snapshotQuery = useBusinessPerformanceSnapshot(
    filters.organizationId,
    filters.buildingIds,
  );
  const snapshotRows = snapshotQuery.data ?? EMPTY_SNAPSHOT_ROWS;
  const snapshot = useMemo(
    () => aggregateSnapshot(snapshotRows),
    [snapshotRows],
  );
  const snapshotState = deriveFinanceQueryState(snapshotQuery);
  const cohortQuery = useBusinessPerformanceInvoiceCohort(filters);
  const cashQuery = useBusinessPerformanceCashReceived(filters);
  const cohortState = deriveFinanceQueryState(cohortQuery);
  const cashState = deriveFinanceQueryState(cashQuery);
  const cohortRows = cohortQuery.data ?? [];
  const cashRows = cashQuery.data ?? [];
  const cohortAvailable =
    cohortRows.length > 0 && cohortRows.every((row) => row.cohort_available);
  const cohortTotals = cohortAvailable
    ? cohortRows.reduce(
        (total, row) => ({
          billed: total.billed + (row.billed_current_charge ?? 0),
          collected: total.collected + (row.collected_current_charge ?? 0),
          remaining: total.remaining + (row.remaining_current_charge ?? 0),
        }),
        { billed: 0, collected: 0, remaining: 0 },
      )
    : null;
  const cashTotal = cashRows.reduce((total, row) => total + row.cash_received, 0);
  const paymentEventCount = cashRows.reduce(
    (total, row) => total + row.payment_event_count,
    0,
  );

  const agingBuckets = snapshot
    ? [
        { key: "aging_not_due", label: "Chưa tới hạn", value: snapshot.aging_not_due },
        { key: "aging_1_30", label: "Quá hạn 1–30 ngày", value: snapshot.aging_1_30 },
        { key: "aging_31_60", label: "Quá hạn 31–60 ngày", value: snapshot.aging_31_60 },
        { key: "aging_61_90", label: "Quá hạn 61–90 ngày", value: snapshot.aging_61_90 },
        { key: "aging_over_90", label: "Quá hạn trên 90 ngày", value: snapshot.aging_over_90 },
      ]
    : [];
  const agingTotal = agingBuckets.reduce(
    (total, bucket) => total + bucket.value,
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <Alert role="note">
        <Info aria-hidden="true" />
        <AlertTitle>Ba lát cắt riêng, không trộn khái niệm</AlertTitle>
        <AlertDescription>
          Cohort bám tháng phát hành và chỉ tính current charge; tiền thực thu bám
          ngày payment; tuổi nợ và cọc là snapshot live. Các con số được trình bày
          tách riêng để không gọi nợ chuyển tiếp hoặc tiền cọc là doanh thu của kỳ.
        </AlertDescription>
      </Alert>

      <section aria-labelledby="collections-cohort-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="collections-cohort-heading" className="text-lg font-semibold">
            Hóa đơn phát hành theo cohort
          </h2>
          <p className="text-sm text-muted-foreground">
            Current charge của hóa đơn MONTHLY đã phát hành trong {filters.month}; nợ chuyển tiếp,
            cọc, settlement và hóa đơn nháp được công bố riêng.
          </p>
        </div>

        {cohortState.showLoading ? <FinanceLoadingGrid count={4} /> : null}
        {cohortState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void cohortQuery.refetch()} />
        ) : null}
        {cohortState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải cohort hóa đơn"
            error={cohortState.blockingError}
            onRetry={() => void cohortQuery.refetch()}
          />
        ) : null}
        {cohortState.canRenderData && cohortRows.length === 0 ? (
          <FinanceEmptyState
            title="Chưa có dữ liệu cohort"
            description="Không có dòng cohort cho tháng và phạm vi tòa đã chọn."
          />
        ) : null}
        {cohortState.canRenderData && cohortRows.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard
                title="Current charge đã phát hành"
                value={cohortTotals ? formatCurrency(cohortTotals.billed) : "Chưa khả dụng"}
                description="Không gồm nợ chuyển tiếp, cọc kỳ này, khoản nội bộ hoặc settlement."
                icon={FileSignature}
              />
              <SummaryCard
                title="Đã thu cho current charge"
                value={cohortTotals ? formatCurrency(cohortTotals.collected) : "Chưa khả dụng"}
                description="Chỉ hiện khi phân bổ payment vào thành phần hóa đơn đã đầy đủ."
                icon={CircleDollarSign}
              />
              <SummaryCard
                title="Còn lại current charge"
                value={cohortTotals ? formatCurrency(cohortTotals.remaining) : "Chưa khả dụng"}
                description="Current charge đã phát hành trừ phần payment được phân bổ vào current charge."
                icon={Clock3}
              />
              <SummaryCard
                title="Tỷ lệ thu cohort"
                value={
                  cohortTotals && cohortTotals.billed > 0
                    ? `${((cohortTotals.collected / cohortTotals.billed) * 100).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
                    : "Chưa khả dụng"
                }
                description="Không phải tiền thực thu trong tháng; mẫu số là current charge của cohort phát hành."
                icon={WalletCards}
              />
            </div>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableCaption className="sr-only">Cohort hóa đơn theo tòa vật lý.</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Tòa nhà</TableHead>
                    <TableHead scope="col" className="text-right">Current charge</TableHead>
                    <TableHead scope="col" className="text-right">Đã thu</TableHead>
                    <TableHead scope="col" className="text-right">Nợ chuyển tiếp</TableHead>
                    <TableHead scope="col" className="text-right">Cọc kỳ này</TableHead>
                    <TableHead scope="col">Chất lượng phân bổ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cohortRows.map((row) => (
                    <TableRow key={row.building_id}>
                      <TableHead scope="row" className="h-auto text-foreground">{row.building_name}</TableHead>
                      <TableCell className="text-right tabular-nums">
                        {row.cohort_available ? formatCurrency(row.billed_current_charge ?? 0) : "Chưa khả dụng"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.cohort_available ? formatCurrency(row.collected_current_charge ?? 0) : "Chưa khả dụng"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(row.carried_invoice_debt + row.carried_deposit_debt)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(row.current_deposit)}</TableCell>
                      <TableCell>
                        {row.cohort_available
                          ? "Đầy đủ"
                          : `Thiếu phân bổ thành phần: ${formatCurrency(row.allocation_unknown_amount)}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="collections-cash-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="collections-cash-heading" className="text-lg font-semibold">
            Tiền thực thu trong tháng
          </h2>
          <p className="text-sm text-muted-foreground">
            Tổng payment còn hiệu lực theo payment_date, đã loại reversal và collection bị đảo.
          </p>
        </div>
        {cashState.showLoading ? <FinanceLoadingGrid count={2} /> : null}
        {cashState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void cashQuery.refetch()} />
        ) : null}
        {cashState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải tiền thực thu"
            error={cashState.blockingError}
            onRetry={() => void cashQuery.refetch()}
          />
        ) : null}
        {cashState.canRenderData && cashRows.length === 0 ? (
          <FinanceEmptyState
            title="Chưa có payment trong tháng"
            description="Không có sự kiện payment còn hiệu lực trong tháng và phạm vi tòa đã chọn."
          />
        ) : null}
        {cashState.canRenderData && cashRows.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SummaryCard
              title="Tiền thực thu trong tháng"
              value={formatCurrency(cashTotal)}
              description="Tiền giữ lại theo payment_date; không bao gồm cascade trạng thái công nợ."
              icon={CircleDollarSign}
            />
            <SummaryCard
              title="Sự kiện payment còn hiệu lực"
              value={paymentEventCount}
              description="Số payment sau khi loại reversal và collection đã bị đảo."
              icon={Clock3}
            />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="collections-live-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="collections-live-heading" className="text-lg font-semibold">
            Công nợ phải thu hiện tại
          </h2>
          <p className="text-sm text-muted-foreground">
            Tất cả số tiền dùng cùng một mốc live để tránh ghép công nợ hiện tại
            với tháng phân tích cũ.
          </p>
        </div>

        {snapshotState.showLoading ? <FinanceLoadingGrid count={5} /> : null}
        {snapshotState.showStaleWarning ? (
          <StaleDataWarning onRetry={() => void snapshotQuery.refetch()} />
        ) : null}
        {snapshotState.hasBlockingError ? (
          <FinanceQueryError
            title="Không thể tải công nợ hiện tại"
            error={snapshotState.blockingError}
            onRetry={() => void snapshotQuery.refetch()}
          />
        ) : null}
        {snapshotState.canRenderData && snapshotRows.length === 0 ? (
          <FinanceEmptyState
            title="Chưa có dữ liệu công nợ trong phạm vi đã chọn"
            description="Hãy kiểm tra lại tòa đang chọn hoặc quyền truy cập dữ liệu tài chính."
          />
        ) : null}

        {snapshotState.canRenderData && snapshotRows.length > 0 && snapshot ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard
                title="Tổng phải thu hiện tại"
                value={formatCurrency(snapshot.receivable_total)}
                description="Số phải thu do snapshot live trả về; không phải tiền đã thu."
                icon={CircleDollarSign}
              />
              <SummaryCard
                title="Cọc đang giữ"
                value={formatCurrency(snapshot.deposit_held)}
                description="Nghĩa vụ có thể hoàn trả; không phải doanh thu hoặc tiền thu của kỳ."
                icon={WalletCards}
              />
              <SummaryCard
                title="Hợp đồng có trạng thái ACTIVE"
                value={snapshot.active_contracts}
                description="Nguồn live đếm theo status ACTIVE, không tái kiểm tra ngày bắt đầu hoặc ngày kết thúc thực tế."
                icon={FileSignature}
              />
              <SummaryCard
                title="Giá thuê trung bình — trạng thái ACTIVE"
                value={
                  snapshot.avg_rent == null
                    ? "—"
                    : formatCurrency(snapshot.avg_rent)
                }
                description="Trung bình có trọng số trên các hợp đồng mang status ACTIVE trong nguồn live."
                icon={Clock3}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Phân bổ tuổi nợ hiện tại</CardTitle>
                <CardDescription>
                  Tỷ trọng được tính trên tổng phải thu hiện tại; không diễn giải
                  thành hiệu quả thu tiền theo kỳ hóa đơn.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  {agingBuckets.map((bucket) => (
                    <div
                      key={bucket.key}
                      className="flex min-w-0 flex-col gap-1 rounded-lg border bg-muted/20 p-4"
                    >
                      <span className="text-sm text-muted-foreground">{bucket.label}</span>
                      <span className="truncate text-lg font-semibold tabular-nums">
                        {formatCurrency(bucket.value)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {shareOfTotal(bucket.value, snapshot.receivable_total)} tổng phải thu
                      </span>
                    </div>
                  ))}
                </div>

                <div className="mt-6 rounded-md border">
                  <Table>
                    <TableCaption className="sr-only">
                      Bảng giá trị và tỷ trọng các bucket tuổi nợ hiện tại
                    </TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Bucket tuổi nợ</TableHead>
                        <TableHead scope="col" className="text-right">Giá trị</TableHead>
                        <TableHead scope="col" className="text-right">Tỷ trọng tổng phải thu</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {agingBuckets.map((bucket) => (
                        <TableRow key={`detail-${bucket.key}`}>
                          <TableHead
                            scope="row"
                            className="h-auto font-medium text-foreground"
                          >
                            {bucket.label}
                          </TableHead>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(bucket.value)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {shareOfTotal(bucket.value, snapshot.receivable_total)}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableHead
                          scope="row"
                          className="h-auto font-semibold text-foreground"
                        >
                          Tổng
                        </TableHead>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatCurrency(agingTotal)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {shareOfTotal(
                            agingTotal,
                            snapshot.receivable_total,
                          )}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </section>
    </div>
  );
}

export default CollectionsDebtTab;
