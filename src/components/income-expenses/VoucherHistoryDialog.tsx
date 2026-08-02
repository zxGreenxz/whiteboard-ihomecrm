// Lịch sử một phiếu thu/chi — vế "đánh đổi" của Đợt 4.
//
// Chủ chấp nhận cho huỷ thẳng (trừ luôn khỏi sổ quỹ, không sinh phiếu đối ứng)
// với điều kiện phiếu phải TỰ GIẢI THÍCH ĐƯỢC về sau. Màn này là chỗ đọc lại:
//   • mốc lập / duyệt / huỷ + ai huỷ + lý do   → get_voucher_cancellation_v1
//   • giá trị TRƯỚC / SAU của mọi lần sửa      → get_voucher_change_log_v1
// Dùng chung desktop và mobile (Dialog render qua portal).

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, CircleAlert, FilePlus2, History, Stamp, Ban } from "lucide-react";
import {
  useVoucherCancellation,
  useVoucherChangeLog,
} from "@/hooks/income-expenses/flexMutations";
import {
  cancellationKindText,
  formatLogMoment,
  formatMoney,
  humanizeChangeLog,
} from "./voucherHistoryFormat";

export interface VoucherHistoryTarget {
  id: string;
  code?: string | null;
  name?: string | null;
  /** Mốc lập lấy từ dòng danh sách khi phiếu CHƯA huỷ (bảng dấu vết chưa có dòng). */
  created_at?: string | null;
  approved_at?: string | null;
  total_amount?: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: VoucherHistoryTarget | null;
}

interface MilestoneProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
  detail?: React.ReactNode;
}

const Milestone = ({ icon, label, value, tone, detail }: MilestoneProps) => (
  <div className="flex gap-3">
    <div
      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone}`}
    >
      {icon}
    </div>
    <div className="min-w-0 flex-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-medium">{value}</div>
      {detail ? <div className="mt-1 text-sm">{detail}</div> : null}
    </div>
  </div>
);

const VoucherHistoryDialog = ({ open, onOpenChange, voucher }: Props) => {
  const voucherId = open ? voucher?.id ?? null : null;
  const { data: cancellation, isLoading: loadingCancel } =
    useVoucherCancellation(voucherId);
  const { data: changeLog, isLoading: loadingLog, error: logError } =
    useVoucherChangeLog(voucherId);

  const entries = humanizeChangeLog(changeLog);
  const kind = cancellationKindText(cancellation?.cancellation_kind);

  // Phiếu chưa huỷ thì bảng dấu vết chưa có dòng — mốc lập/duyệt vẫn lấy được
  // từ chính dòng danh sách đang mở.
  const createdAt = cancellation?.created_at ?? voucher?.created_at ?? null;
  const approvedAt = cancellation?.approved_at ?? voucher?.approved_at ?? null;
  const amount = cancellation?.amount ?? voucher?.total_amount ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-blue-600" />
            Lịch sử phiếu {voucher?.code ?? ""}
          </DialogTitle>
          <DialogDescription>
            {voucher?.name ?? "Mốc thời gian và mọi thay đổi đã ghi nhận của phiếu này."}
          </DialogDescription>
        </DialogHeader>

        {/* ── Mốc lập / duyệt / huỷ ───────────────────────────────────────── */}
        <section className="space-y-3 rounded-lg border border-zinc-200 p-3">
          <h3 className="text-sm font-semibold">Mốc thời gian</h3>
          {loadingCancel ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <div className="space-y-3">
              <Milestone
                icon={<FilePlus2 className="h-4 w-4" />}
                label="Lập phiếu"
                tone="bg-slate-100 text-slate-600"
                value={formatLogMoment(createdAt)}
                detail={
                  amount !== null ? (
                    <span className="text-muted-foreground">
                      Số tiền {formatMoney(Number(amount))}
                    </span>
                  ) : null
                }
              />
              <Milestone
                icon={<Stamp className="h-4 w-4" />}
                label="Duyệt"
                tone="bg-emerald-100 text-emerald-700"
                value={approvedAt ? formatLogMoment(approvedAt) : "Chưa duyệt"}
              />
              {cancellation?.cancelled_at ? (
                <Milestone
                  icon={<Ban className="h-4 w-4" />}
                  label="Huỷ"
                  tone="bg-red-100 text-red-700"
                  value={formatLogMoment(cancellation.cancelled_at)}
                  detail={
                    <div className="space-y-1">
                      <div>
                        Người huỷ:{" "}
                        <b>{cancellation.cancelled_by_name ?? "(không rõ)"}</b>
                      </div>
                      <div>
                        Lý do:{" "}
                        <b className="text-red-700">
                          {cancellation.cancel_reason ?? "(không ghi)"}
                        </b>
                      </div>
                      {kind ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{kind.label}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {kind.hint}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  }
                />
              ) : (
                <Milestone
                  icon={<Ban className="h-4 w-4" />}
                  label="Huỷ"
                  tone="bg-zinc-100 text-zinc-400"
                  value="Chưa huỷ"
                />
              )}
            </div>
          )}
        </section>

        {/* ── Nhật ký thay đổi trước / sau ────────────────────────────────── */}
        <section className="space-y-3 rounded-lg border border-zinc-200 p-3">
          <h3 className="text-sm font-semibold">Nhật ký thay đổi</h3>

          {loadingLog ? (
            <Skeleton className="h-24 w-full" />
          ) : logError ? (
            <p className="flex items-center gap-2 text-sm text-red-600">
              <CircleAlert className="h-4 w-4" />
              Không đọc được nhật ký: {(logError as Error).message}
            </p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Chưa ghi nhận thay đổi nào sau khi lập phiếu.
            </p>
          ) : (
            <ol className="space-y-3">
              {entries.map((entry, idx) => (
                <li
                  key={`${entry.at}-${idx}`}
                  className="rounded-md border border-zinc-100 bg-zinc-50/60 p-2.5"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium">{entry.headline}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.atText}
                    </span>
                  </div>
                  {entry.changes.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      (không có trường nào đọc được)
                    </p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {entry.changes.map((c) => (
                        <li
                          key={c.column}
                          className={
                            c.technical
                              ? "flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                              : "flex flex-wrap items-center gap-1.5 text-sm"
                          }
                        >
                          <span className="font-medium">{c.label}:</span>
                          <span className="rounded bg-white px-1.5 py-0.5 line-through decoration-zinc-400">
                            {c.before}
                          </span>
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800">
                            {c.after}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
};

export default VoucherHistoryDialog;
