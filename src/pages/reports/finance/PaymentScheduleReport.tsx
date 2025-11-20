import { useState } from "react";
import { Calendar, Clock, CheckCircle2, XCircle } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { usePaymentScheduleReport } from "@/hooks/useReports";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

export default function PaymentScheduleReport() {
  const [daysFilter, setDaysFilter] = useState(30);
  const { data: invoices, isLoading } = usePaymentScheduleReport(daysFilter);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const upcoming = invoices?.filter(i => i.days_until_due >= 0 && i.status === "PENDING") || [];
  const overdue = invoices?.filter(i => i.days_until_due < 0 && i.status === "PENDING") || [];
  const paid = invoices?.filter(i => i.status === "PAID") || [];

  const stats = (
    <>
      <ReportCard
        title="Sắp đến hạn"
        value={upcoming.length}
        icon={Clock}
        description={`Trong ${daysFilter} ngày tới`}
      />
      <ReportCard
        title="Quá hạn"
        value={overdue.length}
        icon={XCircle}
        description="Chưa thanh toán"
      />
      <ReportCard
        title="Đã thanh toán"
        value={paid.length}
        icon={CheckCircle2}
        description="Trong kỳ"
      />
      <ReportCard
        title="Dự kiến thu"
        value={formatCurrency(upcoming.reduce((sum, i) => sum + i.remaining_amount, 0))}
        icon={Calendar}
        description="Tiền cần thu"
      />
    </>
  );

  const exportData = invoices?.map(inv => ({
    "Mã HĐ": inv.invoice_number,
    "Khách hàng": inv.tenants?.full_name || "N/A",
    "Phòng": `${inv.rooms?.buildings?.name} - ${inv.rooms?.room_number}`,
    "Ngày đến hạn": format(new Date(inv.due_date), "dd/MM/yyyy", { locale: vi }),
    "Số tiền": inv.amount,
    "Còn lại": inv.remaining_amount,
    "Trạng thái": inv.status === "PAID" ? "Đã thanh toán" : "Chưa thanh toán",
  })) || [];

  return (
    <ReportLayout
      title="Lịch thanh toán"
      description="Lịch hóa đơn đến hạn và quá hạn"
      icon={<Calendar className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="lich-thanh-toan"
        />
      }
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
          ) : invoices && invoices.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Mã HĐ</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Ngày đến hạn</TableHead>
                    <TableHead>Còn lại</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
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
                      <TableCell className="font-medium">{inv.invoice_number}</TableCell>
                      <TableCell>{inv.tenants?.full_name || "N/A"}</TableCell>
                      <TableCell>{inv.rooms?.buildings?.name} - {inv.rooms?.room_number}</TableCell>
                      <TableCell>{format(new Date(inv.due_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                      <TableCell className="font-semibold">
                        {formatCurrency(inv.remaining_amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có hóa đơn nào
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
