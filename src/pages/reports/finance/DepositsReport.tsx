import { Wallet, DollarSign, Clock, CheckCircle2 } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useDepositsReport } from "@/hooks/useReports";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

const STATUS_MAP: Record<string, string> = {
  PENDING: "Chờ xác nhận",
  CONFIRMED: "Đã xác nhận",
  CONVERTED: "Đã chuyển HĐ",
  REFUNDED: "Đã hoàn",
  FORFEITED: "Mất cọc",
};

export default function DepositsReport() {
  const { data: rawDeposits, isLoading } = useDepositsReport();

  // Cast to any[] to handle hook's runtime data shape
  const deposits = (rawDeposits || []) as any[];

  const totalDeposits = deposits.reduce((sum: number, d: any) => sum + (d.amount || 0), 0);
  const pendingDeposits = deposits.filter((d: any) => d.status === "PENDING" || d.status === "CONFIRMED");
  const pendingTotal = pendingDeposits.reduce((sum: number, d: any) => sum + (d.amount || 0), 0);
  const refundedCount = deposits.filter((d: any) => d.status === "REFUNDED").length;
  const convertedCount = deposits.filter((d: any) => d.status === "CONVERTED").length;

  const stats = (
    <>
      <ReportCard title="Tổng tiền cọc" value={formatCurrency(totalDeposits)} icon={DollarSign} description="Tất cả tiền cọc" />
      <ReportCard title="Đang giữ" value={formatCurrency(pendingTotal)} icon={Clock} description={`${pendingDeposits.length} khoản cọc`} />
      <ReportCard title="Đã hoàn" value={refundedCount} icon={CheckCircle2} description="Đã hoàn lại khách" />
      <ReportCard title="Đã chuyển HĐ" value={convertedCount} icon={Wallet} description="Chuyển thành hợp đồng" />
    </>
  );

  const exportData = deposits.map((deposit: any) => ({
    "Khách hàng": deposit.leads?.full_name || "N/A",
    "Điện thoại": deposit.leads?.phone || "",
    "Căn hộ": `${deposit.rooms?.buildings?.name || ""} - ${deposit.rooms?.room_number || deposit.rooms?.name || ""}`,
    "Số tiền cọc": deposit.amount || 0,
    "Ngày cọc": format(new Date(deposit.deposit_date), "dd/MM/yyyy", { locale: vi }),
    "Số ngày giữ": deposit.days_held || 0,
    "Trạng thái": STATUS_MAP[deposit.status] || deposit.status,
  }));

  return (
    <MainLayout>
      <ReportLayout
        title="Danh sách tiền cọc"
        description="Tổng tiền cọc đang giữ, phân theo trạng thái"
        icon={<Wallet className="h-8 w-8" />}
        backPath="/reports/finance"
        actions={<ExportButtons data={exportData} filename="danh-sach-tien-coc" />}
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
            ) : deposits.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Liên hệ</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead className="text-right">Số tiền cọc</TableHead>
                      <TableHead>Ngày cọc</TableHead>
                      <TableHead>Số ngày giữ</TableHead>
                      <TableHead>Trạng thái</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deposits.map((deposit: any) => (
                      <TableRow key={deposit.id}>
                        <TableCell className="font-medium">{deposit.leads?.full_name || "N/A"}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div>{deposit.leads?.phone || "-"}</div>
                            <div className="text-muted-foreground">{deposit.leads?.email || "-"}</div>
                          </div>
                        </TableCell>
                        <TableCell>{deposit.rooms?.buildings?.name || ""} - {deposit.rooms?.room_number || deposit.rooms?.name || ""}</TableCell>
                        <TableCell className="text-right font-semibold">{formatCurrency(deposit.amount || 0)}</TableCell>
                        <TableCell>{format(new Date(deposit.deposit_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                        <TableCell>{deposit.days_held || 0} ngày</TableCell>
                        <TableCell>
                          <Badge variant={
                            deposit.status === "PENDING" || deposit.status === "CONFIRMED" ? "default" :
                            deposit.status === "REFUNDED" ? "secondary" :
                            deposit.status === "FORFEITED" ? "destructive" : "outline"
                          }>
                            {STATUS_MAP[deposit.status] || deposit.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">Không có tiền cọc nào</div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
