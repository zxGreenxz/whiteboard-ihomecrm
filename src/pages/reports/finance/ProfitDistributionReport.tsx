import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { PieChart as PieChartIcon, TrendingUp, DollarSign, Percent } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useProfitDistributionReport } from "@/hooks/useReports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRange } from "react-day-picker";
import { startOfMonth } from "date-fns";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts";

const COLORS = ["#10B981", "#3B82F6", "#F59E0B", "#EF4444"];

export default function ProfitDistributionReport() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: new Date(),
  });

  const { data: profitData, isLoading } = useProfitDistributionReport(dateRange?.from, dateRange?.to);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const pieData = profitData ? [
    { name: "Tiền thuê", value: profitData.breakdown.rent, color: COLORS[0] },
    { name: "Dịch vụ", value: profitData.breakdown.services, color: COLORS[1] },
    { name: "Khác", value: profitData.breakdown.other, color: COLORS[2] },
  ].filter(item => item.value > 0) : [];

  const stats = profitData && (
    <>
      <ReportCard
        title="Tổng doanh thu"
        value={formatCurrency(profitData.totalRevenue)}
        icon={DollarSign}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Tổng chi phí"
        value={formatCurrency(profitData.totalExpenses)}
        icon={TrendingUp}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Lợi nhuận ròng"
        value={formatCurrency(profitData.netProfit)}
        icon={PieChartIcon}
        description="Doanh thu - Chi phí"
      />
      <ReportCard
        title="Biên lợi nhuận"
        value={`${profitData.profitMargin.toFixed(1)}%`}
        icon={Percent}
        description="Profit margin"
      />
    </>
  );

  const exportData = pieData.map(item => ({
    "Loại": item.name,
    "Giá trị": item.value,
    "Tỷ lệ %": ((item.value / profitData!.totalRevenue) * 100).toFixed(2),
  }));

  return (
    <MainLayout>
    <ReportLayout
      title="Báo cáo Phân bổ lợi nhuận"
      description="Phân tích cấu trúc doanh thu và lợi nhuận"
      icon={<PieChartIcon className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-phan-bo-loi-nhuan"
        />
      }
      filters={
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      }
      stats={stats}
    >
      {isLoading ? (
        <Skeleton className="h-[400px] w-full" />
      ) : profitData ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Cấu trúc doanh thu</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={(entry) => `${entry.name}: ${((entry.value / profitData.totalRevenue) * 100).toFixed(1)}%`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Thống kê tài chính</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Tổng doanh thu:</span>
                <span className="font-semibold text-lg">{formatCurrency(profitData.totalRevenue)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Tổng chi phí:</span>
                <span className="font-semibold text-lg">{formatCurrency(profitData.totalExpenses)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between items-center">
                <span className="font-semibold">Lợi nhuận ròng:</span>
                <span className="font-bold text-xl text-green-600">{formatCurrency(profitData.netProfit)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Biên lợi nhuận:</span>
                <span className="font-semibold text-lg">{profitData.profitMargin.toFixed(1)}%</span>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          Không có dữ liệu
        </div>
      )}
    </ReportLayout>
    </MainLayout>
  );
}
