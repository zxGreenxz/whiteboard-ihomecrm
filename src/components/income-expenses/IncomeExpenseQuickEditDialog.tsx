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
import AttachmentUpload from "./AttachmentUpload";
import type { IncomeExpenseWithRelations } from "@/hooks/useIncomeExpenses";
import { useAnnotateIncomeExpense } from "@/hooks/income-expenses/annotateMutations";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations | null;
}

/**
 * Bổ sung ảnh chứng từ + ghi chú cho một phiếu ở BẤT KỲ trạng thái nào.
 *
 * Đợt 2: ô "Sổ quỹ" đã bị BỎ khỏi màn này. Trước đây nó gọi
 * `update_income_expense_quick` với `account_id`, mà `account_id` nằm trong
 * danh sách `UPDATE OF` của cầu auto-posting a85 — nên một cú "sửa nhanh" trên
 * phiếu ĐÃ GHI SỔ sẽ đảo bút toán ở sổ cũ và ghi bút toán ở sổ mới: tiền rời
 * két người khác, không ai duyệt, không dòng nhật ký nào. Server đã chặn ở Đợt
 * 0; ở đây bỏ luôn ô đó khỏi giao diện để không mời người dùng làm việc sai.
 * Cần đổi sổ quỹ thì huỷ phiếu và lập lại.
 */
export function IncomeExpenseQuickEditDialog({
  open,
  onOpenChange,
  voucher,
}: Props) {
  const { data: authUser } = useAuth();
  const isMobile = useIsMobile();
  const annotate = useAnnotateIncomeExpense();

  const [attachments, setAttachments] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>("");

  useEffect(() => {
    if (open && voucher) {
      setAttachments(voucher.attachments ?? []);
      setNotes(voucher.notes ?? "");
    }
  }, [open, voucher]);

  if (!voucher) return null;

  const original: string[] = voucher.attachments ?? [];
  const added = attachments.filter((url) => !original.includes(url));
  const removed = original.filter((url) => !attachments.includes(url));
  const notesChanged = (notes.trim() || null) !== (voucher.notes ?? null);
  const nothingToDo = added.length === 0 && removed.length === 0 && !notesChanged;

  const handleSave = async () => {
    try {
      await annotate.mutateAsync({
        voucherId: voucher.id,
        addAttachments: added,
        removeAttachments: removed,
        // Chỉ gửi ghi chú khi thật sự đổi — gửi thừa sẽ đụng vào bộ canh dấu
        // hiệu tiền trong ghi chú mà chẳng để làm gì.
        notes: notesChanged ? (notes.trim() ? notes.trim() : "") : null,
      });
      onOpenChange(false);
    } catch {
      // toast đã xử lý trong hook
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
          <DialogTitle>BỔ SUNG CHỨNG TỪ / GHI CHÚ</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Bổ sung ảnh chứng từ và ghi chú cho phiếu <b>{voucher.code}</b> — làm
          được ở mọi trạng thái, kể cả phiếu đã ghi sổ. Số tiền, hạng mục, sổ quỹ,
          người nhận/trả không sửa ở đây; cần đổi thì huỷ phiếu rồi lập lại.
        </p>

        <div className="space-y-4 mt-2">
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
            disabled={annotate.isPending}
          >
            Huỷ
          </Button>
          <Button onClick={handleSave} disabled={annotate.isPending || nothingToDo}>
            {annotate.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default IncomeExpenseQuickEditDialog;
