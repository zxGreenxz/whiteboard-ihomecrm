import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Minus, FileText } from "lucide-react";

interface IncomeExpenseStatsProps {
  stats: {
    totalIncome: number;
    totalExpense: number;
    difference: number;
  };
  isLoading?: boolean;
}

export function formatVND(amount: number): string {
  return amount.toLocaleString("vi-VN") + " đ";
}

export function IncomeExpenseStats({
  stats,
  isLoading,
}: IncomeExpenseStatsProps) {
  const statCards = [
    {
      label: "Thu",
      value: stats.totalIncome,
      icon: Plus,
      iconBg: "bg-emerald-100",
      iconColor: "text-emerald-600",
      valueColor: "text-emerald-600",
      borderColor: "border-l-emerald-500",
    },
    {
      label: "Chi",
      value: stats.totalExpense,
      icon: Minus,
      iconBg: "bg-red-100",
      iconColor: "text-red-600",
      valueColor: "text-red-600",
      borderColor: "border-l-red-500",
    },
    {
      label: "Thu - chi",
      value: stats.difference,
      icon: FileText,
      iconBg: "bg-blue-100",
      iconColor: "text-blue-600",
      valueColor: "text-blue-600",
      borderColor: "border-l-blue-500",
    },
  ];

  return (
    <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
      {statCards.map((card) => {
        const Icon = card.icon;
        return (
          <Card
            key={card.label}
            className={`border-l-4 ${card.borderColor} hover:shadow-md transition-shadow`}
          >
            <CardContent className="flex items-center gap-4 p-4">
              <div
                className={`h-12 w-12 rounded-full ${card.iconBg} flex items-center justify-center shrink-0`}
              >
                <Icon className={`h-6 w-6 ${card.iconColor}`} />
              </div>
              <div className="min-w-0">
                {isLoading ? (
                  <Skeleton className="h-7 w-32" />
                ) : (
                  <div className={`text-xl font-bold ${card.valueColor} truncate`}>
                    {formatVND(card.value)}
                  </div>
                )}
                <div className="text-sm text-muted-foreground">{card.label}</div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
