import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AttachmentUpload from "./AttachmentUpload";
import {
  useQuickUpdateIncomeExpense,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import { useAccounts } from "@/hooks/useAccounts";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations | null;
}

export function IncomeExpenseQuickEditDialog({
  open,
  onOpenChange,
  voucher,
}: Props) {
  const { data: accounts = [] } = useAccounts();
  const { data: authUser } = useAuth();
  const isMobile = useIsMobile();
  const quickUpdate = useQuickUpdateIncomeExpense();

  const [accountId, setAccountId] = useState<string>("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>("");

  useEffect(() => {
    if (open && voucher) {
      setAccountId(voucher.account_id ?? "");
      setAttachments(voucher.attachments ?? []);
      setNotes(voucher.notes ?? "");
    }
  }, [open, voucher]);

  if (!voucher) return null;

  const handleSave = async () => {
    try {
      await quickUpdate.mutateAsync({
        id: voucher.id,
        account_id: accountId || null,
        attachments,
        notes: notes.trim() ? notes.trim() : null,
      });
      onOpenChange(false);
    } catch {
      // toast handled by hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isMobile
            ? "max-w-full w-full h-[100dvh] !top-0 !left-0 !translate-x-0 !translate-y-0 rounded-none p-4 overflow-y-auto"
            : "sm:max-w-[560px] max-h-[90vh] overflow-y-auto"
        }
      >
        <DialogHeader>
          <DialogTitle>SỬA NHANH PHIẾU</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Chỉnh sửa nhanh sổ quỹ, hình ảnh đính kèm và ghi chú của phiếu{" "}
          <b>{voucher.code}</b>. Các trường khác (số tiền, hạng mục, người
          nhận/trả…) không sửa được — nếu cần đổi, hãy huỷ phiếu và tạo lại.
        </p>

        <div className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="quick-edit-account">Sổ quỹ</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="quick-edit-account">
                <SelectValue placeholder="Chọn sổ quỹ" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Hình ảnh đính kèm</Label>
            <AttachmentUpload
              attachments={attachments}
              onChange={setAttachments}
              userId={authUser?.id ?? voucher.user_id}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="quick-edit-notes">Ghi chú</Label>
            <Textarea
              id="quick-edit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ghi chú thêm cho phiếu (không bắt buộc)"
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={quickUpdate.isPending}
          >
            Huỷ
          </Button>
          <Button onClick={handleSave} disabled={quickUpdate.isPending}>
            {quickUpdate.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default IncomeExpenseQuickEditDialog;
