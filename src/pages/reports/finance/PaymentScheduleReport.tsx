import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Calendar, Clock, CheckCircle2, XCircle } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { usePaymentScheduleReport } from "@/hooks/useReports";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

export default function PaymentScheduleReport() {
  const [daysFilter, setDaysFilter] = useState(30);
  const { data: rawInvoices, isLoading } = usePaymentScheduleReport(daysFilter);

  // Cast to any[] to handle hook's runtime data shape
  const invoices = (rawInvoices || []) as any[];

  const upcoming = invoices.filter(i => i.days_until_due >= 0 && i.status !== "PAID");
  const overdue = invoices.filter(i => i.days_until_due < 0 && i.status !== "PAID");
  const paid = invoices.filter(i => i.status === "PAID");
  const totalDue = upcoming.reduce((sum: number, i: any) => sum + (i.remaining_amount || 0), 0);

  const stats = (
    <>
      <ReportCard title="HĐ cần thu trong tháng" value={upcoming.length} icon={Clock} description={`Trong ${daysFilter} ngày tới`} />
      <ReportCard title="Quá hạn" value={overdue.length} icon={XCircle} description="Chưa thanh toán" />
      <ReportCard title="Đã thanh toán" value={paid.length} icon={CheckCircle2} description="Trong kỳ" />
      <ReportCard title="Dự kiến thu" value={formatCurrency(totalDue)} icon={Calendar} description="Tổng tiền cần thu" />
    </>
  );

  const exportData = invoices.map((inv: any) => ({
    "Mã HĐ": inv.invoice_number || "",
    "Khách hàng": inv.tenants?.full_name || "N/A",
    "Căn hộ": `${inv.rooms?.buildings?.name || inv.rooms?.name || ""} - ${inv.rooms?.room_number || inv.rooms?.name || ""}`,
    "Ngày đáo hạn": format(new Date(inv.due_date), "dd/MM/yyyy", { locale: vi }),
    "Số tiền": inv.total_amount || inv.amount || 0,
    "Còn lại": inv.remaining_amount || 0,
    "Trạng thái": inv.status === "PAID" ? "Đã thanh toán" : inv.days_until_due < 0 ? "Quá hạn" : "Chưa thanh toán",
  }));

  return (
    <MainLayout>
      <ReportLayout
        title="Lịch thanh toán"
        description="HĐ cần thu trong tháng, ngày đáo hạn, số tiền"
        icon={<Calendar className="h-8 w-8" />}
        backPath="/reports/finance"
        actions={<ExportButtons data={exportData} filename="lich-thanh-toan" />}
        stats={stats}
      >
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>Danh sách hóa đơn</CardTitle>
              <Tabs value={daysFilter.toString()} onValueChange={(v) => setDaysFilter(Number(v))}>
                <TabsList>
                  <TabsTrigger value="7">7 ngày</TabsTrigger>
                  <TabsTrigger value="30">30 ngày</TabsTrigger>
                  <TabsTrigger value="90">90 ngày</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : invoices.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Ngày đáo hạn</TableHead>
                      <TableHead className="text-right">Số tiền</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((inv: any) => (
                      <TableRow key={inv.id}>
                        <TableCell>
                          <Badge variant={
                            inv.status === "PAID" ? "default" :
                            inv.days_until_due < 0 ? "destructive" : "secondary"
                          }>
                            {inv.status === "PAID" ? "Đã thanh toán" :
                             inv.days_until_due < 0 ? `Quá hạn ${Math.abs(inv.days_until_due)} ngày` :
                             `Còn ${inv.days_until_due} ngày`}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-medium">{inv.invoice_number || ""}</TableCell>
                        <TableCell>{inv.tenants?.full_name || "N/A"}</TableCell>
                        <TableCell>{inv.rooms?.buildings?.name || ""} - {inv.rooms?.room_number || inv.rooms?.name || ""}</TableCell>
                        <TableCell>{format(new Date(inv.due_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatCurrency(inv.remaining_amount || 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">Không có hóa đơn nào</div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
