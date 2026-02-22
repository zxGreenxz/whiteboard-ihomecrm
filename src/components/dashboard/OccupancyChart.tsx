import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts";
import { useOccupancyChart } from "@/hooks/useDashboard";

const COLORS = ["#10b981", "#ef4444"];

export function OccupancyChart({ buildingId }: { buildingId?: string | null }) {
  const { data: occupancyData = [], isLoading } = useOccupancyChart(buildingId);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tỷ lệ lấp đầy</CardTitle>
          <CardDescription>Phân bố căn hộ trống/đã thuê</CardDescription>
        </CardHeader>
        <CardContent className="h-[300px] flex items-center justify-center">
          <p className="text-muted-foreground">Đang tải...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tỷ lệ lấp đầy</CardTitle>
        <CardDescription>Phân bố căn hộ trống/đã thuê</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={occupancyData}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ status, percentage }) => `${status}: ${percentage.toFixed(1)}%`}
              outerRadius={80}
              fill="#8884d8"
              dataKey="count"
            >
              {occupancyData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value: number) => `${value} căn hộ`} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
