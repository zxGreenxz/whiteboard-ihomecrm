import { useState } from "react";
import { Plus, Search, FileText, DollarSign } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePayments, usePaymentsSummary } from "@/hooks/usePayments";
import { CollectPaymentDialog } from "@/components/payments/CollectPaymentDialog";
import { PaymentReceiptDialog } from "@/components/payments/PaymentReceiptDialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { PaymentWithRelations } from "@/hooks/usePayments";

const PAYMENT_METHODS = {
  CASH: { label: "Tiền mặt", color: "bg-green-100 text-green-800" },
  BANK_TRANSFER: { label: "Chuyển khoản", color: "bg-blue-100 text-blue-800" },
  MOMO: { label: "MoMo", color: "bg-pink-100 text-pink-800" },
  ZALO_PAY: { label: "ZaloPay", color: "bg-purple-100 text-purple-800" },
  CREDIT_CARD: { label: "Thẻ tín dụng", color: "bg-yellow-100 text-yellow-800" },
  OTHER: { label: "Khác", color: "bg-gray-100 text-gray-800" },
};

const PaymentsPage = () => {
  const [collectDialogOpen, setCollectDialogOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<PaymentWithRelations | null>(null);
  const [methodFilter, setMethodFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  const { data: payments = [], isLoading } = usePayments({
    start_date: dateRange.start,
    end_date: dateRange.end,
    payment_method: methodFilter || undefined,
  });

  const { data: summary } = usePaymentsSummary(dateRange.start, dateRange.end);

  const handleViewReceipt = (payment: PaymentWithRelations) => {
    setSelectedPayment(payment);
    setReceiptDialogOpen(true);
  };

  const filteredPayments = payments.filter((payment) => {
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      payment.invoice?.contract?.tenant?.full_name?.toLowerCase().includes(search) ||
      payment.invoice?.invoice_number?.toLowerCase().includes(search) ||
      payment.receipt_number?.toLowerCase().includes(search)
    );
  });

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
    <MainLayout
      title="Quản lý Thu tiền"
      subtitle="Ghi nhận các khoản thu từ khách thuê"
      icon={DollarSign}
    >
      {/* Action Button */}
      <div className="flex justify-end mb-6">
        <Button onClick={() => setCollectDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Thu tiền
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng thu
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(summary?.total || 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {summary?.count || 0} giao dịch
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tiền mặt
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(summary?.byMethod?.CASH || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Chuyển khoản
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(summary?.byMethod?.BANK_TRANSFER || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Khác
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(
                (summary?.byMethod?.MOMO || 0) +
                (summary?.byMethod?.ZALO_PAY || 0) +
                (summary?.byMethod?.CREDIT_CARD || 0) +
                (summary?.byMethod?.OTHER || 0)
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Tìm kiếm theo khách thuê, số phiếu thu..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Input
          type="date"
          value={dateRange.start}
          onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
          className="w-40"
        />
        <Input
          type="date"
          value={dateRange.end}
          onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
          className="w-40"
        />

        <Select value={methodFilter} onValueChange={setMethodFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Phương thức" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả</SelectItem>
            {Object.entries(PAYMENT_METHODS).map(([key, config]) => (
              <SelectItem key={key} value={key}>
                {config.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ngày thu</TableHead>
              <TableHead>Số phiếu thu</TableHead>
              <TableHead>Khách hàng</TableHead>
              <TableHead>Hóa đơn</TableHead>
              <TableHead>Số tiền</TableHead>
              <TableHead>Phương thức</TableHead>
              <TableHead>Ghi chú</TableHead>
              <TableHead>Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPayments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Không tìm thấy giao dịch nào
                </TableCell>
              </TableRow>
            ) : (
              filteredPayments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>
                    {payment.payment_date ? formatDate(payment.payment_date) : "-"}
                  </TableCell>
                  <TableCell className="font-mono">
                    {payment.receipt_number || "-"}
                  </TableCell>
                  <TableCell className="font-medium">
                    {payment.invoice?.contract?.tenant?.full_name || "-"}
                  </TableCell>
                  <TableCell className="font-mono">
                    {payment.invoice?.invoice_number || "-"}
                  </TableCell>
                  <TableCell className="font-semibold text-green-600">
                    {formatCurrency(payment.amount)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        PAYMENT_METHODS[payment.payment_method as keyof typeof PAYMENT_METHODS]?.color || ""
                      }
                    >
                      {PAYMENT_METHODS[payment.payment_method as keyof typeof PAYMENT_METHODS]?.label ||
                        payment.payment_method}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {payment.notes || "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleViewReceipt(payment)}
                    >
                      <FileText className="w-3 h-3 mr-1" />
                      Phiếu thu
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Dialogs */}
      <CollectPaymentDialog
        open={collectDialogOpen}
        onOpenChange={setCollectDialogOpen}
      />

      {selectedPayment && (
        <PaymentReceiptDialog
          open={receiptDialogOpen}
          onOpenChange={setReceiptDialogOpen}
          payment={selectedPayment}
        />
      )}
    </MainLayout>
  );
};

export default PaymentsPage;
