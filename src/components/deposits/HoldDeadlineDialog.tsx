import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { useSetReservationHoldDeadline } from "@/hooks/useReservationHoldDeadlines";
import { addDaysISO, diffDaysISO, formatISODateVN, vnTodayISO } from "@/lib/vnDate";

/**
 * Đặt / gia hạn / bỏ "hạn phải làm hợp đồng" của một phiếu cọc giữ chỗ.
 *
 * VÌ SAO CẦN: không có nó thì thẻ đỏ "QUÁ HẠN LÀM HỢP ĐỒNG" là ngõ cụt — lối ra
 * duy nhất là ký hợp đồng, mà thực tế khách hay xin thêm vài ngày. Thẻ không
 * bao giờ rời hàng đợi sẽ dạy người dùng bỏ qua màu đỏ, và khi đó nhóm này mất
 * hết tác dụng.
 *
 * Ghi qua `set_reservation_hold_deadline_v1` (kiểm quyền toà + tư cách phiếu);
 * bỏ hạn = truyền null, đó là hành vi hợp lệ chứ không phải lỗi.
 */
export interface HoldDeadlineTarget {
  voucherId: string;
  label: string;
  /** Hạn hiện tại, "YYYY-MM-DD" hoặc null nếu chưa đặt. */
  current: string | null;
}

const QUICK_DAYS = [3, 5, 7, 14];

export function HoldDeadlineDialog({
  target,
  onOpenChange,
}: {
  target: HoldDeadlineTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const setDeadline = useSetReservationHoldDeadline();
  const [value, setValue] = useState("");

  // Mở lại cho phiếu khác thì phải nạp lại hạn của phiếu ĐÓ. Giữ state cũ sẽ
  // đề nghị ngày của phiếu trước — sai âm thầm.
  useEffect(() => {
    setValue(target?.current ?? "");
  }, [target]);

  const today = vnTodayISO();
  const days = diffDaysISO(value || null, today);

  const submit = (next: string | null) => {
    if (!target) return;
    setDeadline.mutate(
      { incomeExpenseId: target.voucherId, holdUntil: next },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hạn phải làm hợp đồng</DialogTitle>
          <DialogDescription>
            {target?.label} — quá ngày này phiếu vào nhóm "quá hạn làm HĐ" trên bàn xử lý.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {QUICK_DAYS.map((d) => (
              <Button
                key={d}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setValue(addDaysISO(today, d) ?? "")}
              >
                +{d} ngày
              </Button>
            ))}
          </div>

          <DateInput value={value} onChange={setValue} name="hold_until" />

          {days !== null && (
            <p
              className={
                "text-[12.5px] " + (days < 0 ? "text-red-600" : "text-muted-foreground")
              }
            >
              {days < 0
                ? `Ngày này đã qua ${-days} ngày — phiếu vẫn nằm ở nhóm quá hạn.`
                : days === 0
                  ? "Hạn là HÔM NAY."
                  : `Còn ${days} ngày — phải ký hợp đồng trước ${formatISODateVN(value)}.`}
            </p>
          )}
          {target?.current && (
            <p className="text-[12px] text-muted-foreground">
              Hạn hiện tại: {formatISODateVN(target.current)}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {target?.current ? (
            <Button
              type="button"
              variant="ghost"
              className="text-red-600 hover:text-red-700"
              disabled={setDeadline.isPending}
              onClick={() => submit(null)}
            >
              Bỏ hạn
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button
              type="button"
              disabled={!value || setDeadline.isPending}
              onClick={() => submit(value)}
            >
              {setDeadline.isPending ? "Đang lưu..." : "Lưu hạn"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
