// Đợt 6 — hộp thư "đang chờ tôi ký" + đường ra biên bản đã ký.
//
// Nghi thức đối soát CŨ chết đúng ở chỗ này: `propose_reconciliation` tạo được
// bản PENDING nhưng KHÔNG có màn hình nào để bên kia bấm xác nhận
// (useConfirmReconciliation là code chết, không ai import). Một đề nghị gửi đi
// là treo vĩnh viễn. Cửa này là thứ giữ cho nghi thức mới không chết y hệt.
//
// Cùng lý do đó, khối "biên bản đã ký" nằm ngay đây: closures ghi vào
// app_private.cashbook_closures, không bảng nào ở FE join tới, nên nếu không có
// một đường link thì trang biên bản in được sẽ là một URL không ai bấm tới.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Inbox } from "lucide-react";
import {
  useCashbookClosings,
  type ConfirmedClosure,
  type PendingClosure,
} from "@/hooks/useCashbookClosing";
import ConfirmCashbookClosingDialog from "./ConfirmCashbookClosingDialog";

function fmtVND(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return new Intl.NumberFormat("vi-VN").format(Number(n)) + "đ";
}

/** Đường dẫn biên bản in được của một lần chốt đã ký. */
export const closureRecordPath = (closureId: number | string) =>
  `/finance/cashbooks/closure/${closureId}`;

export interface CashbookClosingInboxProps {
  /** Lọc theo một sổ (bỏ trống = mọi sổ người dùng thấy được). */
  cashbookId?: string | null;
  /**
   * "mobile" = thu nhỏ chữ + xếp dọc cho khung 432px của trang app điện thoại.
   * Chỉ đổi cách bày, KHÔNG đổi luồng: vẫn cùng RPC, cùng hộp thoại ký.
   */
  variant?: "desktop" | "mobile";
  /** Số biên bản đã ký hiển thị gần nhất. */
  recentLimit?: number;
  /**
   * Deep-link `?confirm=<request_id>` từ thông báo E6b: tự mở hộp thoại ký khi
   * dòng tương ứng đã về. Dialog do component này sở hữu (nó có sẵn
   * `PendingClosure` đầy đủ), nên trang chỉ cần chuyển id xuống.
   */
  autoOpenRequestId?: string | null;
}

export default function CashbookClosingInbox({
  cashbookId = null,
  variant = "desktop",
  recentLimit = 5,
  autoOpenRequestId = null,
}: CashbookClosingInboxProps) {
  const { data } = useCashbookClosings(cashbookId);
  const [target, setTarget] = useState<PendingClosure | null>(null);
  const pending = data?.pending ?? [];

  // Mở đúng MỘT lần cho mỗi request_id: query poll 60s nên effect chạy lại
  // nhiều lượt, không chốt lại thì hộp thoại bật lên sau khi người dùng đóng.
  const autoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoOpenRequestId) {
      autoOpenedRef.current = null;
      return;
    }
    if (autoOpenedRef.current === autoOpenRequestId) return;
    const row = pending.find((p) => p.request_id === autoOpenRequestId);
    if (!row) return; // dữ liệu chưa về — thử lại ở lượt sau
    autoOpenedRef.current = autoOpenRequestId;
    // Không phải người ký thì đừng mở hộp thoại ký; dòng vẫn hiện trong danh sách.
    if (row.is_mine_to_confirm) setTarget(row);
  }, [autoOpenRequestId, pending]);

  const closures: ConfirmedClosure[] = (data?.closures ?? []).slice(0, recentLimit);

  if (pending.length === 0 && closures.length === 0) return null;

  const mine = pending.filter((p) => p.is_mine_to_confirm);
  const others = pending.filter((p) => !p.is_mine_to_confirm);
  const isMobile = variant === "mobile";
  const bodyText = isMobile ? "text-xs" : "text-sm";

  return (
    <>
      {pending.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900">
            <Inbox className="h-4 w-4 shrink-0" />
            Đề nghị chốt sổ đang chờ
            {mine.length > 0 && (
              <Badge className="bg-red-600 hover:bg-red-600">{mine.length} chờ bạn ký</Badge>
            )}
          </div>
          <ul className="space-y-2">
            {[...mine, ...others].map((p) => (
              <li
                key={p.request_id}
                className={
                  isMobile
                    ? "rounded-md bg-white px-3 py-2 text-xs"
                    : "flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm"
                }
              >
                <div className="min-w-0">
                  <span className="font-medium">{p.cashbook_name}</span>
                  <span className="text-muted-foreground">
                    {" "}· {p.proposed_by_name ?? "người giữ sổ"} đề nghị chốt tới {p.closed_through}
                    {" "}· đã đếm <span className="tabular-nums">{fmtVND(p.counted_balance)}</span>
                    {Number(p.difference) !== 0 && (
                      <span className="text-amber-800">
                        {" "}(lệch {fmtVND(p.difference)})
                      </span>
                    )}
                  </span>
                </div>
                {p.is_mine_to_confirm ? (
                  <Button
                    size="sm"
                    className={`bg-red-600 hover:bg-red-700 ${isMobile ? "mt-2 w-full" : ""}`}
                    onClick={() => setTarget(p)}
                  >
                    Xem &amp; ký nhận
                  </Button>
                ) : (
                  <span className={`text-xs text-muted-foreground ${isMobile ? "mt-1 block" : ""}`}>
                    chờ {p.confirmer_name ?? "người nhận"} ký
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {closures.length > 0 && (
        <div className="mb-4 rounded-lg border bg-white p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 shrink-0 text-emerald-700" />
            Biên bản chốt sổ đã ký
          </div>
          <ul className="space-y-1.5">
            {closures.map((c) => (
              <li
                key={c.closure_id}
                className={
                  isMobile
                    ? `rounded-md bg-zinc-50 px-2.5 py-2 ${bodyText}`
                    : `flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-50 px-3 py-2 ${bodyText}`
                }
              >
                <div className="min-w-0">
                  <span className="font-medium">{c.cashbook_name}</span>
                  <span className="text-muted-foreground">
                    {" "}· chốt tới {c.closed_through} · đã đếm{" "}
                    <span className="tabular-nums">{fmtVND(c.counted_balance)}</span>
                    {Number(c.difference) !== 0 && (
                      <span className="text-amber-800"> (lệch {fmtVND(c.difference)})</span>
                    )}
                  </span>
                </div>
                <Link
                  to={closureRecordPath(c.closure_id)}
                  className={`text-blue-600 underline underline-offset-2 ${
                    isMobile ? "mt-1 inline-block font-medium" : "shrink-0"
                  }`}
                >
                  Xem biên bản
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmCashbookClosingDialog
        open={!!target}
        onOpenChange={(o) => { if (!o) setTarget(null); }}
        request={target}
      />
    </>
  );
}
