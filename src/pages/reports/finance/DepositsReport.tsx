import { Wallet, DollarSign, Clock, CheckCircle2 } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useDepositsReport } from "@/hooks/useReports";
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
import { format } from "date-fns";
import { vi } from "date-fns/locale";

export default function DepositsReport() {
  const { data: deposits, isLoading } = useDepositsReport();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const totalDeposits = deposits?.reduce((sum, d) => sum + d.amount, 0) || 0;
  const holdingDeposits = deposits?.filter(d => d.status === "HOLDING").length || 0;

  const stats = (
    <>
      <ReportCard
        title="Tổng tiền cọc"
        value={formatCurrency(totalDeposits)}
        icon={DollarSign}
        description="Tất cả tiền cọc"
      />
      <ReportCard
        title="Số lượng"
        value={deposits?.length || 0}
        icon={Wallet}
        description="Tổng số tiền cọc"
      />
      <ReportCard
        title="Đang giữ"
        value={holdingDeposits}
        icon={Clock}
        description="Chưa hoàn lại"
      />
      <ReportCard
        title="Đã xử lý"
        value={(deposits?.length || 0) - holdingDeposits}
        icon={CheckCircle2}
        description="Đã hoàn/sử dụng"
      />
    </>
  );

  const exportData = deposits?.map(deposit => ({
    "Khách hàng": deposit.leads?.full_name || "N/A",
    "Điện thoại": deposit.leads?.phone || "",
    "Phòng": `${deposit.rooms?.buildings?.name} - ${deposit.rooms?.room_number}`,
    "Số tiền cọc": deposit.amount,
    "Ngày cọc": format(new Date(deposit.deposit_date), "dd/MM/yyyy", { locale: vi }),
    "Số ngày giữ": deposit.days_held,
    "Trạng thái": deposit.status,
  })) || [];

  return (
    <ReportLayout
      title="Báo cáo Tiền cọc"
      description="Quản lý danh sách tiền cọc khách hàng"
      icon={<Wallet className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-tien-coc"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Danh sách tiền cọc</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : deposits && deposits.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Liên hệ</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Số tiền cọc</TableHead>
                    <TableHead>Ngày cọc</TableHead>
                    <TableHead>Số ngày giữ</TableHead>
                    <TableHead>Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deposits.map((deposit) => (
                    <TableRow key={deposit.id}>
                      <TableCell className="font-medium">
                        {deposit.leads?.full_name || "N/A"}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div>{deposit.leads?.phone || "-"}</div>
                          <div className="text-muted-foreground">{deposit.leads?.email || "-"}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {deposit.rooms?.buildings?.name} - {deposit.rooms?.room_number}
                      </TableCell>
                      <TableCell className="font-semibold">
                        {formatCurrency(deposit.amount)}
                      </TableCell>
                      <TableCell>
                        {format(new Date(deposit.deposit_date), "dd/MM/yyyy", { locale: vi })}
                      </TableCell>
                      <TableCell>{deposit.days_held} ngày</TableCell>
                      <TableCell>
                        <Badge variant={
                          deposit.status === "HOLDING" ? "default" :
                          deposit.status === "REFUNDED" ? "secondary" : "outline"
                        }>
                          {deposit.status === "HOLDING" ? "Đang giữ" :
                           deposit.status === "REFUNDED" ? "Đã hoàn" :
                           deposit.status === "CONVERTED" ? "Đã chuyển" : deposit.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có tiền cọc nào
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
