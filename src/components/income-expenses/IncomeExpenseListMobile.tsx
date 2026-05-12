import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { Receipt, Image as ImageIcon } from "lucide-react";
import { format } from "date-fns";
import type { IncomeExpenseWithRelations } from "@/hooks/useIncomeExpenses";

interface Props {
  vouchers: IncomeExpenseWithRelations[];
  isLoading: boolean;
  onView: (v: IncomeExpenseWithRelations) => void;
  /** Pull-to-refresh handler — optional */
  onRefresh?: () => void;
}

const formatCompact = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "tỷ";
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "tr";
  if (abs >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return n.toLocaleString("vi-VN");
};

export function IncomeExpenseListMobile({
  vouchers,
  isLoading,
  onView,
}: Props) {
  if (isLoading) {
    return (
      <div className="px-3 py-3 space-y-2.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (vouchers.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={Receipt}
          title="Chưa có phiếu nào"
          description="Hãy tạo phiếu mới qua nút (+) bên dưới hoặc nới bộ lọc."
        />
      </div>
    );
  }

  return (
    <ul role="list" className="px-3 py-3 space-y-2.5 pb-24">
      {vouchers.map((v) => {
        const isCancelled = v.approval_status === "CANCELLED";
        const isUnapproved = v.approval_status === "UNAPPROVED";
        const isIncome = v.type === "INCOME";
        const accentColor = isIncome ? "#10b981" : "#ef4444";
        const firstAttachment = v.attachments?.[0];

        return (
          <li key={v.id}>
            <article
              role="button"
              tabIndex={0}
              onClick={() => onView(v)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onView(v);
              }}
              className={`relative bg-white border border-zinc-200 rounded-xl p-3.5 shadow-sm active:scale-[0.985] active:shadow-none transition-transform cursor-pointer ${
                isCancelled ? "opacity-60" : ""
              }`}
              style={{
                borderLeft: `3px solid ${accentColor}`,
              }}
            >
              {/* Row 1: code + chip + amount */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="font-mono font-medium text-sm text-zinc-900">
                    {v.code}
                  </span>
                  <span
                    className={`px-2 py-0.5 text-[11px] font-medium rounded-full ${
                      isIncome
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {isIncome ? "Phiếu thu" : "Phiếu chi"}
                  </span>
                  {isCancelled && (
                    <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-zinc-100 text-zinc-600">
                      Đã huỷ
                    </span>
                  )}
                  {isUnapproved && (
                    <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-amber-100 text-amber-700">
                      Nháp
                    </span>
                  )}
                </div>
                <span
                  className={`shrink-0 text-[15px] font-bold tabular-nums ${
                    isIncome ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {isIncome ? "+" : "-"}
                  {formatCompact(v.total_amount)}
                </span>
              </div>

              {/* Row 2: meta */}
              <div className="text-[13px] text-zinc-600 mb-1 line-clamp-1">
                <span className="font-medium">{v.name}</span>
                {v.payer_name && (
                  <>
                    <span className="mx-1.5 text-zinc-300">·</span>
                    <span>{v.payer_name}</span>
                  </>
                )}
              </div>

              {/* Row 3: time + thumb */}
              <div className="flex items-center justify-between gap-2 mt-1">
                <div className="flex items-center gap-1.5 text-[12px] text-zinc-400 min-w-0">
                  <span className="truncate">
                    {v.voucher_date
                      ? format(new Date(v.voucher_date), "dd/MM/yyyy")
                      : "—"}
                  </span>
                  {v.account_name && (
                    <>
                      <span>·</span>
                      <span className="truncate">{v.account_name}</span>
                    </>
                  )}
                  {v.building_name && (
                    <>
                      <span>·</span>
                      <span className="truncate">
                        {v.building_name}
                        {v.room_name ? ` - ${v.room_name}` : ''}
                      </span>
                    </>
                  )}
                </div>
                {firstAttachment && (
                  <div className="shrink-0 w-8 h-8 rounded-md border border-zinc-200 bg-zinc-50 overflow-hidden flex items-center justify-center">
                    {/\.pdf(\?|$)/i.test(firstAttachment) ? (
                      <ImageIcon className="h-4 w-4 text-zinc-400" />
                    ) : (
                      <img
                        src={firstAttachment}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                )}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export default IncomeExpenseListMobile;
