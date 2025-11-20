import { PlusCircle, DollarSign, Users, TrendingUp } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useOverpaymentReport } from "@/hooks/useReports";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function OverpaymentReport() {
  const { data: overpayments, isLoading } = useOverpaymentReport();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const totalOverpaid = overpayments?.reduce((sum, o) => sum + o.overpaid_amount, 0) || 0;
  const avgOverpaid = overpayments && overpayments.length > 0
    ? totalOverpaid / overpayments.length
    : 0;

  const stats = (
    <>
      <ReportCard
        title="Số trường hợp"
        value={overpayments?.length || 0}
        icon={Users}
        description="Khách thanh toán thừa"
      />
      <ReportCard
        title="Tổng tiền thừa"
        value={formatCurrency(totalOverpaid)}
        icon={DollarSign}
        description="Cần hoàn lại"
      />
      <ReportCard
        title="Trung bình"
        value={formatCurrency(avgOverpaid)}
        icon={TrendingUp}
        description="Tiền thừa TB"
      />
      <ReportCard
        title="Khách có tiền thừa"
        value={new Set(overpayments?.map(o => o.tenants?.id)).size}
        icon={PlusCircle}
        description="Số khách unique"
      />
    </>
  );

  const exportData = overpayments?.map(op => ({
    "Mã HĐ": op.id.slice(0, 8),
    "Khách hàng": op.tenants?.full_name || "N/A",
    "Điện thoại": op.tenants?.phone || "",
    "Phòng": `${op.rooms?.buildings?.name} - ${op.rooms?.room_number}`,
    "Số tiền HĐ": op.amount,
    "Đã thanh toán": op.amount_paid || 0,
    "Tiền thừa": op.overpaid_amount,
  })) || [];

  return (
    <ReportLayout
      title="Báo cáo Tiền thừa"
      description="Danh sách khách hàng thanh toán thừa"
      icon={<PlusCircle className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-tien-thua"
        />
      }
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
                    <TableHead>Phòng</TableHead>
                    <TableHead>Số tiền HĐ</TableHead>
                    <TableHead>Đã thanh toán</TableHead>
                    <TableHead>Tiền thừa</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overpayments.map((op) => (
                    <TableRow key={op.id}>
                      <TableCell className="font-medium">
                        {op.tenants?.full_name || "N/A"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {op.tenants?.phone || "-"}
                      </TableCell>
                      <TableCell>
                        {op.rooms?.buildings?.name} - {op.rooms?.room_number}
                      </TableCell>
                      <TableCell>{formatCurrency(op.amount)}</TableCell>
                      <TableCell>{formatCurrency(op.amount_paid || 0)}</TableCell>
                      <TableCell className="font-semibold text-green-600">
                        +{formatCurrency(op.overpaid_amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có tiền thừa nào
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
