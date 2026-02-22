import { AlertCircle, Clock, DollarSign, TrendingDown } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useDebtReport } from "@/hooks/useReports";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts";

const COLORS: Record<string, string> = {
  "0-30": "#10B981",
  "31-60": "#F59E0B",
  "61-90": "#EF4444",
  ">90": "#991B1B",
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

export default function DebtReport() {
  const { data: debts, isLoading } = useDebtReport();

  const totalDebt = debts?.reduce((sum, d) => sum + d.remaining_amount, 0) || 0;
  const criticalDebts = debts?.filter(d => d.days_overdue > 60).length || 0;
  const agingData = debts?.reduce((acc, d) => {
    const category = d.aging_category;
    acc[category] = (acc[category] || 0) + d.remaining_amount;
    return acc;
  }, {} as Record<string, number>);

  const pieData = Object.entries(agingData || {}).map(([name, value]) => ({
    name: `${name} ngày`,
    value,
    color: COLORS[name] || "#6b7280",
  }));

  const stats = (
    <>
      <ReportCard title="Tổng công nợ" value={formatCurrency(totalDebt)} icon={DollarSign} description="Tất cả hóa đơn chưa thanh toán" />
      <ReportCard title="Số hóa đơn nợ" value={debts?.length || 0} icon={AlertCircle} description="Hóa đơn quá hạn" />
      <ReportCard title="Nợ > 60 ngày" value={criticalDebts} icon={Clock} description="Cần ưu tiên thu" />
      <ReportCard title="Trung bình/HĐ" value={formatCurrency(debts && debts.length > 0 ? totalDebt / debts.length : 0)} icon={TrendingDown} description="Giá trị TB" />
    </>
  );

  const exportData = debts?.map(debt => ({
    "Mã HĐ": debt.invoice_number,
    "Khách hàng": debt.tenants?.full_name || "N/A",
    "Căn hộ": `${debt.rooms?.buildings?.name || ""} - ${debt.rooms?.room_number || ""}`,
    "Tổng tiền": debt.amount,
    "Đã trả": debt.amount_paid || 0,
    "Còn nợ": debt.remaining_amount,
    "Ngày quá hạn": debt.days_overdue,
    "Phân loại": debt.aging_category,
  })) || [];

  return (
    <MainLayout>
      <ReportLayout
        title="Công nợ hợp đồng mới"
        description="Phân tích công nợ theo tuổi nợ (0-30, 31-60, 61-90, >90 ngày)"
        icon={<AlertCircle className="h-8 w-8" />}
        backPath="/reports/finance"
        actions={<ExportButtons data={exportData} filename="cong-no-hop-dong-moi" />}
        stats={stats}
      >
        {isLoading ? (
          <Skeleton className="h-[400px] w-full" />
        ) : debts && debts.length > 0 ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Phân tích theo tuổi nợ</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={(entry) => `${entry.name}: ${formatCurrency(entry.value)}`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Chi tiết công nợ</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Mức độ</TableHead>
                        <TableHead>Mã HĐ</TableHead>
                        <TableHead>Khách hàng</TableHead>
                        <TableHead>Căn hộ</TableHead>
                        <TableHead className="text-right">Còn nợ</TableHead>
                        <TableHead>Ngày quá hạn</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {debts.map((debt) => (
                        <TableRow key={debt.id}>
                          <TableCell>
                            <Badge variant={
                              debt.aging_category === ">90" || debt.aging_category === "61-90"
                                ? "destructive"
                                : debt.aging_category === "31-60" ? "default" : "secondary"
                            }>
                              {debt.aging_category} ngày
                            </Badge>
                          </TableCell>
                          <TableCell className="font-medium">{debt.invoice_number}</TableCell>
                          <TableCell>{debt.tenants?.full_name || "N/A"}</TableCell>
                          <TableCell>{debt.rooms?.buildings?.name} - {debt.rooms?.room_number}</TableCell>
                          <TableCell className="text-right font-semibold text-red-600">
                            {formatCurrency(debt.remaining_amount)}
                          </TableCell>
                          <TableCell>{debt.days_overdue} ngày</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <div className="text-center py-8 text-muted-foreground">Không có công nợ</div>
        )}
      </ReportLayout>
    </MainLayout>
  );
}
