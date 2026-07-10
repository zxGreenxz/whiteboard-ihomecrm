import { Building2, Home, DoorOpen, Wrench, TrendingUp } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useOccupancyReport, useOccupancyTrend } from "@/hooks/useReports";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { usePersistedState } from "@/hooks/usePersistedState";

const COLORS = {
  occupied: "#10B981",
  available: "#EF4444",
  maintenance: "#F59E0B",
  trend: "#3B82F6",
};

export default function OccupancyReport() {
  const [buildingId, setBuildingId] = usePersistedState<string | undefined>("flt:rpt-occupancy:buildingId", undefined);

  const { data: buildings } = useBuildings();
  const { data: occupancyData, isLoading } = useOccupancyReport(buildingId);
  const { data: trendData, isLoading: trendLoading } = useOccupancyTrend(buildingId);

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
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Tỉ lệ lấp đầy"
        description="Biểu đồ trend tỉ lệ lấp đầy theo tháng và thống kê theo toà nhà"
        icon={<TrendingUp className="h-8 w-8" />}
        actions={<ExportButtons data={exportData} filename="ty-le-lap-day-moi" />}
        stats={stats}
        filters={filters}
      >
        {isLoading || trendLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-[350px] w-full" />
            <Skeleton className="h-[300px] w-full" />
          </div>
        ) : (
          <>
            {/* Monthly Trend Line Chart */}
            {trendData && trendData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Trend tỷ lệ lấp đầy theo tháng</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={350}>
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis domain={[0, 100]} unit="%" />
                      <Tooltip formatter={(value: number) => [`${value}%`, "Tỷ lệ lấp đầy"]} />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="rate"
                        stroke={COLORS.trend}
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        activeDot={{ r: 6 }}
                        name="Tỷ lệ lấp đầy (%)"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Bar Chart by Building */}
            {occupancyData && occupancyData.byBuilding.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Tỷ lệ lấp đầy theo toà nhà</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={occupancyData.byBuilding}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="building" />
                      <YAxis domain={[0, 100]} unit="%" />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="occupancyRate" fill={COLORS.trend} name="Tỷ lệ lấp đầy (%)" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Detail Table */}
            {occupancyData && occupancyData.byBuilding.length > 0 ? (
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
          </>
        )}
      </ReportLayout>
    </MainLayout>
  );
}
