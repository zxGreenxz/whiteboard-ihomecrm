// Lịch sử sửa phiếu Chờ duyệt / đổi hình thức thu (đợt 1 sửa phiếu, 25/09/2026).
//
// Ba mảnh dùng chung cho mọi mặt Thu chi:
//   RevisionCountBadges — dấu "Đã sửa N lần" trên bảng/danh sách
//   RevisionComparison  — hộp Duyệt: "trước khi sửa → hiện tại" + từng lần sửa (ai, lúc nào, lý do)
//   RevisionHistory     — màn chi tiết: từng lần sửa kèm các trường đổi
// Dữ liệu: income_expense_revisions (RLS cùng tầm nhìn phiếu). Lần sửa cũ trước ngày
// áp dụng không có ở đây — vẫn xem ở "Lịch sử phiếu".

import { History, Pencil, Repeat2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useIncomeExpenseRevisions } from "@/hooks/income-expenses/revisions";
import {
  diffRevisionSnapshots,
  revisionFieldLabel,
  summarizePendingRevisions,
  type IncomeExpenseRevision,
  type RevisionDiffRow,
} from "@/lib/incomeExpenseRevision";

function thoiGian(iso: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function RevisionCountBadges({
  editCount,
  methodChangeCount,
}: {
  editCount: number;
  methodChangeCount: number;
}) {
  if (editCount <= 0 && methodChangeCount <= 0) return null;
  return (
    <>
      {editCount > 0 && (
        <Badge
          variant="secondary"
          className="shrink-0 gap-1 bg-amber-100 text-amber-800 hover:bg-amber-100"
          title="Phiếu đã được sửa khi đang Chờ duyệt — mở phiếu để xem đã đổi gì"
        >
          <Pencil className="h-3 w-3" />
          Đã sửa {editCount} lần
        </Badge>
      )}
      {methodChangeCount > 0 && (
        <Badge
          variant="secondary"
          className="shrink-0 gap-1 bg-violet-100 text-violet-800 hover:bg-violet-100"
          title="Khoản thu đã được đổi hình thức thu / sổ nhận tiền"
        >
          <Repeat2 className="h-3 w-3" />
          Đổi hình thức thu {methodChangeCount} lần
        </Badge>
      )}
    </>
  );
}

function DiffTable({ rows, beforeTitle, afterTitle }: { rows: RevisionDiffRow[]; beforeTitle: string; afterTitle: string }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Không còn khác biệt so với lúc lập (đã sửa rồi sửa lại như cũ).</p>;
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="hidden grid-cols-[8rem_1fr_1fr] gap-2 bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground sm:grid">
        <span>Trường</span>
        <span>{beforeTitle}</span>
        <span>{afterTitle}</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.field}
          className="grid grid-cols-1 gap-1 border-t px-2 py-1.5 text-xs first:border-t-0 sm:grid-cols-[8rem_1fr_1fr] sm:gap-2"
        >
          <span className="font-medium">{row.label}</span>
          <div className="min-w-0 text-muted-foreground line-through decoration-rose-400/70 sm:no-underline">
            <span className="mr-1 text-[10px] uppercase text-muted-foreground sm:hidden">{beforeTitle}:</span>
            {row.before.map((line, i) => (
              <div key={i} className="break-words">{line}</div>
            ))}
          </div>
          <div className="min-w-0 font-medium text-emerald-700">
            <span className="mr-1 text-[10px] uppercase text-muted-foreground sm:hidden">{afterTitle}:</span>
            {row.after.map((line, i) => (
              <div key={i} className="break-words">{line}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RevisionEntry({ revision }: { revision: IncomeExpenseRevision }) {
  const la = revision.kind === "COLLECTION_METHOD" ? "Đổi hình thức thu" : `Lần sửa ${revision.revision_no}`;
  return (
    <div className="space-y-0.5 text-xs">
      <div>
        <span className="font-medium">{la}</span>
        <span className="text-muted-foreground"> · {revision.actor_name} · {thoiGian(revision.created_at)}</span>
      </div>
      <div className="text-muted-foreground">
        Đổi: {revision.changed_fields.map(revisionFieldLabel).join(", ")}
      </div>
      {revision.reason && <div>Lý do: {revision.reason}</div>}
    </div>
  );
}

/** Hộp Duyệt: người duyệt thấy phiếu đã bị đổi gì so với lúc lập, ai sửa, vì sao. */
export function RevisionComparison({ voucherId }: { voucherId: string }) {
  const { data: revisions = [], isLoading } = useIncomeExpenseRevisions(voucherId);
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  const tom = summarizePendingRevisions(revisions);
  if (!tom) return null;
  const edits = revisions.filter((r) => r.kind === "EDIT_PENDING");
  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
        <History className="h-4 w-4" />
        Phiếu đã được sửa {tom.count} lần khi đang Chờ duyệt
      </div>
      <DiffTable rows={tom.diff} beforeTitle="Lúc lập" afterTitle="Hiện tại" />
      <ul className="space-y-1.5">
        {edits.map((r) => (
          <li key={r.id}>
            <RevisionEntry revision={r} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Màn chi tiết: mọi lần sửa / đổi hình thức thu, mỗi lần kèm các trường đã đổi. */
export function RevisionHistory({ voucherId }: { voucherId: string }) {
  const { data: revisions = [], isLoading, isError } = useIncomeExpenseRevisions(voucherId);
  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (isError) return <p className="text-xs text-rose-600">Không tải được lịch sử sửa phiếu.</p>;
  if (revisions.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <History className="h-4 w-4" />
        Lịch sử sửa ({revisions.length})
      </div>
      <ol className="space-y-3">
        {revisions.map((r) => (
          <li key={r.id} className="space-y-1.5">
            <RevisionEntry revision={r} />
            <DiffTable
              rows={diffRevisionSnapshots(r.before_snapshot, r.after_snapshot, r.kind)}
              beforeTitle="Trước"
              afterTitle="Sau"
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
