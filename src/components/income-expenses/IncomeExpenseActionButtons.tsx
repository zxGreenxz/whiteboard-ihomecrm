import {
  Banknote,
  Ban,
  CheckCircle2,
  FilePlus2,
  Pencil,
  RotateCcw,
  Undo2,
  MessageSquareWarning,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { IncomeExpenseAction } from "@/lib/incomeExpenseActionPolicy";
import type { IncomeExpenseActionsController } from "@/hooks/income-expenses/useIncomeExpenseActions";
const definitions: [IncomeExpenseAction, string, typeof Banknote][] = [
  ["edit", "Sửa phiếu", Pencil],
  ['editRecipient', 'Sửa người nhận', Pencil],
  ["supplement", "Bổ sung chứng từ / ghi chú", FilePlus2],
  ["approveOnly", "Chỉ duyệt", CheckCircle2],
  ["legacyApprove", "Duyệt phiếu", CheckCircle2],
  ["approveAndPost", "Duyệt và Thu/Chi", Banknote],
  ["post", "Thu/Chi vào sổ", Banknote],
  ["reverse", "Hoàn tác", RotateCcw],
  ["unapprove", "Huỷ duyệt", Undo2],
  ["requestChanges", "Yêu cầu rà soát", MessageSquareWarning],
  ["resubmitReview", "Chuyển chờ duyệt", Send],
  ["cancel", "Huỷ phiếu", Ban],
];
export function IncomeExpenseActionButtons({
  controller,
  id,
  onChoose,
  moneyAllowed = true,
  refundReverseAllowed = false,
  layout = "icons",
  disabled = false,
}: {
  controller: IncomeExpenseActionsController;
  id: string;
  onChoose?: () => void;
  moneyAllowed?: boolean;
  refundReverseAllowed?: boolean;
  layout?: "icons" | "labeled";
  disabled?: boolean;
}) {
  const availability = controller.availability(id);
  return (
    <div
      className={layout === "labeled" ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-1.5"}
      aria-label="Thao tác phiếu"
    >
      {definitions.map(([action, label, Icon]) => {
        const a = availability[action];
        if (!a.visible) return null;
        if (action === "approveOnly" && availability.legacyApprove.enabled)
          return null;
        const sourceAllowed =
            action === "supplement" ||
            moneyAllowed ||
            (action === "reverse" && refundReverseAllowed),
          enabled = a.enabled && sourceAllowed && !controller.dismissalBlocked && !disabled;
        return (
          <Button
            key={action}
            type="button"
            variant="outline"
            size={layout === "labeled" ? "default" : "icon"}
            className={layout === "labeled" ? "cs-action-button w-full whitespace-normal" : "h-8 w-8"}
            data-primary={["resubmitReview", "approveAndPost", "post"].includes(action)}
            aria-label={label}
            disabled={!enabled}
            title={
              sourceAllowed
                ? a.reason || label
                : "Phiếu đang được xử lý tại luồng giữ chỗ."
            }
            onClick={() => {
              if (!enabled) return;
              onChoose?.();
              controller.open(action, id);
            }}
          >
            <Icon className="h-4 w-4" />
            {layout === "labeled" && <span>{label}</span>}
          </Button>
        );
      })}
    </div>
  );
}
