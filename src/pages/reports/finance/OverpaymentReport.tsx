import { PlusCircle, DollarSign, Users, TrendingUp } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useOverpaymentReport } from "@/hooks/useReports";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

export default function OverpaymentReport() {
  const { data: overpayments, isLoading } = useOverpaymentReport();

  const totalOverpaid = overpayments?.reduce((sum, o) => sum + o.overpaid_amount, 0) || 0;
  const avgOverpaid = overpayments && overpayments.length > 0 ? totalOverpaid / overpayments.length : 0;
  const uniqueCustomers = new Set(overpayments?.map(o => o.tenants?.id).filter(Boolean)).size;

  const stats = (
    <>
      <ReportCard title="Khách trả thừa" value={overpayments?.length || 0} icon={Users} description="Số trường hợp" />
      <ReportCard title="Tổng tiền thừa" value={formatCurrency(totalOverpaid)} icon={DollarSign} description="Cần hoàn lại" />
      <ReportCard title="Trung bình" value={formatCurrency(avgOverpaid)} icon={TrendingUp} description="Tiền thừa TB" />
      <ReportCard title="Khách unique" value={uniqueCustomers} icon={PlusCircle} description="Số khách có tiền thừa" />
    </>
  );

  const exportData = overpayments?.map(op => ({
    "Khách hàng": op.tenants?.full_name || "N/A",
    "Điện thoại": op.tenants?.phone || "",
    "Căn hộ": `${op.rooms?.buildings?.name || ""} - ${op.rooms?.room_number || ""}`,
    "Số tiền HĐ": op.amount,
    "Đã thanh toán": op.amount_paid || 0,
    "Tiền thừa": op.overpaid_amount,
  })) || [];

  return (
    <MainLayout>
      <ReportLayout
        title="Báo cáo Tiền thừa"
        description="Khách trả thừa, cần hoàn lại"
        icon={<PlusCircle className="h-8 w-8" />}
        backPath="/reports/finance"
        actions={<ExportButtons data={exportData} filename="bao-cao-tien-thua" />}
        stats={stats}
      >
        <Card>
          <CardHeader>
            <CardTitle>Danh sách tiền thừa</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : overpayments && overpayments.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Liên hệ</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead className="text-right">Số tiền HĐ</TableHead>
                      <TableHead className="text-right">Đã thanh toán</TableHead>
                      <TableHead className="text-right">Tiền thừa</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overpayments.map((op) => (
                      <TableRow key={op.id}>
                        <TableCell className="font-medium">{op.tenants?.full_name || "N/A"}</TableCell>
                        <TableCell className="text-sm">{op.tenants?.phone || "-"}</TableCell>
                        <TableCell>{op.rooms?.buildings?.name} - {op.rooms?.room_number}</TableCell>
                        <TableCell className="text-right">{formatCurrency(op.amount)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(op.amount_paid || 0)}</TableCell>
                        <TableCell className="text-right font-semibold text-green-600">
                          +{formatCurrency(op.overpaid_amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">Không có tiền thừa nào</div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
