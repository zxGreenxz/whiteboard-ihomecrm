import { useState, useSyncExternalStore } from "react";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatPendingTime } from "@/lib/financialPending";
import {
  pendingOperationName,
  pendingValve,
  PendingValveError,
  type PendingValve,
  type PendingValveNotice,
} from "@/lib/pendingValve";

/**
 * Hộp cảnh báo dùng chung, gắn MỘT lần ở gốc ứng dụng. Hiện khi một lần ghi bị chặn bởi dấu «chờ đối
 * chiếu» của lần gửi trước mà máy không tự kết luận được.
 *
 * - Dấu chưa quá 2 phút kể từ hoạt động cuối, hoặc lượt ghi còn chạy trong tab: chỉ báo đang chờ kết quả, không cho gỡ.
 * - Dấu đã quá 2 phút: nêu việc nào kẹt, lúc mấy giờ, mã bản ghi cần xem; người dùng kiểm tra rồi tự xác nhận
 *   «Đã kiểm tra, cho làm tiếp». Lần xác nhận được ghi nhật ký trước khi gỡ dấu.
 *
 * Hộp không tự chạy lại thao tác: gỡ xong, nếu vẫn cần làm thì người dùng bấm lại ở màn đang làm, với nội
 * dung đang có trên màn.
 */
export function PendingValveDialog({ valve = pendingValve }: { valve?: PendingValve }) {
  const notice = useSyncExternalStore(valve.subscribe, valve.current, () => null);
  const waiting = useSyncExternalStore(valve.subscribe, valve.waitingCount, () => 0);
  if (!notice) return null;
  return <PendingValveNoticeDialog key={notice.pending.attemptId} valve={valve} notice={notice} others={waiting - 1} />;
}

function PendingValveNoticeDialog({ valve, notice, others }: { valve: PendingValve; notice: PendingValveNotice; others: number }) {
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  const { pending, kind, blockedOperation } = notice;
  const stale = kind === "stale";
  const name = pendingOperationName(pending);
  const sentAt = formatPendingTime(pending.startedAt);

  const recheck = () => {
    try {
      const result = valve.recheck(notice);
      if (result === "resolved") toast.success("Lần gửi trước đã có kết quả. Kiểm tra danh sách trước khi làm lại.");
      else setRecheckNote(result === "waiting"
        ? "Vẫn chưa đủ 2 phút kể từ hoạt động cuối của lần gửi trước, hoặc nó còn đang chạy. Chờ thêm rồi kiểm tra lại; nếu chờ lâu vẫn vậy, tải lại trang rồi thử lại."
        : "Máy vẫn chưa tự kết luận được. Bạn cần tự kiểm tra bản ghi liên quan.");
    } catch {
      toast.error("Chưa đọc được dấu của lần gửi trước trong trình duyệt. Thử lại sau.");
    }
  };
  const release = () => {
    try {
      valve.release(notice);
      toast.success("Đã ghi nhận và gỡ khoá. Bấm lại thao tác nếu vẫn cần làm.");
    } catch (error) {
      toast.error(error instanceof PendingValveError
        ? error.message
        : "Chưa lưu được nhật ký nên chưa gỡ khoá. Kiểm tra quyền lưu dữ liệu của trình duyệt rồi thử lại.");
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) valve.dismiss(notice); }}>
      <AlertDialogContent className="z-[70] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto rounded-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-start gap-2 text-left">
            {stale
              ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
              : <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />}
            <span>{stale ? "Lần gửi trước chưa rõ kết quả" : "Lần gửi trước đang chờ kết quả"}</span>
          </AlertDialogTitle>
          <AlertDialogDescription className="text-left">
            {stale
              ? "Máy chưa tự kết luận được lần gửi này đã được ghi hay chưa. Kiểm tra trước khi làm tiếp để tránh ghi trùng."
              : "Lần gửi trước có thể vẫn đang được xử lý. Thử lại sau ít phút."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <dl className="grid gap-3 rounded-md border bg-muted/40 p-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Thao tác đang kẹt</dt>
            <dd className="font-medium">{name ?? "Không rõ tên (dấu ghi từ bản cũ)"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Gửi lúc</dt>
            <dd className="font-medium">{sentAt}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Mã bản ghi cần xem</dt>
            {pending.completedIds.length ? (
              <dd>
                <ul className="space-y-1">
                  {pending.completedIds.map((id) => (
                    <li key={id} className="break-all font-mono text-xs">{id}</li>
                  ))}
                </ul>
              </dd>
            ) : (
              <dd className="font-medium">Chưa có mã nào được ghi nhận</dd>
            )}
          </div>
          {blockedOperation && blockedOperation !== name && (
            <div>
              <dt className="text-muted-foreground">Bạn vừa bấm</dt>
              <dd className="font-medium">{blockedOperation}</dd>
            </div>
          )}
        </dl>

        {stale && (
          <p className="text-sm text-muted-foreground">
            Mở danh sách liên quan và tìm bản ghi của lần gửi lúc {sentAt}. Kiểm tra xong, chọn «Đã kiểm tra, cho
            làm tiếp» để gỡ khoá: bản ghi chưa có thì bấm lại thao tác, đã có thì không cần làm lại. Lần xác
            nhận này được ghi vào nhật ký.
          </p>
        )}
        {recheckNote && <p role="status" className="text-sm font-medium">{recheckNote}</p>}
        {others > 0 && (
          <p className="text-xs text-muted-foreground">Còn {others} lần gửi khác đang chờ xem sau hộp này.</p>
        )}

        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <AlertDialogCancel className="mt-0">Đóng</AlertDialogCancel>
          <Button type="button" variant="outline" onClick={recheck}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Kiểm tra lại
          </Button>
          {stale && (
            <Button type="button" onClick={release}>Đã kiểm tra, cho làm tiếp</Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
