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
import type { IncomeExpenseWithRelations } from "@/hooks/useIncomeExpenses";
import { useAnnotateIncomeExpense } from "@/hooks/income-expenses/annotateMutations";
import {
  useMyCashbookAccess,
  useMoveIncomeVoucherCashbook,
} from "@/hooks/income-expenses/incomeVoucherCashbook";
import { useAccounts } from "@/hooks/useAccounts";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations | null;
}

/**
 * Bổ sung ảnh chứng từ + ghi chú cho một phiếu ở BẤT KỲ trạng thái nào, và —
 * với PHIẾU THU — đổi sổ quỹ (ĐỢT C).
 *
 * Lịch sử ô "Sổ quỹ": Đợt 2 đã GỠ nó khỏi màn này vì đường cũ
 * (`update_income_expense_quick`) UPDATE thẳng `account_id` mà không kiểm gì,
 * nên một cú "sửa nhanh" trên phiếu ĐÃ GHI SỔ sẽ đảo bút toán ở sổ cũ và ghi ở
 * sổ mới: tiền rời két người khác, không ai duyệt, không dòng nhật ký nào.
 * ĐỢT C mở lại ô đó CHỈ CHO PHIẾU THU, qua RPC riêng
 * `move_income_voucher_cashbook_v1`: sổ đi phải đang GIỮ, sổ đến GIỮ hoặc
 * BIẾT, bắt buộc lý do, ba khoá thời gian vẫn chặn, và server tự kiểm tiền đã
 * rời hẳn sổ cũ. Phiếu CHI vẫn không đổi sổ ở đây.
 */
export function IncomeExpenseQuickEditDialog({
  open,
  onOpenChange,
  voucher,
}: Props) {
  const { data: authUser } = useAuth();
  const isMobile = useIsMobile();
  const annotate = useAnnotateIncomeExpense();
  const moveCashbook = useMoveIncomeVoucherCashbook();

  const [attachments, setAttachments] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [accountId, setAccountId] = useState<string>("");
  const [moveReason, setMoveReason] = useState<string>("");

  const isIncome = voucher?.type === "INCOME";
  // Sổ quỹ chỉ đổi được cho phiếu thu THỦ CÔNG: phiếu của một đợt thu hoá đơn
  // mang sổ quỹ theo đợt, server sẽ từ chối.
  const canMoveCashbook =
    isIncome &&
    !!voucher?.account_id &&
    voucher?.approval_status !== "CANCELLED" &&
    !(voucher as { payment_collection_id?: string | null } | null)
      ?.payment_collection_id;

  const { data: cashbookAccess = [] } = useMyCashbookAccess(open && canMoveCashbook);
  const { data: allAccounts = [] } = useAccounts();

  useEffect(() => {
    if (open && voucher) {
      setAttachments(voucher.attachments ?? []);
      setNotes(voucher.notes ?? "");
      setAccountId(voucher.account_id ?? "");
      setMoveReason("");
    }
  }, [open, voucher]);

  if (!voucher) return null;

  // Sổ ĐẾN hợp lệ = sổ mình GIỮ hoặc BIẾT (đúng luật server).
  //
  // Tên sổ lấy TỪ CHÍNH RPC possession, KHÔNG giao với useAccounts(): bảng
  // `accounts` có RLS hẹp hơn possession rất nhiều (đo prod 01/08/2026: chủ nhà
  // DEMO giữ 5 sổ nhưng chỉ nhìn được 1 qua bảng đó), giao hai danh sách làm
  // dropdown rỗng gần hết. Sổ ảo cũng không lọc được ở client vì RPC không trả
  // cờ đó — server đã chặn sẵn bằng câu tiếng Việt rõ ràng.
  const virtualIds = new Set(allAccounts.filter((a) => a.is_virtual).map((a) => a.id));
  const moveOptions = cashbookAccess
    .filter(
      (r) =>
        (r.possession_kind === "CUSTODIAN" || r.possession_kind === "KNOWER") &&
        r.cashbook_id !== voucher.account_id &&
        !virtualIds.has(r.cashbook_id),
    )
    // Một sổ có thể có nhiều dòng possession (vừa giữ vừa biết) — gộp theo id.
    .filter((r, i, arr) => arr.findIndex((x) => x.cashbook_id === r.cashbook_id) === i)
    .map((r) => ({
      id: r.cashbook_id,
      name:
        r.cashbook_name ??
        allAccounts.find((a) => a.id === r.cashbook_id)?.name ??
        "Sổ không rõ tên",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));

  const currentBookName =
    allAccounts.find((a) => a.id === voucher.account_id)?.name ??
    cashbookAccess.find((r) => r.cashbook_id === voucher.account_id)?.cashbook_name ??
    "Sổ hiện tại";
  const accountChanged = !!accountId && accountId !== voucher.account_id;

  const original: string[] = voucher.attachments ?? [];
  const added = attachments.filter((url) => !original.includes(url));
  const removed = original.filter((url) => !attachments.includes(url));
  const notesChanged = (notes.trim() || null) !== (voucher.notes ?? null);
  const nothingToDo = added.length === 0 && removed.length === 0 && !notesChanged;

  const handleSave = async () => {
    try {
      if (added.length || removed.length || notesChanged) {
        await annotate.mutateAsync({
          voucherId: voucher.id,
          addAttachments: added,
          removeAttachments: removed,
          // Chỉ gửi ghi chú khi thật sự đổi — gửi thừa sẽ đụng vào bộ canh dấu
          // hiệu tiền trong ghi chú mà chẳng để làm gì.
          notes: notesChanged ? (notes.trim() ? notes.trim() : "") : null,
        });
      }
      // Đổi sổ quỹ đi RPC RIÊNG (chuyển tiền thật giữa hai két) — chạy SAU khi
      // ảnh/ghi chú đã lưu để lỗi ở đây không nuốt mất phần kia.
      if (accountChanged) {
        await moveCashbook.mutateAsync({
          voucherId: voucher.id,
          newAccountId: accountId,
          reason: moveReason.trim(),
        });
      }
      onOpenChange(false);
    } catch {
      // toast đã xử lý trong hook
    }
  };

  const busy = annotate.isPending || moveCashbook.isPending;
  const moveReasonTooShort = accountChanged && moveReason.trim().length < 8;

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
          <DialogTitle>
            {canMoveCashbook
              ? "SỬA SỔ QUỸ / CHỨNG TỪ / GHI CHÚ"
              : "BỔ SUNG CHỨNG TỪ / GHI CHÚ"}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {canMoveCashbook ? (
            <>
              Sửa sổ quỹ, ảnh chứng từ và ghi chú cho phiếu <b>{voucher.code}</b>{" "}
              — làm được ở mọi trạng thái, kể cả phiếu đã ghi sổ. Số tiền, hạng
              mục, người nhận/trả không sửa ở đây; cần đổi thì huỷ phiếu rồi lập
              lại.
            </>
          ) : (
            <>
              Bổ sung ảnh chứng từ và ghi chú cho phiếu <b>{voucher.code}</b> —
              làm được ở mọi trạng thái, kể cả phiếu đã ghi sổ. Số tiền, hạng
              mục, sổ quỹ, người nhận/trả không sửa ở đây; cần đổi thì huỷ phiếu
              rồi lập lại.
            </>
          )}
        </p>

        <div className="space-y-4 mt-2">
          {canMoveCashbook && (
            <div className="space-y-2">
              <Label htmlFor="quick-edit-cashbook">Sổ quỹ</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="quick-edit-cashbook">
                  <SelectValue placeholder="Chọn sổ quỹ" />
                </SelectTrigger>
                <SelectContent>
                  {/* Sổ hiện tại luôn có mặt để người dùng thấy mình đang ở đâu,
                      kể cả khi họ chỉ BIẾT chứ không GIỮ sổ đó. */}
                  {voucher.account_id && (
                    <SelectItem value={voucher.account_id}>
                      {currentBookName} (đang dùng)
                    </SelectItem>
                  )}
                  {moveOptions.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {accountChanged ? (
                <div className="space-y-1">
                  <Textarea
                    value={moveReason}
                    onChange={(e) => setMoveReason(e.target.value)}
                    placeholder="Lý do đổi sổ quỹ (bắt buộc, ít nhất 8 ký tự) — ví dụ: ghi nhầm sổ khi thu tiền"
                    rows={2}
                  />
                  <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    Tiền của phiếu sẽ <b>rút khỏi sổ cũ và cộng vào sổ mới</b>{" "}
                    ngay. Chỉ đổi được sổ bạn đang giữ sang sổ bạn giữ hoặc biết;
                    tiền thối (nếu có) vẫn nằm ở sổ cũ của nó.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Chỉ hiện các sổ quỹ bạn đang giữ hoặc được chia sẻ.
                </p>
              )}
            </div>
          )}
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Huỷ
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              busy || (nothingToDo && !accountChanged) || moveReasonTooShort
            }
          >
            {busy ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default IncomeExpenseQuickEditDialog;
