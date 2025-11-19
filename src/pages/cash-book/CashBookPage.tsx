import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  BookOpen,
  Calendar,
  TrendingUp,
  TrendingDown,
  Wallet,
  ArrowUpCircle,
  ArrowDownCircle,
  DollarSign,
} from 'lucide-react';
import { useCashBook } from '@/hooks/useCashBook';
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { vi } from 'date-fns/locale';

const CashBookPage = () => {
  const navigate = useNavigate();
  const [startDate, setStartDate] = useState(startOfMonth(new Date()).toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(endOfMonth(new Date()).toISOString().split('T')[0]);

  const { data: cashBookData, isLoading } = useCashBook({
    start_date: startDate,
    end_date: endDate,
  });

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
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

  const getTransactionIcon = (type: string) => {
    return type === 'INCOME' ? (
      <ArrowUpCircle className="h-5 w-5 text-green-600" />
    ) : (
      <ArrowDownCircle className="h-5 w-5 text-red-600" />
    );
  };

  const getPaymentMethodLabel = (method?: string) => {
    if (!method) return '-';
    const labels: Record<string, string> = {
      CASH: 'Tiền mặt',
      BANK_TRANSFER: 'Chuyển khoản',
      CARD: 'Thẻ',
      MOMO: 'MoMo',
      ZALO_PAY: 'ZaloPay',
      VNPAY: 'VNPay',
    };
    return labels[method] || method;
  };

  return (
    <MainLayout
      title="Sổ quỹ"
      subtitle="Theo dõi toàn bộ thu chi và số dư"
      icon={BookOpen}
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
        </div>
      </div>

      {/* Summary Cards */}
      {cashBookData && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-500">Số dư đầu kỳ</div>
                  <div className="text-xl font-bold mt-1">
                    {formatCurrency(cashBookData.summary.opening_balance)}
                  </div>
                </div>
                <Wallet className="h-8 w-8 text-gray-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-500">Tổng thu</div>
                  <div className="text-xl font-bold mt-1 text-green-600">
                    {formatCurrency(cashBookData.summary.total_income)}
                  </div>
                </div>
                <TrendingUp className="h-8 w-8 text-green-600" />
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {cashBookData.transactions.filter((t) => t.type === 'INCOME').length} giao dịch
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-500">Tổng chi</div>
                  <div className="text-xl font-bold mt-1 text-red-600">
                    {formatCurrency(cashBookData.summary.total_expense)}
                  </div>
                </div>
                <TrendingDown className="h-8 w-8 text-red-600" />
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {cashBookData.transactions.filter((t) => t.type === 'EXPENSE').length} giao dịch
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-blue-600">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-blue-600 font-medium">Số dư cuối kỳ</div>
                  <div className="text-2xl font-bold mt-1 text-blue-600">
                    {formatCurrency(cashBookData.summary.closing_balance)}
                  </div>
                </div>
                <DollarSign className="h-8 w-8 text-blue-600" />
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Lãi/lỗ: {formatCurrency(cashBookData.summary.total_income - cashBookData.summary.total_expense)}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Transactions Table */}
      <div className="bg-white rounded-lg border">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Đang tải dữ liệu...</div>
        ) : !cashBookData || cashBookData.transactions.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            Không có giao dịch nào trong khoảng thời gian này.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ngày</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead>Danh mục</TableHead>
                <TableHead>Phương thức</TableHead>
                <TableHead className="text-right">Thu</TableHead>
                <TableHead className="text-right">Chi</TableHead>
                <TableHead className="text-right">Số dư</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Opening Balance Row */}
              <TableRow className="bg-gray-50 font-medium">
                <TableCell colSpan={7}>
                  <div className="flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-gray-600" />
                    Số dư đầu kỳ ({format(new Date(startDate), 'dd/MM/yyyy', { locale: vi })})
                  </div>
                </TableCell>
                <TableCell className="text-right font-bold">
                  {formatCurrency(cashBookData.summary.opening_balance)}
                </TableCell>
              </TableRow>

              {/* Transaction Rows */}
              {cashBookData.transactions.map((transaction) => (
                <TableRow key={transaction.id} className="hover:bg-gray-50">
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {format(new Date(transaction.date), 'dd/MM/yyyy', { locale: vi })}
                      </span>
                      <span className="text-xs text-gray-500">
                        {format(new Date(transaction.date), 'EEEE', { locale: vi })}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {getTransactionIcon(transaction.type)}
                      <Badge variant={transaction.type === 'INCOME' ? 'default' : 'destructive'}>
                        {transaction.type === 'INCOME' ? 'Thu' : 'Chi'}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-md">
                      <div className="font-medium">{transaction.description}</div>
                      {transaction.related_to && transaction.related_to.type === 'INVOICE' && (
                        <div
                          className="text-xs text-blue-600 hover:underline cursor-pointer"
                          onClick={() => navigate(`/invoices/${transaction.related_to!.id}`)}
                        >
                          Xem hóa đơn →
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-gray-600">{transaction.category}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">
                      {getPaymentMethodLabel(transaction.payment_method)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {transaction.type === 'INCOME' && (
                      <span className="font-bold text-green-600">
                        +{formatCurrency(transaction.amount)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {transaction.type === 'EXPENSE' && (
                      <span className="font-bold text-red-600">
                        -{formatCurrency(transaction.amount)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-bold">{formatCurrency(transaction.balance || 0)}</span>
                  </TableCell>
                </TableRow>
              ))}

              {/* Closing Balance Row */}
              <TableRow className="bg-blue-50 font-bold border-t-2 border-blue-600">
                <TableCell colSpan={5}>
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-blue-600" />
                    Số dư cuối kỳ ({format(new Date(endDate), 'dd/MM/yyyy', { locale: vi })})
                  </div>
                </TableCell>
                <TableCell className="text-right text-green-600">
                  {formatCurrency(cashBookData.summary.total_income)}
                </TableCell>
                <TableCell className="text-right text-red-600">
                  {formatCurrency(cashBookData.summary.total_expense)}
                </TableCell>
                <TableCell className="text-right text-blue-600 text-lg">
                  {formatCurrency(cashBookData.summary.closing_balance)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </div>

      {/* Info Note */}
      {cashBookData && cashBookData.summary.total_expense === 0 && (
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md text-sm text-yellow-800">
          <strong>Lưu ý:</strong> Hiện tại chỉ ghi nhận các khoản thu từ thanh toán.
          Tính năng quản lý chi phí sẽ được bổ sung trong các phase tiếp theo.
        </div>
      )}
    </MainLayout>
  );
};

export default CashBookPage;
