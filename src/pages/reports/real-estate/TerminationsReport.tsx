import { useState } from "react";
import { XCircle, AlertCircle, Clock, TrendingDown } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useTerminationsReport } from "@/hooks/useReports";
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

export default function TerminationsReport() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: new Date(),
  });

  const { data: terminations, isLoading } = useTerminationsReport(dateRange?.from, dateRange?.to);

  const cancelled = terminations?.filter(t => t.status === "CANCELLED").length || 0;
  const completed = terminations?.filter(t => t.status === "COMPLETED").length || 0;
  const avgDuration = terminations && terminations.length > 0
    ? Math.round(terminations.reduce((sum, t) => sum + t.duration_actual, 0) / terminations.length)
    : 0;

  const stats = terminations && (
    <>
      <ReportCard
        title="Tổng hợp đồng kết thúc"
        value={terminations.length}
        icon={XCircle}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Hủy giữa chừng"
        value={cancelled}
        icon={AlertCircle}
        description="Hợp đồng bị hủy"
      />
      <ReportCard
        title="Kết thúc đúng hạn"
        value={completed}
        icon={Clock}
        description="Hoàn thành bình thường"
      />
      <ReportCard
        title="Thời gian thuê TB"
        value={`${avgDuration} ngày`}
        icon={TrendingDown}
        description="Trung bình"
      />
    </>
  );

  const exportData = terminations?.map(term => ({
    "Mã HĐ": term.contract_number,
    "Khách hàng": term.tenants?.full_name || "N/A",
    "Phòng": `${term.rooms?.buildings?.name} - ${term.rooms?.room_number}`,
    "Ngày bắt đầu": format(new Date(term.start_date), "dd/MM/yyyy", { locale: vi }),
    "Ngày kết thúc": format(new Date(term.end_date), "dd/MM/yyyy", { locale: vi }),
    "Thời gian thuê (ngày)": term.duration_actual,
    "Lý do": term.termination_reason || "N/A",
    "Trạng thái": term.status === "CANCELLED" ? "Hủy" : "Hoàn thành",
  })) || [];

  return (
    <ReportLayout
      title="Báo cáo Hợp đồng kết thúc"
      description="Danh sách hợp đồng đã kết thúc hoặc bị hủy"
      icon={<XCircle className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-hop-dong-ket-thuc"
        />
      }
      filters={
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Danh sách hợp đồng kết thúc</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : terminations && terminations.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã HĐ</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Ngày BĐ</TableHead>
                    <TableHead>Ngày KT</TableHead>
                    <TableHead>Thời gian thuê</TableHead>
                    <TableHead>Lý do</TableHead>
                    <TableHead>Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {terminations.map((term) => (
                    <TableRow key={term.id}>
                      <TableCell className="font-medium">
                        {term.contract_number || term.id.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{term.tenants?.full_name || "N/A"}</div>
                          <div className="text-muted-foreground">{term.tenants?.phone || "-"}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{term.rooms?.buildings?.name}</div>
                          <div className="text-muted-foreground">Phòng {term.rooms?.room_number}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {format(new Date(term.start_date), "dd/MM/yyyy", { locale: vi })}
                      </TableCell>
                      <TableCell>
                        {format(new Date(term.end_date), "dd/MM/yyyy", { locale: vi })}
                      </TableCell>
                      <TableCell>{term.duration_actual} ngày</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {term.termination_reason || "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={term.status === "CANCELLED" ? "destructive" : "secondary"}>
                          {term.status === "CANCELLED" ? "Đã hủy" : "Hoàn thành"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có hợp đồng kết thúc nào trong kỳ này
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
