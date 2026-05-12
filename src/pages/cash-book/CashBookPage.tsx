import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Search, Download } from "lucide-react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCashBook, useCashBookSummary } from "@/hooks/useCashBook";
import { formatCurrency, formatDate } from "@/lib/utils";

const CashBookPage = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  // DEFENSIVE CHECK: ensure entries is array
  const { data: entriesData = [], isLoading } = useCashBook(dateRange.start, dateRange.end);
  const entries = Array.isArray(entriesData) ? entriesData : [];
  const { data: summary } = useCashBookSummary(dateRange.start, dateRange.end);

  // DEFENSIVE CHECK: ensure filteredEntries is array
  const filteredEntries = Array.isArray(entries) ? entries.filter((entry) => {
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return entry.description?.toLowerCase()?.includes(search);
  }) : [];

  // Calculate running balance
  let runningBalance = summary?.openingBalance || 0;
  const entriesWithBalance = filteredEntries.map((entry) => {
    if (entry.type === "INCOME") {
      runningBalance += entry.amount;
    } else {
      runningBalance -= entry.amount;
    }
    return { ...entry, balance: runningBalance };
  });

  const handleExport = () => {
    // Export to CSV
    const headers = ["Ngày", "Loại", "Mô tả", "Thu", "Chi", "Số dư"];
    const rows = entriesWithBalance.map((entry) => [
      formatDate(entry.date),
      entry.type === "INCOME" ? "Thu" : "Chi",
      entry.description,
      entry.type === "INCOME" ? entry.amount : "",
      entry.type === "EXPENSE" ? entry.amount : "",
      entry.balance,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `so-quy-${dateRange.start}-${dateRange.end}.csv`;
    link.click();
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="p-6">
          <div className="flex items-center justify-center h-96">
            <p className="text-muted-foreground">Đang tải...</p>
          </div>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Sổ quỹ</h1>
            <p className="text-muted-foreground mt-1">
              Theo dõi thu chi và số dư quỹ tiền mặt
            </p>
          </div>
          <Button onClick={handleExport}>
            <Download className="w-4 h-4 mr-2" />
            Xuất Excel
          </Button>
        </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Số dư đầu kỳ
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(summary?.openingBalance || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng thu
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(summary?.totalIncome || 0)}
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
              {formatCurrency(summary?.totalExpense || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
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

      {/* Net Cash Flow */}
      <Card className={summary && summary.netCashFlow >= 0 ? "border-green-200" : "border-red-200"}>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Dòng tiền thuần (Net Cash Flow)</p>
              <p className="text-3xl font-bold mt-1">
                {formatCurrency(summary?.netCashFlow || 0)}
              </p>
            </div>
            <Badge
              variant={summary && summary.netCashFlow >= 0 ? "default" : "destructive"}
              className="text-lg px-4 py-2"
            >
              {summary && summary.netCashFlow >= 0 ? "Dương" : "Âm"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Tìm kiếm theo mô tả..."
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
      </div>

      {/* Cash Book Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ngày</TableHead>
              <TableHead>Loại</TableHead>
              <TableHead>Mô tả</TableHead>
              <TableHead className="text-right">Thu</TableHead>
              <TableHead className="text-right">Chi</TableHead>
              <TableHead className="text-right">Số dư</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Opening Balance Row */}
            <TableRow className="bg-muted/50 font-semibold">
              <TableCell>{formatDate(dateRange.start)}</TableCell>
              <TableCell>
                <Badge variant="outline">Số dư đầu</Badge>
              </TableCell>
              <TableCell>Số dư đầu kỳ</TableCell>
              <TableCell className="text-right">-</TableCell>
              <TableCell className="text-right">-</TableCell>
              <TableCell className="text-right">
                {formatCurrency(summary?.openingBalance || 0)}
              </TableCell>
            </TableRow>

            {/* Transactions */}
            {entriesWithBalance.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Không có giao dịch nào trong kỳ này
                </TableCell>
              </TableRow>
            ) : (
              entriesWithBalance.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{formatDate(entry.date)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={entry.type === "INCOME" ? "default" : "destructive"}
                    >
                      {entry.type === "INCOME" ? "Thu" : "Chi"}
                    </Badge>
                  </TableCell>
                  <TableCell>{entry.description}</TableCell>
                  <TableCell className="text-right text-green-600 font-semibold">
                    {entry.type === "INCOME" ? formatCurrency(entry.amount) : "-"}
                  </TableCell>
                  <TableCell className="text-right text-red-600 font-semibold">
                    {entry.type === "EXPENSE" ? formatCurrency(entry.amount) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(entry.balance)}
                  </TableCell>
                </TableRow>
              ))
            )}

            {/* Closing Balance Row */}
            <TableRow className="bg-muted/50 font-bold border-t-2">
              <TableCell>{formatDate(dateRange.end)}</TableCell>
              <TableCell>
                <Badge variant="outline">Số dư cuối</Badge>
              </TableCell>
              <TableCell>Số dư cuối kỳ</TableCell>
              <TableCell className="text-right text-green-600">
                {formatCurrency(summary?.totalIncome || 0)}
              </TableCell>
              <TableCell className="text-right text-red-600">
                {formatCurrency(summary?.totalExpense || 0)}
              </TableCell>
              <TableCell className="text-right text-blue-600">
                {formatCurrency(summary?.closingBalance || 0)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        </Card>
      </div>
    </MainLayout>
  );
};

export default CashBookPage;
