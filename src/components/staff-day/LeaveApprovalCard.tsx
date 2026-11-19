// Thẻ «Đơn xin nghỉ chờ duyệt» trên các màn Hôm nay (/my-day, /my-day/team, /my-day/nguoi/:id).
//
// VÌ SAO CÓ: trước 19/11/2026 nút Duyệt/Từ chối CHỈ nằm ở Bảng lương → tab «Đơn xin nghỉ».
// Chủ mở Hôm nay, chọn quản lý, thấy nhãn «Chờ duyệt phép» mà không có chỗ bấm — đơn treo.
//
// Cùng nguồn với tab ở Bảng lương (usePendingLeaveRequests). Từ 19/11/2026 nhân viên xin được nhiều ngày một đơn: thẻ
// gom các ngày cùng đơn (cùng mã đơn) thành MỘT dòng và duyệt / từ chối cả đơn bằng approve_leave_batch; tab ở Bảng
// lương vẫn duyệt lẻ từng ngày. Chỉ hiện với super admin vì cả hai RPC gác `is_admin()` = `is_super_admin()`: hiện nút
// cho người khác thì bấm chỉ nhận lỗi không có quyền. Chưa xác nhận được quyền (đang tải/lỗi đọc quyền) ⇒ không hiện
// nút; lỗi đọc danh sách đơn thì báo lỗi, không giả là «không có đơn».
import { CalendarCheck } from "lucide-react";
import { toast } from "sonner";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle } from "@/components/staff-day/StaffShell";
import { Button } from "@/components/ui/button";
import { useIsSuperAdmin } from "@/hooks/useIsAdmin";
import { leaveActionErrorMessage, useApproveLeaveBatch, usePendingLeaveRequests } from "@/hooks/useMyDay";
import { groupPendingLeaves, leaveDateSpan, leaveDaysLabel, type PendingLeaveGroup } from "@/lib/leaveDates";

type Working = { user: string; dates: readonly string[]; approve: boolean };

/** `userId`: chỉ hiện đơn của người này (trang một quản lý); bỏ trống = mọi đơn đang chờ. */
export function LeaveApprovalCard({ userId }: { userId?: string }) {
  const superAdmin = useIsSuperAdmin();
  const canApprove = superAdmin.data === true;
  const query = usePendingLeaveRequests(canApprove);
  const approve = useApproveLeaveBatch();

  if (!canApprove) return null;
  const groups = groupPendingLeaves((query.data ?? []).filter((row) => !userId || row.user_id === userId));
  // Đang tải lần đầu hoặc không có đơn: không chiếm chỗ. Lỗi đọc thì luôn đi qua QueryRegion.
  if (!query.isError && groups.length === 0) return null;

  const decide = (group: PendingLeaveGroup, ok: boolean) => {
    approve.mutate(
      { user: group.user_id, dates: group.dates, approve: ok },
      {
        onSuccess: () => toast.success(`Đã ${ok ? "duyệt" : "từ chối"} đơn nghỉ ${leaveDaysLabel(group.dates)} của ${group.staff_name}.`),
        onError: (error: unknown) => toast.error(leaveActionErrorMessage(error, { date: leaveDateSpan(group.dates), approve: ok, employeeName: group.staff_name })),
      },
    );
  };

  return (
    // Lỗi không có bản cũ ⇒ QueryRegion báo lỗi + Tải lại; lỗi mạng còn bản cũ ⇒ cảnh báo + vẫn hiện đơn.
    <QueryRegion label="đơn nghỉ chờ duyệt" queries={[query]} skeleton="none">
      {groups.length > 0 ? <LeaveRows groups={groups} busy={approve.isPending} working={approve.isPending ? approve.variables : undefined} onDecide={decide} /> : null}
    </QueryRegion>
  );
}

function LeaveRows({ groups, busy, working, onDecide }: {
  groups: readonly PendingLeaveGroup[];
  busy: boolean;
  working: Working | undefined;
  onDecide: (group: PendingLeaveGroup, ok: boolean) => void;
}) {
  return (
    <Card label="Đơn xin nghỉ chờ duyệt" className="border-sky-200">
      <CardTitle icon={<CalendarCheck className="h-[18px] w-[18px] text-sky-600" aria-hidden="true" />} right={`${groups.length} đơn`}>
        Đơn xin nghỉ chờ duyệt
      </CardTitle>
      {groups.map((group) => {
        // Một lượt gửi chạy thì khoá mọi nút: hai quyết định chạy song song dễ bấm nhầm đơn khác.
        const mine = working !== undefined && working.user === group.user_id && working.dates.join(",") === group.dates.join(",");
        const days = leaveDaysLabel(group.dates);
        const label = `đơn nghỉ ${days} của ${group.staff_name}`;
        const many = group.dates.length > 1;
        return (
          <div key={group.key} className="flex flex-wrap items-center gap-2 rounded-[10px] border px-2.5 py-2">
            {/* Ngày đứng riêng một dòng, được xuống dòng chứ không cắt: khổ 390px cạnh hai nút, dòng gộp «tên · ngày» bị cắt mất ngày.
                Cột chữ giữ tối thiểu 10rem: đơn nhiều ngày (nút «Duyệt cả N ngày» rộng) thì hai nút xuống hàng dưới, canh phải. */}
            <div className="min-w-[10rem] flex-1">
              <div className="truncate text-[13px] font-semibold">{group.staff_name}</div>
              <div className="text-[13px] font-medium text-sky-800">Nghỉ {days}</div>
              <div className="truncate text-xs text-muted-foreground">{group.reason || "Không ghi lý do"}</div>
            </div>
            <div className="ml-auto flex shrink-0 gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={`Từ chối ${label}`} onClick={() => onDecide(group, false)}>
                {mine && working?.approve === false ? "Đang từ chối…" : "Từ chối"}
              </Button>
              <Button type="button" size="sm" disabled={busy} aria-label={`Duyệt ${label}`} onClick={() => onDecide(group, true)}>
                {mine && working?.approve === true ? "Đang duyệt…" : many ? `Duyệt cả ${group.dates.length} ngày` : "Duyệt"}
              </Button>
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">Duyệt xong nhân viên nhận thông báo kết quả. Muốn duyệt lẻ từng ngày: Bảng lương → Đơn xin nghỉ.</p>
    </Card>
  );
}
