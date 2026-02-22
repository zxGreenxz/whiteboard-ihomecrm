import { useState } from "react";
import { Building2, Home, DoorOpen, Wrench, TrendingUp } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useOccupancyReport } from "@/hooks/useReports";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export default function OccupancyOldReport() {
  const [buildingId, setBuildingId] = useState<string | undefined>();

  const { data: buildings } = useBuildings();
  const { data: occupancyData, isLoading } = useOccupancyReport(buildingId);

  const stats = occupancyData && (
    <>
      <ReportCard title="Tổng số căn hộ" value={occupancyData.summary.total} icon={Building2} description="Tổng căn hộ quản lý" />
      <ReportCard title="Đang cho thuê" value={occupancyData.summary.occupied} icon={Home} description={`${occupancyData.summary.occupancyRate}% tỷ lệ lấp đầy`} />
      <ReportCard title="Căn hộ trống" value={occupancyData.summary.available} icon={DoorOpen} description="Sẵn sàng cho thuê" />
      <ReportCard title="Bảo dưỡng" value={occupancyData.summary.maintenance} icon={Wrench} description="Đang sửa chữa" />
    </>
  );

  const exportData = occupancyData?.byBuilding.map(b => ({
    "Toà nhà": b.building,
    "Tổng căn hộ": b.total,
    "Đang thuê": b.occupied,
    "Căn hộ trống": b.available,
    "Bảo dưỡng": b.maintenance,
    "Tỷ lệ lấp đầy (%)": b.occupancyRate,
  })) || [];

  const filters = (
    <div className="flex flex-wrap gap-4 items-end">
      <div className="w-[200px]">
        <Select value={buildingId || "all"} onValueChange={(v) => setBuildingId(v === "all" ? undefined : v)}>
          <SelectTrigger>
            <SelectValue placeholder="Chọn toà nhà" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả toà nhà</SelectItem>
            {buildings?.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Tỷ lệ lấp đầy (Phiên bản cũ)"
        description="Bảng thống kê tỷ lệ lấp đầy theo từng toà nhà"
        icon={<TrendingUp className="h-8 w-8" />}
        actions={<ExportButtons data={exportData} filename="ty-le-lap-day-cu" />}
        stats={stats}
        filters={filters}
      >
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : occupancyData && occupancyData.byBuilding.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Chi tiết theo toà nhà</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Toà nhà</TableHead>
                      <TableHead className="text-center">Tổng căn hộ</TableHead>
                      <TableHead className="text-center">Đang thuê</TableHead>
                      <TableHead className="text-center">Căn hộ trống</TableHead>
                      <TableHead className="text-center">Bảo dưỡng</TableHead>
                      <TableHead className="text-center">Tỷ lệ lấp đầy</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {occupancyData.byBuilding.map((b, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-medium">{b.building}</TableCell>
                        <TableCell className="text-center">{b.total}</TableCell>
                        <TableCell className="text-center text-green-600 font-semibold">{b.occupied}</TableCell>
                        <TableCell className="text-center text-red-600">{b.available}</TableCell>
                        <TableCell className="text-center text-yellow-600">{b.maintenance}</TableCell>
                        <TableCell className="text-center">
                          <span className={`font-semibold ${b.occupancyRate >= 90 ? "text-green-600" : b.occupancyRate >= 70 ? "text-yellow-600" : "text-red-600"}`}>
                            {b.occupancyRate}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            Không có dữ liệu
          </div>
        )}
      </ReportLayout>
    </MainLayout>
  );
}
