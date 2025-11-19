import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  TooltipProps,
} from 'recharts';
import {
  TrendingUp,
  Calendar,
  DollarSign,
  ArrowUpCircle,
  ArrowDownCircle,
  Activity,
} from 'lucide-react';
import { useCashFlow } from '@/hooks/useCashBook';
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { vi } from 'date-fns/locale';

const CashFlowPage = () => {
  const [startDate, setStartDate] = useState(startOfMonth(new Date()).toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(endOfMonth(new Date()).toISOString().split('T')[0]);
  const [chartType, setChartType] = useState<'bar' | 'line'>('bar');

  const { data: cashFlowData, isLoading } = useCashFlow({
    start_date: startDate,
    end_date: endDate,
  });

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const formatShortCurrency = (amount: number) => {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(1)}M`;
    } else if (amount >= 1000) {
      return `${(amount / 1000).toFixed(0)}K`;
    }
    return amount.toString();
  };

  const handleSetCurrentMonth = () => {
    setStartDate(startOfMonth(new Date()).toISOString().split('T')[0]);
    setEndDate(endOfMonth(new Date()).toISOString().split('T')[0]);
  };

  const handleSetLastMonth = () => {
    const lastMonth = subMonths(new Date(), 1);
    setStartDate(startOfMonth(lastMonth).toISOString().split('T')[0]);
    setEndDate(endOfMonth(lastMonth).toISOString().split('T')[0]);
  };

  const handleSet3Months = () => {
    const threeMonthsAgo = subMonths(new Date(), 3);
    setStartDate(startOfMonth(threeMonthsAgo).toISOString().split('T')[0]);
    setEndDate(endOfMonth(new Date()).toISOString().split('T')[0]);
  };

  // Prepare chart data
  const chartData = cashFlowData?.map((item) => ({
    date: format(new Date(item.date), 'dd/MM', { locale: vi }),
    fullDate: format(new Date(item.date), 'dd/MM/yyyy', { locale: vi }),
    income: item.income,
    expense: item.expense,
    net: item.net,
  })) || [];

  // Calculate summary
  const totalIncome = cashFlowData?.reduce((sum, item) => sum + item.income, 0) || 0;
  const totalExpense = cashFlowData?.reduce((sum, item) => sum + item.expense, 0) || 0;
  const netCashFlow = totalIncome - totalExpense;
  const avgDailyIncome = cashFlowData && cashFlowData.length > 0 ? totalIncome / cashFlowData.length : 0;
  const avgDailyExpense = cashFlowData && cashFlowData.length > 0 ? totalExpense / cashFlowData.length : 0;

  // Custom tooltip for charts
  const CustomTooltip = ({ active, payload }: TooltipProps<number, string>) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white p-3 border border-gray-200 rounded-md shadow-lg">
          <p className="font-medium text-sm mb-2">{payload[0].payload.fullDate}</p>
          {payload.map((entry, index) => (
            <p
              key={index}
              className="text-sm"
              style={{ color: entry.color }}
            >
              <span className="font-medium">{entry.name}:</span>{' '}
              {formatCurrency(entry.value as number)}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <MainLayout
      title="Báo cáo Dòng tiền"
      subtitle="Phân tích thu chi theo thời gian"
      icon={TrendingUp}
    >
      {/* Date Range Filter */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex gap-2 items-center flex-1">
          <Calendar className="h-4 w-4 text-gray-400" />
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-40"
          />
          <span className="text-gray-400">→</span>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-40"
          />
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleSetLastMonth}>
            Tháng trước
          </Button>
          <Button variant="outline" size="sm" onClick={handleSetCurrentMonth}>
            Tháng này
          </Button>
          <Button variant="outline" size="sm" onClick={handleSet3Months}>
            3 tháng
          </Button>
        </div>

        <Select value={chartType} onValueChange={(value: any) => setChartType(value)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bar">Biểu đồ cột</SelectItem>
            <SelectItem value="line">Biểu đồ đường</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-500">Tổng thu</div>
                <div className="text-xl font-bold mt-1 text-green-600">
                  {formatCurrency(totalIncome)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  TB: {formatCurrency(avgDailyIncome)}/ngày
                </div>
              </div>
              <ArrowUpCircle className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-500">Tổng chi</div>
                <div className="text-xl font-bold mt-1 text-red-600">
                  {formatCurrency(totalExpense)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  TB: {formatCurrency(avgDailyExpense)}/ngày
                </div>
              </div>
              <ArrowDownCircle className="h-8 w-8 text-red-600" />
            </div>
          </CardContent>
        </Card>

        <Card className={netCashFlow >= 0 ? 'border-2 border-green-600' : 'border-2 border-red-600'}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className={`text-sm font-medium ${netCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  Dòng tiền ròng
                </div>
                <div className={`text-2xl font-bold mt-1 ${netCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(netCashFlow)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {netCashFlow >= 0 ? 'Lãi' : 'Lỗ'}
                </div>
              </div>
              <DollarSign className={`h-8 w-8 ${netCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-500">Số ngày</div>
                <div className="text-2xl font-bold mt-1">
                  {cashFlowData?.length || 0}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {cashFlowData?.filter(d => d.income > 0 || d.expense > 0).length || 0} ngày có GD
                </div>
              </div>
              <Activity className="h-8 w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Biểu đồ dòng tiền theo ngày
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="p-8 text-center text-gray-500">Đang tải dữ liệu...</div>
          ) : !chartData || chartData.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              Không có dữ liệu trong khoảng thời gian này.
            </div>
          ) : (
            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                {chartType === 'bar' ? (
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 12 }}
                      angle={-45}
                      textAnchor="end"
                      height={80}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      tickFormatter={formatShortCurrency}
                      label={{ value: 'VNĐ', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={CustomTooltip} />
                    <Legend />
                    <Bar dataKey="income" name="Thu" fill="#16a34a" />
                    <Bar dataKey="expense" name="Chi" fill="#dc2626" />
                  </BarChart>
                ) : (
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 12 }}
                      angle={-45}
                      textAnchor="end"
                      height={80}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      tickFormatter={formatShortCurrency}
                      label={{ value: 'VNĐ', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={CustomTooltip} />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="income"
                      name="Thu"
                      stroke="#16a34a"
                      strokeWidth={2}
                      dot={{ r: 4 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="expense"
                      name="Chi"
                      stroke="#dc2626"
                      strokeWidth={2}
                      dot={{ r: 4 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="net"
                      name="Ròng"
                      stroke="#2563eb"
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      strokeDasharray="5 5"
                    />
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Daily Breakdown Table */}
      {chartData && chartData.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Chi tiết theo ngày</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-4 font-medium">Ngày</th>
                    <th className="text-right py-2 px-4 font-medium text-green-600">Thu</th>
                    <th className="text-right py-2 px-4 font-medium text-red-600">Chi</th>
                    <th className="text-right py-2 px-4 font-medium text-blue-600">Ròng</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.map((item, index) => (
                    <tr key={index} className="border-b hover:bg-gray-50">
                      <td className="py-2 px-4">{item.fullDate}</td>
                      <td className="py-2 px-4 text-right text-green-600 font-medium">
                        {item.income > 0 ? formatCurrency(item.income) : '-'}
                      </td>
                      <td className="py-2 px-4 text-right text-red-600 font-medium">
                        {item.expense > 0 ? formatCurrency(item.expense) : '-'}
                      </td>
                      <td className={`py-2 px-4 text-right font-bold ${item.net >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                        {formatCurrency(item.net)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-bold">
                    <td className="py-3 px-4">Tổng cộng</td>
                    <td className="py-3 px-4 text-right text-green-600">{formatCurrency(totalIncome)}</td>
                    <td className="py-3 px-4 text-right text-red-600">{formatCurrency(totalExpense)}</td>
                    <td className={`py-3 px-4 text-right text-lg ${netCashFlow >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                      {formatCurrency(netCashFlow)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Info Note */}
      {totalExpense === 0 && (
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md text-sm text-yellow-800">
          <strong>Lưu ý:</strong> Hiện tại chỉ ghi nhận các khoản thu từ thanh toán.
          Tính năng quản lý chi phí sẽ được bổ sung trong các phase tiếp theo.
        </div>
      )}
    </MainLayout>
  );
};

export default CashFlowPage;
