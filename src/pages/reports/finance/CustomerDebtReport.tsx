import { Users, AlertTriangle, DollarSign, FileText } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useCustomerDebtReport } from "@/hooks/useReports";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

function getDebtLevel(totalDebt: number): { label: string; variant: "destructive" | "default" | "secondary" } {
  if (totalDebt >= 10_000_000) return { label: "Cao", variant: "destructive" };
  if (totalDebt >= 5_000_000) return { label: "Trung bình", variant: "default" };
  return { label: "Thấp", variant: "secondary" };
}

export default function CustomerDebtReport() {
  const { data: customerDebts, isLoading } = useCustomerDebtReport();

  // Sort by totalDebt descending (top debtors first)
  const sorted = [...(customerDebts || [])].sort((a, b) => b.totalDebt - a.totalDebt);

  const totalDebt = sorted.reduce((sum, d) => sum + d.totalDebt, 0);
  const avgDebt = sorted.length > 0 ? totalDebt / sorted.length : 0;
  const highDebtCount = sorted.filter(d => d.totalDebt >= 10_000_000).length;

  const stats = (
    <>
      <ReportCard title="Số khách nợ" value={sorted.length} icon={Users} description="Khách hàng có nợ" />
      <ReportCard title="Tổng công nợ" value={formatCurrency(totalDebt)} icon={DollarSign} description="Tổng tiền nợ" />
      <ReportCard title="Nợ trung bình" value={formatCurrency(avgDebt)} icon={AlertTriangle} description="Nợ TB/khách" />
      <ReportCard title="Nợ cao" value={highDebtCount} icon={FileText} description="Khách nợ ≥ 10 triệu" />
    </>
  );

  const exportData = sorted.map(debt => ({
    "Khách hàng": debt.tenant?.full_name || "N/A",
    "Điện thoại": debt.tenant?.phone || "",
    "Email": debt.tenant?.email || "",
    "Căn hộ": `${debt.room?.buildings?.name || ""} - ${debt.room?.room_number || ""}`,
    "Tổng nợ": debt.totalDebt,
    "Số HĐ": debt.invoiceCount,
    "Quá hạn (ngày)": debt.daysOverdue,
    "Mức độ": getDebtLevel(debt.totalDebt).label,
  }));

  return (
    <MainLayout>
      <ReportLayout
        title="Báo cáo Khách nợ tiền"
        description="Top debtors, tổng công nợ, phân loại theo mức độ"
        icon={<Users className="h-8 w-8" />}
        backPath="/reports/finance"
        actions={<ExportButtons data={exportData} filename="bao-cao-khach-no-tien" />}
        stats={stats}
      >
        <Card>
          <CardHeader>
            <CardTitle>Danh sách khách nợ (sắp xếp theo tổng nợ giảm dần)</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : sorted.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Liên hệ</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead className="text-right">Tổng nợ</TableHead>
                      <TableHead>Số HĐ</TableHead>
                      <TableHead>Quá hạn</TableHead>
                      <TableHead>Mức độ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((debt, index) => {
                      const level = getDebtLevel(debt.totalDebt);
                      return (
                        <TableRow key={index}>
                          <TableCell className="font-medium">{index + 1}</TableCell>
                          <TableCell className="font-medium">{debt.tenant?.full_name || "N/A"}</TableCell>
                          <TableCell>
                            <div className="text-sm">
                              <div>{debt.tenant?.phone || "-"}</div>
                              <div className="text-muted-foreground">{debt.tenant?.email || "-"}</div>
                            </div>
                          </TableCell>
                          <TableCell>{debt.room?.buildings?.name} - {debt.room?.room_number}</TableCell>
                          <TableCell className="text-right font-semibold text-red-600">
                            {formatCurrency(debt.totalDebt)}
                          </TableCell>
                          <TableCell>{debt.invoiceCount} HĐ</TableCell>
                          <TableCell className="text-red-600">{debt.daysOverdue} ngày</TableCell>
                          <TableCell>
                            <Badge variant={level.variant}>{level.label}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">Không có khách nợ nào</div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
