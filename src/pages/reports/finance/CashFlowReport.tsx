import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { TrendingUp, ArrowUpCircle, ArrowDownCircle, Activity } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useCashFlowReport } from "@/hooks/useReports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRange } from "react-day-picker";
import { startOfYear } from "date-fns";
import { BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart } from "recharts";

export default function CashFlowReport() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfYear(new Date()),
    to: new Date(),
  });

  const { data: cashFlow, isLoading } = useCashFlowReport(dateRange?.from, dateRange?.to);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const totalIncome = cashFlow?.reduce((sum, m) => sum + m.income, 0) || 0;
  const totalExpense = cashFlow?.reduce((sum, m) => sum + m.expense, 0) || 0;
  const avgNetFlow = cashFlow && cashFlow.length > 0
    ? (totalIncome - totalExpense) / cashFlow.length
    : 0;

  const stats = (
    <>
      <ReportCard
        title="Tổng thu"
        value={formatCurrency(totalIncome)}
        icon={ArrowUpCircle}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Tổng chi"
        value={formatCurrency(totalExpense)}
        icon={ArrowDownCircle}
        description="Trong kỳ báo cáo"
      />
      <ReportCard
        title="Dòng tiền ròng"
        value={formatCurrency(totalIncome - totalExpense)}
        icon={TrendingUp}
        description="Thu - Chi"
      />
      <ReportCard
        title="Trung bình/tháng"
        value={formatCurrency(avgNetFlow)}
        icon={Activity}
        description="Dòng tiền TB"
      />
    </>
  );

  const exportData = cashFlow?.map(item => ({
    "Tháng": item.month,
    "Thu": item.income,
    "Chi": item.expense,
    "Dòng tiền ròng": item.netFlow,
  })) || [];

  return (
    <MainLayout>
    <ReportLayout
      title="Báo cáo Dòng tiền"
      description="Phân tích dòng tiền vào/ra và xu hướng"
      icon={<TrendingUp className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-dong-tien"
        />
      }
      filters={
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      }
      stats={stats}
    >
      {isLoading ? (
        <Skeleton className="h-[400px] w-full" />
      ) : cashFlow && cashFlow.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Biểu đồ dòng tiền</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <ComposedChart data={cashFlow}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Legend />
                <Bar dataKey="income" fill="#10B981" name="Thu" />
                <Bar dataKey="expense" fill="#EF4444" name="Chi" />
                <Line type="monotone" dataKey="netFlow" stroke="#3B82F6" strokeWidth={2} name="Dòng tiền ròng" />
              </ComposedChart>
            </ResponsiveContainer>
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
