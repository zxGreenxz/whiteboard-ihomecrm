import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { RefreshCw, FileEdit, ArrowRightLeft, TrendingUp } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useContractChangesReport } from "@/hooks/useReports";
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

export default function ContractChangesReport() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: new Date(),
  });

  const { data: changes, isLoading } = useContractChangesReport(dateRange?.from, dateRange?.to);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const extensions = changes?.filter(c => c.change_type === "EXTENSION").length || 0;
  const avgDuration = changes && changes.length > 0
    ? Math.round(changes.reduce((sum, c) => sum + c.duration_months, 0) / changes.length)
    : 0;

  const stats = changes && (
    <>
      <ReportCard
        title="Tổng thay đổi"
        value={changes.length}
        icon={RefreshCw}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Gia hạn"
        value={extensions}
        icon={FileEdit}
        description="Hợp đồng gia hạn"
      />
      <ReportCard
        title="Thời hạn TB"
        value={`${avgDuration} tháng`}
        icon={TrendingUp}
        description="Gia hạn trung bình"
      />
      <ReportCard
        title="Tỷ lệ gia hạn"
        value={`${changes.length > 0 ? ((extensions / changes.length) * 100).toFixed(1) : 0}%`}
        icon={ArrowRightLeft}
        description="So với tổng thay đổi"
      />
    </>
  );

  const exportData = changes?.map(change => ({
    "Mã HĐ": change.contract_number,
    "Loại thay đổi": change.change_type === "EXTENSION" ? "Gia hạn" : "Mới",
    "Khách hàng": change.tenants?.full_name || "N/A",
    "Phòng": `${change.rooms?.buildings?.name} - ${change.rooms?.room_number}`,
    "Ngày bắt đầu": format(new Date(change.start_date), "dd/MM/yyyy", { locale: vi }),
    "Thời hạn (tháng)": change.duration_months,
    "Giá thuê": change.monthly_rent,
    "Ngày tạo": format(new Date(change.created_at), "dd/MM/yyyy", { locale: vi }),
  })) || [];

  return (
    <MainLayout>
    <ReportLayout
      title="Báo cáo Thay đổi hợp đồng"
      description="Danh sách các thay đổi: gia hạn, chuyển nhượng, điều chỉnh"
      icon={<RefreshCw className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-thay-doi-hop-dong"
        />
      }
      filters={
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Danh sách thay đổi hợp đồng</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : changes && changes.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Loại</TableHead>
                    <TableHead>Mã HĐ</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Ngày bắt đầu</TableHead>
                    <TableHead>Thời hạn</TableHead>
                    <TableHead>Giá thuê</TableHead>
                    <TableHead>Ngày tạo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changes.map((change) => (
                    <TableRow key={change.id}>
                      <TableCell>
                        <Badge variant={change.change_type === "EXTENSION" ? "default" : "secondary"}>
                          {change.change_type === "EXTENSION" ? "Gia hạn" : "Mới"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">
                        {change.contract_number || change.id.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{change.tenants?.full_name || "N/A"}</div>
                          <div className="text-muted-foreground">{change.tenants?.phone || "-"}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{change.rooms?.buildings?.name}</div>
                          <div className="text-muted-foreground">Phòng {change.rooms?.room_number}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {format(new Date(change.start_date), "dd/MM/yyyy", { locale: vi })}
                      </TableCell>
                      <TableCell>{change.duration_months} tháng</TableCell>
                      <TableCell>{formatCurrency(change.monthly_rent)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {format(new Date(change.created_at), "dd/MM/yyyy", { locale: vi })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có thay đổi hợp đồng nào trong kỳ này
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
    </MainLayout>
  );
}
