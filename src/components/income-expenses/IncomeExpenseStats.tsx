import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowUpCircle,
  ArrowDownCircle,
  TrendingUp,
  TrendingDown,
  FileText,
} from "lucide-react";

interface IncomeExpenseStatsProps {
  stats: {
    totalIncome: number;
    totalExpense: number;
    difference: number;
    totalTransactions: number;
  };
  isLoading?: boolean;
}

function formatVND(amount: number): string {
  return amount.toLocaleString("vi-VN") + " đ";
}

export function IncomeExpenseStats({
  stats,
  isLoading,
}: IncomeExpenseStatsProps) {
  const isDifferencePositive = stats.difference >= 0;

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {/* Tổng thu */}
      <Card className="border-l-4 border-l-emerald-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Tổng thu
          </CardTitle>
          <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center">
            <ArrowUpCircle className="h-5 w-5 text-emerald-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="text-2xl font-bold text-emerald-600">
              {formatVND(stats.totalIncome)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tổng chi */}
      <Card className="border-l-4 border-l-red-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Tổng chi
          </CardTitle>
          <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center">
            <ArrowDownCircle className="h-5 w-5 text-red-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="text-2xl font-bold text-red-600">
              {formatVND(stats.totalExpense)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chênh lệch */}
      <Card
        className={`border-l-4 hover:shadow-md transition-shadow ${
          isDifferencePositive ? "border-l-emerald-500" : "border-l-red-500"
        }`}
      >
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Chênh lệch
          </CardTitle>
          <div
            className={`h-10 w-10 rounded-full flex items-center justify-center ${
              isDifferencePositive ? "bg-emerald-100" : "bg-red-100"
            }`}
          >
            {isDifferencePositive ? (
              <TrendingUp className="h-5 w-5 text-emerald-600" />
            ) : (
              <TrendingDown className="h-5 w-5 text-red-600" />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div
              className={`text-2xl font-bold ${
                isDifferencePositive ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatVND(stats.difference)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tổng số giao dịch */}
      <Card className="border-l-4 border-l-blue-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Tổng số giao dịch
          </CardTitle>
          <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
            <FileText className="h-5 w-5 text-blue-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold text-foreground">
              {stats.totalTransactions.toLocaleString("vi-VN")}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
