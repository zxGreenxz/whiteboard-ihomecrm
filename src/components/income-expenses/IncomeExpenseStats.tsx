import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Minus, FileText } from "lucide-react";

interface IncomeExpenseStatsProps {
  stats: {
    totalIncome: number;
    totalExpense: number;
    difference: number;
    // B4 (04/07): 3 thẻ = TIỀN THẬT; bút toán nội bộ & phiếu chờ xử lý tách
    // thành dòng phụ trung tính bên dưới (không cộng vào thẻ).
    internalCount?: number;
    internalIncome?: number;
    internalExpense?: number;
    pendingCount?: number;
    pendingTotal?: number;
  };
  isLoading?: boolean;
  /** Bấm dòng "Bút toán nội bộ" → chuyển tab lớp Nội bộ. */
  onShowInternal?: () => void;
  /** Bấm dòng "Chờ xử lý" → chuyển tab lớp Chờ xử lý. */
  onShowPending?: () => void;
}

export function formatVND(amount: number): string {
  return amount.toLocaleString("vi-VN") + " đ";
}

export function IncomeExpenseStats({
  stats,
  isLoading,
  onShowInternal,
  onShowPending,
}: IncomeExpenseStatsProps) {
  const internalCount = stats.internalCount ?? 0;
  const internalNet =
    (stats.internalIncome ?? 0) + (stats.internalExpense ?? 0);
  const pendingCount = stats.pendingCount ?? 0;
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
    <div className="space-y-2">
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

    {/* B4: dòng phụ TRUNG TÍNH — bút toán nội bộ & phiếu chờ xử lý không nằm
        trong 3 thẻ tiền thật, nhưng phải nhìn thấy được (không giấu). */}
    {!isLoading && (internalCount > 0 || pendingCount > 0) && (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-sm text-muted-foreground">
        {internalCount > 0 && (
          <button
            type="button"
            onClick={onShowInternal}
            className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
            title="Bút toán không có tiền thật ra/vào két (cấn cọc, điều chỉnh…) — bấm để xem"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-slate-400" />
            Bút toán nội bộ kỳ này: <b className="tabular-nums">{internalCount}</b> phiếu
            {internalNet > 0 && (
              <span className="tabular-nums">· {formatVND(internalNet)}</span>
            )}
            <span className="underline">xem</span>
          </button>
        )}
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={onShowPending}
            className="inline-flex items-center gap-1.5 text-amber-700 hover:underline"
            title="Phiếu nháp/chờ chọn sổ — chưa tính vào tồn quỹ, cần xử lý"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            Chờ xử lý: <b className="tabular-nums">{pendingCount}</b> phiếu
            {(stats.pendingTotal ?? 0) > 0 && (
              <span className="tabular-nums">· {formatVND(stats.pendingTotal ?? 0)}</span>
            )}
            <span className="underline">xem</span>
          </button>
        )}
      </div>
    )}
    </div>
  );
}
