import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X, Pencil, Trash2, Wallet } from "lucide-react";
import {
  accountTypeLabel,
  type AccountWithBalance,
} from "@/hooks/useAccounts";
import { format } from "date-fns";
import { useIsMobile } from "@/hooks/use-mobile";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountWithBalance | null;
  onEdit: (acc: AccountWithBalance) => void;
  onDelete: (id: string) => void;
}

const formatVND = (n: number) => `${n.toLocaleString("vi-VN")} đ`;

const Row = ({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) => (
  <div className="flex items-start justify-between gap-3 py-3 border-b border-zinc-200 last:border-b-0">
    <div className="text-[15px] text-zinc-700 shrink-0">{label}</div>
    <div className="text-[15px] font-semibold text-zinc-900 text-right break-words">
      {value || "—"}
    </div>
  </div>
);

export function CashbookDetailDialog({
  open,
  onOpenChange,
  account,
  onEdit,
  onDelete,
}: Props) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  if (!account) return null;

  const handleViewIncomeExpense = () => {
    onOpenChange(false);
    navigate(`/income-expense?account_id=${account.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isMobile
            ? "max-w-full w-full h-[100vh] !top-0 !left-0 !translate-x-0 !translate-y-0 rounded-none p-0 overflow-hidden flex flex-col"
            : "max-w-md p-0 overflow-hidden flex flex-col"
        }
      >
        {/* Green header */}
        <header className="bg-emerald-600 text-white flex items-center px-3 py-4 relative">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="absolute left-3 p-1.5 rounded hover:bg-white/10 active:bg-white/20"
            aria-label="Đóng"
          >
            <X className="h-6 w-6" />
          </button>
          <h2 className="flex-1 text-center text-base font-bold uppercase tracking-wide">
            Thông tin sổ quỹ
          </h2>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <div className="bg-zinc-100/70 rounded-2xl p-4">
            <Row label="Tên sổ quỹ:" value={account.name} />
            <Row
              label="Loại sổ quỹ:"
              value={accountTypeLabel(account.type)}
            />
            {account.type === "bank" || account.type === "ewallet" ? (
              <>
                <Row label="Số tài khoản:" value={account.account_number} />
                <Row label="Chủ TK:" value={account.bank_account_holder} />
              </>
            ) : null}
            {account.type === "bank" && account.bank_name && (
              <Row label="Ngân hàng:" value={account.bank_name} />
            )}
            {account.type === "bank" && account.branch && (
              <Row label="Chi nhánh:" value={account.branch} />
            )}
            <Row
              label="Ngày chốt số dư đầu kỳ:"
              value={
                account.initial_date
                  ? format(new Date(account.initial_date), "dd-MM-yyyy")
                  : "—"
              }
            />
            <Row
              label="Số dư đầu kỳ:"
              value={formatVND(Number(account.initial_amount))}
            />
            <Row
              label="Số dư hiện tại:"
              value={
                <span
                  className={
                    Number(account.current_amount) < 0
                      ? "text-red-600"
                      : "text-emerald-600"
                  }
                >
                  {formatVND(Number(account.current_amount))}
                </span>
              }
            />
            {account.lock_date && (
              <Row
                label="Ngày khoá sổ:"
                value={format(new Date(account.lock_date), "dd-MM-yyyy")}
              />
            )}
            {account.description && (
              <Row label="Mô tả:" value={account.description} />
            )}
          </div>

          {/* CTA: Xem thu chi */}
          <button
            type="button"
            onClick={handleViewIncomeExpense}
            className="mt-5 w-full flex items-center justify-center gap-2 py-3.5 rounded-xl border-2 border-emerald-600 text-emerald-700 font-medium active:bg-emerald-50"
          >
            <Wallet className="h-5 w-5" />
            <span>Xem thu chi</span>
          </button>
        </div>

        {/* Footer actions */}
        <footer className="border-t border-zinc-200 px-4 py-3 bg-white flex items-center justify-end gap-6">
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onEdit(account);
            }}
            className="flex flex-col items-center gap-1 text-blue-500 active:opacity-70"
          >
            <span className="w-9 h-9 rounded-md border-2 border-blue-500 grid place-items-center">
              <Pencil className="h-4 w-4" />
            </span>
            <span className="text-xs">Chỉnh sửa</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onDelete(account.id);
            }}
            className="flex flex-col items-center gap-1 text-red-500 active:opacity-70"
          >
            <span className="w-9 h-9 rounded-md border-2 border-red-500 grid place-items-center">
              <Trash2 className="h-4 w-4" />
            </span>
            <span className="text-xs">Xoá</span>
          </button>
        </footer>

        {/* Đệm safe-area cho iPhone notch */}
        {isMobile && (
          <div
            style={{ height: "env(safe-area-inset-bottom, 0px)" }}
            className="bg-white"
          />
        )}

        {/* Hide native dialog close button — chúng ta dùng X header riêng */}
        <Button
          variant="ghost"
          size="icon"
          className="hidden"
          aria-hidden
        />
      </DialogContent>
    </Dialog>
  );
}

export default CashbookDetailDialog;
