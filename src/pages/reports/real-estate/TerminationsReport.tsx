import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { XCircle, AlertCircle, TrendingDown, Percent } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useTerminationsReport } from "@/hooks/useReports";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateRange } from "react-day-picker";
import { format, startOfMonth } from "date-fns";
import { vi } from "date-fns/locale";

export default function TerminationsReport() {
  const [buildingId, setBuildingId] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: new Date(),
  });

  const { data: buildings } = useBuildings();
  const { data: reportData, isLoading } = useTerminationsReport(
    dateRange?.from, dateRange?.to, buildingId
  );

  const terminations = reportData?.items || [];
  const terminationRate = reportData?.terminationRate || 0;

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

  const cancelled = terminations.filter(t => t.status === "TERMINATED").length;
  const expired = terminations.filter(t => t.status === "EXPIRED").length;

  const stats = (
    <>
      <ReportCard title="HĐ thanh lý" value={terminations.length} icon={XCircle} description="Trong kỳ báo cáo" />
      <ReportCard title="Thanh lý sớm" value={cancelled} icon={AlertCircle} description="Chấm dứt trước hạn" />
      <ReportCard title="Hết hạn" value={expired} icon={TrendingDown} description="Kết thúc đúng hạn" />
      <ReportCard title="Tỷ lệ bỏ trả" value={`${terminationRate}%`} icon={Percent} description="So với tổng HĐ" />
    </>
  );

  const exportData = terminations.map(term => ({
    "Mã HĐ": term.contract_number || term.id.slice(0, 8),
    "Khách hàng": term.tenants?.full_name || "N/A",
    "Căn hộ": `${term.rooms?.buildings?.name} - ${term.rooms?.room_number}`,
    "Ngày thanh lý": format(new Date(term.actual_end_date || term.end_date), "dd/MM/yyyy", { locale: vi }),
    "Lý do": term.termination_reason || term.termination_type || "N/A",
    "Tiền cọc": term.total_deposit,
  }));

  const filters = (
    <div className="flex flex-wrap gap-4">
      <div className="w-[200px]">
        <SearchableSelect
          value={buildingId || "all"}
          onValueChange={(v) => setBuildingId(v === "all" ? undefined : v)}
          placeholder="Chọn toà nhà"
          options={[
            { value: "all", label: "Tất cả toà nhà" },
            ...(buildings?.map((b) => ({ value: b.id, label: b.name })) ?? []),
          ]}
        />
      </div>
      <DateRangePicker value={dateRange} onChange={setDateRange} />
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Báo cáo Bỏ trả"
        description="Danh sách hợp đồng đã thanh lý, chấm dứt"
        icon={<XCircle className="h-8 w-8" />}
        actions={<ExportButtons data={exportData} filename="bao-cao-bo-tra" />}
        filters={filters}
        stats={stats}
      >
        <Card>
          <CardHeader><CardTitle>Danh sách hợp đồng thanh lý</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map(i => (<Skeleton key={i} className="h-12 w-full" />))}</div>
            ) : terminations.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Ngày thanh lý</TableHead>
                      <TableHead>Lý do</TableHead>
                      <TableHead>Tiền cọc</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {terminations.map((term) => (
                      <TableRow key={term.id}>
                        <TableCell className="font-medium">{term.contract_number || term.id.slice(0, 8)}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div className="font-medium">{term.tenants?.full_name || "N/A"}</div>
                            <div className="text-muted-foreground">{term.tenants?.phone || "-"}</div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div className="font-medium">{term.rooms?.buildings?.name}</div>
                            <div className="text-muted-foreground">Căn hộ {term.rooms?.room_number}</div>
                          </div>
                        </TableCell>
                        <TableCell>{format(new Date(term.actual_end_date || term.end_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                        <TableCell>
                          <Badge variant={term.status === "TERMINATED" ? "destructive" : "secondary"}>
                            {term.termination_reason || term.termination_type}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatCurrency(term.total_deposit)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">Không có hợp đồng thanh lý nào trong kỳ này</div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
