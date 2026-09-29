import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

import type { ContractFormState } from "./useContractFormState";

type ContractFormFooterProps = Pick<
  ContractFormState,
  "isEditMode" | "isPending" | "blockByDepositDebt"
> & {
  onOpenChange: (open: boolean) => void;
  onSaveDraft?: () => void;
};

/** ===== Footer buttons ===== (JSX chuyển NGUYÊN VĂN) */
export function ContractFormFooter({
  isEditMode,
  isPending,
  blockByDepositDebt,
  onOpenChange,
  onSaveDraft,
}: ContractFormFooterProps) {
  return (
    <div className="flex flex-wrap justify-end gap-3 pt-4 border-t">
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
        disabled={isPending}
      >
        Hủy
      </Button>
      {!isEditMode && onSaveDraft && <Button type="button" variant="outline" disabled={isPending} onClick={onSaveDraft}>Lưu nháp</Button>}
      <Button
        type="submit"
        disabled={isPending || (isEditMode && blockByDepositDebt)}
        title={
          isEditMode && blockByDepositDebt
            ? "Khách chưa đóng đủ cọc — tích \"Đồng ý cho nợ cọc\" để lưu"
            : undefined
        }
      >
        {isPending && (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        )}
        {isEditMode ? "Cập nhật" : "Lưu"}
      </Button>
    </div>
  );
}
