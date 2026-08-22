import { useState } from "react";
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
import { CurrencyInput } from "@/components/ui/currency-input";
import { AlertTriangle } from "lucide-react";
import { useSetReservationHoldTerms } from "@/hooks/useReservationHoldDeadlines";
import { formatCurrency } from "@/lib/utils";
import { addDaysISO, diffDaysISO, formatISODateVN, vnTodayISO } from "@/lib/vnDate";

/**
 * Đặt / gia hạn / bỏ KỲ HẠN của một phiếu cọc giữ chỗ.
 *
 * HAI MỐC, HAI RỦI RO — hộp thoại cố ý tách hẳn hai khối:
 *   hạn bổ sung cọc  lỡ là khách MẤT TIỀN đã trả
 *   hạn làm hợp đồng lỡ là chủ MẤT PHÒNG vài ngày
 * Gộp làm một ô thì mất khả năng nói "còn 2 ngày nữa mất cọc" trong khi phòng
 * vẫn đang được giữ bình thường.
 *
 * VÌ SAO CẦN: không có nó thì thẻ đỏ trên bàn xử lý là ngõ cụt — lối ra duy
 * nhất là ký hợp đồng, mà thực tế khách hay xin thêm vài ngày. Thẻ không bao
 * giờ rời hàng đợi sẽ dạy người dùng bỏ qua màu đỏ.
 */
export interface HoldDeadlineTarget {
  voucherId: string;
  label: string;
  holdUntil: string | null;
  topupDueDate: string | null;
  depositTarget: number | null;
  /** Đã thu được bao nhiêu trên phòng này — để tính "còn thiếu". */
  paidAmount: number | null;
}

const QUICK_DAYS = [3, 5, 7, 14];

export function HoldDeadlineDialog({
  target,
  onOpenChange,
}: {
  target: HoldDeadlineTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      {/*
        `key` theo id phiếu: nội dung được DỰNG LẠI cho từng phiếu, nên state
        khởi tạo thẳng từ `target` thay vì nạp qua useEffect.

        VÌ SAO KHÔNG DÙNG useEffect: `CurrencyInput` cố ý bỏ qua đồng bộ khi ô
        đang focus (`if (focused) return`) — đúng, không ai muốn bị giành chữ
        đang gõ. Mà hộp thoại tự focus vào đúng ô "Cọc cần đủ" lúc mở, nên giá
        trị nạp sau đó KHÔNG bao giờ hiện: ô báo 0 trong khi state là 8.000.000.
        Đã đo trên màn thật; dòng "còn thiếu" ngay dưới vẫn đúng nên lỗi rất dễ
        lọt qua nếu chỉ đọc code.
      */}
      {target && <HoldDeadlineForm key={target.voucherId} target={target} onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

function HoldDeadlineForm({
  target,
  onOpenChange,
}: {
  target: HoldDeadlineTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const setTerms = useSetReservationHoldTerms();
  const [hold, setHold] = useState(target.holdUntil ?? "");
  const [topup, setTopup] = useState(target.topupDueDate ?? "");
  const [depositTarget, setDepositTarget] = useState(target.depositTarget ?? 0);

  const today = vnTodayISO();
  const holdDays = diffDaysISO(hold || null, today);
  const topupDays = diffDaysISO(topup || null, today);
  const topupSauHold = !!topup && !!hold && (diffDaysISO(topup, hold) ?? 0) > 0;
  const conThieu =
    target.paidAmount === null
      ? 0
      : Math.max(0, Math.round(depositTarget) - Math.round(target.paidAmount));

  const submit = (xoaHet: boolean) => {
    setTerms.mutate(
      {
        incomeExpenseId: target.voucherId,
        holdUntil: xoaHet ? null : hold || null,
        topupDueDate: xoaHet ? null : topup || null,
        depositTarget: xoaHet ? null : depositTarget > 0 ? depositTarget : null,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const luuDuoc = !topupSauHold && (!!hold || !!topup || depositTarget > 0);

  return (
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Kỳ hạn phiếu cọc giữ chỗ</DialogTitle>
          <DialogDescription>{target.label}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ── Mốc MẤT TIỀN đặt trước, vì nó đắt hơn ─────────────────────── */}
          <div className="space-y-2 rounded-lg border p-3">
            <div className="text-[13px] font-bold">Hạn bổ sung cọc cho đủ</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[11.5px] font-semibold text-muted-foreground">
                  Cọc cần đủ
                </div>
                <CurrencyInput
                  value={depositTarget}
                  onChange={(v) => setDepositTarget(Number(v) || 0)}
                  name="deposit_target"
                />
              </div>
              <div>
                <div className="mb-1 text-[11.5px] font-semibold text-muted-foreground">
                  Hạn bổ sung
                </div>
                <DateInput value={topup} onChange={setTopup} name="topup_due_date" />
              </div>
            </div>
            {target.paidAmount !== null && (
              <p className="text-[11.5px] text-muted-foreground">
                Đã thu trên phòng này: {formatCurrency(target.paidAmount)}
                {conThieu > 0 && (
                  <>
                    {" · còn thiếu "}
                    <strong className="text-orange-600">{formatCurrency(conThieu)}</strong>
                  </>
                )}
              </p>
            )}
            {topupDays !== null && conThieu > 0 && (
              <p className={"text-[12px] " + (topupDays < 0 ? "text-red-600" : "text-muted-foreground")}>
                {topupDays < 0
                  ? `Đã quá ${-topupDays} ngày — phiếu đang ở nhóm nguy cơ mất cọc.`
                  : topupDays === 0
                    ? "Hạn là HÔM NAY."
                    : `Còn ${topupDays} ngày.`}
              </p>
            )}
          </div>

          {/* ── Mốc MẤT PHÒNG ─────────────────────────────────────────────── */}
          <div className="space-y-2 rounded-lg border p-3">
            <div className="text-[13px] font-bold">Hạn phải làm hợp đồng</div>
            <div className="flex flex-wrap gap-2">
              {QUICK_DAYS.map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setHold(addDaysISO(today, d) ?? "")}
                >
                  +{d} ngày
                </Button>
              ))}
            </div>
            <DateInput value={hold} onChange={setHold} name="hold_until" />
            {holdDays !== null && (
              <p className={"text-[12px] " + (holdDays < 0 ? "text-red-600" : "text-muted-foreground")}>
                {holdDays < 0
                  ? `Đã quá ${-holdDays} ngày — phòng đang bị treo.`
                  : holdDays === 0
                    ? "Hạn là HÔM NAY."
                    : `Còn ${holdDays} ngày — phải ký hợp đồng trước ${formatISODateVN(hold)}.`}
              </p>
            )}
          </div>

          {topupSauHold && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-700">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span>
                Hạn bổ sung <strong>sau</strong> hạn làm hợp đồng — tới ngày đó phòng đã
                nhả khoá, mốc bổ sung thành vô nghĩa. Sửa lại trước khi lưu.
              </span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {target.holdUntil || target.topupDueDate || target.depositTarget ? (
            <Button
              type="button"
              variant="ghost"
              className="text-red-600 hover:text-red-700"
              disabled={setTerms.isPending}
              onClick={() => submit(true)}
            >
              Bỏ hết kỳ hạn
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
              disabled={!luuDuoc || setTerms.isPending}
              onClick={() => submit(false)}
            >
              {setTerms.isPending ? "Đang lưu..." : "Lưu kỳ hạn"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
  );
}
