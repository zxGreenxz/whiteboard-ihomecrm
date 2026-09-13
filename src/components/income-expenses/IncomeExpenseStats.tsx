import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Minus, FileText, Check } from "lucide-react";
import { formatVND } from "@/lib/utils";
import { buildIncomeExpenseStatCards } from "@/lib/incomeExpenseStatCards";

interface IncomeExpenseStatsProps {
  stats: {
    totalIncome: number;
    totalExpense: number;
    // `difference` KHÔNG còn là prop: thẻ Thu-chi tự tính từ totalIncome/
    // totalExpense (qua buildIncomeExpenseStatCards) để số lớn và số trong
    // ngoặc luôn cùng một nguồn. Nhận lại nó ở đây chỉ tạo đường trôi câm.
    // B4 (04/07): 3 thẻ = TIỀN THẬT; bút toán nội bộ & phiếu chờ xử lý tách
    // thành dòng phụ trung tính bên dưới (không cộng vào thẻ).
    internalCount?: number;
    internalIncome?: number;
    internalExpense?: number;
    pendingCount?: number;
    pendingTotal?: number;
    // 13/09: chờ xử lý tách theo chiều — nuôi con số TRONG NGOẶC của từng thẻ.
    pendingIncome?: number;
    pendingExpense?: number;
  };
  isLoading?: boolean;
  /** Bấm dòng "Bút toán nội bộ" → chuyển tab lớp Nội bộ. */
  onShowInternal?: () => void;
  /** Bấm dòng "Chờ xử lý" → chuyển tab lớp Chờ xử lý. */
  onShowPending?: () => void;
}

// Lời chú phải nói về ĐÚNG THẺ ĐANG ĐỨNG, không nói thay cả trang: thẻ Thu có
// thể sạch trong khi vẫn còn hàng trăm phiếu CHI chờ (đúng trạng thái thật của
// sổ hôm nay). Và ✓ nói về TIỀN của thẻ này, không phải số phiếu — còn phiếu
// chờ 0đ thì "duyệt hết cũng không đổi số này" vẫn đúng.
const pendingHint = (label: string) =>
  `"${label}" nếu duyệt hết phiếu chờ xử lý (chờ duyệt hoặc chưa chọn sổ quỹ)`;
const clearHint = (label: string) =>
  `Duyệt hết phiếu chờ xử lý cũng không đổi số "${label}" này`;

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
  // Toán nằm ở lib để kiểm được bằng test (src/lib/incomeExpenseStatCards.ts).
  const withPending = buildIncomeExpenseStatCards({
    totalIncome: stats.totalIncome,
    totalExpense: stats.totalExpense,
    pendingIncome: stats.pendingIncome ?? 0,
    pendingExpense: stats.pendingExpense ?? 0,
  });
  const statCards = [
    {
      label: "Thu",
      card: withPending.income,
      icon: Plus,
      iconBg: "bg-emerald-100",
      iconColor: "text-emerald-600",
      valueColor: "text-emerald-600",
      borderColor: "border-l-emerald-500",
    },
    {
      label: "Chi",
      card: withPending.expense,
      icon: Minus,
      iconBg: "bg-red-100",
      iconColor: "text-red-600",
      valueColor: "text-red-600",
      borderColor: "border-l-red-500",
    },
    {
      label: "Thu - chi",
      card: withPending.difference,
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
      {statCards.map(({ label, card, ...style }) => {
        const Icon = style.icon;
        return (
          <Card
            key={label}
            className={`border-l-4 ${style.borderColor} hover:shadow-md transition-shadow`}
          >
            <CardContent className="flex items-center gap-4 p-4">
              <div
                className={`h-12 w-12 rounded-full ${style.iconBg} flex items-center justify-center shrink-0`}
              >
                <Icon className={`h-6 w-6 ${style.iconColor}`} />
              </div>
              <div className="min-w-0">
                {isLoading ? (
                  <Skeleton className="h-7 w-32" />
                ) : (
                  <div className={`text-xl font-bold ${style.valueColor} truncate`}>
                    {formatVND(card.value)}
                  </div>
                )}
                {/* Ngoặc = tổng ĐÃ GỒM phiếu chờ xử lý; hết phiếu chờ thì ✓.
                    Cả 3 thẻ đều có để tự kiểm chứng được bằng mắt:
                    ngoặc Thu − ngoặc Chi = ngoặc Thu-chi. */}
                <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
                  <span>{label}</span>
                  {!isLoading &&
                    (card.hasPending ? (
                      <span
                        className="font-semibold tabular-nums text-amber-700"
                        title={pendingHint(label)}
                      >
                        ({formatVND(card.withPending)})
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center text-emerald-600"
                        title={clearHint(label)}
                      >
                        <Check className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">{clearHint(label)}</span>
                      </span>
                    ))}
                </div>
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
            title="Phiếu chờ duyệt/chờ chọn sổ — chưa tính vào tồn quỹ, cần xử lý"
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
