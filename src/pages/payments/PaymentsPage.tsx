import { useState } from "react";
import { Plus, Search, FileText, DollarSign, Download, ArrowUpCircle, ArrowDownCircle } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
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
import ExportExcelDialog from "@/components/import-export/ExportExcelDialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { PaymentWithRelations } from "@/hooks/usePayments";

const PAYMENT_METHODS: Record<string, { label: string; color: string }> = {
  TM: { label: "TM", color: "bg-zinc-100 text-zinc-800" },
  TK: { label: "TK", color: "bg-zinc-100 text-zinc-800" },
  TT: { label: "TT", color: "bg-zinc-100 text-zinc-800" },
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Chờ duyệt", color: "bg-yellow-100 text-yellow-800" },
  APPROVED: { label: "Đã duyệt", color: "bg-green-100 text-green-800" },
  REJECTED: { label: "Từ chối", color: "bg-red-100 text-red-800" },
};

const PaymentsPage = () => {
  const [collectDialogOpen, setCollectDialogOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<PaymentWithRelations | null>(null);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogType, setDialogType] = useState<"income" | "expense">("income");
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  const { data: payments = [], isLoading } = usePayments({
    start_date: dateRange.start,
    end_date: dateRange.end,
    payment_method: methodFilter !== "ALL" ? methodFilter : undefined,
  });

  const { data: summary } = usePaymentsSummary(dateRange.start, dateRange.end);

  const handleViewReceipt = (payment: PaymentWithRelations) => {
    setSelectedPayment(payment);
    setReceiptDialogOpen(true);
  };

  const handleCreateIncome = () => {
    setDialogType("income");
    setCollectDialogOpen(true);
  };

  const handleCreateExpense = () => {
    setDialogType("expense");
    setCollectDialogOpen(true);
  };

  const filteredPayments = payments.filter((payment) => {
    // Filter by type (income/expense)
    if (typeFilter !== "ALL") {
      const paymentType = (payment as any).type || "income";
      if (paymentType !== typeFilter) return false;
    }

    // Filter by status
    if (statusFilter !== "ALL") {
      const paymentStatus = (payment as any).status || "APPROVED";
      if (paymentStatus !== statusFilter) return false;
    }

    // Filter by search query
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      payment.invoice?.contract?.tenant?.full_name?.toLowerCase().includes(search) ||
      payment.invoice?.invoice_number?.toLowerCase().includes(search) ||
      payment.receipt_number?.toLowerCase().includes(search) ||
      payment.notes?.toLowerCase().includes(search)
    );
  });

  // Calculate income/expense totals
  const incomeTotal = payments
    .filter((p) => ((p as any).type || "income") === "income")
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const expenseTotal = payments
    .filter((p) => (p as any).type === "expense")
    .reduce((sum, p) => sum + (p.amount || 0), 0);

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
      title="Quản lý Thu chi"
      subtitle="Ghi nhận các khoản thu chi trong hệ thống"
      icon={DollarSign}
    >
      {/* Action Buttons */}
      <div className="flex justify-end gap-2 mb-6">
        <Button variant="outline" onClick={() => setExportDialogOpen(true)}>
          <Download className="w-4 h-4 mr-2" />
          Xuất Excel
        </Button>
        <Button variant="outline" onClick={handleCreateExpense}>
          <ArrowDownCircle className="w-4 h-4 mr-2" />
          Tạo phiếu chi
        </Button>
        <Button onClick={handleCreateIncome}>
          <ArrowUpCircle className="w-4 h-4 mr-2" />
          Tạo phiếu thu
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
              {formatCurrency(incomeTotal || summary?.total || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng chi
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {formatCurrency(expenseTotal)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Chênh lệch
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(incomeTotal - expenseTotal) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatCurrency(incomeTotal - expenseTotal)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng giao dịch
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {summary?.count || payments.length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              giao dịch trong kỳ
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Tìm kiếm theo khách hàng, số phiếu, ghi chú..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <DateInput
          value={dateRange.start}
          onChange={(v) => setDateRange({ ...dateRange, start: v })}
          className="w-40"
        />
        <DateInput
          value={dateRange.end}
          onChange={(v) => setDateRange({ ...dateRange, end: v })}
          className="w-40"
        />

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Loại" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Tất cả loại</SelectItem>
            <SelectItem value="income">Thu</SelectItem>
            <SelectItem value="expense">Chi</SelectItem>
          </SelectContent>
        </Select>

        <Select value={methodFilter} onValueChange={setMethodFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Phương thức" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Tất cả PT</SelectItem>
            {Object.entries(PAYMENT_METHODS).map(([key, config]) => (
              <SelectItem key={key} value={key}>
                {config.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Trạng thái" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Tất cả TT</SelectItem>
            <SelectItem value="PENDING">Chờ duyệt</SelectItem>
            <SelectItem value="APPROVED">Đã duyệt</SelectItem>
            <SelectItem value="REJECTED">Từ chối</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ngày</TableHead>
              <TableHead>Số phiếu</TableHead>
              <TableHead>Loại</TableHead>
              <TableHead>Khách hàng</TableHead>
              <TableHead>Loại thu chi</TableHead>
              <TableHead>Số tiền</TableHead>
              <TableHead>Phương thức</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ghi chú</TableHead>
              <TableHead>Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPayments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10}>
                  {payments.length === 0 && typeFilter === "ALL" && statusFilter === "ALL" && methodFilter === "ALL" && !searchQuery ? (
                    <EmptyState
                      icon={DollarSign}
                      title="Chưa có phiếu thu chi nào"
                      description="Hãy tạo phiếu thu hoặc phiếu chi đầu tiên để bắt đầu quản lý"
                      actionLabel="Tạo phiếu thu"
                      onAction={handleCreateIncome}
                    />
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      Chưa có phiếu thu chi nào. Hãy tạo phiếu thu hoặc phiếu chi đầu tiên.
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filteredPayments.map((payment) => {
                const paymentType = (payment as any).type || "income";
                const paymentStatus = (payment as any).status || "APPROVED";
                const incomeExpenseTypeName = (payment as any).income_expense_type_name || "";
                return (
                  <TableRow key={payment.id}>
                    <TableCell>
                      {payment.payment_date ? formatDate(payment.payment_date) : "-"}
                    </TableCell>
                    <TableCell className="font-mono">
                      {payment.receipt_number || "-"}
                    </TableCell>
                    <TableCell>
                      <Badge className={paymentType === "income" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                        {paymentType === "income" ? "Thu" : "Chi"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {payment.invoice?.contract?.tenant?.full_name || "-"}
                    </TableCell>
                    <TableCell>
                      {incomeExpenseTypeName || "-"}
                    </TableCell>
                    <TableCell className={`font-semibold ${paymentType === "income" ? "text-green-600" : "text-red-600"}`}>
                      {paymentType === "expense" ? "-" : "+"}{formatCurrency(payment.amount)}
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
                    <TableCell>
                      <Badge className={STATUS_LABELS[paymentStatus]?.color || "bg-gray-100 text-gray-800"}>
                        {STATUS_LABELS[paymentStatus]?.label || paymentStatus}
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
                        {paymentType === "income" ? "Phiếu thu" : "Phiếu chi"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Dialogs */}
      <CollectPaymentDialog
        open={collectDialogOpen}
        onOpenChange={setCollectDialogOpen}
        defaultType={dialogType}
      />

      {selectedPayment && (
        <PaymentReceiptDialog
          open={receiptDialogOpen}
          onOpenChange={setReceiptDialogOpen}
          payment={selectedPayment}
        />
      )}

      <ExportExcelDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        exportType="payments"
      />
    </MainLayout>
  );
};

export default PaymentsPage;
