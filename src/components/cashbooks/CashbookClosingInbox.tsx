// Đợt 6 — hộp thư "đang chờ tôi ký".
//
// Nghi thức đối soát CŨ chết đúng ở chỗ này: `propose_reconciliation` tạo được
// bản PENDING nhưng KHÔNG có màn hình nào để bên kia bấm xác nhận
// (useConfirmReconciliation là code chết, không ai import). Một đề nghị gửi đi
// là treo vĩnh viễn. Cửa này là thứ giữ cho nghi thức mới không chết y hệt.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Inbox } from "lucide-react";
import { useCashbookClosings, type PendingClosure } from "@/hooks/useCashbookClosing";
import ConfirmCashbookClosingDialog from "./ConfirmCashbookClosingDialog";

function fmtVND(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return new Intl.NumberFormat("vi-VN").format(Number(n)) + "đ";
}

export default function CashbookClosingInbox() {
  const { data } = useCashbookClosings();
  const [target, setTarget] = useState<PendingClosure | null>(null);
  const pending = data?.pending ?? [];

  if (pending.length === 0) return null;

  const mine = pending.filter((p) => p.is_mine_to_confirm);
  const others = pending.filter((p) => !p.is_mine_to_confirm);

  return (
    <>
      <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900">
          <Inbox className="h-4 w-4" />
          Đề nghị chốt sổ đang chờ
          {mine.length > 0 && (
            <Badge className="bg-red-600 hover:bg-red-600">{mine.length} chờ bạn ký</Badge>
          )}
        </div>
        <ul className="space-y-2">
          {[...mine, ...others].map((p) => (
            <li
              key={p.request_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm"
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
                <Button size="sm" className="bg-red-600 hover:bg-red-700"
                        onClick={() => setTarget(p)}>
                  Xem &amp; ký nhận
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  chờ {p.confirmer_name ?? "người nhận"} ký
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <ConfirmCashbookClosingDialog
        open={!!target}
        onOpenChange={(o) => { if (!o) setTarget(null); }}
        request={target}
      />
    </>
  );
}
