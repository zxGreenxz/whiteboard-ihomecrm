import { Building2, Home, DoorOpen, Wrench, TrendingUp } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useOccupancyReport } from "@/hooks/useReports";
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
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

const COLORS = {
  occupied: "#10B981",
  available: "#EF4444",
  maintenance: "#F59E0B",
};

export default function OccupancyReport() {
  const { data: occupancyData, isLoading } = useOccupancyReport();

  const stats = occupancyData && (
    <>
      <ReportCard
        title="Tổng số phòng"
        value={occupancyData.summary.total}
        icon={Building2}
        description="Tổng phòng quản lý"
      />
      <ReportCard
        title="Đang cho thuê"
        value={occupancyData.summary.occupied}
        icon={Home}
        description={`${occupancyData.summary.occupancyRate}% tỷ lệ lấp đầy`}
      />
      <ReportCard
        title="Phòng trống"
        value={occupancyData.summary.available}
        icon={DoorOpen}
        description="Sẵn sàng cho thuê"
      />
      <ReportCard
        title="Bảo dưỡng"
        value={occupancyData.summary.maintenance}
        icon={Wrench}
        description="Đang sửa chữa"
      />
    </>
  );

  const pieData = occupancyData ? [
    { name: "Đang thuê", value: occupancyData.summary.occupied, color: COLORS.occupied },
    { name: "Trống", value: occupancyData.summary.available, color: COLORS.available },
    { name: "Bảo dưỡng", value: occupancyData.summary.maintenance, color: COLORS.maintenance },
  ] : [];

  const exportData = occupancyData?.byBuilding.map(building => ({
    "Tòa nhà": building.building,
    "Tổng phòng": building.total,
    "Đang thuê": building.occupied,
    "Phòng trống": building.available,
    "Bảo dưỡng": building.maintenance,
    "Tỷ lệ lấp đầy (%)": building.occupancyRate,
  })) || [];

  return (
    <ReportLayout
      title="Báo cáo Tỷ lệ lấp đầy"
      description="Thống kê tỷ lệ lấp đầy và phân tích theo tòa nhà"
      icon={<TrendingUp className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-ty-le-lap-day"
        />
      }
      stats={stats}
    >
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[400px] w-full" />
          <Skeleton className="h-[300px] w-full" />
        </div>
      ) : occupancyData ? (
        <>
          {/* Charts */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Pie Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Phân bố trạng thái phòng</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={(entry) => `${entry.name}: ${entry.value} (${((entry.value / occupancyData.summary.total) * 100).toFixed(1)}%)`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Bar Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Tỷ lệ lấp đầy theo tòa nhà</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={occupancyData.byBuilding}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="building" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="occupancyRate" fill="#3B82F6" name="Tỷ lệ lấp đầy (%)" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Table by Building */}
          <Card>
            <CardHeader>
              <CardTitle>Chi tiết theo tòa nhà</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tòa nhà</TableHead>
                      <TableHead className="text-center">Tổng phòng</TableHead>
                      <TableHead className="text-center">Đang thuê</TableHead>
                      <TableHead className="text-center">Phòng trống</TableHead>
                      <TableHead className="text-center">Bảo dưỡng</TableHead>
                      <TableHead className="text-center">Tỷ lệ lấp đầy</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {occupancyData.byBuilding.map((building, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-medium">{building.building}</TableCell>
                        <TableCell className="text-center">{building.total}</TableCell>
                        <TableCell className="text-center text-green-600 font-semibold">
                          {building.occupied}
                        </TableCell>
                        <TableCell className="text-center text-red-600">
                          {building.available}
                        </TableCell>
                        <TableCell className="text-center text-yellow-600">
                          {building.maintenance}
                        </TableCell>
                        <TableCell className="text-center">
                          <span className={`font-semibold ${
                            building.occupancyRate >= 90
                              ? "text-green-600"
                              : building.occupancyRate >= 70
                              ? "text-yellow-600"
                              : "text-red-600"
                          }`}>
                            {building.occupancyRate}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          Không có dữ liệu
        </div>
      )}
    </ReportLayout>
  );
}
