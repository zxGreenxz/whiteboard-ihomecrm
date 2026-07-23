import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { Wallet, Lock, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type AccountWithBalance } from "@/hooks/useAccounts";
import { useMyCashbookAccessV2 } from "@/hooks/income-expenses/financeV2Mutations";

interface Props {
  rows: AccountWithBalance[];
  isLoading: boolean;
  onView: (acc: AccountWithBalance) => void;
  onEdit: (acc: AccountWithBalance) => void;
  onDelete: (id: string) => void;
  onLock: (acc: AccountWithBalance) => void;
  onUnlock: (acc: AccountWithBalance) => void;
}

const formatVND = (n: number) =>
  new Intl.NumberFormat("vi-VN").format(Math.round(n)) + " đ";

export function CashbookListMobile({
  rows,
  isLoading,
  onView,
  onEdit,
  onDelete,
  onLock,
  onUnlock,
}: Props) {
  // §12.6/§1810: binding KNOWER = biết sổ, KHÔNG thấy tồn quỹ (parity desktop).
  const { data: myAccess } = useMyCashbookAccessV2();
  const knowerBooks = new Set(
    (myAccess ?? [])
      .filter((a) => a.possession_kind === "KNOWER")
      .map((a) => a.cashbook_id),
  );
  if (isLoading) {
    return (
      <div className="px-3 py-3 space-y-2.5">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={Wallet}
          title="Chưa có sổ quỹ"
          description="Thêm sổ quỹ qua nút (+) bên dưới."
        />
      </div>
    );
  }

  return (
    <ul role="list" className="px-3 py-3 space-y-2.5 pb-24">
      {rows.map((acc) => {
        const isLocked = !!acc.lock_date;
        const balanceNeg = Number(acc.current_amount) < 0;

        return (
          <li key={acc.id}>
            <article
              role="button"
              tabIndex={0}
              onClick={() => onView(acc)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onView(acc);
              }}
              className={`relative bg-white border border-zinc-200 rounded-xl p-3.5 shadow-sm cursor-pointer active:scale-[0.985] transition-transform ${
                isLocked ? "ring-1 ring-orange-200" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="shrink-0 w-9 h-9 rounded-lg grid place-items-center bg-amber-100 text-amber-700">
                    <Wallet className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-sm text-zinc-900 truncate">
                        {acc.name}
                      </span>
                      {isLocked && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-orange-100 text-orange-700">
                          Khoá sổ
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {acc.code}
                      {acc.owner_name ? ` · ${acc.owner_name}` : ""}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    Tồn quỹ
                  </div>
                  <div
                    className={`text-base font-bold tabular-nums ${
                      balanceNeg ? "text-red-600" : "text-emerald-600"
                    }`}
                  >
                    {knowerBooks.has(acc.id)
                      ? "—"
                      : formatVND(Number(acc.current_amount))}
                  </div>
                </div>
              </div>

              <div
                className="flex items-center justify-between text-[11px] text-muted-foreground border-t border-zinc-100 pt-2"
                onClick={(e) => e.stopPropagation()}
              >
                <span>
                  Số dư đầu kỳ:{" "}
                  <span className="font-medium text-zinc-700 tabular-nums">
                    {formatVND(Number(acc.initial_amount))}
                  </span>
                </span>
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-amber-500 hover:bg-amber-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      isLocked ? onUnlock(acc) : onLock(acc);
                    }}
                    title={isLocked ? "Mở khoá sổ" : "Khoá sổ"}
                  >
                    <Lock className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-blue-500 hover:bg-blue-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(acc);
                    }}
                    title="Sửa"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-500 hover:bg-red-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(acc.id);
                    }}
                    title="Xoá"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export default CashbookListMobile;
