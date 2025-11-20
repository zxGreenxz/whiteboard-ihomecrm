import { Users, AlertTriangle, DollarSign, FileText } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useCustomerDebtReport } from "@/hooks/useReports";
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

export default function CustomerDebtReport() {
  const { data: customerDebts, isLoading } = useCustomerDebtReport();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const totalDebt = customerDebts?.reduce((sum, d) => sum + d.totalDebt, 0) || 0;
  const avgDebt = customerDebts && customerDebts.length > 0
    ? totalDebt / customerDebts.length
    : 0;

  const stats = (
    <>
      <ReportCard
        title="Số khách nợ"
        value={customerDebts?.length || 0}
        icon={Users}
        description="Khách hàng có nợ"
      />
      <ReportCard
        title="Tổng công nợ"
        value={formatCurrency(totalDebt)}
        icon={DollarSign}
        description="Tổng tiền nợ"
      />
      <ReportCard
        title="Trung bình"
        value={formatCurrency(avgDebt)}
        icon={AlertTriangle}
        description="Nợ TB/khách"
      />
      <ReportCard
        title="Số hóa đơn"
        value={customerDebts?.reduce((sum, d) => sum + d.invoiceCount, 0) || 0}
        icon={FileText}
        description="Tổng HĐ chưa thanh toán"
      />
    </>
  );

  const exportData = customerDebts?.map(debt => ({
    "Khách hàng": debt.tenant?.full_name || "N/A",
    "Điện thoại": debt.tenant?.phone || "",
    "Email": debt.tenant?.email || "",
    "Phòng": `${debt.room?.buildings?.name} - ${debt.room?.room_number}`,
    "Tổng nợ": debt.totalDebt,
    "Số HĐ": debt.invoiceCount,
    "Quá hạn (ngày)": debt.daysOverdue,
  })) || [];

  return (
    <ReportLayout
      title="Báo cáo Khách nợ tiền"
      description="Danh sách khách hàng có công nợ"
      icon={<Users className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-khach-no-tien"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Danh sách khách nợ</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : customerDebts && customerDebts.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Liên hệ</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Tổng nợ</TableHead>
                    <TableHead>Số HĐ</TableHead>
                    <TableHead>Quá hạn</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customerDebts.map((debt, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium">
                        {debt.tenant?.full_name || "N/A"}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div>{debt.tenant?.phone || "-"}</div>
                          <div className="text-muted-foreground">{debt.tenant?.email || "-"}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {debt.room?.buildings?.name} - {debt.room?.room_number}
                      </TableCell>
                      <TableCell className="font-semibold text-red-600">
                        {formatCurrency(debt.totalDebt)}
                      </TableCell>
                      <TableCell>{debt.invoiceCount} HĐ</TableCell>
                      <TableCell className="text-red-600">
                        {debt.daysOverdue} ngày
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có khách nợ nào
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
