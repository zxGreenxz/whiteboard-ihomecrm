import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { FileCheck, Plus, TrendingUp, DollarSign } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useNewLeasesReport } from "@/hooks/useReports";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateRange } from "react-day-picker";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { vi } from "date-fns/locale";

export default function NewLeasesReport() {
  const [buildingId, setBuildingId] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: endOfMonth(new Date()),
  });

  const { data: buildings } = useBuildings();
  const { data: leases, isLoading } = useNewLeasesReport(
    dateRange?.from, dateRange?.to, buildingId
  );

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

  const totalRevenue = leases?.reduce((sum, l) => sum + l.total_value, 0) || 0;
  const avgRent = leases && leases.length > 0
    ? leases.reduce((sum, l) => sum + l.monthly_rent, 0) / leases.length : 0;

  const stats = leases && (
    <>
      <ReportCard title="HĐ mới trong kỳ" value={leases.length} icon={Plus} description="Hợp đồng mới ký" />
      <ReportCard title="Doanh thu mới" value={formatCurrency(totalRevenue)} icon={DollarSign} description="Tổng giá trị HĐ mới" />
      <ReportCard title="Giá thuê TB" value={formatCurrency(avgRent)} icon={TrendingUp} description="Trung bình/tháng" />
      <ReportCard title="Thời hạn TB" value={`${leases.length > 0 ? Math.round(leases.reduce((sum, l) => sum + l.duration_months, 0) / leases.length) : 0} tháng`} icon={FileCheck} description="Trung bình" />
    </>
  );

  const exportData = leases?.map(lease => ({
    "Mã HĐ": lease.contract_number || lease.id.slice(0, 8),
    "Khách hàng": lease.tenants?.full_name || "N/A",
    "Căn hộ": `${lease.rooms?.buildings?.name} - ${lease.rooms?.room_number}`,
    "Ngày ký": format(new Date(lease.signed_date), "dd/MM/yyyy", { locale: vi }),
    "Giá thuê": lease.monthly_rent,
    "Thời hạn (tháng)": lease.duration_months,
  })) || [];

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
        title="Báo cáo Cho thuê"
        description="Danh sách hợp đồng cho thuê mới được ký trong kỳ"
        icon={<FileCheck className="h-8 w-8" />}
        actions={<ExportButtons data={exportData} filename="bao-cao-cho-thue" />}
        filters={filters}
        stats={stats}
      >
        <Card>
          <CardHeader><CardTitle>Danh sách hợp đồng mới</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map(i => (<Skeleton key={i} className="h-12 w-full" />))}</div>
            ) : leases && leases.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Ngày ký</TableHead>
                      <TableHead>Giá thuê</TableHead>
                      <TableHead>Thời hạn</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leases.map((lease) => (
                      <TableRow key={lease.id}>
                        <TableCell className="font-medium">{lease.contract_number || lease.id.slice(0, 8)}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div className="font-medium">{lease.tenants?.full_name || "N/A"}</div>
                            <div className="text-muted-foreground">{lease.tenants?.phone || "-"}</div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div className="font-medium">{lease.rooms?.buildings?.name}</div>
                            <div className="text-muted-foreground">Căn hộ {lease.rooms?.room_number}</div>
                          </div>
                        </TableCell>
                        <TableCell>{format(new Date(lease.signed_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                        <TableCell>{formatCurrency(lease.monthly_rent)}</TableCell>
                        <TableCell>{lease.duration_months} tháng</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">Không có hợp đồng mới nào trong kỳ này</div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
