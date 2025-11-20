import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCashFlowByDay, useCashBookSummary } from "@/hooks/useCashBook";
import { formatCurrency } from "@/lib/utils";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";

const CashFlowPage = () => {
  // Default to current month
  const currentDate = new Date();
  const [dateRange, setDateRange] = useState({
    start: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).toISOString().split('T')[0],
    end: new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).toISOString().split('T')[0],
  });

  const { data: flowData = [], isLoading } = useCashFlowByDay(dateRange.start, dateRange.end);
  const { data: summary } = useCashBookSummary(dateRange.start, dateRange.end);

  // Calculate cumulative balance
  const cumulativeData = flowData.map((item, index) => {
    const prevBalance = index === 0 ? (summary?.openingBalance || 0) : cumulativeData[index - 1].balance;
    const balance = prevBalance + item.income - item.expense;
    return {
      ...item,
      balance,
      netFlow: item.income - item.expense,
    };
  });

  // Format date for display
  const chartData = cumulativeData.map((item) => ({
    ...item,
    date: new Date(item.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
  }));

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground">Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Dòng tiền (Cash Flow)</h1>
          <p className="text-muted-foreground mt-1">
            Phân tích thu chi và xu hướng dòng tiền
          </p>
        </div>
      </div>

      {/* Date Range Filter */}
      <div className="flex gap-4">
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">Từ ngày</label>
          <Input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            className="w-40"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">Đến ngày</label>
          <Input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            className="w-40"
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng thu
            </CardTitle>
            <TrendingUp className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(summary?.totalIncome || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng chi
            </CardTitle>
            <TrendingDown className="w-4 h-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {formatCurrency(summary?.totalExpense || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Dòng tiền thuần
            </CardTitle>
            <Activity className="w-4 h-4" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(summary?.netCashFlow || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatCurrency(summary?.netCashFlow || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Số dư cuối kỳ
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {formatCurrency(summary?.closingBalance || 0)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Income vs Expense Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Thu chi theo ngày</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis tickFormatter={(value) => formatCurrency(value)} />
              <Tooltip
                formatter={(value: number) => formatCurrency(value)}
                labelStyle={{ color: '#000' }}
              />
              <Legend />
              <Bar dataKey="income" name="Thu" fill="#22c55e" />
              <Bar dataKey="expense" name="Chi" fill="#ef4444" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Net Cash Flow Trend */}
      <Card>
        <CardHeader>
          <CardTitle>Xu hướng dòng tiền thuần</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis tickFormatter={(value) => formatCurrency(value)} />
              <Tooltip
                formatter={(value: number) => formatCurrency(value)}
                labelStyle={{ color: '#000' }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="netFlow"
                name="Dòng tiền thuần"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Cumulative Balance Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Số dư tích lũy theo ngày</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis tickFormatter={(value) => formatCurrency(value)} />
              <Tooltip
                formatter={(value: number) => formatCurrency(value)}
                labelStyle={{ color: '#000' }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="balance"
                name="Số dư"
                stroke="#3b82f6"
                strokeWidth={3}
                dot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Statistics Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Thống kê tổng quan</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Số ngày có giao dịch</p>
              <p className="text-2xl font-bold mt-1">{flowData.length} ngày</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Thu TB/ngày</p>
              <p className="text-2xl font-bold mt-1 text-green-600">
                {formatCurrency((summary?.totalIncome || 0) / (flowData.length || 1))}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Chi TB/ngày</p>
              <p className="text-2xl font-bold mt-1 text-red-600">
                {formatCurrency((summary?.totalExpense || 0) / (flowData.length || 1))}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tỷ lệ Thu/Chi</p>
              <p className="text-2xl font-bold mt-1">
                {summary?.totalExpense
                  ? ((summary.totalIncome / summary.totalExpense) * 100).toFixed(1)
                  : "0"}%
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default CashFlowPage;
