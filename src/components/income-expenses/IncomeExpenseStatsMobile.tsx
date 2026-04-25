import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUp, ArrowDown, Wallet } from "lucide-react";

interface Stats {
  totalIncome: number;
  totalExpense: number;
  difference: number;
}

interface Props {
  stats: Stats;
  isLoading?: boolean;
}

const formatCompact = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000)
    return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "tỷ";
  if (abs >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "tr";
  if (abs >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return n.toLocaleString("vi-VN");
};

export function IncomeExpenseStatsMobile({ stats, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 px-3 pt-3">
        <Skeleton className="h-[78px] rounded-xl" />
        <Skeleton className="h-[78px] rounded-xl" />
        <Skeleton className="col-span-2 h-[92px] rounded-xl" />
      </div>
    );
  }

  const positive = stats.difference >= 0;

  return (
    <section className="grid grid-cols-2 gap-2 px-3 pt-3">
      <div className="bg-white border border-zinc-200 rounded-xl p-3 min-h-[78px] flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <ArrowUp className="h-3 w-3 text-emerald-500" />
          Tổng thu
        </div>
        <span className="text-xl font-bold text-emerald-600 tabular-nums">
          {formatCompact(stats.totalIncome)}
        </span>
      </div>

      <div className="bg-white border border-zinc-200 rounded-xl p-3 min-h-[78px] flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <ArrowDown className="h-3 w-3 text-red-500" />
          Tổng chi
        </div>
        <span className="text-xl font-bold text-red-600 tabular-nums">
          {formatCompact(stats.totalExpense)}
        </span>
      </div>

      <div
        className={`col-span-2 rounded-xl p-3 border ${
          positive
            ? "border-emerald-200"
            : "border-red-200"
        }`}
        style={{
          background: positive
            ? "linear-gradient(135deg, #f0f9ff 0%, #ecfdf5 100%)"
            : "linear-gradient(135deg, #fff7ed 0%, #fef2f2 100%)",
        }}
      >
        <div className="flex items-center justify-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase mb-1">
          <Wallet className="h-3 w-3" />
          Thu - Chi
        </div>
        <div
          className={`text-2xl font-bold text-center tabular-nums ${
            positive ? "text-emerald-600" : "text-red-600"
          }`}
        >
          {positive ? "+" : ""}
          {formatCompact(stats.difference)}
        </div>
      </div>
    </section>
  );
}

export default IncomeExpenseStatsMobile;
