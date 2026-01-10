import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Book, DollarSign, TrendingUp, Calendar } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useCashBookReport } from "@/hooks/useReports";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRange } from "react-day-picker";
import { format, startOfMonth } from "date-fns";
import { vi } from "date-fns/locale";

export default function CashBookReport() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: new Date(),
  });

  const { data: entries, isLoading } = useCashBookReport(dateRange?.from, dateRange?.to);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const totalIncome = entries?.reduce((sum, e) => sum + (e.type === "INCOME" ? e.amount : 0), 0) || 0;
  const totalExpense = entries?.reduce((sum, e) => sum + (e.type === "EXPENSE" ? e.amount : 0), 0) || 0;
  const closingBalance = entries?.[entries.length - 1]?.balance || 0;

  const stats = (
    <>
      <ReportCard
        title="Tổng thu"
        value={formatCurrency(totalIncome)}
        icon={TrendingUp}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Tổng chi"
        value={formatCurrency(totalExpense)}
        icon={DollarSign}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Dòng tiền ròng"
        value={formatCurrency(totalIncome - totalExpense)}
        icon={TrendingUp}
        description="Thu - Chi"
      />
      <ReportCard
        title="Số dư cuối kỳ"
        value={formatCurrency(closingBalance)}
        icon={Book}
        description="Running balance"
      />
    </>
  );

  const exportData = entries?.map(entry => ({
    "Ngày": format(new Date(entry.date), "dd/MM/yyyy", { locale: vi }),
    "Loại": entry.type === "INCOME" ? "Thu" : "Chi",
    "Diễn giải": entry.description,
    "Số tiền": entry.amount,
    "Phương thức": entry.method,
    "Số dư": entry.balance,
    "Ghi chú": entry.notes || "",
  })) || [];

  return (
    <MainLayout>
    <ReportLayout
      title="Sổ quỹ tiền mặt"
      description="Sổ quỹ chi tiết theo ngày với số dư tích lũy"
      icon={<Book className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="so-quy-tien-mat"
        />
      }
      filters={
        <DateRangePicker value={dateRange} onChange={setDateRange} />
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
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : entries && entries.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Loại</TableHead>
                    <TableHead>Diễn giải</TableHead>
                    <TableHead>Số tiền</TableHead>
                    <TableHead>Phương thức</TableHead>
                    <TableHead>Số dư</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        {format(new Date(entry.date), "dd/MM/yyyy", { locale: vi })}
                      </TableCell>
                      <TableCell>
                        <Badge variant={entry.type === "INCOME" ? "default" : "destructive"}>
                          {entry.type === "INCOME" ? "Thu" : "Chi"}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-md">{entry.description}</TableCell>
                      <TableCell className={entry.type === "INCOME" ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>
                        {entry.type === "INCOME" ? "+" : "-"}{formatCurrency(entry.amount)}
                      </TableCell>
                      <TableCell>{entry.method}</TableCell>
                      <TableCell className="font-semibold">{formatCurrency(entry.balance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có dữ liệu trong kỳ này
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
    </MainLayout>
  );
}
