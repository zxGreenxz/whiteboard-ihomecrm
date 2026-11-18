// Thẻ «Đơn xin nghỉ chờ duyệt» trên các màn Hôm nay (/my-day, /my-day/team, /my-day/nguoi/:id).
//
// VÌ SAO CÓ: trước 19/11/2026 nút Duyệt/Từ chối CHỈ nằm ở Bảng lương → tab «Đơn xin nghỉ».
// Chủ mở Hôm nay, chọn quản lý, thấy nhãn «Chờ duyệt phép» mà không có chỗ bấm — đơn treo.
//
// Cùng nguồn và cùng RPC với tab ở Bảng lương (usePendingLeaveRequests / useApproveLeave),
// không có đường duyệt thứ hai. Chỉ hiện với super admin vì `approve_leave` gác
// `is_admin()` = `is_super_admin()`: hiện nút cho người khác thì bấm chỉ nhận lỗi không có quyền.
// Chưa xác nhận được quyền (đang tải/lỗi đọc quyền) ⇒ không hiện nút; lỗi đọc danh sách đơn thì
// báo lỗi, không giả là «không có đơn».
import { CalendarCheck } from "lucide-react";
import { toast } from "sonner";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle } from "@/components/staff-day/StaffShell";
import { Button } from "@/components/ui/button";
import { useIsSuperAdmin } from "@/hooks/useIsAdmin";
import { leaveActionErrorMessage, useApproveLeave, usePendingLeaveRequests, type PendingLeaveRequest } from "@/hooks/useMyDay";

function dmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** `userId`: chỉ hiện đơn của người này (trang một quản lý); bỏ trống = mọi đơn đang chờ. */
export function LeaveApprovalCard({ userId }: { userId?: string }) {
  const superAdmin = useIsSuperAdmin();
  const canApprove = superAdmin.data === true;
  const query = usePendingLeaveRequests(canApprove);
  const approve = useApproveLeave();

  if (!canApprove) return null;
  const rows = (query.data ?? []).filter((row) => !userId || row.user_id === userId);
  // Đang tải lần đầu hoặc không có đơn: không chiếm chỗ. Lỗi đọc thì luôn đi qua QueryRegion.
  if (!query.isError && rows.length === 0) return null;

  const decide = (row: PendingLeaveRequest, ok: boolean) => {
    approve.mutate(
      { user: row.user_id, date: row.work_date, approve: ok },
      {
        onSuccess: () => toast.success(`Đã ${ok ? "duyệt" : "từ chối"} đơn nghỉ ngày ${dmy(row.work_date)} của ${row.staff_name}.`),
        onError: (error: unknown) => toast.error(leaveActionErrorMessage(error, { date: row.work_date, approve: ok, employeeName: row.staff_name })),
      },
    );
  };

  return (
    // Lỗi không có bản cũ ⇒ QueryRegion báo lỗi + Tải lại; lỗi mạng còn bản cũ ⇒ cảnh báo + vẫn hiện đơn.
    <QueryRegion label="đơn nghỉ chờ duyệt" queries={[query]} skeleton="none">
      {rows.length > 0 ? <LeaveRows rows={rows} busy={approve.isPending} working={approve.isPending ? approve.variables : undefined} onDecide={decide} /> : null}
    </QueryRegion>
  );
}

function LeaveRows({ rows, busy, working, onDecide }: {
  rows: readonly PendingLeaveRequest[];
  busy: boolean;
  working: { user: string; date: string; approve: boolean } | undefined;
  onDecide: (row: PendingLeaveRequest, ok: boolean) => void;
}) {
  return (
    <Card label="Đơn xin nghỉ chờ duyệt" className="border-sky-200">
      <CardTitle icon={<CalendarCheck className="h-[18px] w-[18px] text-sky-600" aria-hidden="true" />} right={`${rows.length} đơn`}>
        Đơn xin nghỉ chờ duyệt
      </CardTitle>
      {rows.map((row) => {
        // Một lượt gửi chạy thì khoá mọi nút: hai quyết định chạy song song dễ bấm nhầm đơn khác.
        const mine = working !== undefined && working.user === row.user_id && working.date === row.work_date;
        const label = `đơn nghỉ ngày ${dmy(row.work_date)} của ${row.staff_name}`;
        return (
          <div key={`${row.user_id}-${row.work_date}`} className="flex flex-wrap items-center gap-2 rounded-[10px] border px-2.5 py-2">
            {/* Ngày đứng riêng một dòng không cắt: khổ 390px cạnh hai nút, dòng gộp «tên · ngày» bị cắt mất ngày. */}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">{row.staff_name}</div>
              <div className="whitespace-nowrap text-[13px] font-medium text-sky-800">Nghỉ ngày {dmy(row.work_date)}</div>
              <div className="truncate text-xs text-muted-foreground">{row.reason || "Không ghi lý do"}</div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={`Từ chối ${label}`} onClick={() => onDecide(row, false)}>
                {mine && working?.approve === false ? "Đang từ chối…" : "Từ chối"}
              </Button>
              <Button type="button" size="sm" disabled={busy} aria-label={`Duyệt ${label}`} onClick={() => onDecide(row, true)}>
                {mine && working?.approve === true ? "Đang duyệt…" : "Duyệt"}
              </Button>
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">Duyệt xong nhân viên nhận thông báo kết quả. Cũng xem được ở Bảng lương → Đơn xin nghỉ.</p>
    </Card>
  );
}
