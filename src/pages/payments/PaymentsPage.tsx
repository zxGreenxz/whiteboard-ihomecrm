import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  DollarSign,
  Plus,
  Search,
  MoreVertical,
  Receipt,
  Trash2,
  Calendar,
  TrendingUp,
  Wallet,
  CreditCard,
} from 'lucide-react';
import { usePayments, usePaymentStats, useDeletePayment, type PaymentWithRelations } from '@/hooks/usePayments';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { vi } from 'date-fns/locale';
import CollectPaymentDialog from '@/components/payments/CollectPaymentDialog';
import PaymentReceiptDialog from '@/components/payments/PaymentReceiptDialog';

const PaymentsPage = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [startDate, setStartDate] = useState(startOfMonth(new Date()).toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(endOfMonth(new Date()).toISOString().split('T')[0]);
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<string>('');
  const [selectedPayment, setSelectedPayment] = useState<PaymentWithRelations | null>(null);

  // Dialog states
  const [collectDialogOpen, setCollectDialogOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);

  const { data: payments, isLoading } = usePayments({
    start_date: startDate,
    end_date: endDate,
    payment_method: paymentMethodFilter || undefined,
  });

  const { data: stats } = usePaymentStats({
    start_date: startDate,
    end_date: endDate,
  });

  const deleteMutation = useDeletePayment();

  // Filter payments based on search term
  const filteredPayments = payments?.filter((payment) => {
    const searchLower = searchTerm.toLowerCase();
    return (
      payment.invoice?.title?.toLowerCase().includes(searchLower) ||
      payment.invoice?.contract?.contract_number?.toLowerCase().includes(searchLower) ||
      payment.invoice?.contract?.tenant?.full_name.toLowerCase().includes(searchLower) ||
      payment.invoice?.contract?.tenant?.phone.includes(searchTerm) ||
      payment.notes?.toLowerCase().includes(searchLower)
    );
  });

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getPaymentMethodBadge = (method: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'outline'; label: string; icon: any }> = {
      CASH: { variant: 'default', label: 'Tiền mặt', icon: Wallet },
      BANK_TRANSFER: { variant: 'secondary', label: 'Chuyển khoản', icon: TrendingUp },
      CARD: { variant: 'outline', label: 'Thẻ', icon: CreditCard },
      MOMO: { variant: 'secondary', label: 'MoMo', icon: Wallet },
      ZALO_PAY: { variant: 'secondary', label: 'ZaloPay', icon: Wallet },
      VNPAY: { variant: 'secondary', label: 'VNPay', icon: Wallet },
    };

    const methodConfig = config[method] || { variant: 'outline' as const, label: method, icon: Wallet };
    const Icon = methodConfig.icon;

    return (
      <Badge variant={methodConfig.variant} className="flex items-center gap-1 w-fit">
        <Icon className="h-3 w-3" />
        {methodConfig.label}
      </Badge>
    );
  };

  const handleDeletePayment = (paymentId: string) => {
    if (confirm('Xác nhận xóa thanh toán này? Số tiền sẽ được trừ khỏi hóa đơn.')) {
      deleteMutation.mutate(paymentId);
    }
  };

  const handlePrintReceipt = (payment: PaymentWithRelations) => {
    setSelectedPayment(payment);
    setReceiptDialogOpen(true);
  };

  const handleSetCurrentMonth = () => {
    setStartDate(startOfMonth(new Date()).toISOString().split('T')[0]);
    setEndDate(endOfMonth(new Date()).toISOString().split('T')[0]);
  };

  return (
    <MainLayout
      title="Quản lý Thu chi"
      subtitle="Ghi nhận và theo dõi các khoản thu"
      icon={DollarSign}
    >
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Tìm theo khách, hóa đơn, ghi chú..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex gap-2">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-gray-400" />
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-40"
            />
          </div>
          <span className="text-gray-400 flex items-center">→</span>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-40"
          />
          <Button variant="outline" size="sm" onClick={handleSetCurrentMonth}>
            Tháng này
          </Button>
        </div>

        <select
          value={paymentMethodFilter}
          onChange={(e) => setPaymentMethodFilter(e.target.value)}
          className="px-4 py-2 border rounded-md bg-white"
        >
          <option value="">Tất cả phương thức</option>
          <option value="CASH">Tiền mặt</option>
          <option value="BANK_TRANSFER">Chuyển khoản</option>
          <option value="CARD">Thẻ</option>
          <option value="MOMO">MoMo</option>
          <option value="ZALO_PAY">ZaloPay</option>
          <option value="VNPAY">VNPay</option>
        </select>

        <Button onClick={() => setCollectDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Thu tiền
        </Button>
      </div>

      {/* Statistics Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-500">Tổng số phiếu</div>
                  <div className="text-2xl font-bold mt-1">{stats.total_count}</div>
                </div>
                <Receipt className="h-8 w-8 text-blue-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-500">Tổng thu</div>
                  <div className="text-xl font-bold mt-1 text-green-600">
                    {formatCurrency(stats.total_amount)}
                  </div>
                </div>
                <DollarSign className="h-8 w-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          {stats.by_method.slice(0, 2).map((method) => (
            <Card key={method.method}>
              <CardContent className="p-4">
                <div className="text-sm text-gray-500 mb-1">{method.method}</div>
                <div className="text-lg font-bold text-blue-600">
                  {formatCurrency(method.amount)}
                </div>
                <div className="text-xs text-gray-500 mt-1">{method.count} giao dịch</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-lg border">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">
            Đang tải dữ liệu...
          </div>
        ) : !filteredPayments || filteredPayments.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {searchTerm || paymentMethodFilter
              ? 'Không tìm thấy thanh toán nào phù hợp'
              : 'Chưa có thanh toán nào trong khoảng thời gian này.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ngày thu</TableHead>
                <TableHead>Mã phiếu</TableHead>
                <TableHead>Khách hàng</TableHead>
                <TableHead>Hóa đơn</TableHead>
                <TableHead>Phòng</TableHead>
                <TableHead className="text-right">Số tiền</TableHead>
                <TableHead>Phương thức</TableHead>
                <TableHead>Ghi chú</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPayments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {format(new Date(payment.payment_date), 'dd/MM/yyyy', { locale: vi })}
                      </span>
                      <span className="text-xs text-gray-500">
                        {format(new Date(payment.created_at), 'HH:mm', { locale: vi })}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                      {payment.id.slice(0, 8).toUpperCase()}
                    </code>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {payment.invoice?.contract?.tenant?.full_name || 'N/A'}
                      </span>
                      <span className="text-xs text-gray-500">
                        {payment.invoice?.contract?.tenant?.phone}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div
                      className="text-sm text-blue-600 hover:underline cursor-pointer"
                      onClick={() => navigate(`/invoices/${payment.invoice_id}`)}
                    >
                      {payment.invoice?.title || payment.invoice_id.slice(0, 8)}
                    </div>
                  </TableCell>
                  <TableCell>
                    {payment.invoice?.contract?.room?.name ||
                     payment.invoice?.contract?.bed?.name ||
                     'N/A'}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-bold text-green-600">
                      {formatCurrency(payment.amount)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {getPaymentMethodBadge(payment.payment_method)}
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[200px] truncate text-sm text-gray-500">
                      {payment.notes || '-'}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Thao tác</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handlePrintReceipt(payment)}>
                          <Receipt className="h-4 w-4 mr-2" />
                          In phiếu thu
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => navigate(`/invoices/${payment.invoice_id}`)}
                        >
                          <DollarSign className="h-4 w-4 mr-2" />
                          Xem hóa đơn
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleDeletePayment(payment.id)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Xóa thanh toán
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Dialogs */}
      <CollectPaymentDialog
        open={collectDialogOpen}
        onOpenChange={setCollectDialogOpen}
      />

      <PaymentReceiptDialog
        open={receiptDialogOpen}
        onOpenChange={setReceiptDialogOpen}
        payment={selectedPayment}
      />
    </MainLayout>
  );
};

export default PaymentsPage;
