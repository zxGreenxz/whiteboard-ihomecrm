import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Book, TrendingUp, TrendingDown, Wallet } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useCashBook, useCashBookSummary } from "@/hooks/useCashBook";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DateRange } from "react-day-picker";
import { format, startOfMonth } from "date-fns";
import { vi } from "date-fns/locale";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

export default function DailyCashbookReport() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: new Date(),
  });
  const [buildingId, setBuildingId] = useState<string>("all");

  const startDate = dateRange?.from?.toISOString().split("T")[0];
  const endDate = dateRange?.to?.toISOString().split("T")[0];

  const { data: entriesData = [], isLoading } = useCashBook(startDate, endDate);
  const { data: summary } = useCashBookSummary(startDate, endDate);
  const { data: buildings = [] } = useBuildings();

  const entries = Array.isArray(entriesData) ? entriesData : [];

  // Calculate running balance from opening balance
  let runningBalance = summary?.openingBalance || 0;
  const entriesWithBalance = entries.map((entry) => {
    runningBalance += entry.type === "INCOME" ? entry.amount : -entry.amount;
    return { ...entry, balance: runningBalance };
  });

  const stats = (
    <>
      <ReportCard
        title="Số dư đầu kỳ"
        value={formatCurrency(summary?.openingBalance || 0)}
        icon={Wallet}
        description="Đầu kỳ báo cáo"
      />
      <ReportCard
        title="Tổng thu"
        value={formatCurrency(summary?.totalIncome || 0)}
        icon={TrendingUp}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Tổng chi"
        value={formatCurrency(summary?.totalExpense || 0)}
        icon={TrendingDown}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Số dư cuối kỳ"
        value={formatCurrency(summary?.closingBalance || 0)}
        icon={Book}
        description="Cuối kỳ báo cáo"
      />
    </>
  );

  const exportData = entriesWithBalance.map((entry) => ({
    "Ngày": format(new Date(entry.date), "dd/MM/yyyy", { locale: vi }),
    "Mô tả": entry.description,
    "Thu": entry.type === "INCOME" ? entry.amount : "",
    "Chi": entry.type === "EXPENSE" ? entry.amount : "",
    "Số dư": entry.balance,
  }));

  return (
    <MainLayout>
      <ReportLayout
        title="Sổ quỹ theo ngày"
        description="Thu chi hàng ngày, số dư đầu kỳ, tổng thu, tổng chi, số dư cuối kỳ"
        icon={<Book className="h-8 w-8" />}
        backPath="/reports/finance"
        actions={
          <ExportButtons data={exportData} filename="so-quy-theo-ngay" />
        }
        filters={
          <div className="flex flex-wrap gap-4 items-end">
            <DateRangePicker value={dateRange} onChange={setDateRange} />
            <Select value={buildingId} onValueChange={setBuildingId}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Tất cả toà nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả toà nhà</SelectItem>
                {buildings.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
        stats={stats}
      >
        <Card>
          <CardHeader>
            <CardTitle>Chi tiết sổ quỹ</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ngày</TableHead>
                      <TableHead>Mô tả</TableHead>
                      <TableHead className="text-right">Thu</TableHead>
                      <TableHead className="text-right">Chi</TableHead>
                      <TableHead className="text-right">Số dư</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* Opening Balance Row */}
                    <TableRow className="bg-muted/50 font-semibold">
                      <TableCell>
                        {startDate
                          ? format(new Date(startDate), "dd/MM/yyyy", { locale: vi })
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">Số dư đầu kỳ</Badge>
                      </TableCell>
                      <TableCell className="text-right">-</TableCell>
                      <TableCell className="text-right">-</TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatCurrency(summary?.openingBalance || 0)}
                      </TableCell>
                    </TableRow>

                    {entriesWithBalance.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center py-8 text-muted-foreground"
                        >
                          Không có giao dịch nào trong kỳ này
                        </TableCell>
                      </TableRow>
                    ) : (
                      entriesWithBalance.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            {format(new Date(entry.date), "dd/MM/yyyy", {
                              locale: vi,
                            })}
                          </TableCell>
                          <TableCell className="max-w-md">
                            {entry.description}
                          </TableCell>
                          <TableCell className="text-right text-green-600 font-semibold">
                            {entry.type === "INCOME"
                              ? formatCurrency(entry.amount)
                              : "-"}
                          </TableCell>
                          <TableCell className="text-right text-red-600 font-semibold">
                            {entry.type === "EXPENSE"
                              ? formatCurrency(entry.amount)
                              : "-"}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(entry.balance)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}

                    {/* Closing Balance Row */}
                    <TableRow className="bg-muted/50 font-bold border-t-2">
                      <TableCell>
                        {endDate
                          ? format(new Date(endDate), "dd/MM/yyyy", { locale: vi })
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">Số dư cuối kỳ</Badge>
                      </TableCell>
                      <TableCell className="text-right text-green-600">
                        {formatCurrency(summary?.totalIncome || 0)}
                      </TableCell>
                      <TableCell className="text-right text-red-600">
                        {formatCurrency(summary?.totalExpense || 0)}
                      </TableCell>
                      <TableCell className="text-right text-blue-600 font-bold">
                        {formatCurrency(summary?.closingBalance || 0)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
